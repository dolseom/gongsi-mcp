#!/usr/bin/env node
/**
 * 공정위 공시 매뉴얼 본문 지식베이스 빌드 스크립트 (1회성 — 매뉴얼 새 판이 나오면 재실행)
 *
 * 왜: search_ftc_qna 는 문답 430건(data/ftc-qna.json)만 봤다. 평가(eval/b2a)에서 모델이
 * **매뉴얼 본문에만 있는 규칙**을 못 찾아 "정보 부족"으로 끝나거나 추측했다 — 예:
 *   · 대규모내부거래 매뉴얼 "주식을 계열증권사를 통해 장내시장에서 거래하는 경우 (다만, 장 종료 후 시간외거래는 공시대상임)"
 *   · 서식 「특수관계인의 유상증자 참여」 기재상의 주의 (발행회사 쪽이 작성하는 양식)
 *   · 비상장 매뉴얼 "공시양식이 내부거래공시와 동일한 경우 내부거래공시로 갈음"
 *   · 현황 매뉴얼 "18:00 이후에 제출할 경우 다음 업무 일에 공시한 것으로 처리"
 *
 * 입력: RESEARCH/공정위매뉴얼_202604/txt_*.txt (PDF → pypdf 텍스트 덤프, gitignore)
 *       — 다른 위치(예: worktree 에서 원 저장소)를 읽으려면 FTC_MANUAL_TXT_DIR 로 폴더를 지정한다.
 *       텍스트 구조(실측 2026-09-24): `===== PAGE N =====` 마커 뒤에 그 쪽 본문. 마커 수 = PDF 쪽수
 *       (178·85·28·138 — README 표와 일치). 본문 첫 줄은 인쇄 쪽 번호 "- n -" (표지·목차엔 없음).
 * 출력: data/ftc-manual.json  ← 커밋 대상 (원본 PDF·txt 는 gitignore, URL 은 README)
 *
 * 원본 문서는 공정거래위원회가 배포한 공공저작물이다 (build-ftc-qna.mjs 와 같은 취급).
 *
 * ── 구절 단위 ──
 *   쪽 안에서 `□` 블록 단위로 자르고, 900자를 넘으면 `ㅇ`·`❍`·`주N)` 경계에서 다시 나눈다.
 *   `□` 가 없는 쪽은 쪽 단위(역시 900자 초과 시 같은 경계로 분할).
 *   heading = [직전 소제목(□ 바로 앞의 짧은 제목줄 — 쪽을 넘어 이어짐), □ 줄의 머리말] 또는 서식 제목.
 *
 * ── 거르는 기준 (잡음) ──
 *   ① 표지·목차: 인쇄 쪽 번호("- n -")가 없는 쪽 + 문서별 목차·양식목록 쪽(아래 DOCS.skip, 실측)
 *   ② 대규모내부거래 매뉴얼 <참고: 주요 사례>(PDF 32~63쪽): ftc-qna.json 에 lit26-001~079 로
 *      이미 문답 단위로 들어 있다 — 중복 수록하면 같은 근거가 두 번 상위를 차지한다.
 *   ③ 순수 서식 틀: 서식 쪽(마커 '기업집단명회사명공시일자'·'<작성양식'·'공시양식 및 기재요령')에서
 *      칸 이름만 나열된 줄은 버리고 **기재상의 주의·<기재요령>·주N) 이 있는 줄만** 남긴다
 *      (작성 주체·작성 조건이 여기 있다 — 예: 유상증자 참여 양식 주2 "상대방이 기재하는 양식임").
 *      남는 게 서식 제목뿐이면 구절을 만들지 않는다.
 *   ④ 정규화 후 30자 미만 구절.
 *
 * 검증 게이트(실패 시 파일을 쓰지 않고 종료): 위 네 규칙 문장이 각각 한 구절에 온전히 들어 있을 것 ·
 * id 중복 없음 · 빈 text 없음 · 문서별 구절 수 하한.
 *
 * 사용: node scripts/build-ftc-manual.mjs
 *       FTC_MANUAL_TXT_DIR=<txt 폴더> node scripts/build-ftc-manual.mjs
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = process.env.FTC_MANUAL_TXT_DIR || join(ROOT, 'RESEARCH', '공정위매뉴얼_202604');
const OUT = join(ROOT, 'data', 'ftc-manual.json');

const POST = (nttSn) => `https://www.ftc.go.kr/www/selectBbsNttView.do?key=725&bordCd=101&nttSn=${nttSn}`;

/** 문서 목록 — 문서명·nttSn·쪽수는 RESEARCH/공정위매뉴얼_202604/README.md 표 */
const DOCS = [
  {
    file: 'txt_대규모내부거래.txt',
    docKey: 'lit',
    idPrefix: 'lit',
    doc: '대규모내부거래 등에 대한 공시 업무 매뉴얼(2026. 4. 27.)',
    url: POST(47396),
    pages: 178,
    // 64·65 = <참고: 공시 양식> 양식 목록 (양식 이름 나열뿐)
    skip: new Set([64, 65]),
    // <참고: 주요 사례> — ftc-qna.json lit26-* 로 이미 수록 (거르는 기준 ②)
    skipRange: [32, 63],
    minPassages: 60,
  },
  {
    file: 'txt_비상장사.txt',
    docKey: 'unlisted',
    idPrefix: 'unl',
    doc: '비상장사 중요사항 공시 매뉴얼(2026. 4. 27.)',
    url: POST(47397),
    pages: 85,
    // 10 = <참고: 공시 양식> 양식 목록
    skip: new Set([10]),
    minPassages: 40,
  },
  {
    file: 'txt_현황공시_소속회사용.txt',
    docKey: 'group_affiliate',
    idPrefix: 'gaf',
    doc: '기업집단 현황공시 매뉴얼(소속회사용, 2026. 4. 27.)',
    url: POST(47395),
    pages: 138,
    // 4 = 목차 (인쇄 쪽 번호가 있어 ①로 안 걸린다 — 실측)
    skip: new Set([4]),
    minPassages: 60,
  },
  {
    file: 'txt_현황공시_동일인용.txt',
    docKey: 'group_owner',
    idPrefix: 'gow',
    doc: '기업집단 현황공시 매뉴얼(동일인용, 2026. 4. 27.)',
    url: POST(47395),
    pages: 28,
    skip: new Set(),
    minPassages: 10,
  },
];

