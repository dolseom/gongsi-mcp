/**
 * `search_ftc_qna` — 공정위 공식 Q&A + 공시 업무 매뉴얼 본문 검색
 *
 * "이거 공시사항이야?"라는 경계사례 질문에 확답 대신 **공정위 공식 근거**를 제시한다.
 *  - results        : 해설서·FAQ·매뉴얼 사례 문답 430건 (data/ftc-qna.json) — 기존 형식 그대로
 *  - manualPassages : 2026. 4. 27. 공시 업무 매뉴얼 4종 본문 구절 (data/ftc-manual.json)
 *    문답에 없고 매뉴얼 본문에만 있는 규칙(장내 거래 제외·서식 작성 주체·중복 공시 갈음·18시 이후 제출)을
 *    모델이 못 찾아 "정보 부족"으로 끝나던 문제(eval/b2a)의 대응이다.
 * 로컬 지식베이스만 읽으므로 인증키 없이, 호출 한도 없이 동작한다.
 *
 * ⚠️ 문답 원본 상당수가 2008~2015년 자료라 폐지된 옛 기준이 섞여 있다.
 * 항목별 caveats 가 옛 수치를 표시한다 — 응답에서 절대 떼어내면 안 된다.
 * 매뉴얼 본문은 현행(2026. 4. 27.)이라 같은 주제에서 옛 문답과 다르면 매뉴얼이 우선이다.
 */

import { z } from 'zod';
import { kbStalenessNote, loadQnaKb, searchQna, type QnaCategory } from '../kb/qna.js';
import { excerpt, loadManualKb, searchManual, type ManualDocKey } from '../kb/manual.js';

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
        'group_status=기업집단현황(J004), subcontract=하도급대금 결제조건(J009). 생략하면 전체에서 검색. ' +
        '매뉴얼 본문도 같은 공시유형의 매뉴얼로 좁힙니다 (하도급대금은 매뉴얼 본문이 없습니다)',
    ),
  limit: z.number().int().min(1).max(20).optional().describe('문답 최대 결과 수 (기본 5)'),
  manual_limit: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('매뉴얼 본문 구절 최대 수 (기본 3, 0 이면 매뉴얼 검색 생략)'),
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

interface ManualPassageResult {
  id: string;
  /** 매뉴얼 정식 문서명 */
  doc: string;
  /** 인쇄 쪽 번호 — 인용·원문 확인 시 이 쪽을 안내한다 */
  page: number;
  /** PDF 쪽 번호 (인쇄 쪽과 다르다 — 표지·목차만큼 밀린다) */
  pdfPage: number;
  heading: string;
  /** body = 본문 / form_note = 서식의 "기재상의 주의"·"기재요령" (작성 주체·작성 조건) */
  kind: 'body' | 'form_note';
  text: string;
  /** 본문이 길어 질의 낱말 주변만 발췌했으면 true — 전문은 url 의 매뉴얼 해당 쪽 */
  truncated?: boolean;
  /** 질의 낱말의 절반 미만만 맞은 약한 일치 — 관련성을 직접 확인한 뒤에만 근거로 쓴다 */
  weak_match?: boolean;
  url: string;
  /** 문서 지위 표시 — 옛 문답과 구분 */
  status: string;
}

interface SearchFtcQnaResult {
  query: string;
  results: QnaResult[];
  manualPassages: ManualPassageResult[];
  notes: string[];
  diagnostics: {
    kbVersion: string | null;
    kbEntries: number | null;
    matched: number;
    manualVersion: string | null;
    manualPassages: number | null;
    manualMatched: number;
  };
}

/** 공시유형 → 매뉴얼 (하도급대금은 매뉴얼 본문 없음) */
const CATEGORY_TO_DOCS: Record<QnaCategory, readonly ManualDocKey[]> = {
  internal_transaction: ['lit'],
  unlisted_material: ['unlisted'],
  group_status: ['group_affiliate', 'group_owner'],
  subcontract: [],
};

/** 0건에도 범위 고지는 필수다 — 없으면 "공정위 자료에 그런 규정이 없다"로 오독된다 (P2-마 18번) */
const SCOPE_NOTE =
  '⚠️ 이 지식베이스는 공정위 해설서·FAQ·매뉴얼 추출분이며 법령·유권해석의 전수가 아닙니다 — ' +
  '여기 없다고 해서 규정이 없는 것이 아닙니다. 현행 수치 판정은 check_disclosure_duty 를 사용하세요.';

function searchManualSafe(
  input: SearchFtcQnaInput,
): { passages: ManualPassageResult[]; version: string | null; total: number | null; failed: boolean } {
  const manualLimit = input.manual_limit ?? 3;
  const docKeys = input.category ? CATEGORY_TO_DOCS[input.category as QnaCategory] : undefined;
  if (manualLimit === 0 || (docKeys && docKeys.length === 0)) {
    return { passages: [], version: null, total: null, failed: false };
  }
  try {
    const kb = loadManualKb();
    const status = `${kb.manualDate} 매뉴얼 본문(현행)`;
    const matches = searchManual(input.query, { docKeys, limit: manualLimit });
    return {
      passages: matches.map((m) => {
        const ex = excerpt(m.passage.text, input.query);
        return {
          id: m.passage.id,
          doc: m.passage.doc,
          page: m.passage.printedPage,
          pdfPage: m.passage.page,
          heading: m.passage.heading,
          kind: m.passage.kind,
          text: ex.text,
          ...(ex.truncated ? { truncated: true } : {}),
          ...(m.weak ? { weak_match: true } : {}),
          url: m.passage.url,
          status,
        };
      }),
      version: kb.version,
      total: kb.passages.length,
      failed: false,
    };
  } catch {
    // 매뉴얼 KB 손상이 문답 검색까지 막지 않게 한다 — 실패는 notes 로 알린다
    return { passages: [], version: null, total: null, failed: true };
  }
}

