/**
 * check_disclosure_duty 의 relatedOfficialQna 개정판 중복 제거 — "연도만 다른 같은 질문"은 최신판 하나만.
 *
 * searchQna(kb 모듈)도 dedup 을 하지만 키가 **답변 문자열**이라, 개정판에서 답변이 바뀌었거나(기준금액 50억→100억,
 * 2026판에 관리비 단서 추가 등) 표기만 흔들린 문답은 접히지 않는다 — 묶음4 실측: f03 자회사 설립 출자 문답 3판(2009·2015·2026),
 * f08 외국인 이사 문답 3판, f01 부동산 VAT 문답 2판이 relatedOfficialQna 3칸을 다 차지했다.
 * kb 모듈은 이 작업 범위 밖이라 수정하지 않고, 공개된 loadQnaKb() 로 여기서 해결한다.
 *
 * 규칙: 각 문답에 대해 **같은 카테고리의 더 최신 문서** 중 질문이 가장 비슷한 것을 찾아, 질문 bigram Dice ≥ 0.85 이면
 * 그 최신판이 이 문답을 대체한 것으로 본다(사슬로 끝까지). 결과에는 대체한 최신판(lit26-* 등)만 남긴다.
 *
 * ⚠️ "가장 비슷한 것"만 따라가는 이유: 2015판 "다른 운용사의 동일한 성격" 문답과 2026판 "같은 운용사의 동일한 성격"
 *    문답은 Dice 0.86 으로 문턱을 넘지만 서로 다른 질문이다. 2015판의 가장 가까운 최신판은 2026판 "다른 운용사"(≈0.97)
 *    이므로 올바른 쪽으로만 접힌다. 같은 해 문서끼리는 접지 않는다 (한 문서 안의 문답은 서로 다른 질문이다).
 */

import { loadQnaKb, type QnaEntry, type QnaMatch } from '../../kb/qna.js';

const SAME_QUESTION_DICE = 0.85;

function norm(s: string): string {
  return s.replace(/[\s.,?!·․ㆍ()\[\]"'“”‘’:;~-]+/g, '');
}

function bigramSet(s: string): Set<string> {
  const chars = [...norm(s)];
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) out.add(`${chars[i]}${chars[i + 1]}`);
  return out;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return (2 * n) / (a.size + b.size);
}

const gramCache = new Map<string, Set<string>>();
function grams(e: QnaEntry): Set<string> {
  let g = gramCache.get(e.id);
  if (!g) {
    g = bigramSet(e.question);
    gramCache.set(e.id, g);
  }
  return g;
}

/** 이 문답을 대체한 최신판 (없으면 자기 자신) */
export function latestVersionOf(entry: QnaEntry, kbEntries: readonly QnaEntry[] = loadQnaKb().entries): QnaEntry {
  let cur = entry;
  for (let guard = 0; guard < 10; guard++) {
    const year = cur.docYear ?? 0;
    let best: QnaEntry | undefined;
    let bestScore = 0;
    for (const cand of kbEntries) {
      if (cand.category !== cur.category) continue;
      if ((cand.docYear ?? 0) <= year) continue;
      const s = dice(grams(cur), grams(cand));
      if (s > bestScore) {
        bestScore = s;
        best = cand;
      }
    }
    if (!best || bestScore < SAME_QUESTION_DICE) return cur;
    cur = best;
  }
  return cur;
}

/** 개정판 중복을 접고 최신판으로 바꿔 상위 limit 개를 돌려준다 (노출 순서는 원래 점수 순서) */
export function dedupRelatedQna(matches: readonly QnaMatch[], limit: number): QnaMatch[] {
  let kbEntries: readonly QnaEntry[];
  try {
    kbEntries = loadQnaKb().entries;
  } catch {
    return matches.slice(0, limit);
  }
  const seen = new Set<string>();
  const out: QnaMatch[] = [];
  for (const m of matches) {
    const latest = latestVersionOf(m.entry, kbEntries);
    if (seen.has(latest.id)) continue;
    seen.add(latest.id);
    out.push({ entry: latest, score: m.score });
    if (out.length >= limit) break;
  }
  return out;
}
