/**
 * `search_ftc_qna` — 공정위 공식 Q&A 검색
 *
 * "이거 공시사항이야?"라는 경계사례 질문에 확답 대신 **공정위 공식 답변**을 근거로 제시한다.
 * 로컬 지식베이스만 읽으므로 인증키 없이, 호출 한도 없이 동작한다.
 *
 * ⚠️ 원본 문서 상당수가 2008~2015년 자료라 폐지된 옛 기준이 섞여 있다.
 * 항목별 caveats 가 옛 수치를 표시한다 — 응답에서 절대 떼어내면 안 된다.
 */

import { z } from 'zod';
import { kbStalenessNote, loadQnaKb, searchQna, type QnaCategory } from '../kb/qna.js';

export const searchFtcQnaInput = z.object({
  query: z
    .string()
    .min(2, '검색어는 2글자 이상이어야 합니다')
    .max(500, '검색어는 500자 이내여야 합니다 — 핵심 명사 위주로 요약하세요')
    .describe(
      '검색어. 거래 상황을 키워드로: "발행어음 자동연장", "자회사 설립 출자", "퇴직연금 거래금액" 등. ' +
        '질문 문장을 통째로 넣어도 됩니다',
    ),
  category: z
    .enum(['internal_transaction', 'unlisted_material', 'group_status', 'subcontract'])
    .optional()
    .describe(
      '공시유형 필터. internal_transaction=대규모내부거래(J001), unlisted_material=비상장사 중요사항(J005), ' +
        'group_status=기업집단현황(J004), subcontract=하도급대금 결제조건(J009). 생략하면 전체에서 검색',
    ),
  limit: z.number().int().min(1).max(20).optional().describe('최대 결과 수 (기본 5)'),
});

export type SearchFtcQnaInput = z.infer<typeof searchFtcQnaInput>;

interface QnaResult {
  /** 토큰(단어) 일치 없이 bigram 부분일치로만 걸린 결과 — 관련성 확신이 낮다 (Opus 7차 제안) */
  weak_match?: boolean;
  id: string;
  category: QnaCategory;
  question: string;
  answer: string | null;
  source: { doc: string; docYear: number | null; url: string };
  caveats: string[];
}

interface SearchFtcQnaResult {
  query: string;
  results: QnaResult[];
  notes: string[];
  diagnostics: { kbVersion: string; kbEntries: number; matched: number };
}

export function searchFtcQna(input: SearchFtcQnaInput): SearchFtcQnaResult {
  const kb = loadQnaKb();
  const limit = input.limit ?? 5;
  const matches = searchQna(input.query, { category: input.category as QnaCategory, limit });

  const staleness = kbStalenessNote();

  // 0건은 에러가 아니다 — 검색어 조정 방법을 담아 정상 응답으로 돌려준다
  if (!matches.length) {
    return {
      query: input.query,
      results: [],
      notes: [
        `"${input.query}" 와 유사한 공정위 Q&A를 찾지 못했습니다. ` +
          '핵심 명사 위주로 검색어를 바꿔 보세요 (예: "임대차 변경계약", "수익증권 환매").' +
          (input.category ? ' category 필터를 빼고 전체에서 다시 검색해 볼 수도 있습니다.' : ''),
        // 0건에도 범위 고지는 필수다 — 없으면 "공정위 자료에 그런 규정이 없다"로 오독된다 (P2-마 18번)
        '⚠️ 이 지식베이스는 공정위 해설서·FAQ·매뉴얼 추출분이며 법령·유권해석의 전수가 아닙니다 — ' +
          '여기 없다고 해서 규정이 없는 것이 아닙니다. 현행 수치 판정은 check_disclosure_duty 를 사용하세요.',
        ...(staleness ? [staleness] : []),
      ],
      diagnostics: { kbVersion: kb.version, kbEntries: kb.entries.length, matched: 0 },
    };
  }

  const notes: string[] = [
    '공정위가 배포한 해설서·FAQ에서 추출한 공식 질의응답입니다. 개별 사안에 대한 유권해석이 아니므로 참고 근거로만 사용하세요.',
  ];
  if (staleness) notes.push(staleness);
  if (matches.some((m) => m.entry.caveats.length > 0)) {
    notes.push(
      '⚠️ 일부 결과는 옛 문서(2008~2015)에서 나왔습니다 — 각 항목의 caveats(폐지된 기준금액·기한 등)를 반드시 확인하세요. ' +
        '현행 수치는 check_disclosure_duty 가 계산합니다.',
    );
  }
  if (matches.some((m) => m.entry.answer === null)) {
    notes.push(
      '답변이 null 인 항목은 폐지된 공정위 게시판의 아카이브 복원분입니다 — 이런 질문이 공식 접수된 사실 자체가 근거이며, 답변 본문은 유실되었습니다.',
    );
  }

  // 토큰 일치 없이 bigram 만으로 통과한 결과(score < 1)는 강한 일치와 겉모습이 같아선 안 된다 —
  // "지분율변동" 류 복합어 완화 경로의 결과가 전부 여기 해당한다 (실측 score 0.30 vs 강한 일치 3.4+)
  if (matches.some((m) => m.score < 1)) {
    notes.push(
      'ℹ️ weak_match:true 항목은 단어 일치 없이 부분 문자열(bigram)로만 걸린 결과입니다 — ' +
        '관련성을 질문 본문으로 직접 확인한 뒤 인용하세요.',
    );
  }

  return {
    query: input.query,
    results: matches.map((m) => ({
      ...(m.score < 1 ? { weak_match: true } : {}),
      id: m.entry.id,
      category: m.entry.category,
      question: m.entry.question,
      answer: m.entry.answer,
      source: { doc: m.entry.doc, docYear: m.entry.docYear, url: m.entry.url },
      caveats: m.entry.caveats,
    })),
    notes,
    diagnostics: { kbVersion: kb.version, kbEntries: kb.entries.length, matched: matches.length },
  };
}
