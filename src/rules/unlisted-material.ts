/**
 * 비상장회사 중요사항 공시 — 대상회사·사유 판정
 *
 * 근거: 공시대상기업집단 소속회사 등의 중요사항 공시에 관한 규정(고시) §2②·§5의2
 * (법제처 행정규칙 ID 2100000245368, 원문 확인 2026-08-02)
 *
 * 구조:
 *  - 대상회사 판정(§2②): 공시대상기업집단 소속 + 비금융·보험 + 비상장 +
 *    (자산총액 100억↑ 또는 100억 미만이라도 동일인·친족 합산 20%↑ 소유 / 그 회사의 50% 초과 자회사.
 *     단 후자는 청산 중·1년 이상 휴업 시 제외)
 *  - 사유 판정(§5의2①): 임계 비율형 6종(thresholds.ts) + 금액 무관 결정형 7종(여기 정의)
 */

import type { LegalRef } from './types.js';
import { 억 } from './thresholds.js';

const RULE = '공시대상기업집단 소속회사 등의 중요사항 공시에 관한 규정';

// ── 대상회사 판정 (§2②) ─────────────────────────────────────────────

export interface SubjectCompanyInput {
  /** 주권상장법인 여부 — 상장이면 비상장사 중요사항 공시 대상이 아니다 */
  isListed?: boolean;
  /** 금융업 또는 보험업 영위 여부 — 영위하면 제외 */
  isFinancialOrInsurance?: boolean;
  /** 직전 사업연도말 자산총액 (원) */
  totalAssets?: number;
  /**
   * §2②2호 — 동일인·친족이 단독 또는 합산으로 발행주식총수 20% 이상을 소유한 회사이거나,
   * 그런 회사가 단독으로 50% 초과 소유한 자회사인지
   */
  specialRelated20pct?: boolean;
  /** 청산 절차 진행 중이거나 1년 이상 휴업 중인지 (§2②2호 단서 — 2호 경로에만 적용) */
  inLiquidationOrDormant?: boolean;
}

export interface SubjectCompanyResult {
  subject: boolean | 'insufficient_data';
  reasons: string[];
  legalBasis: LegalRef[];
}

const REF_SUBJECT: LegalRef[] = [
  {
    source: `${RULE} 제2조제2항`,
    summary:
      '공시대상비상장회사 = 공시대상기업집단 소속회사(금융·보험업 제외, 주권상장법인 제외) 중 ' +
      '①직전 사업연도말 자산총액 100억원 이상, 또는 ②100억원 미만이라도 동일인·친족이 합산 20% 이상 ' +
      '주식을 소유한 회사(그 회사가 50% 초과 소유한 회사 포함. 단, 청산 중·1년 이상 휴업 중이면 제외).',
  },
];

/**
 * 공시대상비상장회사 여부를 판정한다.
 * 전제(공시대상기업집단 소속)는 호출자가 확인한다 — 이 함수는 §2②의 나머지 요건만 본다.
 */
