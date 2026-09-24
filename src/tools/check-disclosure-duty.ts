/**
 * `check_disclosure_duty` — 공시의무 진단·기한 계산 (킬러 #1)
 *
 * 룰 엔진을 MCP 도구로 노출한다. **외부 API를 쓰지 않으므로** 키가 없어도 동작하고,
 * 호출 한도와도 무관하다.
 *
 * 설계 원칙:
 *  - 판정 결과에는 **근거 조문·계산식·입력값을 반드시 동봉**한다 (재현 가능성).
 *  - 자본총계·자본금이 없으면 추정하지 않고 `insufficient_data` 로 돌려준다.
 *  - 자동 제출은 하지 않는다. 초안·판정까지만.
 */

import { z } from 'zod';
import { ymdSchema } from '../lib/schemas.js';
import {
  calcThreshold,
  isLargeInternalTransaction,
  AMOUNT_BASIS_GUIDE,
  UNLISTED_MATERIAL_THRESHOLDS,
  UNLISTED_MATERIAL_UNCONDITIONAL,
  effectiveEquity,
  formatWon,
  incompleteCapitalFlipPoint,
} from '../rules/thresholds.js';
import {
  litDeadline,
  unlistedMaterialDeadline,
  unlistedMajorShareholderDeadline,
  goodsServicesReducedDeadline,
  groupStatusAnnualDeadline,
  groupStatusQuarterlyDeadline,
  evaluateCompliance,
  businessDaysRemaining,
} from '../rules/deadlines.js';
import {
  checkUnlistedSubjectCompany,
  UNLISTED_UNCONDITIONAL_ITEMS,
  DECISION_DATE_NOTE,
  CAPITAL_MARKET_OVERLAP_NOTE,
  type UnconditionalItem,
} from '../rules/unlisted-material.js';
import { estimatePenalty, type PenaltyRegime } from '../rules/penalties.js';
import { selfCorrectionWindow, type SelfCorrectionResult } from '../rules/self-correction.js';
import { toDate, todayKstYMD } from '../rules/business-days.js';
import type { AmountBasis, DeadlineResult, Verdict } from '../rules/types.js';
import { errorResponse, type ErrorResponse } from '../lib/errors.js';
import { searchQna, type QnaCategory } from '../kb/qna.js';
import {
  buildReview,
  missingFieldsFor,
  missingLabelList,
  type ComponentStatus,
  type DutyComponents,
  type MissingInput,
  type ReviewMemo,
} from './disclosure-review.js';
import { evaluateOmnibus, type OmnibusEvaluation } from './duty/omnibus.js';
import {
  evaluateLitConditions,
  exclusionConditionsNote,
  GOODS_SERVICES_SPECIAL_NOTE,
  LEASE_GOODS_SERVICES_NOTE,
} from './duty/lit-conditions.js';
import { evaluateDelayScenario, formatPenaltyWon, type DelayScenarioOutput } from './duty/delay.js';

const YMD = ymdSchema;