const MAX_LEN = 900;
const MIN_LEN = 30;

/** 공백 정규화 — 줄바꿈·연속 공백을 한 칸으로 */
function norm(s) {
  // U+F000 = PDF 사용자 정의 글꼴의 항목 번호 글리프(현황 매뉴얼 □ 번호 자리) — 추출되면 의미 없는 사설 영역 문자다
  return s.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * 서식 제목 줄 — 서식은 "제목 + 기업집단명·회사명·공시일자… 칸 이름"으로 시작한다.
 * 공백을 지우고 본다 (PDF 추출이 "공  익법인명"처럼 공백을 끼운다).
 * ⚠️ 본문에서 "<작성양식 3> 참조" 처럼 언급만 하는 경우와 구분하려고 칸 이름 동반 또는
 *    "공시양식 및 기재요령<작성양식" 머리만 인정한다.
 */
function isFormTitleLine(line) {
  const t = line.replace(/\s+/g, '');
  return (
    t.includes('기업집단명회사명공시일자') ||
    t.includes('기업집단명공익법인명공시일자') ||
    /공시양식및기재요령<작성양식/.test(t)
  );
}

/** 쪽 안 서식 시작 위치(문자 오프셋, 줄바꿈 포함 원문 기준). 없으면 -1 */
function findFormStart(lines) {
  let offset = 0;
  for (const line of lines) {
    if (isFormTitleLine(line)) {
      // 같은 줄 앞쪽이 본문인 경우("…가급적 자세하게 기재<작성양식 3>비유동자산…") 서식 제목 위치에서 자른다
      const at = line.search(/<\s*작성양식|공시양식\s*및\s*기재요령/);
      return offset + (at > 0 ? at : 0);
    }
    offset += line.length + 1; // split(/\r?\n/) 로 잃은 \n (\r 은 line 에 남는다)
  }
  return -1;
}

/** 서식 제목 줄에서 제목만 떼어 낸다 — "33. 특수관계인의 유상증자 참여 기업집단명회사명…" → 제목 */
function formTitleOf(line) {
  const l = norm(line);
  const nsIdx = l.search(/기업집단명\s*(회사명|공\s*익법인명)/);
  let head = nsIdx >= 0 ? l.slice(0, nsIdx) : l;
  // 현황 매뉴얼: "공시양식 및 기재요령<작성양식1> (금년도지정일기준…)"
  const m = l.match(/<작성양식\s*[\d-]+>\s*[^(<]{0,40}/);
  if (m && nsIdx < 0) head = m[0];
  return norm(head).slice(0, 80);
}

/** 서식 기재 주의 표지 — 이 표지부터 줄 끝까지가 작성 주체·조건 설명이다 */
const NOTE_MARK = /기재상의\s*주의|<\s*기재요령\s*>|주\s?\d{1,2}\)/;

/**
 * □ 앞의 짧은 소제목을 떼어 낸다 ("…개념과다름공정거래법과 자본시장법상의 공시가 중복되는 경우 □").
 * 끝에서 거꾸로 45자 안에 문장 끝(함·음·임·됨·봄·름…)이나 글머리(ㅇ ❍ -)가 있으면 그 뒤가 제목이다.
 * 제목이 서술어로 끝나면(때·함·다…) 문장 조각이므로 제목으로 보지 않는다.
 */
function splitTrailingTitle(segment, allowWhole) {
  const s = segment.replace(/\s+$/, '');
  if (!s) return { body: '', title: '' };
  const STOP = /[함음임됨봄름짐능것\)\]｣」ㅇ❍\-*※□]/;
  let i = s.length - 1;
  const limit = Math.max(0, s.length - 45);
  // 원문자 항목 번호(⑭ 유상증자 결정)가 꼬리 안에 있으면 거기서 자른다 — '경영위임'의 '임'처럼
  // 낱말 속 글자가 문장 끝으로 오인되는 것보다 항목 번호가 확실한 경계다
  const circled = s.slice(limit).search(/[①-⑳㉑-㉟㊱-㊿]/);
  while (i >= limit && !STOP.test(s[i])) i--;
  let cut;
  if (circled >= 0) {
    cut = limit + circled;
  } else if (i < limit) {
    // 쪽 첫머리 세그먼트 전체가 45자 이하이고 경계가 없다 = 그 자체가 제목 ("8.대규모내부거래등 공시시기 및 내용")
    if (limit === 0 && allowWhole) cut = 0;
    else return { body: s, title: '' };
  } else {
    // 글머리(ㅇ ❍ - * ※) 바로 뒤라면 그것은 제목이 아니라 글머리 항목의 본문이다
    // ("ㅇ 무상증자에 관한 이사회결의 … 결정이 있을 때 공시 □ 공시요령" 오인 방지)
    if (/[ㅇ❍\-*※]/.test(s[i])) return { body: s, title: '' };
    cut = i + 1;
  }
  const title = norm(s.slice(cut));
  if (
    title.length < 2 ||
    /[때함음임됨다요]$/.test(title) ||
    /^\d+$/.test(title) ||
    // 구두점으로 시작("…, 거래의 금액…")·"원, 개인인 경우…"처럼 앞 문장의 꼬리 / 조문 인용 꼬리("제6조부터 제10조")
    /^[,.)\]·ㆍ]/.test(title) ||
    /^[^\s]{1,2}[,)]/.test(title) ||
    /^제\d+조/.test(title) ||
    // 조사로 시작하면 앞 문장에서 잘려 나온 조각이다 ("…(스톡옵션)을 부여하는 경우…")
    /^(을|를|에|의|은|는|이|가|과|와|로|으로|등|및)\s/.test(title)
  ) {
    return { body: s, title: '' };
  }
  return { body: s.slice(0, cut), title };
}

