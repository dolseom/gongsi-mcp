/**
 * `check_j004_consistency` — 기업집단현황공시(J004) 제출 전·후 정합성 자가점검
 *
 * 위반 건수의 84%가 J004 (공정위 실측). 이 도구는 공시 원문에서 기계적으로 재검산 가능한
 * 것들을 전부 다시 계산한다:
 *  - 재무현황: 유동+비유동=총계 (자산·부채), 자산=부채+자본 항등식, 부채비율 재계산,
 *    금융/비금융 소계·합계 재합산, ~1,000배 차이의 단위 오기 힌트
 *  - 그 외 표: 합계 행 재합산 (비율 열 제외)
 *  - 대표회사 취합분 ↔ 개별회사 공시 대사 (compare_rcept_nos)
 *
 * 실측: 미래에셋 연1회 실물에서 자산 합산 불일치 등이 실제로 발견된다 — 서식 검증이 아니라
 * 실전 오류를 잡는 도구다. 다만 이 점검은 **문서 내적 정합성**만 본다. 원천 회계 데이터와의
 * 일치(진실성)는 판정할 수 없다.
 */

import { z } from 'zod';
import { loadDocument } from './read-disclosure.js';
import {
  checkJ004Document,
  crossCheckFinanceRow,
  parseFinanceTable,
  type ConsistencyIssue,
  type FinanceRow,
} from '../rules/j004-checks.js';
import { splitSections } from '../parsers/md-table.js';
import { errorResponse, type ErrorResponse } from '../lib/errors.js';
import { getLogger } from '../lib/logger.js';

const log = getLogger('j004-check');

const RCEPT = z.string().regex(/^\d{14}$/, '접수번호는 14자리 숫자입니다');

export const checkJ004ConsistencyInput = z.object({
  rcept_no: RCEPT.describe('점검할 기업집단현황공시(J004) 접수번호'),
  compare_rcept_nos: z
    .array(RCEPT)
    .max(30, '대사 대상은 한 번에 30건 이하로 나눠 호출하세요')
    .optional()
    .describe(
      '대표회사 취합분과 대사할 개별회사 공시 접수번호 목록. 각 개별회사의 재무현황 행을 ' +
        '대표회사 취합 표의 같은 회사 행과 1백만원 단위로 대조합니다',
    ),
  include_generic_totals: z
    .boolean()
    .optional()
    .describe(
      '재무·손익 외 일반 표의 합계 재합산도 점검할지 (기본 false). ⚠️ 실험적 — 병합 셀·다층 구분 표에서 ' +
        '구조적 오탐이 발생할 수 있어 결과를 참고로만 쓰세요',
    ),
  max_issues: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('반환할 이슈 최대 개수 (기본 100)'),
});

export type CheckJ004ConsistencyInput = z.infer<typeof checkJ004ConsistencyInput>;

/** J004 계열 서식코드 (실측: 80621 분기 개별 / 80622 연1회 대표 / 80623 연1회 개별) */
const J004_ACODES = new Set(['80620', '80621', '80622', '80623', '80624', '80625']);

export interface CrossCheckReport {
  rcept_no: string;
  company: string | null;
  matched: boolean;
  matchedName?: string;
  diffCount: number;
  diffs: ConsistencyIssue[];
  /** max_issues 예산에 걸려 diffs 가 잘렸는지 — diffCount 는 전체 건수를 유지한다 */
  diffsTruncated?: boolean;
  note?: string;
}

/**
 * max_issues 예산을 본문 issues 와 crossChecks 의 diffs 에 함께 적용한다 (Codex 3차 백로그).
 * 본문 issues 가 예산을 우선 소진하고, 남은 예산으로 대사 diffs 를 순서대로 자른다.
 * diffCount·stats 집계는 전체 기준을 유지해 "잘려서 0건"으로 오독되지 않게 한다.
 */
export function applyIssueBudget(
  issues: ConsistencyIssue[],
  crossChecks: CrossCheckReport[],
  maxIssues: number,
): {
  shownIssues: ConsistencyIssue[];
  shownCrossChecks: CrossCheckReport[];
  crossChecksTruncated: boolean;
} {
  const shownIssues = issues.slice(0, maxIssues);
  let budget = Math.max(0, maxIssues - shownIssues.length);
  let crossChecksTruncated = false;
  const shownCrossChecks = crossChecks.map((c) => {
    if (c.diffs.length <= budget) {
      budget -= c.diffs.length;
      return c;
    }
    crossChecksTruncated = true;
    const kept = c.diffs.slice(0, budget);
    budget = 0;
    return { ...c, diffs: kept, diffsTruncated: true };
  });
  return { shownIssues, shownCrossChecks, crossChecksTruncated };
}