export const checkDisclosureDutyInput = z.object({
  duty: z
    .enum([
      'large_internal_transaction',
      'unlisted_material',
      'group_status',
      'public_interest_corp',
      'omnibus_financial',
      'goods_services_reduced',
    ])
    .describe(
      '공시의무 유형. large_internal_transaction=대규모내부거래(법 제26조), unlisted_material=비상장사 중요사항(법 제27조), ' +
        'group_status=기업집단현황(법 제28조), public_interest_corp=공익법인(법 제29조), ' +
        'omnibus_financial=약관에 의한 금융거래 특례(고시 제9조), goods_services_reduced=상품·용역 20%↑ 감소(고시 제9조의2)',
    ),

  listing: z
    .enum(['listed', 'unlisted'])
    .optional()
    .describe('상장 여부. 대규모내부거래 기한이 갈린다 (상장 3영업일 / 비상장 7영업일)'),

  boardDate: YMD.optional().describe(
    '이사회 의결일 (대규모내부거래·공익법인. 약관 금융거래는 분기 일괄 또는 건별 사전 의결일 — 의결내용 공시기한의 기산일)',
  ),
  occurredDate: YMD.optional().describe('사유 발생일 (비상장사 중요사항)'),
  quarterEnd: YMD.optional().describe(
    '분기 종료일 (약관 금융거래의 분기 일괄 공시·상품용역 감소). 3/31·6/30·9/30·12/31 중 하나',
  ),
  year: z.number().int().optional().describe('연도 (기업집단현황)'),
  quarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional()
    .describe('분기. 지정하면 분기공시(종료 후 2개월), 생략하면 연1회(5/31)'),

  amount: z
    .number()
    .nonnegative('거래금액은 0 이상이어야 합니다')
    .optional()
    .describe(
      '거래금액 (원). 기준금액과 비교해 공시 대상 여부를 판정하고, 지연 시 과태료의 ' +
        '거래금액별 적용비율(고시 Ⅵ.2 — 100억원 미만이면 90~50%)에도 쓰인다. ' +
        '약관 금융거래는 분기 일괄 거래금액, 상품·용역 감소 특례는 실제 거래금액을 넣는다',
    ),
  amountBasis: z
    .enum(['actual', 'collateral_limit', 'lease_annualized', 'insurance_premium_total', 'quarterly_sum'])
    .optional()
    .describe(
      '거래금액 산정 방식 (고시 제4조제3항). ⚠️ 틀리면 판정이 뒤집힌다. ' +
        'collateral_limit=담보제공은 담보한도액, lease_annualized=부동산임대차는 연간임대료+보증금환산, ' +
        'insurance_premium_total=보험은 보험료총액, quarterly_sum=상품용역은 분기 합계액',
    ),

  totalEquity: z
    .number()
    .optional()
    .describe(
      '자본총계 (원). 대규모내부거래: 주주총회에서 승인된 최근 사업연도말 **개별(별도)재무제표**상 자본총계 — ' +
        '연결재무제표가 아닙니다 (공정위 매뉴얼 2026-04 제6절, 문답 lit26-011). 공익법인은 순자산총계(이사회 승인 최근 ' +
        '회계연도말). 비상장사 중요사항(unlisted_material)에서는 "자기자본"으로 쓰며, 최근 사업연도말 별도재무제표의 ' +
        '자산총액−부채총액에 사업연도말 이후 사유 발생일까지의 자본금·자본잉여금 증감을 반영한 금액입니다(합병·분할이 ' +
        '있었으면 그 효력발생일 재무제표 기준). 직전 사업연도 결산 수치는 사업연도 종료 후 3개월이 지난 날부터 1년간 ' +
        '적용합니다 (비상장사 매뉴얼 주요용어)',
    ),
  paidInCapital: z
    .number()
    .optional()
    .describe(
      '자본금 (원). 대규모내부거래: 이사회 의결일 직전일의 자본금 (공익법인은 기본순자산). 자본총계와 둘 중 큰 금액이 ' +
        '기준금액의 기초라, 한쪽만 주면 그 값으로 계산한 하한값이 됩니다',
    ),
  totalAssets: z.number().optional().describe('자산총액 (원). 비상장사 중요사항 중 고정자산 판정용'),

  materialItem: z
    .enum([
      'fixed_asset',
      'other_corp_stock',
      'gift',
      'guarantee',
      'debt_relief',
      'shareholding_change',
      'capital_change',
      'cb_bw_issue',
      'business_transfer',
      'stock_exchange_transfer',
      'dissolution',
      'rehabilitation',
      'restructuring_procedure',
    ])
    .optional()
    .describe(
      '비상장사 중요사항 세부 항목. 임계 비율형: fixed_asset=고정자산 취득·처분(자산총액 10%), ' +
        'other_corp_stock=타법인 주식(자기자본 5%), gift=증여(1%), guarantee=담보·보증(5%), ' +
        'debt_relief=채무 면제·인수(5%), shareholding_change=최대·주요주주 지분 1%p 변동. ' +
        '금액 무관 결정형: capital_change=증자·감자, cb_bw_issue=CB·BW 발행, business_transfer=영업양수도·합병·분할, ' +
        'stock_exchange_transfer=주식 포괄적 교환·이전, dissolution=해산, rehabilitation=회생절차, ' +
        'restructuring_procedure=기촉법 관리절차',
    ),

  shareholderType: z
    .enum(['largest', 'major'])
    .optional()
    .describe(
      'shareholding_change 전용 — largest=최대주주(7영업일 공시) / major=주요주주(분기별 공시, 고시 제5조의2제4항 단서). ' +
        '기한이 완전히 달라지므로 반드시 구분하세요',
    ),
  shareChangePct: z
    .number()
    .optional()
    .describe('shareholding_change 전용 — 발행주식총수 대비 지분 변동 크기 (%p). 1 이상이면 공시 대상'),

  isFinancialCompany: z
    .boolean()
    .optional()
    .describe(
      '공시하는 회사가 금융업·보험업을 영위하는지. ① 비상장사 중요사항: 영위하면 대상회사에서 제외. ' +
        '② 약관 금융거래(omnibus_financial): 금융·보험회사가 자기 금융·보험업의 일상적 거래분야에서 약관에 따라 하는 ' +
        '거래만 이사회 의결을 생략할 수 있다(대규모내부거래 고시 제9조제1항). 금융·보험회사가 아니면 계열 금융회사와의 ' +
        '약관거래도 사전 이사회 의결이 필요하다(같은 조 제2항 — 분기별 일괄 가능). 모르면 비워 두세요 — 추측하지 않고 경로별로 답합니다',
    ),
  routineFinancialBusiness: z
    .boolean()
    .optional()
    .describe(
      'omnibus_financial 전용 — 금융·보험회사라면, 이 거래가 그 회사가 영위하는 금융·보험업(표준산업분류 K64~66)과 관련한 ' +
        '일상적 거래분야(관련 시장 영업 중 비중이 높고 거래빈도가 높은 거래)인지 (고시 제9조제1항, 매뉴얼 11-1절). ' +
        'false 면 금융·보험회사라도 제9조제2항 경로(사전 의결 필요)입니다',
    ),
  standardTermsContract: z
    .boolean()
    .optional()
    .describe(
      'omnibus_financial 전용 — 약관(약관규제법 제2조: 한쪽이 거래조건을 미리 정하고 상대방은 동의 여부만 결정)에 따른 ' +
        '거래인지. false(거래조건을 협의로 정함, 사모사채 인수 등 특정 조건 부기)면 제9조 특례가 없고 일반 대규모내부거래 절차입니다',
    ),
  beneficiaryCertificate: z
    .boolean()
    .optional()
    .describe(
      'omnibus_financial 전용 — 자본시장법상 수익증권 거래인지. 계열 금융회사와의 약관거래(제9조제2항)에서 수익증권만 ' +
        '1년 이내의 거래기간을 정해 일괄 의결할 수 있고, 그 밖의 상품은 분기별 일괄까지입니다 (같은 항 단서, 문답 lit26-029)',
    ),
  shortTermDemandProduct: z
    .boolean()
    .optional()
    .describe(
      'omnibus_financial 전용 — 만기가 없고, 중도환매수수료가 없고, 수시입출금이 가능한 단기금융상품인지(세 요건 모두 — 예: ' +
        'MMF 등 초단기수익증권, 상품 약관으로 확인). true 면 계열 금융회사와의 약관거래의 **실제 거래내역**을 거래 후 3·7영업일 ' +
        '대신 분기 종료 후 익월 10영업일까지 분기 일괄 공시할 수 있습니다 (고시 제9조제5항). 사전 의결내용 공시에는 적용되지 않습니다',
    ),
  transactionDate: YMD.optional().describe(
    'omnibus_financial 전용 — 실제 거래일. 계열 금융회사와의 약관거래는 거래 후 상장 3·비상장 7영업일 이내에 거래내역을 ' +
      '공시합니다(고시 제9조제4항). quarterEnd 를 안 주면 이 날짜가 속한 분기의 종료일로 계산합니다',
  ),
  omnibusFiling: z
    .enum(['resolution', 'transaction'])
    .optional()
    .describe(
      'omnibus_financial 전용 — actualDisclosureDate·대표 기한이 어느 공시에 대한 것인지. resolution=사전(분기 일괄 또는 건별) ' +
        '의결내용 공시(의결 후 3·7영업일), transaction=실제 거래내역 공시(거래 후 3·7영업일 / 단기금융상품은 분기 일괄 선택). ' +
        '두 기한을 모두 계산할 수 있는데 공시일을 주면서 이 값을 빼면 추측하지 않고 되묻습니다',
    ),
  specialRelated20pct: z
    .boolean()
    .optional()
    .describe(
      '자산총액 100억 미만 회사의 대상 판정용 — 동일인·친족이 합산 20% 이상 소유한 회사(또는 그 회사가 ' +
        '50% 초과 소유한 자회사)인지 (고시 제2조제2항제2호)',
    ),
  inLiquidationOrDormant: z
    .boolean()
    .optional()
    .describe('청산 절차 진행 중 또는 1년 이상 휴업 중인지 (고시 제2조제2항제2호 단서의 제외 요건)'),

  counterpartyForeignAffiliate: z
    .boolean()
    .optional()
    .describe(
      '대규모내부거래·공익법인 — 거래상대방이 국외 계열회사인지. 법 제26조제1항은 상대방 특수관계인에서 국외 계열회사를 ' +
        '제외합니다(직접 거래는 대상 아님, 공정위 문답 lit26-020). true 면 forSpecialRelatedParty 도 알려 주세요',
    ),
  forSpecialRelatedParty: z
    .boolean()
    .optional()
    .describe(
      '국외 계열회사 상대 거래가 특수관계인을 **위한** 거래인지 (예: 국외 계열회사를 통해 간접적으로 특수관계인 발행 주식 ' +
        '매입 — 이 경우는 국외 제외가 적용되지 않아 대상, lit26-020 단서)',
    ),
  stockTradeVenue: z
    .enum(['exchange_regular', 'exchange_after_hours', 'off_exchange'])
    .optional()
    .describe(
      '주식 취득·처분일 때 거래 방식. exchange_regular=계열증권사 등을 통한 장내시장 정규 매매(거래조건 결정 불가 → ' +
        '대규모내부거래로 보지 않음, 고시 제4조제6항제2호·매뉴얼 6절), exchange_after_hours=장 종료 후 시간외거래(장내 제외 ' +
        '없음 — "시간외거래는 공시대상"), off_exchange=장외 직접 거래. 공익법인의 소속 국내회사 주식은 장내라도 대상',
    ),
  incidentalTransaction: z
    .boolean()
    .optional()
    .describe(
      '이미 공시대상인 거래의 권리 행사·의무 이행에 따른 부수적 거래로 새로운 거래관계가 성립하지 않는지 (예: 채권·CP 매입 ' +
        '또는 차입 후 만기 상환, 거래에 수반한 할부금융·카드결제) — true 면 대규모내부거래로 보지 않음 (고시 제4조제6항제1호)',
    ),
  picGroupShareTrade: z
    .boolean()
    .optional()
    .describe(
      'public_interest_corp 전용 — 공익법인이 해당 기업집단 소속 국내회사 주식을 취득·처분하는 거래인지. true 면 거래상대방·' +
        '금액과 관계없이 대상이고 부수적 거래·장내 제외도 적용되지 않습니다 (고시 제4조제2항제1호·제6항 단서)',
    ),

  actualDisclosureDate: YMD.optional()
    .describe('실제 공시일. 주면 기한 준수 여부와 지연일수를 함께 판정한다'),
  today: YMD.optional().describe('오늘 날짜 (기본: 시스템 날짜). D-day 계산 기준'),

  delayDays: z
    .number()
    .int('지연일수는 정수로 넣으세요')
    .min(1, '지연일수는 1 이상이어야 합니다')
    .optional()
    .describe(
      '날짜 없이 "기한을 N일 넘겼다"만 알 때의 지연일수 (최초 공시를 기한 뒤에 한 사건 — 이미 한 공시의 누락·거짓 보완은 ' +
        'assess_correction_risk). 주면 공시기한을 역산하지 않고 이 일수를 전제로 과태료를 조건부 산정합니다(delayScenario). ' +
        '날짜(boardDate·actualDisclosureDate 등)로 계산한 지연과 다르면 불일치를 표시합니다',
    ),
  delayDayBasis: z
    .enum(['calendar', 'business', 'unknown'])
    .optional()
    .describe(
      'delayDays 의 단위. 과태료 일수가산·공시지연 감경 구간은 달력일 기준입니다. business(영업일)면 날짜 없이 달력일로 바꿀 수 ' +
        '없어 금액을 만들지 않습니다. 생략·unknown 이면 달력일로 가정하고 그 가정을 알립니다',
    ),
  delayFilingState: z
    .enum(['filed', 'not_yet_filed'])
    .optional()
    .describe(
      'delayDays 가 이미 공시를 마친 날까지의 일수(filed)인지, 아직 공시 전이라 "오늘 내면 N일"(not_yet_filed)인지. ' +
        'not_yet_filed 면 다음 감경 경계와 자진시정 면제 기간(기한 만료 다음 날부터 10영업일) 충족 여부를 함께 알립니다',
    ),

  estimatePenaltyIfLate: z
    .boolean()
    .optional()
    .describe('지연이 확인되면 예상 과태료도 함께 산정할지 (기본 true)'),

  boardResolution: z
    .boolean()
    .optional()
    .describe(
      '과태료 산정용: 이사회 의결을 실제로 거쳤는지. 대규모내부거래·공익법인(법 제26조 계열)에서 의결 없이 ' +
        '공시하거나 미공시한 사건은 별표 9의 "의결 X" 칸(기본금액 5,000만~7,000만원)이 적용되어 금액이 ' +
        '크게 달라집니다. 생략하면 의결을 거친 것으로 가정하고 그 가정을 caveat 로 알립니다',
    ),

  disclosureStatus: z
    .enum(['not_disclosed', 'disclosed'])
    .optional()
    .describe(
      '공시 이행 상태. not_disclosed(아직 공시 전)를 명시하면 기한 경과 시 자진시정 골든타임을 계산합니다. ' +
        '생략하면 미공시로 단정하지 않습니다 — 기한만 조회하는 호출과 구분하기 위한 명시적 입력입니다',
    ),

  situation: z
    .string()
    .max(500, '거래 상황 서술은 500자 이내로 요약하세요')
    .optional()
    .describe(
      '거래 상황 서술 (예: "계열사 발행어음이 만기 후 자동연장됨", 500자 이내). 주면 유사한 공정위 공식 Q&A를 ' +
        'relatedOfficialQna 로 함께 돌려줍니다 — 규칙만으로 판정하기 어려운 경계사례(대상 여부·거래 성격)에 유용합니다',
    ),
});

