#!/usr/bin/env node
/**
 * 공정위 Q&A 지식베이스 빌드 스크립트 (1회성)
 *
 * 입력: RESEARCH/공시담당자_니즈_20260730/artifacts/agent_results/Q1_ftc_qna.md
 *       (공정위 정책자료 게시판 배포 해설서·FAQ 9종에서 추출한 질문·답변 전문 330건
 *        + 폐지된 '내부거래공시 주요 질문답변' 게시판 아카이브 복원 제목 21건)
 * 출력: data/ftc-qna.json  ← 이 파일이 커밋 대상이다 (입력 md는 gitignore)
 *
 * 원본 문서는 공정거래위원회가 배포한 공공저작물이다. 커뮤니티 스크랩과 달리 커밋해도 된다.
 *
 * 사용: node scripts/build-ftc-qna.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(
  ROOT,
  'RESEARCH',
  '공시담당자_니즈_20260730',
  'artifacts',
  'agent_results',
  'Q1_ftc_qna.md',
);
const OUT = join(ROOT, 'data', 'ftc-qna.json');

const md = readFileSync(SRC, 'utf-8');

// ── 원본 문서 목록 (doc → url) ──
const docUrls = new Map();
{
  const listStart = md.indexOf('### 원본 문서 목록');
  const listEnd = md.indexOf('\n## ', listStart + 1);
  const table = md.slice(listStart, listEnd);
  for (const m of table.matchAll(/^\| (.+?) \| \d+ \| \[원문\]\((https?:[^)]+)\) \|$/gm)) {
    docUrls.set(m[1].trim(), m[2]);
  }
}

/**
 * 문서명에 연도가 없는 2종은 원본 표지에서 실측한 연도를 쓴다
 * (Q1_sources/*.txt 표지: "2009. 5." / "2015. 8.")
 */
const DOC_YEAR_OVERRIDE = new Map([
  ['대규모내부거래 이사회 의결 및 공시제도 해설', 2009],
  ['비상장회사 중요사항 수시공시 매뉴얼(질의응답)', 2015],
]);

/** 문서명에서 연도 추출. "2015 수정본" / "(2008.2)" / "2009년" 전부 처리 */
function docYear(doc) {
  const override = DOC_YEAR_OVERRIDE.get(doc);
  if (override) return override;
  const m = doc.match(/(20\d{2})/);
  return m ? Number(m[1]) : null;
}

// ── 문답 전문 섹션 파싱 ──
const SECTIONS = [
  { heading: '## 대규모내부거래 이사회 의결·공시 (공시유형 J001)', category: 'internal_transaction', prefix: 'lit' },
  { heading: '## 비상장사 중요사항 공시 (J005)', category: 'unlisted_material', prefix: 'unl' },
  { heading: '## 기업집단현황 공시 (J004)', category: 'group_status', prefix: 'grp' },
  { heading: '## 하도급대금 결제조건 공시 (J009)', category: 'subcontract', prefix: 'sub' },
];

/** 옛 문서의 폐지된 수치·용어를 자동 감지해 주의 문구를 단다 */
function detectCaveats(question, answer, category, year) {
  const caveats = [];
  const text = question + '\n' + (answer ?? '');
  if (year !== null && year <= 2015) {
    caveats.push(
      `${year}년 문서입니다 — 이후 법령·고시 개정으로 현행과 다른 수치·용어가 있을 수 있습니다.`,
    );
  } else if (year === null) {
    caveats.push('작성 연도 미상의 구 문서입니다 — 현행 법령·고시와 대조가 필요합니다.');
  }
  if (category === 'internal_transaction' && /50억/.test(text)) {
    caveats.push(
      "문답에 '50억원'이 등장합니다 — 폐지된 옛 기준금액(50억원)일 수 있습니다. " +
        '현행 기준금액은 min(100억원, max(5억원, 자본금·자본총계 중 큰 금액의 5%))입니다.',
    );
  }
  if (/1일\s*이내/.test(text)) {
    caveats.push(
      "문답의 '1일 이내' 공시기한은 옛 기준입니다. 현행은 상장 3영업일 / 비상장·공익법인 7영업일입니다.",
    );
  }
  if (/상호출자제한기업집단/.test(text)) {
    caveats.push(
      "옛 문서의 '상호출자제한기업집단'은 공시의무 맥락에서 현행 '공시대상기업집단'(자산총액 5조원 이상)으로 읽어야 합니다.",
    );
  }
  return caveats;
}

/**
 * 2022.3 FAQ 답변 재추출.
 *
 * 추출 에이전트가 md 에 옮기며 lit-129·130 답변을 문장 중간에서 잘랐다 (원본 txt 는 완전함 — 실측).
 * 이 문서는 "(기존해석변경)" 항목을 담은 최신 해석이라 절단을 방치할 수 없다.
 * 원본 구조: 페이지 마커 제거 후 "N.질문☞답변" 반복. 질문의 마지막 출현(본문, TOC 제외) 뒤 ☞부터
 * 다음 질문 직전까지가 답변 전문이다. ※ 이 PDF 는 원본부터 공백이 없다 — 그대로 둔다.
 */