/**
 * verdict 결정 — 수행하지 못한 대사(crossFailed)가 있으면 'consistent' 를 반환하지 않는다.
 * 대사가 전건 실패해도 diffCount 0 으로만 남아 "정합"이 되던 거짓 안심 경로의 차단 지점이다.
 */
export function decideJ004Verdict(
  errors: number,
  warnings: number,
  coreChecked: boolean,
  crossFailed: number,
): 'inconsistencies_found' | 'warnings_only' | 'not_checkable' | 'cross_check_incomplete' | 'consistent' {
  if (errors > 0) return 'inconsistencies_found';
  // 대사 미수행을 경고보다 먼저 — warnings_only 는 "점검은 다 됐고 경고만 남았다"로 읽히므로
  // 대사 실패를 가리면 그 자체가 거짓 안심이다. 경고 건수는 summary·stats 로 함께 전달된다 (Codex 6차).
  if (crossFailed > 0) return 'cross_check_incomplete';
  if (warnings > 0) return 'warnings_only';
  if (!coreChecked) return 'not_checkable';
  return 'consistent';
}

export async function checkJ004Consistency(
  input: CheckJ004ConsistencyInput,
): Promise<Record<string, unknown> | ErrorResponse> {
  const maxIssues = input.max_issues ?? 100;

  // DartClient 를 미리 만들지 않는다 — 캐시 hit 경로는 API 키 없이도 동작해야 한다 (Codex 3차)
  const { markdown, meta, cached } = await loadDocument(input.rcept_no);
  if (!markdown) {
    return errorResponse(
      'body_unparsable',
      '원문 본문을 파싱할 수 없습니다 (HWP 첨부만 있는 공시일 수 있습니다).',
      { rcept_no: input.rcept_no },
    );
  }

  const notes: string[] = [];
  if (meta.acode && !J004_ACODES.has(meta.acode)) {
    notes.push(
      `서식코드 ${meta.acode}는 기업집단현황공시 계열(8062x)이 아닐 수 있습니다 — 점검은 수행하지만 결과 해석에 주의하세요.`,
    );
  }

  const result = checkJ004Document(markdown, {
    includeGenericTotals: input.include_generic_totals ?? false,
  });
  if (input.include_generic_totals) {
    notes.push(
      '일반 표 합계 점검(include_generic_totals)은 실험적입니다 — 병합 셀·다층 구분 표에서 구조적 오탐이 날 수 있으니 warning 은 원문 대조 후 판단하세요.',
    );
  }
  if (result.financeRows === null) {
    notes.push(
      '재무현황 표를 찾지 못해 항등식·소계 점검을 건너뛰었습니다. 분기용 개별회사 공시(대표회사 참조 문서)이거나 표 구조가 다른 문서일 수 있습니다.',
    );
  }

  // ── 대표회사 ↔ 개별회사 대사 ──
  const crossChecks: CrossCheckReport[] = [];
  if (input.compare_rcept_nos?.length) {
    if (!result.financeRows) {
      notes.push('기준 문서에 재무현황 표가 없어 compare_rcept_nos 대사를 수행하지 못했습니다.');
    } else {
      for (const no of input.compare_rcept_nos) {
        try {
          const indiv = await loadDocument(no);
          if (!indiv.markdown) {
            crossChecks.push({ rcept_no: no, company: null, matched: false, diffCount: 0, diffs: [], note: '본문 파싱 불가' });
            continue;
          }
          const sections = splitSections(indiv.markdown);
          let indivRows: FinanceRow[] | null = null;
          for (const sec of sections) {
            if (!sec.title.includes('재무현황')) continue;
            for (const t of sec.tables) {
              const parsed = parseFinanceTable(t);
              if (parsed) {
                indivRows = parsed;
                break;
              }
            }
            if (indivRows) break;
          }
          if (!indivRows) {
            crossChecks.push({
              rcept_no: no, company: null, matched: false, diffCount: 0, diffs: [],
              note: '개별회사 문서에서 재무현황 표를 찾지 못했습니다 (분기용 참조 문서일 수 있음)',
            });
            continue;
          }
          const firstData = indivRows.find((r) => !r.isSubtotal && !r.isTotal);
          const cross = crossCheckFinanceRow(result.financeRows, indivRows, firstData?.company ?? '');
          crossChecks.push({
            rcept_no: no,
            company: firstData?.company ?? null,
            matched: cross.matched,
            ...(cross.matchedName ? { matchedName: cross.matchedName } : {}),
            diffCount: cross.diffs.length,
            diffs: cross.diffs,
            ...(cross.matched ? {} : { note: '대표회사 취합 표에서 같은 이름의 회사를 찾지 못했습니다 (표기 차이 가능)' }),
          });
        } catch (err) {
          crossChecks.push({
            rcept_no: no, company: null, matched: false, diffCount: 0, diffs: [],
            note: `문서 로드 실패: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
  }

  const allIssues = [
    ...result.issues,
    ...crossChecks.flatMap((c) => c.diffs),
  ];
  const errors = allIssues.filter((i) => i.severity === 'error').length;
  const warnings = allIssues.filter((i) => i.severity === 'warning').length;
  const truncatedIssues = result.issues.length > maxIssues;

  const { shownIssues, shownCrossChecks, crossChecksTruncated } = applyIssueBudget(
    result.issues,
    crossChecks,
    maxIssues,
  );

  log.info('J004 정합성 점검 완료', {
    rcept_no: input.rcept_no,
    errors,
    warnings,
    crossChecks: crossChecks.length,
  });

  notes.push(
    '이 점검은 문서 내적 정합성(합산·항등식·비율·문서 간 일치)만 봅니다 — 원천 회계 데이터와의 일치 여부는 판정할 수 없습니다.',
    '허용오차: 항등식은 max(2백만원, 총계의 0.01%), 합계 재합산은 행수 비례 (백만원 반올림 누적) — 오차 이내 불일치는 보고하지 않습니다.',
  );

  // 핵심 표(재무현황)를 하나도 검증하지 못했으면 "정합"이라고 말하지 않는다 —
  // 비-J004 문서·파서 회귀가 가장 신뢰도 높은 정상 판정으로 뒤바뀌는 것을 막는다 (Codex 3차)
  const coreChecked = result.financeRows !== null;

  // 요청받은 대사 중 수행하지 못한 건수 — 회사명 표기 차이·개별문서 표 미검출·문서 로드 실패는
  // 전부 matched:false 로만 남고 diffCount 0 이라, 이대로 두면 "대사 0건 수행 + verdict consistent"가 된다.
  // 수행하지 못한 대사는 "불일치 없음"의 근거가 아니다 (find_precedents 표본 결함과 같은 유형의 거짓 안심).
  const crossRequested = input.compare_rcept_nos?.length ?? 0;
  const crossFailed = crossChecks.filter((c) => !c.matched).length;
  if (crossFailed > 0) {
    notes.push(
      `⚠️ 요청한 개별회사 대사 ${crossRequested}건 중 ${crossFailed}건을 수행하지 못했습니다 ` +
        '(사유는 crossChecks[].note 참조). 수행하지 못한 대사는 "불일치 없음"의 근거가 아닙니다.',
    );
  }

  const verdict = decideJ004Verdict(errors, warnings, coreChecked, crossFailed);

  return {
    rcept_no: input.rcept_no,
    acode: meta.acode,
    cached,
    verdict,
    summary:
      errors > 0
        ? `불일치 ${errors}건(경고 ${warnings}건 별도)이 발견됐습니다. 정정 여부 판단은 assess_correction_risk 를 참고하세요.`
        : crossFailed > 0
          ? `요청한 개별회사 대사 ${crossRequested}건 중 ${crossFailed}건을 수행하지 못했습니다` +
            (warnings > 0 ? ` (경고 ${warnings}건 별도)` : '') +
            ' — 대사까지 확인된 "정합"이 아닙니다. 사유는 crossChecks[].note 를 보세요.'
          : warnings > 0
            ? `치명적 불일치는 없고 경고 ${warnings}건이 있습니다.`
            : !coreChecked
              ? '핵심 표(재무현황)를 찾지 못해 정합성을 판정할 수 없습니다 — "정합"이 아니라 "미점검"입니다.'
              : '기계 검증 가능한 항목에서 불일치가 발견되지 않았습니다.',
    issues: shownIssues,
    ...(truncatedIssues ? { issuesTruncated: true, totalIssues: result.issues.length } : {}),
    ...(shownCrossChecks.length > 0 ? { crossChecks: shownCrossChecks } : {}),
    ...(crossChecksTruncated ? { crossChecksTruncated: true } : {}),
    stats: {
      ...result.stats,
      errors,
      warnings,
      crossChecked: crossChecks.filter((c) => c.matched).length,
      crossCheckFailed: crossFailed,
    },
    notes,
    disclaimer:
      '본 점검은 공시 문서의 기계 검증 가능한 정합성만 확인하는 참고 정보이며, 공시 내용의 진실성·완전성에 대한 판단이 아닙니다.',
  };
}