export type CheckDisclosureDutyInput = z.infer<typeof checkDisclosureDutyInput>;

interface DutyResult {
  duty: string;
  verdict: Verdict;
  summary: string;
  /**
   * 지금 질문에 답하려면 무엇이 더 필요한가 — **오류가 아니다.**
   * 각 항목의 `purpose` 가 duty(대상 판정)인지 deadline(기한)인지 갈라 주므로, 모델은
   * 현재 질문에 필요한 것만 되물을 수 있다 (대상만 물었으면 의결일을 캐묻지 않는다).
   */
  missing_inputs: MissingInput[];
  /**
   * 대상 판정과 기한 계산의 **독립적인** 수행 상태.
   * 한쪽이 insufficient_data 여도 다른 쪽은 evaluated 일 수 있다 — 그것이 이 필드의 존재 이유다.
   */
  components: DutyComponents;
  /** 결론 → 전제 → 근거 → 미확인 → 다음 행동 순서의 검토 메모 (원본 근거는 아래 필드에 그대로 남는다) */
  review: ReviewMemo;
  threshold?: {
    amount: number;
    formula: string;
    inputs: Record<string, number | undefined>;
    amountBasisNote?: string;
  };
  deadline?: DeadlineResult & { dDay?: number };
  compliance?: { onTime: boolean; delayDays: number; actualDisclosureDate: string };
  penalty?: unknown;
  selfCorrection?: SelfCorrectionResult;
  /** 날짜 없이 지연일수(delayDays)만 받은 경우의 조건부 과태료 산정 */
  delayScenario?: DelayScenarioOutput;
  /** 약관 금융거래(고시 제9조) 경로 판정·경로별 공시기한 — omnibus_financial 에서만 */
  omnibus?: {
    path: OmnibusEvaluation['path'];
    pathReason: string;
    boardResolutionRequired: OmnibusEvaluation['boardResolutionRequired'];
    mainFiling?: OmnibusEvaluation['mainFiling'];
    mainDeadlineConditional: boolean;
    scenarios: OmnibusEvaluation['scenarios'];
  };
  relatedOfficialQna?: Array<{
    question: string;
    answer: string | null;
    source: { doc: string; docYear: number | null; url: string };
    caveats: string[];
  }>;
  notes: string[];
  disclaimer: string;
}

/** duty → Q&A 지식베이스 카테고리. 약관특례·상품용역감소·공익법인은 전부 대규모내부거래 문서권이다 */
const DUTY_TO_QNA_CATEGORY: Record<CheckDisclosureDutyInput['duty'], QnaCategory> = {
  large_internal_transaction: 'internal_transaction',
  public_interest_corp: 'internal_transaction',
  omnibus_financial: 'internal_transaction',
  goods_services_reduced: 'internal_transaction',
  unlisted_material: 'unlisted_material',
  group_status: 'group_status',
};

function isUnconditionalItem(x: string): x is UnconditionalItem {
  return x in UNLISTED_UNCONDITIONAL_ITEMS;
}

const DISCLAIMER =
  '본 판정은 공개된 법령·고시에 기반한 참고 정보이며 공정거래위원회의 공식 유권해석이 아닙니다. ' +
  '실제 신고 전 소관 부서 확인을 권장합니다.';

/** 분기 종료일 형식인지 — "2분기 → 7월 말" 착각을 받으면 기한이 밀려 지연이 "적법"으로 뒤집힌다 */
function isQuarterEndYMD(ymd: string): boolean {
  const mmdd = ymd.slice(4);
  return mmdd === '0331' || mmdd === '0630' || mmdd === '0930' || mmdd === '1231';
}

/**
 * duty별 공시일 하한 기준일 — 무관한 날짜 필드가 검증에 끼어들지 않게 duty 로 선택한다 (Codex 6차).
 * group_status 는 이벤트 입력이 없으므로 공시 대상 분기말(분기공시)·연도 시작일(연1회)을 하한으로 쓴다 —
 * 연1회 공시가 그 해 5/31 기한인데 실제 공시일 연도가 다르면(2025↔2026 오타) 확실한 이상 신호다.
 */
function dutyEventDate(
  input: CheckDisclosureDutyInput,
  today: string,
): { date: string; label: string } | null {
  switch (input.duty) {
    case 'large_internal_transaction':
    case 'public_interest_corp':
      return input.boardDate ? { date: input.boardDate, label: '이사회 의결일' } : null;
    case 'unlisted_material':
      return input.occurredDate ? { date: input.occurredDate, label: '사유 발생일' } : null;
    case 'omnibus_financial':
      // 약관거래는 경로·공시 종류(사전 의결내용 / 거래내역 / 분기 일괄)마다 기산일이 달라 evaluateOmnibus 가 고른다.
      // (종전: 모든 약관거래를 분기말로 고정 → 거래 후 3영업일 공시를 "분기말보다 앞섬" 오류로 거부할 수 있었다)
      return null;
    case 'goods_services_reduced':
      return input.quarterEnd ? { date: input.quarterEnd, label: '분기 종료일' } : null;
    case 'group_status': {
      const y = input.year ?? Number(today.slice(0, 4));
      if (input.quarter) {
        const mmdd = { 1: '0331', 2: '0630', 3: '0930', 4: '1231' }[input.quarter];
        return { date: `${y}${mmdd}`, label: '공시 대상 분기 종료일' };
      }
      return { date: `${y}0101`, label: '공시 대상 연도 시작일' };
    }
  }
}

