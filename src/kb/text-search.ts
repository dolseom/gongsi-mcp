/**
 * 지식베이스 공통 텍스트 매칭 — 문답(qna.ts)과 매뉴얼 본문(manual.ts)이 같은 규칙으로 점수를 매긴다.
 *
 * 방식은 qna.ts 에서 실측으로 다듬어진 것 그대로다:
 *  - 토큰 **존재**(출현 횟수 아님) — 횟수를 합산하면 범용 토큰이 여러 번 나오는 긴 항목이 정답을 밀어낸다
 *  - 한글 문자 bigram 부분일치 — 조사가 붙은 토큰("공시의무가")도 부분 매칭되게 (동점 해소용 소수 가중)
 *  - 필드는 **앞선 필드 우선**(first-match-wins) — 질문/제목에 있으면 답변/본문에서는 다시 세지 않는다
 */

/** 직접 호출 경계의 질의 길이 상한 — bigram 생성이 O(질의 길이 × 코퍼스)라 무제한 입력은 이벤트 루프를 점유한다 */
export const MAX_QUERY_LENGTH = 500;

export function clampQuery(query: string): string {
  return query.length > MAX_QUERY_LENGTH ? query.slice(0, MAX_QUERY_LENGTH) : query;
}

/** 질의를 공백·구두점 기준 토큰으로 나눈다. 1글자 토큰은 잡음이라 버린다. */
export function tokenize(query: string): string[] {
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
export function bigrams(s: string): string[] {
  const chars = [...s.replace(/\s+/g, '')];
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i]}${chars[i + 1]}`);
  return [...new Set(out)];
}

export interface ScoreField {
  text: string;
  /** 이 필드에서 토큰이 처음 일치했을 때의 가중치 */
  tokenWeight: number;
  /** 이 필드에서 bigram 이 처음 일치했을 때의 가중치 */
  gramWeight: number;
}

export interface FieldScore {
  /** Σ 토큰 가중치 × (선택) 토큰 가중 함수 */
  tokenScore: number;
  /** Σ bigram 가중치 × (선택) bigram 가중 함수 — 호출자가 소수 계수(0.05 등)를 곱해 쓴다 */
  gramScore: number;
  /** 필드별로 처음 일치한 토큰 수 */
  tokenHits: number[];
  /** 필드별로 처음 일치한 서로 다른 bigram 수 */
  gramHits: number[];
  /** 첫·끝 bigram 이 **첫 필드**에서 일치했는가 — 짧은 복합어 하한 판정용 (qna.ts 주석 참조) */
  firstGramInPrimary: boolean;
  lastGramInPrimary: boolean;
}

/**
 * 필드 목록에 대해 토큰·bigram 점수를 매긴다. 필드 순서가 우선순위다(앞 필드에서 맞으면 뒤는 안 센다).
 * `weightOf` 를 주면 토큰·bigram 마다 곱할 가중(예: 코퍼스 희소도)을 적용한다 — 생략하면 1.
 */
export function scoreFields(
  tokens: readonly string[],
  grams: readonly string[],
  fields: readonly ScoreField[],
  weightOf?: { token?: (t: string) => number; gram?: (g: string) => number },
): FieldScore {
  const tokenHits = fields.map(() => 0);
  const gramHits = fields.map(() => 0);
  let tokenScore = 0;
  for (const t of tokens) {
    const fi = fields.findIndex((f) => f.text.includes(t));
    if (fi < 0) continue;
    tokenHits[fi]! += 1;
    tokenScore += fields[fi]!.tokenWeight * (weightOf?.token ? weightOf.token(t) : 1);
  }
  let gramScore = 0;
  let firstGramInPrimary = false;
  let lastGramInPrimary = false;
  for (let gi = 0; gi < grams.length; gi++) {
    const g = grams[gi]!;
    const fi = fields.findIndex((f) => f.text.includes(g));
    if (fi < 0) continue;
    gramHits[fi]! += 1;
    gramScore += fields[fi]!.gramWeight * (weightOf?.gram ? weightOf.gram(g) : 1);
    if (fi === 0) {
      if (gi === 0) firstGramInPrimary = true;
      if (gi === grams.length - 1) lastGramInPrimary = true;
    }
  }
  return { tokenScore, gramScore, tokenHits, gramHits, firstGramInPrimary, lastGramInPrimary };
}

/**
 * 짧은 복합어 하한 — 띄어쓰기 없는 5자 질의("지분율변동")는 bigram 이 4개뿐이고 코퍼스엔 조사가 끼어
 * 가운데 경계 bigram 이 안 맞는다. **첫 필드**에서 bigram 3개 이상·75% 이상, 그리고 첫·끝 bigram 이
 * 모두 맞으면 통과시킨다 (끝이 빠졌다 = 마지막 형태소가 다르다 — "금융상품권" 오탐 방지, qna.ts 주석).
 */
export function shortCompoundMatched(s: FieldScore, gramCount: number): boolean {
  const primary = s.gramHits[0] ?? 0;
  return primary >= 3 && primary >= gramCount * 0.75 && s.firstGramInPrimary && s.lastGramInPrimary;
}
