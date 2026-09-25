/**
 * 공정위 공시 매뉴얼 본문 지식베이스 — `data/ftc-manual.json` 로드·검색
 *
 * 2026. 4. 27. 공시 업무 매뉴얼 4종(대규모내부거래·비상장사 중요사항·기업집단 현황공시 소속회사용/동일인용)
 * 본문을 □ 블록 단위 구절로 자른 것 (scripts/build-ftc-manual.mjs).
 *
 * 왜 따로 두나: 문답(ftc-qna.json)에는 없고 **매뉴얼 본문에만 있는 규칙**이 있다 — 평가(eval/b2a)에서
 * 모델이 이런 규칙을 못 찾아 "정보 부족"으로 끝나거나 추측했다. 예:
 *   · "주식을 계열증권사를 통해 장내시장에서 거래하는 경우 (다만, 장 종료 후 시간외거래는 공시대상임)"
 *   · 서식 「특수관계인의 유상증자 참여」 기재상의 주의 — 발행회사 쪽이 작성하는 양식
 *   · "공시양식이 내부거래공시와 동일한 경우 내부거래공시로 갈음"
 *   · "18:00 이후에 제출할 경우 다음 업무 일에 공시한 것으로 처리"
 * 매뉴얼은 **현행 원문**(2026. 4. 27.)이라 2008~2015 문답보다 우선한다.
 *
 * 점수는 qna.ts 와 같은 토큰 존재·bigram 방식(text-search.ts)에 두 가지를 더한다:
 *  ① 코퍼스 희소도(idf) 가중 — 매뉴얼 본문은 문답보다 길고 "공시"·"경우"·"회사"가 거의 모든 구절에 있다.
 *     희소도 없이 존재만 세면 흔한 낱말 서너 개를 가진 구절이 "장내" 같은 결정적 낱말 하나를 이긴다.
 *  ② 길이 보정 — 긴 구절이 낱말 존재만으로 유리해지지 않게 본문 일치에 √(기준길이/길이)를 곱한다.
 *  + 제목(heading) 일치 2 > 본문 1 > 문서명 0.5 (문서명: "비상장"·"현황공시"처럼 매뉴얼 종류를 지목하는 질의용)
 *  + 서식 기재 주의(form_note)는 질의에 양식·서식·작성·기재 류 낱말이 없으면 0.75배
 *    (서식 주의는 거의 모든 거래유형 낱말을 담아 "무엇이 공시대상인가" 질의에서 본문 규칙을 밀어낸다 — 실측)
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { bigrams, clampQuery, scoreFields, shortCompoundMatched, tokenize } from './text-search.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export type ManualDocKey = 'lit' | 'unlisted' | 'group_affiliate' | 'group_owner';

/** 로드 시 전체 검증 — 필드 누락·손상이 도구 응답 단계에서 터지지 않게 신뢰경계를 여기 둔다 */
const passageSchema = z.object({
  id: z.string().min(1),
  doc: z.string().min(1),
  docKey: z.enum(['lit', 'unlisted', 'group_affiliate', 'group_owner']),
  /** PDF 쪽 번호 */
  page: z.number().int().positive(),
  /** 인쇄 쪽 번호(본문 하단 "- n -") — 사용자가 매뉴얼을 펼쳐 볼 때의 쪽 */
  printedPage: z.number().int().positive(),
  /** body = 본문 / form_note = 서식의 기재상의 주의·기재요령 */
  kind: z.enum(['body', 'form_note']),
  heading: z.string().min(1),
  text: z.string().min(1),
  url: z.string().url(),
});

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) => {
      const d = new Date(`${s}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
    },
    { message: '실존하지 않는 날짜입니다' },
  );

const manualFileSchema = z.object({
  version: z.string(),
  manualCheckDue: isoDate,
  /** 매뉴얼 발간일 — 응답의 "현행 본문" 표시에 쓴다 */
  manualDate: isoDate,
  source: z.string(),
  passages: z.array(passageSchema).min(1),
});

export type ManualPassage = z.infer<typeof passageSchema>;
type ManualFile = z.infer<typeof manualFileSchema>;

function resolveManualPath(): string {
  let dir = HERE;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'data', 'ftc-manual.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(HERE, '..', '..', 'data', 'ftc-manual.json');
}

let cache: ManualFile | null = null;

export function loadManualKb(): ManualFile {
  if (!cache) {
    const raw = JSON.parse(readFileSync(resolveManualPath(), 'utf-8'));
    const parsed = manualFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `data/ftc-manual.json 형식이 올바르지 않습니다 — 빌드 스크립트(scripts/build-ftc-manual.mjs)로 재생성하세요: ` +
          parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join(' / '),
      );
    }
    const ids = new Set(parsed.data.passages.map((p) => p.id));
    if (ids.size !== parsed.data.passages.length) {
      throw new Error('data/ftc-manual.json 에 중복 id 가 있습니다 — 빌드 스크립트로 재생성하세요.');
    }
    cache = parsed.data;
  }
  return cache;
}

export interface ManualMatch {
  passage: ManualPassage;
  score: number;
  /**
   * 질의 낱말의 절반 미만만 이 구절에 있다 — 희소 낱말 하나("추천" → 사외이사후보추천위원회)로 걸린 약한 일치.
   * 공식 근거로 제시하지 말고 관련성부터 확인해야 한다 (Codex 리뷰 8).
   */
  weak?: boolean;
}

/** 질의 낱말이 구절에 있는가 — 조사가 붙은 낱말("공시의무가")은 bigram 절반 이상이 있으면 있는 것으로 본다 */
function tokenCovered(token: string, hay: string): boolean {
  if (hay.includes(token)) return true;
  const g = bigrams(token);
  if (g.length < 2) return false;
  let hit = 0;
  for (const x of g) if (hay.includes(x)) hit++;
  return hit * 2 >= g.length;
}

/**
 * 튜닝 값 (2026-09-24, 실무자식 질의 9개 + 무관 질의 1개로 격자 탐색 — test/manual-kb.test.ts 에 고정):
 *   제목 가중 {3, 2, 1.5} × idf 지수 {1, 1.5, 2} 중 제목 3·지수 1(qna 와 같은 평탄 가중)은 8/10,
 *   제목 2·지수 1.5 는 10/10 이며 모든 정답이 2위 안 — 이웃 값도 10/10 이라 안정 구간의 가운데를 골랐다.
 *   제목 3 은 carried 소제목("8.대규모내부거래등 공시시기 및 내용")의 흔한 낱말이 본문의 결정적 낱말을 이긴다.
 */
const HEADING_WEIGHT = 2;
/** idf 지수 — 1보다 크면 드문 낱말("장내"·"갈음"·"시간외")의 몫이 커진다 */
const IDF_EXPONENT = 1.5;
/** 본문 일치 길이 보정 기준 — 이보다 짧은 구절은 보정하지 않는다(짧다고 가산하지도 않는다) */
const LENGTH_REF = 450;
/** 토큰 일치 신뢰 하한 — 제목·본문에서 맞은 토큰의 희소도 합. "공시"·"경우" 만 맞은 구절은 근거로 내놓지 않는다 */
const MIN_TOKEN_EVIDENCE = 1.5;
/** 서식 기재 주의 감쇠 (파일 머리 주석 참조) */
const FORM_NOTE_FACTOR = 0.75;
/**
 * 도입배경 감쇠 — "비상장회사는 … 특별한 공시의무가 없음" 같은 제도 도입 전 사정 서술이 의무 판정 질의의 최상위로
 * 올라와 "의무 없음" 근거처럼 읽힌다 (Codex 리뷰 8 추가 위험). 규칙 본문보다 뒤로 보낸다.
 */
const BACKGROUND_FACTOR = 0.5;
const BACKGROUND_HEADING = /도입배경/;
const FORM_QUERY = /양식|서식|작성|기재|칸|란에/;

/**
 * 시각 표기 보강 — 실무자는 "6시 넘어서"라고 묻고 매뉴얼은 "18:00 이후"라고 쓴다.
 * "N시"(1~11)는 업무 맥락상 오후일 가능성이 커 "N+12:00"을, 12~23시는 "N:00"을 토큰으로 더한다.
 * 원래 토큰("6시")은 그대로 둔다 — 보강 토큰이 안 맞아도 잃는 것이 없다.
 */
export function expandTimeTokens(query: string): string[] {
  const extra: string[] = [];
  for (const m of query.matchAll(/(오전|오후)?\s*(\d{1,2})\s*시(?!간|행|점|장|가|기|세|작|스)/g)) {
    const h = Number(m[2]);
    if (!(h >= 1 && h <= 23)) continue;
    if (m[1] === '오전') extra.push(`${String(h).padStart(2, '0')}:00`);
    else if (h <= 11) extra.push(`${h + 12}:00`);
    else extra.push(`${h}:00`);
  }
  return [...new Set(extra)];
}

/**
 * 실무 표현 ↔ 매뉴얼 표현 정규화 — 질의와 코퍼스 **양쪽에** 같은 치환을 적용해 한 낱말로 센다.
 *  - 실무자는 "계열사", 매뉴얼은 "계열회사"(260구절)로 쓴다. 그대로 두면 드문 표기 "계열사"(31구절)가
 *    희소도를 높게 받아, 그 표기가 우연히 제목에 있는 구절이 결정적 낱말("장내")을 가진 구절을 이긴다 (실측).
 *  - 주식·자산을 "사다/팔다"는 실무에선 매수·매입, 매뉴얼 본문·서식에선 취득·처분이 섞여 쓰인다.
 * 치환은 매칭용 사본에만 한다 — 응답 본문은 원문 그대로다.
 */
const CANON: readonly [RegExp, string][] = [
  // "상품ㆍ용역거래"(매뉴얼) ↔ "상품용역거래"(실무 입력) — 한글 사이 가운뎃점 변형(ㆍ·･ᆞ)을 지운다
  [/(?<=[가-힣])[ㆍ·･ᆞ‧](?=[가-힣])/g, ''],
  [/계열회사/g, '계열사'],
  [/취득|매입/g, '매수'],
  [/처분/g, '매도'],
];
export function canonicalize(s: string): string {
  let out = s;
  for (const [re, to] of CANON) out = out.replace(re, to);
  return out;
}

interface CanonPassage {
  heading: string;
  text: string;
  doc: string;
}

/** 매칭용 정규화 사본 — 구절 수백 개라 로드 후 1회 만든다 */
let canonCache: CanonPassage[] | null = null;
function canonPassages(kb: ManualFile): CanonPassage[] {
  if (!canonCache) {
    canonCache = kb.passages.map((p) => ({
      heading: canonicalize(p.heading),
      text: canonicalize(p.text),
      doc: canonicalize(`${p.doc} ${DOC_ALIASES[p.docKey]}`),
    }));
  }
  return canonCache;
}

/** 문서 종류를 지목하는 짧은 이름 — 문서명 필드에 넣어 "비상장"·"현황공시"·"동일인" 질의가 맞게 한다 */
const DOC_ALIASES: Record<ManualDocKey, string> = {
  lit: '대규모내부거래 내부거래공시 이사회 의결',
  unlisted: '비상장사 비상장회사 중요사항 공시',
  group_affiliate: '기업집단 현황공시 기업집단현황공시 소속회사',
  group_owner: '기업집단 현황공시 기업집단현황공시 동일인 국외 계열회사',
};

/**
 * 매뉴얼 구절 검색.
 *
 * 점수 = Σ idf(토큰)^1.5 × (제목 2 | 본문 1×길이보정 | 문서명 0.5)
 *      + 0.05 × Σ idf(bigram)^1.5 × (제목 2 | 본문 1×길이보정)
 *      × (서식 기재 주의 감쇠)
 * 신뢰 하한: 제목·본문 토큰의 희소도 합 ≥ MIN_TOKEN_EVIDENCE, 또는 짧은 복합어 규칙(제목 기준).
 */
export function searchManual(
  query: string,
  opts: { docKeys?: readonly ManualDocKey[]; limit?: number } = {},
): ManualMatch[] {
  const kb = loadManualKb();
  const limit = opts.limit ?? 3;
  const trimmed = canonicalize(clampQuery(query));
  const tokens = [...new Set([...tokenize(trimmed), ...expandTimeTokens(trimmed)])];
  const grams = bigrams(trimmed);
  if (!tokens.length && !grams.length) return [];

  const canon = canonPassages(kb);

  // 희소도 — 질의에 나온 토큰·bigram 만 그때그때 센다 (구절 수백 개라 색인이 필요 없다)
  const N = kb.passages.length;
  const hay = canon.map((c) => `${c.heading}\n${c.text}`);
  const idfCache = new Map<string, number>();
  const idf = (term: string): number => {
    let v = idfCache.get(term);
    if (v === undefined) {
      let df = 0;
      for (const h of hay) if (h.includes(term)) df++;
      v = df === 0 ? 0 : Math.log(1 + N / df) ** IDF_EXPONENT;
      idfCache.set(term, v);
    }
    return v;
  };

  const wantsForm = FORM_QUERY.test(trimmed);
  const matches: ManualMatch[] = [];
  for (let i = 0; i < kb.passages.length; i++) {
    const p = kb.passages[i]!;
    if (opts.docKeys?.length && !opts.docKeys.includes(p.docKey)) continue;
    const c = canon[i]!;
    const lenNorm = Math.min(1, Math.sqrt(LENGTH_REF / c.text.length));
    const s = scoreFields(
      tokens,
      grams,
      [
        { text: c.heading, tokenWeight: HEADING_WEIGHT, gramWeight: 2 },
        { text: c.text, tokenWeight: lenNorm, gramWeight: lenNorm },
        { text: c.doc, tokenWeight: 0.5, gramWeight: 0 },
      ],
      { token: idf, gram: idf },
    );

    // 신뢰 하한은 제목·본문에서 맞은 토큰만 본다 — 문서명 일치("비상장")만으로는 근거가 아니다
    let evidence = 0;
    for (const t of tokens) {
      if (c.heading.includes(t) || c.text.includes(t)) evidence += idf(t);
    }
    if (evidence < MIN_TOKEN_EVIDENCE && !shortCompoundMatched(s, grams.length)) continue;

    let score = s.tokenScore + s.gramScore * 0.05;
    if (p.kind === 'form_note' && !wantsForm) score *= FORM_NOTE_FACTOR;
    if (BACKGROUND_HEADING.test(p.heading)) score *= BACKGROUND_FACTOR;
    const words = tokenize(trimmed);
    const covered = words.filter((t) => tokenCovered(t, hay[i]!)).length;
    const weak = words.length >= 2 && covered * 2 < words.length;
    matches.push({ passage: p, score, ...(weak ? { weak: true } : {}) });
  }

  // 약한 일치는 점수가 높아도 질의 낱말 대부분이 없는 구절이다 — 강한 일치 뒤로 보낸다
  matches.sort(
    (x, y) =>
      Number(Boolean(x.weak)) - Number(Boolean(y.weak)) ||
      y.score - x.score ||
      x.passage.id.localeCompare(y.passage.id),
  );
  return matches.slice(0, limit);
}

/** 응답용 본문 발췌 — 길면 질의 낱말이 처음 나오는 곳 주변을 남긴다 */
export function excerpt(text: string, query: string, max = 700): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const tokens = tokenize(clampQuery(query));
  let at = -1;
  for (const t of tokens) {
    const i = text.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = at < 0 ? 0 : Math.max(0, Math.min(at - Math.floor(max / 3), text.length - max));
  const body = text.slice(start, start + max);
  return {
    text: `${start > 0 ? '…' : ''}${body}${start + max < text.length ? '…' : ''}`,
    truncated: true,
  };
}