function extract2022FaqAnswers() {
  const txtPath = join(
    dirname(SRC),
    'Q1_sources',
    '대규모내부거래FAQ_자주묻는질의_0.txt',
  );
  const cleaned = readFileSync(txtPath, 'utf-8')
    .replace(/-\s?\d+\s?-/g, '')
    .replace(/\s+/g, '');
  // 본문 항목 위치: "숫자." 뒤에 질문이 오고 곧 ☞ 가 따르는 지점들
  const positions = [];
  for (const m of cleaned.matchAll(/☞/g)) positions.push(m.index);
  // 각 ☞ 앞의 "N." 마커를 찾아 질문 시작점을 구한다
  const items = positions.map((arrow, i) => {
    const qStart = cleaned.lastIndexOf(String(i + 1) + '.', arrow);
    const question = cleaned.slice(qStart + String(i + 1).length + 1, arrow);
    const next = positions[i + 1]
      ? cleaned.lastIndexOf(String(i + 2) + '.', positions[i + 1])
      : cleaned.length;
    const answer = cleaned.slice(arrow + 1, next);
    return { question, answer };
  });
  if (items.length !== 5) throw new Error(`2022.3 FAQ 재추출 실패: ${items.length}건`);
  return items;
}
const faq2022 = extract2022FaqAnswers();

/** 공백 제거 정규화 — 2022.3 FAQ 질문 대조용 */
function normalizeNoSpace(s) {
  return s.replace(/\s+/g, '');
}

const entries = [];

for (const sec of SECTIONS) {
  const secStart = md.indexOf(sec.heading);
  if (secStart < 0) throw new Error(`섹션을 찾지 못함: ${sec.heading}`);
  const nextSec = md.indexOf('\n## ', secStart + sec.heading.length);
  const body = md.slice(secStart, nextSec < 0 ? undefined : nextSec);
  const fullStart = body.indexOf('### 질문·답변 전문');
  if (fullStart < 0) throw new Error(`전문 섹션 없음: ${sec.heading}`);
  const full = body.slice(fullStart);

  // #### Q{n}. {질문}\n\n> 답변...\n\n*출처: {문서}*
  const entryRe = /^#### Q(\d+)\. (.+)$/gm;
  const matches = [...full.matchAll(entryRe)];
  matches.forEach((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : full.length;
    const block = full.slice(start, end);

    const answerLines = [];
    let doc = null;
    for (const line of block.split('\n')) {
      const t = line.trim();
      if (t.startsWith('>')) answerLines.push(t.replace(/^>\s?/, ''));
      const srcM = t.match(/^\*출처:\s*(.+?)\*$/);
      if (srcM) doc = srcM[1].trim();
    }
    let answer = answerLines.join('\n').trim();
    if (!answer) throw new Error(`답변 없음: ${sec.prefix} Q${m[1]}`);
    if (!doc) throw new Error(`출처 없음: ${sec.prefix} Q${m[1]}`);

    // 2022.3 FAQ 는 md 로 옮기며 잘린 답변이 있어 원본 txt 재추출본으로 교체한다
    if (doc === '대규모 내부거래 FAQ(2022.3)') {
      const qNorm = normalizeNoSpace(m[2]);
      const hit = faq2022.find((f) => f.question === qNorm || qNorm.startsWith(f.question.slice(0, 30)));
      if (!hit) throw new Error(`2022.3 FAQ 원본 대조 실패: ${qNorm.slice(0, 40)}`);
      answer = hit.answer;
    }
    const url = docUrls.get(doc);
    if (!url) throw new Error(`문서 URL 미등록: "${doc}"`);

    const year = docYear(doc);
    const question = m[2].trim();
    entries.push({
      id: `${sec.prefix}-${String(Number(m[1])).padStart(3, '0')}`,
      category: sec.category,
      question,
      answer,
      doc,
      docYear: year,
      url,
      caveats: detectCaveats(question, answer, sec.category, year),
    });
  });
}

// ── 폐지 게시판 아카이브 복원분 (제목만) ──
{
  const secStart = md.indexOf('## [폐지 게시판]');
  const secEnd = md.indexOf('\n## ', secStart + 1);
  const body = md.slice(secStart, secEnd);
  const archiveUrl =
    'https://web.archive.org/web/20191211161054/http://www.ftc.go.kr/www/cop/bbs/selectBoardList.do?key=1975&bbsId=BBSMSTR_000000002370';
  for (const m of body.matchAll(/^\| (\d+) \| (.+?) \| (.+?) \| (\d{4}-\d{2}-\d{2}) \|$/gm)) {
    const [, no, cat, title, date] = m;
    entries.push({
      id: `arch-${no}`,
      category: 'internal_transaction',
      question: title.trim(),
      answer: null, // 아카이브에 본문 캡처가 없다 — 제목만 복원됨
      doc: `내부거래공시 주요 질문답변 게시판(폐지) #${no} · ${cat.trim() === '—' ? '분류 없음' : cat.trim()} · ${date}`,
      docYear: Number(date.slice(0, 4)),
      url: archiveUrl,
      caveats: ['폐지된 공정위 게시판의 아카이브 복원분으로 질문 제목만 남아 있습니다 (답변 본문 유실).'],
    });
  }
}

const out = {
  version: '2026-07-31',
  source:
    '공정거래위원회 정책자료 게시판(bordCd=101) 배포 해설서·FAQ 9종에서 추출한 질문·답변 전문 ' +
    '+ 폐지된 내부거래공시 질문답변 게시판의 Internet Archive 복원 제목. ' +
    '수집·추출 2026-07-31 (RESEARCH/공시담당자_니즈_20260730). 원문은 공정위 공공저작물.',
  entries,
};

writeFileSync(OUT, JSON.stringify(out, null, 1), 'utf-8');

// 검증 출력
const byCat = {};
let withAnswer = 0;
for (const e of entries) {
  byCat[e.category] = (byCat[e.category] ?? 0) + 1;
  if (e.answer) withAnswer++;
}
console.log(`총 ${entries.length}건 (전문 ${withAnswer} + 제목만 ${entries.length - withAnswer})`);
console.log(byCat);
console.log(`→ ${OUT}`);