export function searchFtcQna(input: SearchFtcQnaInput): SearchFtcQnaResult {
  const limit = input.limit ?? 5;
  // 문답 KB 장애가 독립된 매뉴얼 KB 검색까지 막지 않게 한다 — 매뉴얼 실패를 격리하는 것과 대칭 (Codex 리뷰 13)
  let kb: ReturnType<typeof loadQnaKb> | null = null;
  let matches: ReturnType<typeof searchQna> = [];
  try {
    kb = loadQnaKb();
    matches = searchQna(input.query, { category: input.category as QnaCategory, limit });
  } catch {
    kb = null;
    matches = [];
  }
  const manual = searchManualSafe(input);

  const staleness = kbStalenessNote();
  const diagnostics = {
    kbVersion: kb?.version ?? null,
    kbEntries: kb?.entries.length ?? null,
    matched: matches.length,
    manualVersion: manual.version,
    manualPassages: manual.total,
    manualMatched: manual.passages.length,
  };

  const manualNotes: string[] = [];
  if (!kb) {
    manualNotes.push(
      '⚠️ 공정위 문답 지식베이스(data/ftc-qna.json)를 읽지 못해 results 가 비어 있습니다 — 해당 문답이 없다는 뜻이 아닙니다.',
    );
  }
  const weakManual = manual.passages.filter((p) => p.weak_match).length;
  if (weakManual) {
    manualNotes.push(
      'ℹ️ manualPassages 의 weak_match:true 구절은 질의 낱말의 절반 미만만 맞은 약한 일치입니다 — 관련성을 본문으로 직접 ' +
        '확인하기 전에는 근거로 인용하지 마세요.',
    );
  }
  if (manual.failed) {
    manualNotes.push(
      '⚠️ 매뉴얼 본문 지식베이스(data/ftc-manual.json)를 읽지 못해 manualPassages 가 비어 있습니다 — ' +
        '매뉴얼에 해당 규정이 없다는 뜻이 아닙니다.',
    );
  }
  if (manual.passages.length) {
    manualNotes.push(
      'manualPassages 는 공정위 공시 업무 매뉴얼(2026. 4. 27.) **현행 본문**입니다 — 같은 주제에서 옛 문답(2008~2015)과 ' +
        '다르면 매뉴얼이 우선합니다. 인용할 때는 문서명과 쪽(page)을 밝히고, 본문 문장의 조건·예외(“다만 …”)를 바꾸지 마세요.',
    );
    if (manual.passages.some((p) => p.kind === 'form_note')) {
      manualNotes.push(
        "kind:'form_note' 구절은 서식의 '기재상의 주의'·'기재요령'입니다 — 누가 그 서식을 작성하는지, 어떤 조건에서 작성하는지의 근거입니다.",
      );
    }
    if (manual.passages.some((p) => p.truncated)) {
      manualNotes.push('truncated:true 구절은 질의 낱말 주변만 발췌했습니다 — 전문은 url 의 매뉴얼 해당 쪽에서 확인하세요.');
    }
  }

  const manualOut = manual.passages;

  // 0건은 에러가 아니다 — 검색어 조정 방법을 담아 정상 응답으로 돌려준다
  if (!matches.length) {
    const strongManual = manualOut.length - weakManual;
    const qnaHead = kb
      ? `"${input.query}" 와 유사한 공정위 문답은 찾지 못했습니다.`
      : '공정위 문답 지식베이스를 읽지 못해 문답은 검색하지 못했습니다.';
    const head = strongManual
      ? // 문답은 0건이지만 매뉴얼 본문은 걸렸다 — "찾지 못했다"만 말하면 매뉴얼 근거를 버리게 된다
        `${qnaHead} 다만 공시 업무 매뉴얼 본문에서 관련 구절 ${strongManual}개를 찾았습니다 — manualPassages 를 근거로 확인하세요.`
      : manualOut.length
      ? // 약한 일치만 있다 — "관련 구절을 찾았다"고 말하면 무관한 구절이 공식 근거로 둔갑한다 (Codex 리뷰 8)
        `${qnaHead} 매뉴얼 본문에도 질의와 뚜렷이 맞는 구절이 없습니다 — manualPassages 는 낱말 일부만 겹친 약한 일치(weak_match)라 ` +
        '근거로 쓰기 전에 관련성을 확인해야 합니다. 핵심 명사 위주로 검색어를 바꿔 보세요.'
      : `"${input.query}" 와 유사한 공정위 Q&A를 찾지 못했습니다 (매뉴얼 본문 포함). ` +
        '핵심 명사 위주로 검색어를 바꿔 보세요 (예: "임대차 변경계약", "수익증권 환매").' +
        (input.category ? ' category 필터를 빼고 전체에서 다시 검색해 볼 수도 있습니다.' : '');
    return {
      query: input.query,
      results: [],
      manualPassages: manualOut,
      notes: [head, SCOPE_NOTE, ...manualNotes, ...(staleness ? [staleness] : [])],
      diagnostics,
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
  notes.push(...manualNotes);

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
    manualPassages: manualOut,
    notes,
    diagnostics,
  };
}