/** 자간을 벌린 제목("대 규 모 내 부 거 래")의 글자 사이 공백을 지운다 */
function unspace(title) {
  if ((title.match(/[가-힣] (?=[가-힣](?: |$))/g) ?? []).length < 5) return title;
  return title.replace(/(?<=[가-힣]) (?=[가-힣])/g, '');
}

/** 900자 초과 블록을 글머리 경계에서 나눈다 (한 글머리가 900자를 넘으면 그대로 둔다) */
function chunk(text) {
  if (text.length <= MAX_LEN) return [text];
  const pieces = text.split(/(?=\s(?:ㅇ|❍|◦)\s?)|(?=주\s?\d{1,2}\))/);
  const out = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && cur.length + p.length > MAX_LEN) {
      out.push(cur);
      cur = p;
    } else cur += p;
  }
  if (cur) out.push(cur);
  return out.map(norm).filter(Boolean);
}

/** □ 머리말 — □ 뒤 첫 글머리(ㅇ ❍ -) 전까지, 60자 제한 */
function blockLead(block) {
  const b = norm(block.replace(/^□\s*/, ''));
  const m = b.match(/^(.*?)(?=\sㅇ\s|\s❍|\s-\s|$)/);
  let lead = (m ? m[1] : b).trim();
  if (lead.length > 60) lead = lead.slice(0, 60) + '…';
  return lead;
}

