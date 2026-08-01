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
import { loadQnaKb, searchQna, type QnaCategory } from '../kb/qna.js';

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

  // 0건은 에러가 아니다 — 검색어 조정 방법을 담아 정상 응답으로 돌려준다
  if (!matches.length) {
    return {
      query: input.query,
      results: [],
      notes: [
        `"${input.query}" 와 유사한 공정위 Q&A를 찾지 못했습니다. ` +
          '핵심 명사 위주로 검색어를 바꿔 보세요 (예: "임대차 변경계약", "수익증권 환매").' +
          (input.category ? ' category 필터를 빼고 전체에서 다시 검색해 볼 수도 있습니다.' : ''),
      ],
      diagnostics: { kbVersion: kb.version, kbEntries: kb.entries.length, matched: 0 },
    };
  }

  const notes: string[] = [
    '공정위가 배포한 해설서·FAQ에서 추출한 공식 질의응답입니다. 개별 사안에 대한 유권해석이 아니므로 참고 근거로만 사용하세요.',
  ];
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

  return {
    query: input.query,
    results: matches.map((m) => ({
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
