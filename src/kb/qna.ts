/**
 * 공정위 Q&A 지식베이스 — `data/ftc-qna.json` 로드·검색
 *
 * 공정위가 배포한 해설서·FAQ 9종 전문 330건 + 폐지 게시판 복원 제목 21건
 * + 2026. 4. 27. 대규모내부거래 공시 업무 매뉴얼 주요 사례 79건 (계 430건).
 * "이거 공시사항이야?" 류 경계사례에서 규칙만으로 판정할 수 없을 때, 유사한 **공정위 공식 답변**을
 * 근거로 제시하는 것이 목적이다 (제품 철학: 확답이 아니라 근거 동봉).
 *
 * ⚠️ 구판 문서(2008~2015)에는 폐지된 옛 기준(기준금액 50억·기한 1일 등)이 그대로 실려 있어,
 * 항목별 `caveats` 를 반드시 함께 노출해야 한다 — 빌드 스크립트가 연도·옛 수치를 감지해 달았고,
 * 2026 매뉴얼 사례(lit26-*)가 같은 주제의 현행판이다 (scripts/build-ftc-qna.mjs).
 * 매뉴얼은 매년 4월 갱신된다 — 새 판 발간 시 재추출·재빌드할 것.
 *
 * 검색은 인메모리 스코어링이다. 430건 규모에서 SQLite FTS 는 과하고,
 * trigram 토크나이저의 2글자 미매칭·MATCH 구문 문제를 피할 수 있다.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const HERE = dirname(fileURLToPath(import.meta.url));

export type QnaCategory =
  | 'internal_transaction' // 대규모내부거래 (J001)
  | 'unlisted_material' // 비상장사 중요사항 (J005)
  | 'group_status' // 기업집단현황 (J004)
  | 'subcontract'; // 하도급대금 결제조건 (J009)

/** 로드 시 전체 검증 — 필드 누락·손상이 도구 응답 단계에서 터지지 않게 신뢰경계를 여기 둔다 */
const qnaEntrySchema = z.object({
  id: z.string().min(1),
  category: z.enum(['internal_transaction', 'unlisted_material', 'group_status', 'subcontract']),
  question: z.string().min(1),
  /** null = 폐지 게시판 아카이브 복원분 (제목만 남음) */
  answer: z.string().nullable(),
  doc: z.string().min(1),
  docYear: z.number().int().nullable(),
  url: z.string().url(),
  caveats: z.array(z.string()),
});

const qnaFileSchema = z.object({
  version: z.string(),
  source: z.string(),
  /** 공정위 매뉴얼 연례 갱신(매년 4월) 확인 기한 — 지나면 검색 응답에 갱신 안내를 붙인다 */
  manualCheckDue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  entries: z.array(qnaEntrySchema).min(1),
});

export type QnaEntry = z.infer<typeof qnaEntrySchema>;
type QnaFile = z.infer<typeof qnaFileSchema>;

/** holidays.json 과 같은 방식 — dist 실행 시에도 상위 탐색으로 data/ 를 찾는다 */
function resolveKbPath(): string {
  let dir = HERE;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'data', 'ftc-qna.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(HERE, '..', '..', 'data', 'ftc-qna.json');
}

let cache: QnaFile | null = null;

export function loadQnaKb(): QnaFile {
  if (!cache) {
    const raw = JSON.parse(readFileSync(resolveKbPath(), 'utf-8'));
    const parsed = qnaFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `data/ftc-qna.json 형식이 올바르지 않습니다 — 빌드 스크립트(scripts/build-ftc-qna.mjs)로 재생성하세요: ` +
          parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join(' / '),
      );
    }
    const ids = new Set(parsed.data.entries.map((e) => e.id));
    if (ids.size !== parsed.data.entries.length) {
      throw new Error('data/ftc-qna.json 에 중복 id 가 있습니다 — 빌드 스크립트로 재생성하세요.');
    }
    cache = parsed.data;
  }
  return cache;
}

export interface QnaMatch {
  entry: QnaEntry;
  score: number;
}