export function checkUnlistedSubjectCompany(input: SubjectCompanyInput): SubjectCompanyResult {
  const reasons: string[] = [];

  if (input.isListed === true) {
    return {
      subject: false,
      reasons: ['주권상장법인은 비상장회사 중요사항 공시 대상이 아닙니다 (자본시장법 공시 체계 적용).'],
      legalBasis: REF_SUBJECT,
    };
  }
  if (input.isFinancialOrInsurance === true) {
    return {
      subject: false,
      reasons: ['금융업 또는 보험업을 영위하는 회사는 제외됩니다 (§2②).'],
      legalBasis: REF_SUBJECT,
    };
  }

  if (input.totalAssets === undefined) {
    return {
      subject: 'insufficient_data',
      reasons: [
        '직전 사업연도말 자산총액이 필요합니다. 100억원 이상이면 대상, 미만이면 ' +
          '동일인·친족 지분 요건(§2②2호)을 추가로 확인해야 합니다.',
      ],
      legalBasis: REF_SUBJECT,
    };
  }

  // 미확인 전제는 명시한다 — 자산 요건 충족이 상장·업종·소속 요건까지 보장하지 않는다 (Codex 3차)
  const unverifiedPreconditions: string[] = [];
  if (input.isListed === undefined) {
    unverifiedPreconditions.push('비상장(주권상장법인 아님)');
  }
  if (input.isFinancialOrInsurance === undefined) {
    unverifiedPreconditions.push('금융·보험업 미영위');
  }
  const preconditionNote =
    unverifiedPreconditions.length > 0
      ? `※ ${unverifiedPreconditions.join('·')} 및 공시대상기업집단 소속을 전제한 판정입니다 — 해당 전제가 깨지면 대상이 아닙니다.`
      : '※ 공시대상기업집단 소속을 전제한 판정입니다.';

  if (input.totalAssets >= 100 * 억) {
    reasons.push(`직전 사업연도말 자산총액이 100억원 이상입니다 (§2②1호).`);
    reasons.push(preconditionNote);
    return { subject: true, reasons, legalBasis: REF_SUBJECT };
  }

  // 자산총액 100억 미만 — §2②2호 경로
  if (input.specialRelated20pct === undefined) {
    return {
      subject: 'insufficient_data',
      reasons: [
        '자산총액이 100억원 미만입니다. 동일인·친족이 합산 20% 이상 주식을 소유했는지(또는 그런 회사의 ' +
          '50% 초과 자회사인지)에 따라 대상 여부가 갈립니다 — specialRelated20pct 를 지정하세요 (§2②2호).',
      ],
      legalBasis: REF_SUBJECT,
    };
  }
  if (!input.specialRelated20pct) {
    return {
      subject: false,
      reasons: ['자산총액 100억원 미만이고 동일인·친족 20% 소유 요건에도 해당하지 않습니다.'],
      legalBasis: REF_SUBJECT,
    };
  }
  if (input.inLiquidationOrDormant === true) {
    return {
      subject: false,
      reasons: [
        '동일인·친족 20% 소유 요건에는 해당하나, 청산 절차 진행 중이거나 1년 이상 휴업 중인 회사는 ' +
          '제외됩니다 (§2②2호 단서).',
      ],
      legalBasis: REF_SUBJECT,
    };
  }
  reasons.push(
    '자산총액 100억원 미만이지만 동일인·친족이 합산 20% 이상 소유한 회사(또는 그 50% 초과 자회사)로서 대상입니다 (§2②2호).',
  );
  reasons.push(preconditionNote);
  return { subject: true, reasons, legalBasis: REF_SUBJECT };
}

// ── 금액 무관 결정형 사유 (§5의2①2호 바·사목, 3호 전부) ─────────────────

export type UnconditionalItem =
  | 'capital_change'
  | 'cb_bw_issue'
  | 'business_transfer'
  | 'stock_exchange_transfer'
  | 'dissolution'
  | 'rehabilitation'
  | 'restructuring_procedure';

export const UNLISTED_UNCONDITIONAL_ITEMS: Record<
  UnconditionalItem,
  { label: string; clause: string; occurrenceNote?: string }
> = {
  capital_change: { label: '증자 또는 감자에 관한 결정', clause: '제5조의2제1항제2호바목' },
  cb_bw_issue: {
    label: '전환사채·신주인수권부사채 발행에 관한 결정',
    clause: '제5조의2제1항제2호사목',
  },
  business_transfer: {
    label: '영업양도·양수·임대, 합병(간이·소규모 포함), 분할·분할합병에 관한 결정',
    clause: '제5조의2제1항제3호가목',
  },
  stock_exchange_transfer: {
    label: '주식의 포괄적 교환·이전에 관한 결정',
    clause: '제5조의2제1항제3호나목',
  },
  dissolution: { label: '해산사유 발생에 따른 해산 결정', clause: '제5조의2제1항제3호다목' },
  rehabilitation: {
    label: '회생절차 개시·종결·폐지 결정',
    clause: '제5조의2제1항제3호라목',
    occurrenceNote: '법원으로부터 결정사항을 통보받은 경우가 사유입니다.',
  },
  restructuring_procedure: {
    label: '기업구조조정 촉진법상 관리절차 개시·중단·종료 결정',
    clause: '제5조의2제1항제3호마목',
  },
};

export function unconditionalItemRef(item: UnconditionalItem): LegalRef {
  const spec = UNLISTED_UNCONDITIONAL_ITEMS[item];
  return {
    source: `${RULE} ${spec.clause}`,
    summary: `${spec.label}이 있는 경우 금액과 무관하게 공시 대상이다.`,
  };
}

/** §5의2⑤3호 — 결정형 사유의 사유 발생일 정의 */
export const DECISION_DATE_NOTE =
  '결정형 사유의 "사유 발생일"은 이사회 결의(이사회 내 위원회 결의 포함) 또는 대표이사 등 ' +
  '사실상 권한 있는 임원·주요주주의 결정이 있은 때입니다 (고시 §5의2⑤3호).';

/** §5의2⑥ — 자본시장법 공시와 중복 시 갈음 */
export const CAPITAL_MARKET_OVERLAP_NOTE =
  '이 사항이 자본시장법상 신고·공시사항과 중복되면 자본시장법에 따라 공시하면 됩니다. ' +
  '이 경우 공정거래법상 공시의무사항에도 해당함을 표시해야 합니다 (고시 §5의2⑥).';