export function checkDisclosureDuty(
  input: CheckDisclosureDutyInput,
): DutyResult | ErrorResponse {
  const today = input.today ?? todayKstYMD();
  const notes: string[] = [];

  // 공시일 하한 검증 — 의결·사유 발생·분기말 전에 공시할 수는 없다. 연도 오타(2025↔2026)가
  // "기한 내 = 적법"으로 둔갑하는 것을 막는다. 기준일은 duty별로 선택한다 (무관 필드 배제).
  // ※ 객체 수준 superRefine 은 MCP 경유 시 유실된다(registerTool 이 .shape 만 받음) — 핸들러에서 검사한다.
  if (input.actualDisclosureDate) {
    const ev = dutyEventDate(input, today);
    if (ev && toDate(input.actualDisclosureDate) < toDate(ev.date)) {
      return errorResponse(
        'invalid_argument',
        `actualDisclosureDate(${input.actualDisclosureDate})가 ${ev.label}(${ev.date})보다 앞섭니다. ` +
          '날짜 오타(특히 연도)를 확인하세요.',
      );
    }
  }

  // ── 기한 계산 ──
  //
  // ★ **없는 입력은 오류가 아니다.** 의결일·상장 여부·분기말을 아직 모르는 첫 질문
  //   ("자본 1,200억에 80억 거래인데 공시 대상이야?")에도 대상 판정은 나가야 한다.
  //   → 부족한 입력은 `missingInputs` 에 기한 목적으로 적고 이 계산만 건너뛴다.
  //   ⚠️ **제공했지만 잘못된 값은 종전대로 오류다** (분기말 아님·실존하지 않는 날짜·
  //      공시일이 기준일보다 앞섬). 부족과 오류를 뭉개면 오타가 조용히 통과한다.
  const missingInputs: MissingInput[] = [];
  let deadline: DeadlineResult | undefined;
  let omnibusEval: OmnibusEvaluation | undefined;
  switch (input.duty) {
    case 'large_internal_transaction':
    case 'public_interest_corp': {
      if (!input.boardDate) {
        missingInputs.push({
          field: 'boardDate',
          purpose: 'deadline',
          label: '이사회 의결일 — 공시기한의 기산일입니다 (의결일 다음 날부터 기산)',
        });
      }
      if (!input.listing) {
        missingInputs.push({
          field: 'listing',
          purpose: 'deadline',
          label: '상장 여부 — 상장 3영업일 / 비상장·공익법인 7영업일로 기한이 갈립니다',
        });
      }
      if (input.boardDate && input.listing) {
        deadline = litDeadline(input.boardDate, input.listing);
      }
      break;
    }
    case 'unlisted_material': {
      if (!input.occurredDate) {
        missingInputs.push({
          field: 'occurredDate',
          purpose: 'deadline',
          label: '사유 발생일 — 공시기한의 기산일입니다',
        });
      }
      // 주요주주 지분변동만 분기별 공시 — 최대주주 변동·그 외 사유는 전부 7영업일 (§5의2④)
      // 유형에 따라 기한이 완전히 달라지므로 미지정 추정은 위험하다 (Codex 3차: 지연·과태료가 뒤집힌다)
      if (input.materialItem === 'shareholding_change' && !input.shareholderType) {
        missingInputs.push({
          field: 'shareholderType',
          purpose: 'deadline',
          label:
            '최대주주(largest)인지 주요주주(major)인지 — 최대주주 변동은 7영업일, 주요주주 변동은 ' +
            '분기 종료 후 2개월로 기한이 완전히 다릅니다 (고시 제5조의2제4항 단서). 추정하지 않습니다',
        });
      }
      if (input.occurredDate) {
        if (input.materialItem === 'shareholding_change') {
          if (input.shareholderType) {
            deadline =
              input.shareholderType === 'major'
                ? unlistedMajorShareholderDeadline(input.occurredDate)
                : unlistedMaterialDeadline(input.occurredDate);
          }
        } else {
          deadline = unlistedMaterialDeadline(input.occurredDate);
        }
      }
      break;
    }
    case 'omnibus_financial': {
      // 값을 주기는 했는데 분기말이 아니면 **오류다** — 기한이 밀려 지연이 "적법"으로 뒤집힌다.
      if (input.quarterEnd && !isQuarterEndYMD(input.quarterEnd)) {
        return errorResponse(
          'invalid_argument',
          `quarterEnd(${input.quarterEnd})가 분기 종료일이 아닙니다. 3/31·6/30·9/30·12/31 중 하나를 넣으세요 — ` +
            '예: 2분기 종료일은 7월 말이 아니라 6월 30일입니다.',
        );
      }
      // ★ 경로(금융사 일상업무 / 계열 금융회사와의 약관거래 / 약관 아님)를 먼저 가른다 — 의결 필요 여부와 기한이 전부 갈린다.
      omnibusEval = evaluateOmnibus(input);
      if (omnibusEval.error) return errorResponse('invalid_argument', omnibusEval.error);
      if (input.actualDisclosureDate && omnibusEval.eventDate) {
        const ev = omnibusEval.eventDate;
        if (toDate(input.actualDisclosureDate) < toDate(ev.date)) {
          return errorResponse(
            'invalid_argument',
            `actualDisclosureDate(${input.actualDisclosureDate})가 ${ev.label}(${ev.date})보다 앞섭니다. ` +
              '날짜 오타(특히 연도)나 공시 종류(omnibusFiling)를 확인하세요.',
          );
        }
      }
      missingInputs.push(...omnibusEval.missing);
      notes.push(...omnibusEval.notes);
      deadline = omnibusEval.mainDeadline;
      break;
    }
    case 'goods_services_reduced': {
      if (!input.quarterEnd) {
        missingInputs.push({
          field: 'quarterEnd',
          purpose: 'deadline',
          label: '분기 종료일 — 3/31·6/30·9/30·12/31 중 하나입니다 (2분기는 7월 말이 아닙니다)',
        });
        break;
      }
      // 값을 주기는 했는데 분기말이 아니면 **오류다** — 기한이 밀려 지연이 "적법"으로 뒤집힌다.
      if (!isQuarterEndYMD(input.quarterEnd)) {
        return errorResponse(
          'invalid_argument',
          `quarterEnd(${input.quarterEnd})가 분기 종료일이 아닙니다. 3/31·6/30·9/30·12/31 중 하나를 넣으세요 — ` +
            '예: 2분기 종료일은 7월 말이 아니라 6월 30일입니다.',
        );
      }
      deadline = goodsServicesReducedDeadline(input.quarterEnd);
      break;
    }
    case 'group_status': {
      // 기존 기본값 유지 — 연도 생략은 올해, 분기 생략은 연1회(5/31)다.
      const year = input.year ?? Number(today.slice(0, 4));
      deadline = input.quarter
        ? groupStatusQuarterlyDeadline(year, input.quarter)
        : groupStatusAnnualDeadline(year);
      break;
    }
  }

  // ── 기준금액·대상 판정 ──
  let verdict: Verdict = 'insufficient_data';
  let summary = '';
  let threshold: DutyResult['threshold'];

  if (input.duty === 'large_internal_transaction' || input.duty === 'public_interest_corp') {
    const t = calcThreshold(
      { totalEquity: input.totalEquity, paidInCapital: input.paidInCapital },
      { entity: input.duty === 'public_interest_corp' ? 'public_interest_corp' : 'company' },
    );
    // 대상 판정에 부족한 입력을 **먼저** 적는다 — 기준금액을 못 구해 조기 종료해도 목록은 온전해야 한다.
    if (!t) {
      missingInputs.push({
        field: 'totalEquity',
        purpose: 'duty',
        label:
          '자본총계 (원) — 기준금액 계산의 기준. 주주총회 승인 최근 사업연도말 개별(별도)재무제표 기준(연결 아님). ' +
          '자본금(paidInCapital)만 있어도 계산은 되지만 그 경우 기준금액의 하한값입니다',
        alternatives: ['paidInCapital'],
      });
    }
    if (input.amount === undefined) {
      missingInputs.push({
        field: 'amount',
        purpose: 'duty',
        label: '거래금액 (원) — 기준금액과 비교해 대상 여부를 판정합니다',
      });
    }
    if (!t) {
      verdict = 'insufficient_data';
      summary =
        '자본총계 또는 자본금이 없어 기준금액을 계산할 수 없습니다. ' +
        'get_financials 로 해당 회사의 자본총계·자본금을 먼저 조회하세요.';
      notes.push('※ 통용되는 "50억원 기준"은 폐지된 옛 기준입니다. 현행은 min(100억, max(5억, 자본×5%))입니다.');
    } else {
      threshold = {
        amount: t.threshold,
        formula: t.formula,
        inputs: t.inputs as Record<string, number | undefined>,
      };
      if (input.amountBasis) {
        threshold.amountBasisNote = `거래금액 산정: ${AMOUNT_BASIS_GUIDE[input.amountBasis as AmountBasis]}`;
      } else {
        notes.push(
          '⚠️ amountBasis 를 지정하지 않았습니다. 담보제공(담보한도액)·부동산임대차(연간임대료+보증금환산)·' +
            '보험(보험료총액)·상품용역(분기 합계액)은 산정 방식이 달라 판정이 뒤집힐 수 있습니다.',
        );
      }
      const isPic = input.duty === 'public_interest_corp';
      const equityWord = isPic ? '순자산총계' : '자본총계';
      const capitalWord = isPic ? '기본순자산' : '자본금';
      if (input.amount === undefined) {
        verdict = 'insufficient_data';
        summary =
          `기준금액은 ${fmtWon(t.threshold)}입니다` +
          (t.missingSide
            ? ` (${t.missingSide === 'totalEquity' ? equityWord : capitalWord} 미입력 — 입력된 값만으로 계산한 하한값이며, 미입력 쪽이 더 크면 올라갑니다)`
            : '') +
          '. amount(거래금액)를 주면 대상 여부를 판정합니다.';
      } else {
        const required = isLargeInternalTransaction(input.amount, t.threshold);
        // ★ 한쪽 자본 미입력: 미입력 값은 기준금액을 **올리기만** 한다. 그래서 "대상 아님"은 확정이고,
        //   "대상"은 미입력 값에 따라 뒤집힐 수 있다 (거래 100억 이상이면 확정). 뒤집힐 수 있을 때만 전제를 밝힌다.
        const flip = incompleteCapitalFlipPoint(input.amount, t);
        if (flip !== null && t.missingSide === 'totalEquity') {
          // 자본금만 입력 — 자본총계는 보통 자본금보다 크므로 "대상"은 확정할 수 없다 (거짓 확정 방지).
          verdict = 'insufficient_data';
          summary =
            `${capitalWord}만으로 계산한 기준금액 ${fmtWon(t.threshold)} 기준으로는 대상이지만(거래금액 ${fmtWon(input.amount)}), ` +
            `${equityWord}이(가) ${fmtWon(flip)}을 넘으면 기준금액이 거래금액보다 커져 **대상이 아닙니다**. ` +
            `${equityWord}(주주총회 승인 최근 사업연도말 개별재무제표 기준)을 주면 확정합니다.`;
          missingInputs.push({
            field: 'totalEquity',
            purpose: 'duty',
            label:
              `${equityWord} (원) — ${fmtWon(flip)} 이하면 대상, 초과면 대상 아님. ` +
              '주주총회에서 승인된 최근 사업연도말 개별(별도)재무제표상 금액 (연결 아님)',
          });
        } else {
          verdict = required ? 'required' : 'not_required';
          summary = required
            ? `공시 대상입니다. 거래금액 ${fmtWon(input.amount)} ≥ 기준금액 ${fmtWon(t.threshold)}. 이사회 사전 의결이 필요합니다.`
            : `공시 대상이 아닙니다. 거래금액 ${fmtWon(input.amount)} < 기준금액 ${fmtWon(t.threshold)}.`;
          if (flip !== null) {
            // 자본총계만 입력 — 자본금이 자본총계보다 큰 경우는 자본잠식뿐이라 결론이 뒤집힐 여지는 좁다. 전제로 밝힌다.
            notes.push(
              `[전제] ${capitalWord}(이사회 의결일 직전일 기준)이 입력되지 않아 ${equityWord}만으로 기준금액을 계산했습니다. ` +
                `${capitalWord}이 ${fmtWon(flip)}을 넘으면(자본잠식으로 ${capitalWord}이 ${equityWord}보다 큰 경우 등) ` +
                '기준금액이 거래금액보다 커져 대상이 아닙니다 — 그렇지 않으면 이 결론은 그대로입니다.',
            );
          }
        }
        if (!required && input.amount >= t.threshold * 0.9) {
          notes.push(
            '기준금액의 90% 이상입니다. 분기 합산이나 관련 거래 합산 시 대상이 될 수 있으니 확인하세요.',
          );
        }
      }
    }

    // ── 제외 사유·금액 무관 대상 (법 제26조제1항 괄호, 고시 제4조제2항제1호·제6항, lit26-020) ──
    // 입력된 사실은 verdict 에 반영하고, 입력되지 않은 사실은 조건으로만 안내한다.
    const entity = input.duty === 'public_interest_corp' ? 'public_interest_corp' : 'company';
    const lc = evaluateLitConditions(input, entity);
    notes.push(...lc.notes);
    const dropDutyMissing = () => {
      for (let k = missingInputs.length - 1; k >= 0; k--) {
        if (missingInputs[k]!.purpose === 'duty') missingInputs.splice(k, 1);
      }
    };
    if (lc.picShareForced) {
      verdict = 'required';
      summary =
        '공시 대상입니다. 공익법인의 소속 국내회사 주식 취득·처분은 거래상대방·거래금액과 관계없이 미리 이사회 의결을 ' +
        '거치고 공시해야 합니다 (법 제29조제1항제1호, 고시 제4조제2항제1호).';
      dropDutyMissing();
    } else if (lc.excluded) {
      verdict = 'not_required';
      summary = `공시 대상이 아닙니다 — ${lc.excluded.reason}.` + (threshold ? ` (참고: 기준금액 ${fmtWon(threshold.amount)})` : '');
      dropDutyMissing();
    } else if (lc.conditional) {
      if (verdict === 'required') {
        verdict = 'insufficient_data';
        summary = `금액 기준으로는 대상입니다(${summary.replace(/^공시 대상입니다\. /, '')}) — 그러나 ${lc.conditional.reason}.`;
      } else if (verdict === 'insufficient_data') {
        notes.push(`※ ${lc.conditional.reason}.`);
      }
      if (verdict !== 'not_required') {
        missingInputs.push({ field: lc.conditional.field, purpose: 'duty', label: lc.conditional.label });
      }
    } else if (verdict === 'required') {
      notes.push(exclusionConditionsNote(input, entity));
    }
    if (entity === 'public_interest_corp' && verdict === 'not_required' && !lc.excluded && input.picGroupShareTrade === undefined) {
      summary += ' 단, 소속 국내회사 주식의 취득·처분이라면 금액과 무관하게 대상입니다 (고시 제4조제2항제1호 — picGroupShareTrade).';
    }
    if (input.amountBasis === 'quarterly_sum') notes.push(GOODS_SERVICES_SPECIAL_NOTE);
    if (input.amountBasis === 'lease_annualized') notes.push(LEASE_GOODS_SERVICES_NOTE);
  } else if (input.duty === 'unlisted_material') {
    // ── 0단계: 대상회사 판정 (§2②) — 사유를 보기 전에 회사 자체가 대상인지부터 ──
    const subjectCheck = checkUnlistedSubjectCompany({
      isListed: input.listing === undefined ? undefined : input.listing === 'listed',
      isFinancialOrInsurance: input.isFinancialCompany,
      totalAssets: input.totalAssets,
      specialRelated20pct: input.specialRelated20pct,
      inLiquidationOrDormant: input.inLiquidationOrDormant,
    });
    if (subjectCheck.subject === false) {
      verdict = 'not_required';
      summary = `공시대상비상장회사가 아닙니다. ${subjectCheck.reasons.join(' ')}`;
      notes.push(
        '※ 대상회사 판정은 공시대상기업집단 소속을 전제로 합니다 — 소속 여부는 resolve_entity(includeGroup=true)로 확인하세요.',
      );
    } else {
      if (subjectCheck.subject === 'insufficient_data') {
        notes.push(
          `대상회사 여부 미확정: ${subjectCheck.reasons.join(' ')} 아래 사유 판정은 대상회사임을 전제한 참고값입니다.`,
        );
      } else {
        notes.push(`대상회사 확인: ${subjectCheck.reasons.join(' ')}`);
      }
      notes.push(
        '※ 법 제26조(대규모내부거래)에 따라 공시되는 사항은 비상장사 중요사항 공시에서 제외됩니다 (고시 제5조의2제1항 단서). ' +
          '공시양식이 내부거래공시와 같으면 내부거래공시로 갈음하되 **기타란에 비상장회사 등의 중요사항 공시사항에도 해당한다는 ' +
          '것을 표시**하고, 두 양식이 상당히 유사하면 내부거래공시를 하면서 내부거래 양식에 없는 부분을 추가 기재할 수 있습니다 ' +
          '(공정위 비상장사 매뉴얼 2026-04 "공시유의사항").',
      );

      if (!input.materialItem) {
        verdict = 'insufficient_data';
        missingInputs.push({
          field: 'materialItem',
          purpose: 'duty',
          label: '어떤 사유인지 (고정자산 취득·타법인 주식·증여·담보·지분변동·증자 등)',
        });
        summary =
          'materialItem(세부 항목)이 필요합니다. 금액 무관 공시 대상도 있습니다: ' +
          UNLISTED_MATERIAL_UNCONDITIONAL.join(' / ');
      } else if (isUnconditionalItem(input.materialItem)) {
        // ── 금액 무관 결정형 사유 — 결정이 있으면 그 자체로 공시 대상 ──
        const spec = UNLISTED_UNCONDITIONAL_ITEMS[input.materialItem];
        verdict = 'required';
        summary = `${spec.label}은(는) 금액과 무관하게 결정(사유 발생) 자체로 공시 대상입니다 (고시 ${spec.clause}).`;
        if (spec.occurrenceNote) notes.push(spec.occurrenceNote);
        notes.push(DECISION_DATE_NOTE);
        notes.push(CAPITAL_MARKET_OVERLAP_NOTE);
      } else if (input.materialItem === 'shareholding_change') {
        // ── 지분 변동 — 금액이 아니라 발행주식총수 대비 변동폭(%p)으로 판정 ──
        if (input.shareChangePct === undefined) {
          verdict = 'insufficient_data';
          missingInputs.push({
            field: 'shareChangePct',
            purpose: 'duty',
            label: '발행주식총수 대비 지분 변동 크기 (%p) — 1%p 이상이면 공시 대상입니다',
          });
          summary =
            '최대주주·주요주주 지분변동은 발행주식총수 대비 1%p 이상 변동 시 공시 대상입니다. ' +
            'shareChangePct(변동폭 %p)를 주면 판정합니다.';
        } else {
          // 감소(-)도 변동이다 — 절댓값으로 판정한다 (Codex 3차: 음수 입력 미탐)
          const changeMagnitude = Math.abs(input.shareChangePct);
          const required = changeMagnitude >= 1;
          verdict = required ? 'required' : 'not_required';
          summary = required
            ? `공시 대상입니다. 지분 변동 ${changeMagnitude}%p ≥ 1%p (고시 제5조의2제1항제1호가목).`
            : `공시 대상이 아닙니다. 지분 변동 ${changeMagnitude}%p < 1%p.`;
          threshold = {
            amount: 1,
            formula: `발행주식총수 대비 변동폭 |${input.shareChangePct}|%p vs 임계 1%p`,
            inputs: { shareChangePct: input.shareChangePct },
          };
        }
        notes.push(
          '변동 기준일은 시행령 제17조제1호에서 규정한 날입니다. 주요주주 변동은 분기별 공시입니다 (고시 제5조의2제4항 단서).',
        );
      } else {
        // ── 임계 비율형 사유 ──
        const spec = UNLISTED_MATERIAL_THRESHOLDS[input.materialItem];
        const base =
          spec.base === 'totalAssets'
            ? input.totalAssets
            : spec.base === 'equity'
              ? input.totalEquity !== undefined && input.paidInCapital !== undefined
                ? effectiveEquity(input.totalEquity, input.paidInCapital)
                : input.totalEquity
              : undefined;

        if (base === undefined) {
          verdict = 'insufficient_data';
          missingInputs.push(
            spec.base === 'totalAssets'
              ? {
                  field: 'totalAssets',
                  purpose: 'duty',
                  label: `자산총액 (원) — ${spec.label} 임계값(자산총액의 ${spec.rate * 100}%) 계산의 기준`,
                }
              : {
                  field: 'totalEquity',
                  purpose: 'duty',
                  label: `자기자본 (원) — ${spec.label} 임계값(자기자본의 ${spec.rate * 100}%) 계산의 기준`,
                  alternatives: ['paidInCapital'],
                },
          );
          summary = `${spec.label} 판정에는 ${spec.base === 'totalAssets' ? '자산총액' : '자기자본'}이 필요합니다.`;
          notes.push(
            '신설 회사로 최근 사업연도 대차대조표가 없으면 설립 당시 납입자본금을 기준으로 합니다 (고시 제5조의2제2항).',
          );
        } else if (input.amount === undefined) {
          verdict = 'insufficient_data';
          missingInputs.push({
            field: 'amount',
            purpose: 'duty',
            label: `거래금액 (원) — ${spec.label} 임계값과 비교해 대상 여부를 판정합니다`,
          });
          summary = `${spec.label}: 임계값은 ${fmtWon(base * spec.rate)} (${spec.base === 'totalAssets' ? '자산총액' : '자기자본'}의 ${spec.rate * 100}%)입니다. amount 를 주면 판정합니다.`;
        } else {
          const limit = base * spec.rate;
          const required = input.amount >= limit;
          verdict = required ? 'required' : 'not_required';
          summary = required
            ? `공시 대상입니다. ${spec.label} ${fmtWon(input.amount)} ≥ 임계 ${fmtWon(limit)}.`
            : `공시 대상이 아닙니다. ${spec.label} ${fmtWon(input.amount)} < 임계 ${fmtWon(limit)}.`;
          threshold = {
            amount: limit,
            formula: `${spec.base === 'totalAssets' ? '자산총액' : '자기자본'} ${fmtWon(base)} × ${spec.rate * 100}% = ${fmtWon(limit)}`,
            inputs: { base },
          };
          if (input.materialItem === 'guarantee') {
            notes.push('계약 등의 이행보증·납세보증을 위한 채무보증은 제외됩니다 (고시 제5조의2제1항제2호라목).');
            notes.push(
              '건설업을 영위하는 법인이 건설사업을 위하여 발주처 또는 입주예정자 등에게 채무를 보증하는 경우도 제외됩니다 — ' +
                '공정위 비상장사 매뉴얼(2026-04) "타인을 위한 채무보증 결정" 항목 기준이며, 이 제외의 고시 조문 원문은 이 도구가 ' +
                '확인하지 않았습니다(원문 미확인). 두 조건(건설업 영위 법인 · 건설사업을 위한 보증) 모두 해당해야 합니다.',
            );
          }
        }
        if (
          input.totalEquity !== undefined &&
          input.paidInCapital !== undefined &&
          input.totalEquity < input.paidInCapital
        ) {
          notes.push(
            '자기자본이 자본금에 미달하여 고시 제5조의2제3항에 따라 **자본금을 자기자본으로 보아** 계산했습니다.',
          );
        }
        notes.push(DECISION_DATE_NOTE);
        notes.push(CAPITAL_MARKET_OVERLAP_NOTE);
      }
    }
  } else if (omnibusEval) {
    verdict = omnibusEval.verdict;
    summary = omnibusEval.summary;
  } else if (deadline) {
    // 기한만 계산하는 유형 — 기한이 **실제로 계산된** 경우에만 required 라고 말한다.
    // ⚠️ 상품·용역 감소 특례는 "이미 의결·공시한 상품·용역 거래가 20% 이상 감소했다"는 **입력 전제** 위의 결론이다 —
    //    전제를 [전제] note 로 밝혀 review.assumptions 에 올린다 (기한 계산 성공 ≠ 특례 대상 확인).
    verdict = 'required';
    summary =
      input.duty === 'goods_services_reduced'
        ? '입력하신 전제(이미 이사회 의결·공시한 상품·용역 거래의 실제 거래금액이 의결금액보다 20% 이상 감소)라면 ' +
          '이사회 의결 없이 분기 종료 후 45일 이내에 실제 거래금액을 공시해야 합니다 (고시 제9조의2제2항).'
        : '해당 의무의 공시기한을 계산했습니다.';
  } else {
    // ★ 기한을 계산하지 못했는데 "required · 기한을 계산했습니다" 를 내면 그 문장 자체가 거짓이다.
    //   기한 전용 유형은 기한이 곧 이 도구의 답이므로, 못 구했으면 판정도 미확정이다.
    verdict = 'insufficient_data';
    summary = `공시기한을 계산할 수 없습니다 — ${missingLabelList(missingInputs, 'deadline')} 가 필요합니다.`;
  }
  if (input.duty === 'goods_services_reduced') {
    notes.push(
      '[전제] 이미 이사회 의결·공시한 상품·용역 대규모내부거래의 실제 거래금액이 의결금액보다 20% 이상 **감소**한 경우라는 ' +
        '전제입니다. 감소 후 금액이 기준금액 아래로 내려가도 실제 거래금액 공시는 해야 합니다 (공정위 문답 lit26-072: ' +
        '100억원 의결 후 실제 20억원 → "분기 종료 후 45일 이내에 실제 거래금액을 공시하여야 함"). 20% 이상 **증가**가 ' +
        '예상되면 이 특례가 아니라 분기 중에 미리 이사회 의결을 거친 후 공시합니다 (매뉴얼 11-2절).',
    );
  }

  // ── 기한 준수·과태료 ──
  // 약관특례(§9)·상품용역 감소(§9의2)는 대규모내부거래 고시의 특례이므로 위반 시 법 §26 체계다.
  // §27·§28 은 비상장사 중요사항·기업집단현황뿐이다. (Codex 교차검토가 잡은 오분류 수정)
  const regime: PenaltyRegime =
    input.duty === 'unlisted_material' || input.duty === 'group_status' ? 'art27_28' : 'art26_29';

  let compliance: DutyResult['compliance'];
  let penalty: unknown;

  // 대상이 아니라고 판정했으면 지연·과태료를 붙이지 않는다 — "대상 아님 + 20일 지연"은 모순이다
  // (Codex 3차 지적: 상장회사 not_required 응답에 지연·과태료가 동봉되던 실버그)
  // 이사회 의결 여부는 §26 계열 의결형 의무에서만 과태료 칸을 가른다. 약관특례(§9)·상품용역
  // 감소(§9의2)·하도급 결제조건은 의결 요건 자체가 없어 "의결 X" 칸이 성립하지 않는다 → true 고정.
  // 의결형 의무인데 입력이 없으면 undefined 로 넘겨 estimatePenalty 가 가정 caveat 를 붙인다 (P2-다 10).
  // 약관 금융거래는 경로에 따라 갈린다 — 계열 금융회사의 일상적 약관거래(제9조제1항)만 의결 요건이 없고,
  // 제9조제2항 경로·약관 아님은 의결이 필요하다. 경로 미확정이면 과태료 자체를 확정하지 않는다(아래 게이트).
  const boardResolutionDuty =
    input.duty === 'large_internal_transaction' ||
    input.duty === 'public_interest_corp' ||
    omnibusEval?.boardResolutionRequired === true;
  // 약관거래 경로 미확정·상품 속성 미확인이면 대표 기한은 조건부다 — 지연·과태료·자진시정을 확정하지 않는다.
  const conditionalDeadline =
    omnibusEval !== undefined &&
    (omnibusEval.path === 'undetermined' || omnibusEval.mainDeadlineConditional);
  // 의결형 의무에서 의결 없이 공시한 것은 **기한과 무관하게** 별도 위반이다 (별표9 "의결 X/공시" 칸).
  // 기한 내라고 "적법"이라 말하면 최악의 거짓 안심이 된다 (Codex 7차 치명 1)
  const noBoardResolution = boardResolutionDuty && input.boardResolution === false;

  if (deadline && input.actualDisclosureDate && conditionalDeadline) {
    notes.push(
      `⚠️ 실제 공시일(${input.actualDisclosureDate})의 기한 준수 여부를 확정하지 않았습니다 — 적용 기한이 ` +
        '입력되지 않은 사실(경로 또는 단기금융상품 여부)에 따라 달라집니다. omnibus.scenarios 의 ifDisclosedOn 에 ' +
        '경로·공시별 준수 여부를 조건부로 적었습니다.',
    );
  } else if (deadline && input.actualDisclosureDate && verdict !== 'not_required') {
    const c = evaluateCompliance(deadline.deadline, input.actualDisclosureDate);
    compliance = { ...c, actualDisclosureDate: input.actualDisclosureDate };
    summary +=
      ' ' +
      (c.onTime
        ? noBoardResolution
          ? `실제 공시 ${input.actualDisclosureDate} — 기한(${deadline.deadline}) 내이지만, ` +
            `**이사회 의결 없이 공시한 것 자체가 별도의 위반**입니다 (법 제26조, 별표 9 "의결 X/공시" 칸). ` +
            `기한 준수가 이 위반을 치유하지 않습니다.`
          : `실제 공시 ${input.actualDisclosureDate} — 입력한 날짜 기준으로 공시기한(${deadline.deadline})은 지켰습니다 ` +
            '(기한 준수만 판정한 것입니다 — 공시 내용의 누락·거짓, 사전 이사회 의결의 적법성은 판정하지 않았습니다).'
        : `실제 공시 ${input.actualDisclosureDate} — 기한(${deadline.deadline}) 대비 **${c.delayDays}일 지연**입니다.` +
          (noBoardResolution ? ' 이사회 의결 없이 공시한 위반도 별도로 성립합니다 (별표 9 "의결 X" 칸).' : ''));

    if ((!c.onTime || noBoardResolution) && (input.estimatePenaltyIfLate ?? true)) {
      const capitalInputs = [input.totalEquity, input.paidInCapital].filter((x) => x !== undefined);
      penalty = estimatePenalty({
        regime,
        boardResolution: boardResolutionDuty ? input.boardResolution : true,
        disclosed: true,
        onTime: c.onTime,
        delayDays: c.delayDays,
        // 거래금액별 적용비율(고시 Ⅵ.2)은 §26·§29 전용이다. 그 게이트는 estimatePenalty 안에 있으므로
        // 여기서는 그대로 넘긴다 — §27·§28(비상장사 중요사항·기업집단현황)에서는 무시된다.
        ...(input.amount !== undefined ? { transactionAmount: input.amount } : {}),
        capitalBase:
          capitalInputs.length > 0
            ? Math.max(input.totalEquity ?? 0, input.paidInCapital ?? 0)
            : undefined,
        // 한쪽만 주면 max() 가 과소평가될 수 있다 — 소기업 상한 오적용 caveat 용 (P2-다 12)
        ...(capitalInputs.length === 1 ? { capitalBaseIncomplete: true } : {}),
      });
    }
  } else if (noBoardResolution && verdict === 'required') {
    // 공시 전이라도 의결 없는 진행은 경고한다 — 의결부터가 의무의 일부다
    notes.push(
      '⚠️ 이사회 의결 없이 진행 중이라고 입력하셨습니다. 대규모내부거래는 **사전 이사회 의결 + 공시**가 ' +
        '모두 의무입니다 (법 제26조) — 의결 없이 공시하면 기한을 지켜도 별표 9 "의결 X" 칸의 과태료 대상입니다.',
    );
  }

  // ── 날짜 없이 "N일 늦었다"만 알 때 — 조건부 과태료 (지연일수 입력) ──
  let delayScenario: DelayScenarioOutput | undefined;
  if (input.delayDays !== undefined && (input.estimatePenaltyIfLate ?? true)) {
    if (verdict === 'not_required') {
      notes.push(`지연 ${input.delayDays}일을 입력하셨지만 공시 대상이 아니라고 판정했으므로 지연도 과태료도 없습니다.`);
    } else {
      const capitalInputs = [input.totalEquity, input.paidInCapital].filter((x) => x !== undefined);
      const dateBased =
        compliance && deadline
          ? {
              calendarDays: compliance.delayDays,
              businessDays: compliance.onTime ? 0 : -businessDaysRemaining(compliance.actualDisclosureDate, deadline.deadline),
              source: `기한 ${deadline.deadline} → 공시 ${compliance.actualDisclosureDate}`,
            }
          : undefined;
      const boardRequired: boolean | 'undetermined' =
        input.duty === 'large_internal_transaction' || input.duty === 'public_interest_corp'
          ? true
          : input.duty === 'omnibus_financial'
            ? (omnibusEval?.boardResolutionRequired ?? 'undetermined')
            : false;
      const d = evaluateDelayScenario({
        delayDays: input.delayDays,
        basis: input.delayDayBasis,
        filingState: input.delayFilingState,
        regime,
        boardRequired,
        boardResolution: input.boardResolution,
        transactionAmount: input.amount,
        capitalBase: capitalInputs.length > 0 ? Math.max(input.totalEquity ?? 0, input.paidInCapital ?? 0) : undefined,
        capitalBaseIncomplete: capitalInputs.length === 1,
        dateBased,
        dutyUnconfirmed: verdict === 'insufficient_data',
      });
      delayScenario = d.output;
      notes.push(...d.notes);
      if (d.output.status === 'computed' && d.output.scenarios?.length) {
        summary +=
          ` 입력하신 지연 ${input.delayDays}일 기준 예상 과태료(조건부 — delayScenario): ` +
          d.output.scenarios.map((sc) => `${sc.label} ${formatPenaltyWon(sc.penalty.amount)}`).join(' / ') +
          '.';
      }
    }
  }

  const deadlineOut = deadline
    ? { ...deadline, dDay: businessDaysRemaining(today, deadline.deadline) }
    : undefined;

  if (deadline?.warnings.length) notes.push(...deadline.warnings);

  // ── 자진시정 골든타임 ──
  // 리서치 결론의 포지셔닝: "위반 통보"가 아니라 "면제 골든타임 내 구조".
  //
  // Codex 교차검토 반영 2건:
  //  - actualDisclosureDate 생략은 "아직 미공시"가 아니다 (기한만 조회하는 호출이 흔하다)
  //    → disclosureStatus:'not_disclosed' 명시 + verdict가 required 로 확정된 경우에만 부착한다.
  //  - 최초 공시를 늦게 낸 것은 고시 Ⅴ의 "스스로 시정하여 다시 공시"가 아니다
  //    → 지연 공시 사후 판정에는 골든타임을 부착하지 않는다 (면제 요건은 penalty disclaimer가 안내).
  let selfCorrection: DutyResult['selfCorrection'];
  const deadlinePassed = deadline && toDate(today) > toDate(deadline.deadline);
  if (deadline && deadlinePassed && !input.actualDisclosureDate && verdict === 'required' && !conditionalDeadline) {
    if (input.disclosureStatus === 'not_disclosed') {
      selfCorrection = selfCorrectionWindow(deadline.deadline, regime, today);
      if (selfCorrection.status === 'open') {
        notes.push(
          `⚠️ 공시기한(${deadline.deadline})이 지났고 아직 공시 전입니다. ` +
            `자진시정 골든타임이 ${selfCorrection.windowEnd}까지 열려 있습니다` +
            (selfCorrection.isLastDay
              ? ' — **오늘이 마지막 날입니다**. '
              : ` (남은 영업일 ${selfCorrection.businessDaysRemaining}일). `) +
            `selfCorrection 의 면제 사유와 주의사항을 확인하고 즉시 공시하세요.`,
        );
      } else {
        // 감경 구간(지연 30일 이하)이 실제로 남아 있을 때만 감경을 언급한다
        const delaySoFar = evaluateCompliance(deadline.deadline, today).delayDays;
        notes.push(
          `공시기한(${deadline.deadline})과 자진시정 10영업일(${selfCorrection.windowEnd})이 모두 지났습니다. ` +
            (delaySoFar <= 30
              ? `현재 지연 ${delaySoFar}일 — 지연일수 감경 구간(30일 이하, 달력일 기준)이 아직 남아 있으므로 즉시 공시가 손실을 최소화합니다.`
              : `현재 지연 ${delaySoFar}일로 지연일수 감경 구간(30일 이하)도 지났습니다. ` +
                `그래도 기한초과 과태료는 일수 가산에 상한이 있어 미공시 상태보다 불리하지 않습니다 — 즉시 공시해 위반 상태를 해소하세요.`),
        );
      }
    } else {
      notes.push(
        `공시기한(${deadline.deadline})이 이미 지났습니다. 아직 공시 전이라면 disclosureStatus:"not_disclosed" 로 ` +
          `다시 호출하세요 — 자진시정 골든타임(기한 만료 익일부터 10영업일)과 면제 사유를 계산해 드립니다.`,
      );
    }
  }

  // ── 유사 공정위 공식 Q&A 동봉 ──
  // 규칙 엔진은 금액·기한만 판정한다. "이 거래가 애초에 대상인가"(특수관계인 여부·거래 성격)는
  // 규칙으로 환원되지 않는 경계사례가 많아, 상황 서술이 오면 공정위 공식 답변을 근거로 붙인다.
  let relatedOfficialQna: DutyResult['relatedOfficialQna'];
  if (input.situation) {
    // 지식베이스 문제(파일 손상 등)가 본 판정을 죽이면 안 된다 — Q&A 첨부는 부가 기능이다
    let matches: ReturnType<typeof searchQna> = [];
    try {
      matches = searchQna(input.situation, {
        category: DUTY_TO_QNA_CATEGORY[input.duty],
        limit: 3,
      });
    } catch (err) {
      notes.push(
        `공정위 Q&A 지식베이스 검색에 실패해 relatedOfficialQna 를 첨부하지 못했습니다 ` +
          `(${err instanceof Error ? err.name : 'unknown'}). 판정 결과 자체는 유효합니다.`,
      );
    }
    if (matches.length) {
      relatedOfficialQna = matches.map((m) => ({
        question: m.entry.question,
        answer: m.entry.answer,
        source: { doc: m.entry.doc, docYear: m.entry.docYear, url: m.entry.url },
        caveats: m.entry.caveats,
      }));
      notes.push(
        '상황 서술과 유사한 공정위 공식 Q&A를 relatedOfficialQna 로 첨부했습니다. ' +
          '옛 문서의 답변은 caveats(폐지된 기준금액·기한)를 함께 읽어야 하며, 현행 수치는 본 판정 결과가 우선합니다. ' +
          '더 찾으려면 search_ftc_qna 를 사용하세요.',
      );
    }
  }

  // ── 부분 판정 계약 ──
  // 대상 판정(duty)과 기한(deadline)의 상태를 **따로** 보고한다. 한쪽이 미확정이어도
  // 다른 쪽 결과는 그대로 유효하다는 것을 모델·사용자가 필드로 확인할 수 있어야 한다.
  const deadlineOnlyDuty = input.duty === 'goods_services_reduced' || input.duty === 'group_status';
  const deadlineStatus: ComponentStatus = deadline ? 'evaluated' : 'insufficient_data';
  const dutyStatus: ComponentStatus = omnibusEval
    ? // 약관거래의 "대상 판정" = 경로(의결 필요 여부) 판정이다
      omnibusEval.path === 'undetermined'
      ? 'insufficient_data'
      : 'evaluated'
    : deadlineOnlyDuty
      ? 'not_applicable'
      : verdict === 'insufficient_data'
        ? 'insufficient_data'
        : 'evaluated';
  const components: DutyComponents = {
    duty: { status: dutyStatus, missing_fields: missingFieldsFor(missingInputs, 'duty') },
    deadline: { status: deadlineStatus, missing_fields: missingFieldsFor(missingInputs, 'deadline') },
  };

  // 대상 판정이 미확정인데 지연·과태료를 계산했다 — 게이트(verdict !== 'not_required')와 금액·산식은
  // 그대로 두고 **조건**만 밝힌다 (Fable goal 레인 발견 2).
  if (verdict === 'insufficient_data' && (compliance !== undefined || penalty !== undefined)) {
    notes.push(
      '※ 대상 판정이 확정되지 않았습니다(verdict=insufficient_data). compliance·penalty 는 ' +
        '**공시 대상으로 확정될 경우**의 값입니다 — 대상이 아니면 지연도 과태료도 없습니다. ' +
        '기한·지연일수·산식 계산 자체는 입력대로입니다.',
    );
  }

  // 실제 공시일을 줬는데 기한을 못 구한 경우 — 준수 여부를 만들지 않았다는 사실을 밝힌다.
  // (가짜 기한·가짜 지연일을 만들지 않는다. today 로 의결일을 대신하지도 않는다.)
  if (!deadline && input.actualDisclosureDate) {
    notes.push(
      `actualDisclosureDate(${input.actualDisclosureDate})를 받았지만 기한을 계산하지 못해 ` +
        '준수 여부·지연일수·과태료를 산정하지 않았습니다 — "기한 내"도 "지연"도 아닙니다. ' +
        `${missingLabelList(missingInputs, 'deadline')} 를 주면 판정합니다.`,
    );
  }

  const review = buildReview({
    duty: input.duty,
    verdict,
    summary,
    components,
    missingInputs,
    notes,
    ...(threshold?.formula ? { thresholdFormula: threshold.formula } : {}),
    ...(threshold?.amountBasisNote ? { amountBasisNote: threshold.amountBasisNote } : {}),
    ...(deadlineOut
      ? {
          deadline: {
            deadline: deadlineOut.deadline,
            rule: deadlineOut.rule,
            ...(deadlineOut.dDay !== undefined ? { dDay: deadlineOut.dDay } : {}),
            legalBasis: deadlineOut.legalBasis,
          },
        }
      : {}),
    ...(compliance ? { compliance } : {}),
    ...(isPenaltyResult(penalty)
      ? {
          penalty: {
            amount: penalty.amount,
            formula: penalty.formula,
            isUpperBound: penalty.isUpperBound,
          },
        }
      : {}),
    ...(selfCorrection
      ? {
          selfCorrection: {
            status: selfCorrection.status,
            windowEnd: selfCorrection.windowEnd,
            ...(selfCorrection.businessDaysRemaining !== undefined
              ? { businessDaysRemaining: selfCorrection.businessDaysRemaining }
              : {}),
          },
        }
      : {}),
    ...(relatedOfficialQna ? { relatedQnaCount: relatedOfficialQna.length } : {}),
    hasSituation: input.situation !== undefined,
  });

  return {
    duty: input.duty,
    verdict,
    summary,
    missing_inputs: missingInputs,
    components,
    review,
    ...(threshold ? { threshold } : {}),
    ...(deadlineOut ? { deadline: deadlineOut } : {}),
    ...(compliance ? { compliance } : {}),
    ...(penalty ? { penalty } : {}),
    ...(selfCorrection ? { selfCorrection } : {}),
    ...(relatedOfficialQna ? { relatedOfficialQna } : {}),
    ...(delayScenario ? { delayScenario } : {}),
    ...(omnibusEval
      ? {
          omnibus: {
            path: omnibusEval.path,
            pathReason: omnibusEval.pathReason,
            boardResolutionRequired: omnibusEval.boardResolutionRequired,
            ...(omnibusEval.mainFiling ? { mainFiling: omnibusEval.mainFiling } : {}),
            mainDeadlineConditional: omnibusEval.mainDeadlineConditional,
            scenarios: omnibusEval.scenarios,
          },
        }
      : {}),
    notes,
    disclaimer: DISCLAIMER,
  };
}

/** penalty 는 `unknown` 으로 들고 다니므로 검토 메모에 옮길 때 형태를 확인한다 */
function isPenaltyResult(
  x: unknown,
): x is { amount: number; formula: string; isUpperBound: boolean } {
  if (!x || typeof x !== 'object') return false;
  const p = x as Record<string, unknown>;
  return (
    typeof p['amount'] === 'number' &&
    typeof p['formula'] === 'string' &&
    typeof p['isUpperBound'] === 'boolean'
  );
}

const fmtWon = formatWon;