const stats = [];
const passages = [];

for (const d of DOCS) {
  const path = join(SRC_DIR, d.file);
  if (!existsSync(path)) {
    throw new Error(
      `입력 텍스트가 없습니다: ${path} — PDF 를 README 의 URL 에서 받아 pypdf 로 추출하거나, ` +
        'FTC_MANUAL_TXT_DIR 로 txt 폴더를 지정하세요.',
    );
  }
  const raw = readFileSync(path, 'utf-8');
  const parts = raw.split(/^===== PAGE (\d+) =====\r?$/m);
  const pages = [];
  for (let i = 1; i < parts.length; i += 2) pages.push({ page: Number(parts[i]), body: parts[i + 1] ?? '' });
  if (pages.length !== d.pages) {
    throw new Error(`${d.file}: 쪽 수 기대 ${d.pages}, 실제 ${pages.length} — 추출본이 바뀌었습니다.`);
  }

  const st = { doc: d.docKey, pages: pages.length, droppedPages: {}, passages: 0, formNotePassages: 0, droppedShort: 0 };
  const drop = (why) => (st.droppedPages[why] = (st.droppedPages[why] ?? 0) + 1);

  let section = ''; // 직전 소제목 — 쪽을 넘어 이어진다
  let formTitle = ''; // 직전 서식 제목 — 서식 이어지는 쪽에 쓴다
  let prevWasForm = false;
  let prevPassage = null; // 서식 이어짐 조각을 붙일 대상

  for (const { page, body } of pages) {
    const lines = body.split(/\r?\n/);
    const pnIdx = lines.findIndex((l) => /^\s*-\s*\d+\s*-\s*$/.test(l));
    if (pnIdx < 0) {
      drop('표지·목차(쪽 번호 없음)');
      continue;
    }
    const printedPage = Number(lines[pnIdx].replace(/[^\d]/g, ''));
    if (d.skip.has(page)) {
      drop('목차·양식 목록');
      continue;
    }
    if (d.skipRange && page >= d.skipRange[0] && page <= d.skipRange[1]) {
      drop('주요 사례(ftc-qna lit26-* 수록분)');
      continue;
    }
    const contentLines = lines.slice(pnIdx + 1);
    const pageText = contentLines.join('\n');
    const pageNorm = norm(pageText);
    if (!pageNorm) {
      drop('빈 쪽');
      continue;
    }

    const blocks = []; // { heading, text, kind }

    // ── 본문/서식 경계 — 한 쪽에 본문 뒤로 서식이 이어 붙는 경우가 많다 (비상장 "…기재<작성양식 3>비유동자산…") ──
    const startsLikeBody = /^[ㅇ❍□\-]/.test(pageNorm) || /\((작성기준|공시기준)/.test(pageNorm);
    const formStart = findFormStart(contentLines);
    let bodyText = pageText;
    let formText = '';
    if (formStart >= 0) {
      bodyText = pageText.slice(0, formStart);
      formText = pageText.slice(formStart);
    } else if (
      prevWasForm &&
      !pageNorm.includes('□') &&
      !startsLikeBody &&
      // 서식 이어짐은 "주8)"·"<기재요령>"·"<대표회사용>"·"나.한도 약정…" 처럼 시작한다.
      // 그 밖("5공시절차…"·"◇ 체크리스트")은 서식 뒤에 오는 본문이다 — 서식으로 보면 통째로 사라진다
      /^(?:기재)?주\s?\d{1,2}\)|^<(?!\s*예)|^[가-하]\.\s?/.test(pageNorm)
    ) {
      // 앞 쪽 서식의 기재 주의가 이어지는 쪽 ("기재주8) 공시회사는…")
      bodyText = '';
      formText = pageText;
    }

    if (norm(bodyText)) {
      // ── 본문: □ 블록 단위 ──
      const bodyNorm = norm(bodyText);
      const segs = bodyNorm.split(/(?=□(?!\d))/);
      // segs[0] = 첫 □ 앞 (앞 쪽에서 이어지는 본문 또는 소제목), 이후 = □ 블록.
      // 각 세그먼트 끝의 짧은 제목줄은 **다음** □ 블록의 소제목이다 (splitTrailingTitle).
      const rawBlocks = [];
      for (let k = 0; k < segs.length; k++) {
        const seg = segs[k];
        const isLast = k === segs.length - 1;
        // 대규모내부거래 매뉴얼의 번호 붙은 장 제목("5-1.대규모내부거래등 거래상대방 - 자금ㆍ…",
        // "6.대 규 모 내 부 거 래 …")은 45자를 넘거나 ' - '를 품어 꼬리 규칙으로는 안 잡힌다
        const numbered = k === 0 && !isLast && seg.length <= 120 && /^\d{1,2}(?:-\d)?\.\s?[^\d\s]/.test(seg);
        const { body, title } = numbered
          ? { body: '', title: unspace(norm(seg)) }
          : isLast
            ? { body: seg, title: '' }
            : splitTrailingTitle(seg, k === 0);
        if (norm(body)) rawBlocks.push({ text: body, lead: k === 0 && !seg.startsWith('□') ? '' : blockLead(seg), section });
        if (title) section = title;
      }

      // 현황 매뉴얼은 □ 대신 "항목명(작성기준)…" 형태 — 쪽 첫 항목명을 소제목으로
      const itemTitle = bodyNorm.match(
        /^(?:세부\s*공시내용\s*)?(?:□\s?\d{1,2}\s*)?([^()❍□]{2,40}?)(?:\[ESG\])?\s*\((?:작성기준|공시기준|공시기한|공시빈도)/,
      );
      if (itemTitle && !bodyNorm.startsWith('□ ')) {
        section = norm(itemTitle[1]);
        for (const rb of rawBlocks) if (!rb.lead) rb.section = section;
      }

      for (const rb of rawBlocks) {
        const headingParts = [rb.section, rb.lead].filter(Boolean);
        const heading = [...new Set(headingParts)].join(' › ') || d.doc;
        for (const piece of chunk(norm(rb.text))) blocks.push({ heading, text: piece, kind: 'body' });
      }
    }

    prevWasForm = Boolean(formText);
    if (formText) {
      // ── 서식: 제목 + 기재 주의만 남긴다 (거르는 기준 ③) ──
      const kept = [];
      for (const line of formText.split(/\r?\n/)) {
        const l = norm(line);
        if (!l) continue;
        if (isFormTitleLine(l)) {
          // 제목 앞에 붙은 앞 서식의 꼬리("…구분하여 기재13. 특수관계인에 대한 기술제휴기업집단명…")
          const t = formTitleOf(l);
          // (?<!\d) — "10. 특수관계인…"을 "1" + "0. …"으로 가르지 않게
          const tm = t.match(/^(.+?)(?<!\d)(\d{1,2}\.\s?(?:특수관계인|계열|국내|동일인|약관).*)$/);
          if (tm && prevPassage && prevPassage.kind === 'form_note') {
            prevPassage.text = norm(prevPassage.text + ' ' + tm[1]);
          }
          const prevFormTitle = formTitle;
          formTitle = tm ? tm[2].trim() : t;
          // "【일괄공시】" 처럼 같은 서식의 변형만 적힌 제목은 앞 서식 이름을 잇는다
          if (/^【/.test(formTitle) && prevFormTitle) {
            formTitle = prevFormTitle.replace(/【[^】]*】\s*$/, '').trim() + formTitle;
          }
          // 현황 매뉴얼 서식 제목엔 항목명이 없다("<작성양식 5>") — 앞 본문의 항목명을 붙인다
          if (/^(?:공시양식 및 기재요령)?\s*<작성양식\s*[\d-]+>\s*$/.test(formTitle) && section) {
            formTitle = `${section} ${formTitle.replace('공시양식 및 기재요령', '').trim()}`;
          }
          // 제목 줄 안에 기재요령이 이어 붙은 경우(비상장 <작성양식 1>)
          const ni = l.search(NOTE_MARK);
          if (ni >= 0) kept.push(l.slice(ni));
          continue;
        }
        const ni = l.search(NOTE_MARK);
        if (ni >= 0) kept.push(l.slice(ni));
      }
      if (!kept.length) {
        drop('순수 서식 틀(쪽 또는 쪽 일부)');
      } else {
        const heading = `서식 「${formTitle || '제목 미상'}」 기재상의 주의`;
        for (const piece of chunk(norm(kept.join(' ')))) blocks.push({ heading, text: piece, kind: 'form_note' });
      }
    }

    let n = 0;
    for (const b of blocks) {
      if (b.text.length < MIN_LEN) {
        st.droppedShort++;
        continue;
      }
      n++;
      const p = {
        id: `man-${d.idPrefix}-p${page}-${n}`,
        doc: d.doc,
        docKey: d.docKey,
        page,
        printedPage,
        kind: b.kind,
        heading: b.heading,
        text: b.text,
        url: d.url,
      };
      passages.push(p);
      prevPassage = p;
      st.passages++;
      if (b.kind === 'form_note') st.formNotePassages++;
    }
  }
  if (st.passages < d.minPassages) {
    throw new Error(`검증 실패: ${d.docKey} 구절 ${st.passages}개 < 하한 ${d.minPassages} — 파싱이 조용히 실패했을 수 있습니다.`);
  }
  stats.push(st);
}

// ── 검증 게이트 — 조용한 누락을 막는다. 실패하면 기존 JSON 을 덮어쓰지 않는다 ──
const GATES = [
  {
    docKey: 'lit',
    must: '주식을 계열증권사를 통해 장내시장에서 거래하는 경우 (다만, 장 종료 후 시간외거래는 공시대상임)',
  },
  {
    docKey: 'lit',
    must: '“특수관계인에 대한 출자”양식의 상대방이 기재하는 양식임',
    heading: '유상증자 참여',
  },
  { docKey: 'unlisted', must: '공시양식이 내부거래공시와 동일한 경우 내부거래공시로 갈음' },
  { docKey: 'group_affiliate', must: '18:00 이후에 제출할 경우 다음 업무 일에 공시한 것으로 처리됨' },
];
const gateHits = {};
for (const g of GATES) {
  const hit = passages.find(
    (p) => p.docKey === g.docKey && p.text.includes(g.must) && (!g.heading || p.heading.includes(g.heading)),
  );
  if (!hit) {
    throw new Error(`검증 실패: 필수 문장이 한 구절에 온전히 들어 있지 않습니다 — "${g.must}" (${g.docKey}). 기존 JSON 을 덮어쓰지 않았습니다.`);
  }
  gateHits[g.must.slice(0, 24)] = hit.id;
}
const ids = new Set(passages.map((p) => p.id));
if (ids.size !== passages.length) throw new Error('검증 실패: 중복 id — 기존 JSON 을 덮어쓰지 않았습니다.');
if (passages.some((p) => !p.text.trim() || !p.heading.trim())) {
  throw new Error('검증 실패: 빈 text/heading — 기존 JSON 을 덮어쓰지 않았습니다.');
}

const out = {
  version: '2026-09-24',
  // ftc-qna.json 과 같은 의미 — 공정위 매뉴얼은 매년 4월 갱신된다. 이 날짜가 지나면
  // search_ftc_qna 가 응답에 갱신 안내를 붙인다 (src/kb/qna.ts kbStalenessNote)
  manualCheckDue: '2027-05-31',
  manualDate: '2026-04-27',
  source:
    '공정거래위원회 정책자료 게시판(bordCd=101) 공시 업무 매뉴얼 4종(2026. 4. 27.) 본문 — ' +
    '대규모내부거래(nttSn=47396)·비상장사 중요사항(47397)·기업집단 현황공시 소속회사용/동일인용(47395). ' +
    'PDF 텍스트 추출 2026-08-04, 구절 분할 2026-09-24 (scripts/build-ftc-manual.mjs). ' +
    '대규모내부거래 매뉴얼의 <참고: 주요 사례>는 ftc-qna.json(lit26-*)에 있어 제외. 원문은 공정위 공공저작물.',
  passages,
};

writeFileSync(OUT, JSON.stringify(out, null, 1), 'utf-8');

console.log('문서별 통계:');
for (const s of stats) console.log(' ', JSON.stringify(s));
console.log(`총 구절 ${passages.length}개 (서식 기재 주의 ${passages.filter((p) => p.kind === 'form_note').length})`);
const lens = passages.map((p) => p.text.length).sort((a, b) => a - b);
console.log(`구절 길이: 최소 ${lens[0]} / 중앙 ${lens[lens.length >> 1]} / 최대 ${lens[lens.length - 1]}`);
console.log('검증 게이트 적중:', gateHits);
console.log(`→ ${OUT} (${(statSync(OUT).size / 1024).toFixed(1)} KB)`);