/** 질의를 공백·구두점 기준 토큰으로 나눈다. 1글자 토큰은 잡음이라 버린다. */
function tokenize(query: string): string[] {
  return [
    ...new Set(
      query
        .split(/[\s.,?!·()\[\]"'“”‘’]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2),
    ),
  ];
}

/** 한글 질의 대비 문자 bigram — 조사가 붙은 토큰("공시의무가")도 부분 매칭되게 한다 */
function bigrams(s: string): string[] {
  const chars = [...s.replace(/\s+/g, '')];
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i]}${chars[i + 1]}`);
  return [...new Set(out)];
}

/**
 * 유사 Q&A 검색.
 *
 * 점수 = 토큰 **존재**(질문 3점 > 답변 1점) + bigram 부분일치(소수점 가중치, 동점 해소용).
 * - 질문 일치를 답변보다 크게 치는 이유: 실무자의 질의는 "질문이 비슷한" 항목이 정답일 확률이
 *   압도적으로 높다 (답변 본문은 조문 인용이 많아 아무 질의에나 걸린다).
 * - 출현 횟수가 아니라 존재 여부만 세는 이유: 횟수를 합산하면 "만기"·"경우" 같은 범용 토큰이
 *   여러 번 나오는 긴 예시형 질문이 정답을 밀어낸다 (실측으로 확인된 랭킹 왜곡).
 */
export function searchQna(
  query: string,
  opts: { category?: QnaCategory; limit?: number } = {},
): QnaMatch[] {
  const kb = loadQnaKb();
  const limit = opts.limit ?? 5;
  // 도구 입력 스키마와 별개로 직접 호출 경계에서도 길이를 막는다 —
  // bigram 생성이 O(질의 길이 × 코퍼스)라 무제한 입력은 이벤트 루프를 점유한다 (Codex 지적)
  const trimmed = query.length > 500 ? query.slice(0, 500) : query;
  const tokens = tokenize(trimmed);
  const grams = bigrams(trimmed);
  if (!tokens.length && !grams.length) return [];

  const matches: QnaMatch[] = [];
  for (const entry of kb.entries) {
    if (opts.category && entry.category !== opts.category) continue;
    const q = entry.question;
    const a = entry.answer ?? '';

    let score = 0;
    for (const t of tokens) {
      if (q.includes(t)) score += 3;
      else if (a.includes(t)) score += 1;
    }
    let gramHits = 0;
    for (const g of grams) {
      if (q.includes(g)) gramHits += 2;
      else if (a.includes(g)) gramHits += 1;
    }
    score += gramHits * 0.05;

    // 신뢰 하한 — 토큰이 하나도 안 맞으면 bigram 우연 일치(예: "강아지 예방접종"의 '접종' 1개)만으로
    // "공정위 공식 근거"처럼 반환되면 안 된다. bigram 뭉치가 실질적으로 겹칠 때만 통과시킨다.
    const tokenMatched = score >= 1;
    if (tokenMatched || gramHits >= 8) matches.push({ entry, score });
  }

  matches.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    // 동점이면 최신 문서·답변 있는 항목 우선
    if ((y.entry.answer ? 1 : 0) !== (x.entry.answer ? 1 : 0)) {
      return (y.entry.answer ? 1 : 0) - (x.entry.answer ? 1 : 0);
    }
    return (y.entry.docYear ?? 0) - (x.entry.docYear ?? 0);
  });

  // 해설서 개정판(2008→2009→2015)에 같은 문답이 반복 수록되어 있다 (실측: 정규화 답변 동일 53건/26그룹) —
  // 상위 슬롯을 낭비하지 않게 한 건(정렬상 앞선 것)만 남긴다. 키 2종:
  //  ① 질문 앞 40자 + 답변 — 개정판마다 어미가 미세하게 다른 경우("대상입니까"/"대상인지")
  //  ② 답변 전문 — 질문 표기가 40자 안에서 갈리는 경우("해당하지"/"해당되지"). 단답("포함시킴")끼리의
  //     오접힘을 막기 위해 20자 초과 답변에만 적용한다.
  const seen = new Set<string>();
  const out: QnaMatch[] = [];
  for (const m of matches) {
    const qNorm = dedupNorm(m.entry.question);
    const aNorm = dedupNorm(m.entry.answer ?? '');
    const keys = [qNorm.slice(0, 40) + '|' + aNorm];
    if (aNorm.length > 20) keys.push('a|' + aNorm);
    if (keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * dedup 정규화 — 공백·구두점·중점만 제거한다.
 * 개정판마다 문장부호(․/·/ㆍ)와 띄어쓰기가 흔들리는 것을 흡수하되,
 * **숫자는 절대 제거하지 않는다** — 개정판 간 기준금액(50억→100억)이 다른 문답을
 * 하나로 접으면 폐지된 기준만 남을 수 있다 (Codex 경고 반영).
 */
function dedupNorm(s: string): string {
  return s.replace(/[\s.,?!·․ㆍ()\[\]"'“”‘’:;~-]+/g, '');
}

/**
 * 지식베이스 유통기한 경과 안내.
 *
 * 공정위 매뉴얼은 매년 4월 갱신된다 (2024·2025·2026판 실측 — 2026-08-04 발견 전까지
 * 이 사실을 몰라서 2026판을 3개월 놓쳤다). 사람 기억에 맡기지 않고,
 * 빌드 시 기록한 확인 기한(manualCheckDue)이 지나면 도구 응답에 갱신 안내를 붙인다.
 */
export function kbStalenessNote(now: Date = new Date()): string | null {
  const kb = loadQnaKb();
  if (!kb.manualCheckDue) return null;
  const today = now.toISOString().slice(0, 10);
  if (today <= kb.manualCheckDue) return null;
  return (
    `⚠️ 이 지식베이스(${kb.version} 빌드)의 매뉴얼 갱신 확인 기한(${kb.manualCheckDue})이 지났습니다. ` +
    '공정위는 공시 매뉴얼을 매년 4월 갱신합니다 — 정책자료 게시판에서 새 판을 확인하세요: ' +
    'https://www.ftc.go.kr/www/selectBbsNttList.do?bordCd=101&key=725 ' +
    '(재추출 절차: RESEARCH/공정위매뉴얼_202604/README.md)'
  );
}

/** 테스트용 — 캐시를 비운다 */
export function __resetQnaKb(): void {
  cache = null;
}
