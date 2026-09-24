/**
 * 약관에 의한 금융거래 특례(고시 제9조) — 경로 판정·기한 계산
 *
 * ★ 종전 구현은 "약관 금융거래 = 이사회 의결 불요 + 분기 모아 익월 10영업일" 로 **한 경로만** 알았다.
 *   원문은 경로가 셋이다 (대규모내부거래 고시 제9조, 공정위 매뉴얼 2026-04 11-1절):
 *
 *   A. 제9조제1항·제3항 — 금융·보험회사**이면서** 해당 회사가 영위하는 금융·보험업의 **일상적 거래분야**에서
 *      약관에 따라 하는 거래 → 이사회 의결 생략 가능 + 분기 종료 후 익월 10영업일까지 공시(의무).
 *   B. 제9조제2항·제4항·제5항 — A 에 해당하지 않는 사유로 **계열 금융회사**와 하는 약관거래
 *      (비금융사 전부 + 금융사의 일상업무 밖 거래 — 매뉴얼 "C사의 일상적인 거래분야에서의 거래행위가 아니라면")
 *      → 이사회 의결은 **필요**하다. 건별로 하거나 분기별 일괄(수익증권은 1년 이내 기간) 사전 의결을 "할 수 있다".
 *      공시는 두 번이다: 사전 의결내용 공시(의결 후 상장 3·비상장 7영업일) + 실제 거래내역 공시(거래 후 3·7영업일).
 *      실제 거래내역만, 만기·중도환매수수료 없고 수시입출금 가능한 단기금융상품이면 분기 일괄(익월 10영업일) "할 수 있다".
 *   C. 약관거래가 아님(당사자 협의로 조건을 정함·사모사채 인수 등 특정 조건 부기) → 특례 없음, 일반 대규모내부거래 절차.
 *
 * ⚠️ 경로를 가르는 사실이 입력되지 않으면 **"의결 불요"를 단정하지 않는다** — 경로별 조건부 결과만 준다.
 *    상품 속성(제9조제5항 세 요건)이 미확인이면 3·7영업일 기준으로 지연·과태료를 **확정하지 않는다**.
 */

import {
  omnibusQuarterlyDeadline,
  omnibusResolutionDeadline,
  omnibusTransactionDeadline,
  litDeadline,
  evaluateCompliance,
  quarterEndOf,
} from '../../rules/deadlines.js';
import { toDate } from '../../rules/business-days.js';
import type { DeadlineResult, ListingStatus, Verdict, YMD } from '../../rules/types.js';

export type OmnibusPath = 'financial_routine' | 'affiliate_terms' | 'not_standard_terms' | 'undetermined';
export type OmnibusFilingKind = 'resolution' | 'transaction';

export interface OmnibusInput {
  isFinancialCompany?: boolean | undefined;
  routineFinancialBusiness?: boolean | undefined;
  standardTermsContract?: boolean | undefined;
  beneficiaryCertificate?: boolean | undefined;
  shortTermDemandProduct?: boolean | undefined;
  listing?: ListingStatus | undefined;
  boardDate?: YMD | undefined;
  transactionDate?: YMD | undefined;
  quarterEnd?: YMD | undefined;
  omnibusFiling?: OmnibusFilingKind | undefined;
  actualDisclosureDate?: YMD | undefined;
}

export interface OmnibusFiling {
  kind: 'resolution' | 'transaction' | 'quarterly_mandatory' | 'quarterly_option' | 'general_resolution';
  label: string;
  /** 이 공시가 적용되는 조건 */
  condition: string;
  deadline?: DeadlineResult;
  /** 기한 계산에 부족한 입력 */
  missing?: string[];
  /** 실제 공시일을 이 공시로 볼 때의 준수 여부 (조건부 참고) */
  ifDisclosedOn?: { actualDisclosureDate: YMD; onTime: boolean; delayDays: number };
}

export interface OmnibusScenario {
  path: Exclude<OmnibusPath, 'undetermined'>;
  label: string;
  condition: string;
  boardResolution: string;
  filings: OmnibusFiling[];
}

export interface OmnibusEvaluation {
  path: OmnibusPath;
  pathReason: string;
  /** 이 거래에 이사회 의결이 필요한가 — 과태료 칸(의결 O/X)도 이것으로 가른다 */
  boardResolutionRequired: boolean | 'undetermined';
  verdict: Verdict;
  summary: string;
  scenarios: OmnibusScenario[];
  /** 준수 판정·D-day 에 쓸 대표 기한 (없으면 undefined) */
  mainDeadline?: DeadlineResult;
  mainFiling?: OmnibusFiling['kind'];
  /**
   * true 면 mainDeadline 이 **조건부**다 — 지연·과태료·자진시정을 확정하면 안 된다
   * (예: 단기금융상품 여부 미확인이라 분기 일괄 선택지가 열려 있을 수 있음).
   */
  mainDeadlineConditional: boolean;
  /** 공시일 하한 검증용 기준일 */
  eventDate?: { date: YMD; label: string };
  missing: Array<{ field: string; purpose: 'duty' | 'deadline'; label: string }>;
  notes: string[];
  /** 제공한 값끼리 모순 — invalid_argument 로 돌려준다 */
  error?: string;
}

const LISTING_LABEL = 'listing(상장 여부 — 상장 3영업일 / 비상장 7영업일)';

const PREMISE_NOTE =
  '[전제] 약관 금융거래 특례는 대규모내부거래(상대방이 특수관계인 — 국외 계열회사 제외 — 이고, 거래 1건 금액이 ' +
  '기준금액 min(100억원, max(5억원, 자본총계·자본금 중 큰 금액×5%)) 이상)에 대한 절차 특례입니다. 기준금액 미만 ' +
  '거래는 특례 이전에 대규모내부거래가 아닙니다 — 금액 판정은 duty:"large_internal_transaction" 으로 하세요. ' +
  '(분기 일괄 의결의 거래한도는 금융상품별로 기준금액을 넘는 예상 거래를 누적 합산하고, MMF 등 초단기수익증권은 ' +
  '잔고 기준입니다 — 공정위 문답 lit26-023.)';

function withCompliance(f: OmnibusFiling, actual: YMD | undefined): OmnibusFiling {
  if (!f.deadline || !actual) return f;
  const c = evaluateCompliance(f.deadline.deadline, actual);
  return { ...f, ifDisclosedOn: { actualDisclosureDate: actual, ...c } };
}

/** 경로를 가르는 사실로 경로를 정한다 — 입력이 없으면 undetermined (추측하지 않는다) */
function determinePath(i: OmnibusInput): {
  path: OmnibusPath;
  reason: string;
  missing: OmnibusEvaluation['missing'];
  notes: string[];
} {
  const notes: string[] = [];
  if (i.standardTermsContract === false) {
    return {
      path: 'not_standard_terms',
      reason:
        '약관에 따른 거래가 아니라고 입력했습니다(거래조건을 당사자가 협의로 정하거나 사모사채 인수 등 특정 조건을 부기) — ' +
        '고시 제9조 특례가 적용되지 않습니다.',
      missing: [],
      notes,
    };
  }
  if (i.isFinancialCompany === true && i.routineFinancialBusiness === true) {
    return {
      path: 'financial_routine',
      reason:
        '금융·보험회사가 해당 회사가 영위하는 금융·보험업의 일상적 거래분야에서 약관에 따라 하는 거래 — 고시 제9조제1항.',
      missing: [],
      notes,
    };
  }
  if (i.isFinancialCompany === false) {
    if (i.routineFinancialBusiness === true) {
      notes.push(
        '⚠️ 금융·보험회사가 아니라고 입력하면서 "일상적 금융·보험업무"라고도 입력했습니다. 제9조제1항 특례는 ' +
          '금융·보험업 영위 회사에만 있으므로 금융·보험회사가 아닌 쪽으로 판정했습니다 — 회사 업종을 다시 확인하세요.',
      );
    }
    return {
      path: 'affiliate_terms',
      reason: '금융·보험회사가 아닌 회사가 계열 금융회사와 하는 약관거래 — 고시 제9조제2항.',
      missing: [],
      notes,
    };
  }
  if (i.isFinancialCompany === true && i.routineFinancialBusiness === false) {
    return {
      path: 'affiliate_terms',
      reason:
        '금융·보험회사이지만 자기 금융·보험업의 일상적 거래분야가 아닌 약관거래 — 제9조제1항에 해당하지 않아 제9조제2항 ' +
        '(매뉴얼: "C사의 일상적인 거래분야에서의 거래행위가 아니라면 거래건별로 이사회의결 및 공시하거나 금융·보험사가 ' +
        '아닌 회사에 대한 특례를 적용할 수도 있음").',
      missing: [],
      notes,
    };
  }
  const missing: OmnibusEvaluation['missing'] = [];
  if (i.isFinancialCompany === undefined) {
    missing.push({
      field: 'isFinancialCompany',
      purpose: 'duty',
      label:
        '공시하는 회사가 금융업·보험업 영위 회사인지 — 금융·보험회사의 일상적 약관거래만 이사회 의결을 생략할 수 있습니다 ' +
        '(고시 제9조제1항). 금융·보험회사가 아니면 사전 의결이 필요합니다(제9조제2항)',
    });
  }
  if (i.routineFinancialBusiness === undefined) {
    missing.push({
      field: 'routineFinancialBusiness',
      purpose: 'duty',
      label:
        '금융·보험회사라면, 이 거래가 그 회사가 영위하는 금융·보험업(표준산업분류 K64~66)의 일상적 거래분야(영업 중 비중·' +
        '빈도가 높은 거래)인지 — 아니면 제9조제2항 경로로 사전 의결이 필요합니다',
    });
  }
  return {
    path: 'undetermined',
    reason: '경로를 가르는 사실(금융·보험회사 여부, 일상적 금융·보험업무 여부)이 입력되지 않았습니다.',
    missing,
    notes,
  };
}

/** 경로 A 의 공시 목록 */
function financialRoutineFilings(qe: YMD | undefined, actual: YMD | undefined): OmnibusFiling[] {
  return [
    withCompliance(
      {
        kind: 'quarterly_mandatory',
        label: '분기별 거래내역 공시 (의무)',
        condition: '계열 금융회사의 일상적 금융·보험업무 약관거래 (제9조제3항)',
        ...(qe ? { deadline: omnibusQuarterlyDeadline(qe, 'financial_routine') } : { missing: ['quarterEnd 또는 transactionDate'] }),
      },
      actual,
    ),
  ];
}

/** 경로 B 의 공시 목록 */
function affiliateTermsFilings(i: OmnibusInput, qe: YMD | undefined): OmnibusFiling[] {
  const actual = i.actualDisclosureDate;
  const out: OmnibusFiling[] = [];
  const resMissing: string[] = [];
  if (!i.boardDate) resMissing.push('boardDate(사전 의결일)');
  if (!i.listing) resMissing.push(LISTING_LABEL);
  out.push(
    withCompliance(
      {
        kind: 'resolution',
        label: '사전 의결내용 공시 (건별 또는 분기별 일괄 의결 후)',
        condition:
          '의결 후 공시 — 분기별 일괄 의결 시 의결내용에 거래한도·거래대상·거래조건 등 주요내용 포함 (제9조제2항 후단). ' +
          '공시 절차·기한은 제9조제6항이 제6조제1항~제4항을 준용',
        ...(i.boardDate && i.listing
          ? { deadline: omnibusResolutionDeadline(i.boardDate, i.listing) }
          : { missing: resMissing }),
      },
      actual,
    ),
  );
  const txMissing: string[] = [];
  if (!i.transactionDate) txMissing.push('transactionDate(실제 거래일)');
  if (!i.listing) txMissing.push(LISTING_LABEL);
  out.push(
    withCompliance(
      {
        kind: 'transaction',
        label: '실제 거래내역 공시 (원칙)',
        condition: '분기 중 실제 거래를 하면 거래 후 공시 (제9조제4항 — 비상장은 7영업일 "할 수 있다")',
        ...(i.transactionDate && i.listing
          ? { deadline: omnibusTransactionDeadline(i.transactionDate, i.listing) }
          : { missing: txMissing }),
      },
      actual,
    ),
  );
  if (i.shortTermDemandProduct !== false) {
    out.push(
      withCompliance(
        {
          kind: 'quarterly_option',
          label: '실제 거래내역 분기 일괄 공시 (선택)',
          condition:
            (i.shortTermDemandProduct === true ? '' : '[조건부 — 상품 속성 미확인] ') +
            '만기와 중도환매수수료가 없고 수시입출금이 가능한 단기금융상품의 거래일 때만 — 실제 거래내역 공시에만 ' +
            '적용되며 사전 의결내용 공시를 분기 말로 미루는 뜻이 아닙니다 (제9조제5항)',
          ...(qe
            ? { deadline: omnibusQuarterlyDeadline(qe, 'short_term_option') }
            : { missing: ['quarterEnd 또는 transactionDate'] }),
        },
        actual,
      ),
    );
  }
  return out;
}

function affiliateBoardText(i: OmnibusInput): string {
  const base =
    '이사회 의결 **필요** — 건별 사전 의결·공시, 또는 분기별로 일괄하여 사전 의결을 "할 수 있다" (제9조제2항). ' +
    '분기 일괄 의결은 최소한 분기 단위여야 합니다(공정위 문답 lit26-029).';
  if (i.beneficiaryCertificate === true) {
    return base + ' 수익증권(자본시장법) 거래이므로 1년 이내의 거래기간을 정해 그 기간의 거래를 일괄 의결할 수 있습니다 (제9조제2항 단서).';
  }
  if (i.beneficiaryCertificate === undefined) {
    return base + ' 자본시장법상 수익증권 거래라면 1년 이내의 거래기간을 정해 일괄 의결할 수 있습니다 (제9조제2항 단서) — 그 밖의 상품은 분기 단위.';
  }
  return base;
}

export function evaluateOmnibus(i: OmnibusInput): OmnibusEvaluation {
  const notes: string[] = [];
  const det = determinePath(i);
  notes.push(...det.notes);

  // 분기말은 입력값을 쓰고, 없으면 거래일이 속한 분기에서 **계산**한다 (추정이 아니라 달력 계산).
  // 둘 다 주었는데 거래일이 그 분기에 없으면 모순이다 — 조용히 한쪽을 고르지 않는다.
  let qe = i.quarterEnd;
  if (i.transactionDate) {
    const derived = quarterEndOf(i.transactionDate);
    if (qe && qe !== derived) {
      return {
        path: det.path,
        pathReason: det.reason,
        boardResolutionRequired: 'undetermined',
        verdict: 'insufficient_data',
        summary: '',
        scenarios: [],
        mainDeadlineConditional: false,
        missing: [],
        notes,
        error:
          `transactionDate(${i.transactionDate})가 quarterEnd(${qe}) 분기에 속하지 않습니다 — 거래일이 속한 분기 종료일은 ` +
          `${derived}입니다. 둘 중 어느 값이 맞는지 확인하세요.`,
      };
    }
    qe = qe ?? derived;
  }

  const actual = i.actualDisclosureDate;
  const scenarioA: OmnibusScenario = {
    path: 'financial_routine',
    label: '경로 A — 계열 금융회사의 일상적 약관거래 (제9조제1항·제3항)',
    condition: '공시하는 회사가 금융·보험회사이고, 그 회사가 영위하는 금융·보험업의 일상적 거래분야에서 약관에 따라 하는 거래',
    boardResolution:
      '이사회 의결을 거치지 아니할 수 있음 (제9조제1항). 단, 당사자간 계약에 의한 사모사채 인수 등 특정 거래조건을 부기한 ' +
      '금융거래는 의결을 거쳐야 함 (같은 항 단서).',
    filings: financialRoutineFilings(qe, actual),
  };
  const scenarioB: OmnibusScenario = {
    path: 'affiliate_terms',
    label: '경로 B — 그 밖의 계열 금융회사와의 약관거래 (제9조제2항·제4항·제5항)',
    condition:
      '금융·보험회사가 아닌 회사의 약관거래, 또는 금융·보험회사라도 자기 일상적 금융·보험업무가 아닌 약관거래 ' +
      '(상대방이 계열 금융회사 — 금융·보험업 영위 내부거래공시대상회사 — 인 경우)',
    boardResolution: affiliateBoardText(i),
    filings: affiliateTermsFilings(i, qe),
  };
  const scenarioC: OmnibusScenario = {
    path: 'not_standard_terms',
    label: '경로 C — 약관거래가 아님 (특례 없음)',
    condition:
      '거래조건을 당사자가 협의로 정한 거래(매뉴얼: "거래당사자가 협의하여 거래조건을 정하는 경우는 약관에 의한 거래에 ' +
      '해당하지 않음") 또는 사모사채 인수 등 특정 거래조건을 부기한 금융거래',
    boardResolution: '일반 대규모내부거래 절차 — 거래 전 건별 이사회 의결 (법 제26조제1항)',
    filings: [
      withCompliance(
        {
          kind: 'general_resolution',
          label: '의결 후 공시 (일반 절차)',
          condition: '고시 제6조제1항 — 의결 후 상장 3영업일 / 비상장·공익법인 7영업일',
          ...(i.boardDate && i.listing
            ? { deadline: litDeadline(i.boardDate, i.listing) }
            : {
                missing: [
                  ...(i.boardDate ? [] : ['boardDate(이사회 의결일)']),
                  ...(i.listing ? [] : [LISTING_LABEL]),
                ],
              }),
        },
        actual,
      ),
    ],
  };

  const missing = [...det.missing];
  let verdict: Verdict = 'insufficient_data';
  let summary = '';
  let boardResolutionRequired: OmnibusEvaluation['boardResolutionRequired'] = 'undetermined';
  let scenarios: OmnibusScenario[] = [];
  let mainDeadline: DeadlineResult | undefined;
  let mainFiling: OmnibusFiling['kind'] | undefined;
  let mainDeadlineConditional = false;

  switch (det.path) {
    case 'financial_routine': {
      scenarios = [scenarioA];
      boardResolutionRequired = false;
      verdict = 'required';
      const f = scenarioA.filings[0]!;
      if (f.deadline) {
        mainDeadline = f.deadline;
        mainFiling = f.kind;
      } else {
        missing.push({
          field: 'quarterEnd',
          purpose: 'deadline',
          label: '분기 종료일(또는 transactionDate 실제 거래일) — 3/31·6/30·9/30·12/31 중 하나 (2분기는 7월 말이 아닙니다)',
        });
      }
      summary =
        '계열 금융회사의 일상적 금융·보험업무 약관거래로 입력하셨습니다 — 이사회 의결을 거치지 않을 수 있고(고시 제9조제1항), ' +
        '분기별로 해당 분기 종료 후 익월 10영업일까지 거래내역을 공시해야 합니다(제9조제3항).';
      break;
    }
    case 'affiliate_terms': {
      scenarios = [scenarioB];
      boardResolutionRequired = true;
      verdict = 'required';
      summary =
        '계열 금융회사와의 약관거래(고시 제9조제2항 경로)입니다 — **이사회 의결이 필요합니다**. 매 거래마다가 아니라 분기별로 ' +
        '일괄하여 사전 의결할 수 있고(수익증권은 1년 이내 기간), 의결내용을 의결 후 상장 3·비상장 7영업일 이내에 공시한 뒤, ' +
        '실제 거래를 하면 거래 후 상장 3·비상장 7영업일 이내에 거래내역을 다시 공시합니다(제9조제4항). ' +
        '만기·중도환매수수료가 없고 수시입출금이 가능한 단기금융상품이면 실제 거래내역은 분기 종료 후 익월 10영업일까지 ' +
        '분기 일괄 공시할 수 있습니다(제9조제5항).';
      const byKind = new Map(scenarioB.filings.map((f) => [f.kind, f]));
      const res = byKind.get('resolution');
      const tx = byKind.get('transaction');
      const opt = byKind.get('quarterly_option');
      // 실제 거래내역 공시의 "지켜야 할 마지막 날" — 단기금융상품이 확정이면 분기 일괄 선택지까지 허용된다.
      const txEffective: { d?: DeadlineResult; kind: OmnibusFiling['kind']; conditional: boolean } =
        i.shortTermDemandProduct === true && opt?.deadline
          ? { d: opt.deadline, kind: 'quarterly_option', conditional: false }
          : { ...(tx?.deadline ? { d: tx.deadline } : {}), kind: 'transaction', conditional: i.shortTermDemandProduct === undefined };

      let pick: OmnibusFilingKind | undefined = i.omnibusFiling;
      if (!pick) {
        const hasRes = Boolean(res?.deadline);
        const hasTx = Boolean(txEffective.d);
        if (hasRes && !hasTx) pick = 'resolution';
        else if (!hasRes && hasTx) pick = 'transaction';
        else if (hasRes && hasTx) {
          if (actual) {
            missing.push({
              field: 'omnibusFiling',
              purpose: 'deadline',
              label:
                'actualDisclosureDate 가 어느 공시인지 — resolution(사전 의결내용 공시) / transaction(실제 거래내역 공시). ' +
                '둘의 기한이 달라 추측하지 않습니다',
            });
          } else {
            // 공시일 판정이 없으면 D-day 용으로 더 이른 기한을 대표로 보인다 (둘 다 scenarios 에 있다).
            pick = toDate(res!.deadline!.deadline) <= toDate(txEffective.d!.deadline) ? 'resolution' : 'transaction';
          }
        }
        if (pick) {
          notes.push(
            `대표 기한(deadline)은 ${pick === 'resolution' ? '사전 의결내용 공시' : '실제 거래내역 공시'} 기준입니다 — ` +
              '이 경로의 다른 공시 기한은 omnibus.scenarios 에 있습니다' +
              (actual ? ' (actualDisclosureDate 를 이 공시로 보고 판정했습니다 — 다른 공시라면 omnibusFiling 을 지정하세요).' : '.'),
          );
        }
      }
      if (pick === 'resolution') {
        if (res?.deadline) {
          mainDeadline = res.deadline;
          mainFiling = 'resolution';
        } else {
          missing.push(
            ...(!i.boardDate
              ? [{ field: 'boardDate', purpose: 'deadline' as const, label: '사전(분기 일괄 또는 건별) 이사회 의결일 — 의결내용 공시기한의 기산일' }]
              : []),
          );
        }
      } else if (pick === 'transaction') {
        if (txEffective.d) {
          mainDeadline = txEffective.d;
          mainFiling = txEffective.kind;
          // 원칙 기한(3·7영업일) 안에 공시했다면 단기금융상품 여부와 무관하게 기한 내다 — 조건부로 둘 이유가 없다.
          mainDeadlineConditional =
            txEffective.conditional &&
            !(actual !== undefined && evaluateCompliance(txEffective.d.deadline, actual).onTime);
        } else {
          missing.push(
            ...(!i.transactionDate
              ? [{ field: 'transactionDate', purpose: 'deadline' as const, label: '실제 거래일 — 거래내역 공시기한(거래 후 3·7영업일)의 기산일' }]
              : []),
          );
        }
      } else if (!res?.deadline && !tx?.deadline) {
        if (!i.boardDate) {
          missing.push({ field: 'boardDate', purpose: 'deadline', label: '사전(분기 일괄 또는 건별) 이사회 의결일 — 의결내용 공시기한의 기산일' });
        }
        if (!i.transactionDate) {
          missing.push({ field: 'transactionDate', purpose: 'deadline', label: '실제 거래일 — 거래내역 공시기한(거래 후 3·7영업일)의 기산일' });
        }
      }
      if (!i.listing) {
        missing.push({ field: 'listing', purpose: 'deadline', label: '상장 여부 — 상장 3영업일 / 비상장 7영업일로 기한이 갈립니다' });
      }
      if (i.shortTermDemandProduct === undefined) {
        missing.push({
          field: 'shortTermDemandProduct',
          purpose: 'deadline',
          label:
            '만기가 없고, 중도환매수수료가 없고, 수시입출금이 가능한 단기금융상품인지(세 요건 모두) — 충족하면 실제 거래내역을 ' +
            '분기 종료 후 익월 10영업일까지 분기 일괄 공시할 수 있습니다(제9조제5항). 상품 약관으로 확인하세요',
        });
        if (mainDeadlineConditional) {
          notes.push(
            '⚠️ 단기금융상품 여부(제9조제5항 세 요건)가 확인되지 않아, 실제 거래내역 공시기한은 원칙(거래 후 3·7영업일)으로만 ' +
              '보였습니다. 이 기한을 넘긴 공시라도 단기금융상품이면 분기 일괄 선택지(익월 10영업일) 안일 수 있어 ' +
              '**지연·과태료를 확정하지 않습니다** — scenarios 의 두 기한을 함께 보세요.',
          );
        }
      }
      break;
    }
    case 'not_standard_terms': {
      scenarios = [scenarioC];
      boardResolutionRequired = true;
      verdict = 'insufficient_data';
      summary =
        '약관거래가 아니므로 고시 제9조 특례(의결 생략·분기 일괄)가 적용되지 않습니다 — 일반 대규모내부거래 절차(거래 전 ' +
        '건별 이사회 의결 + 의결 후 상장 3·비상장 7영업일 공시)를 따릅니다. 대상 여부(기준금액 이상인지)는 ' +
        'duty:"large_internal_transaction" 으로 판정하세요.';
      const f = scenarioC.filings[0]!;
      if (f.deadline) {
        mainDeadline = f.deadline;
        mainFiling = f.kind;
      }
      break;
    }
    case 'undetermined': {
      scenarios = [scenarioA, scenarioB];
      verdict = 'insufficient_data';
      summary =
        '이사회 의결이 필요한지는 **경로에 따라 갈립니다 — 입력만으로 "의결 불요"라고 단정하지 않습니다.** ' +
        '금융·보험회사가 자기 일상적 금융·보험업무로 약관거래를 하는 경우에만 의결을 생략할 수 있고(고시 제9조제1항), ' +
        '그 밖의 회사(예: 제조업 회사가 계열 증권사·은행과 약관거래)는 사전 이사회 의결이 필요합니다 — 다만 매번이 아니라 ' +
        '분기별로 일괄 의결할 수 있습니다(제9조제2항, 수익증권은 1년 이내 기간). 경로별 기한은 scenarios 를 보세요.';
      break;
    }
  }

  // 공시일 하한 기준일 — 선택된 공시의 기산일. (종전: 모든 약관거래를 분기말로 고정 → 거래 후 공시를 거부하는 오류)
  let eventDate: OmnibusEvaluation['eventDate'];
  if (mainFiling === 'resolution' || mainFiling === 'general_resolution') {
    if (i.boardDate) eventDate = { date: i.boardDate, label: '이사회 의결일' };
  } else if (mainFiling === 'transaction' || mainFiling === 'quarterly_option') {
    if (i.transactionDate) eventDate = { date: i.transactionDate, label: '실제 거래일' };
  } else if (mainFiling === 'quarterly_mandatory') {
    eventDate = i.transactionDate
      ? { date: i.transactionDate, label: '실제 거래일' }
      : qe
        ? { date: qe, label: '분기 종료일' }
        : undefined;
  }

  if (det.path !== 'not_standard_terms') {
    notes.push(PREMISE_NOTE);
    if (i.standardTermsContract === undefined) {
      notes.push(
        '[전제] 약관(약관규제법 제2조 — 한쪽이 거래조건을 미리 정하고 상대방은 동의 여부만 결정)에 따른 거래라는 전제입니다. ' +
          '거래조건을 협의로 정했거나 사모사채 인수 등 특정 조건을 부기했다면 특례가 없고 일반 절차입니다 ' +
          '(standardTermsContract:false 로 다시 호출).',
      );
    }
  }
  notes.push(
    '공시 양식은 특수관계인과의 수익증권거래·예·적금거래 등 해당 거래 관련 양식을 씁니다 (공정위 매뉴얼 11-1절).',
  );

  return {
    path: det.path,
    pathReason: det.reason,
    boardResolutionRequired,
    verdict,
    summary,
    scenarios,
    ...(mainDeadline ? { mainDeadline } : {}),
    ...(mainFiling ? { mainFiling } : {}),
    mainDeadlineConditional,
    ...(eventDate ? { eventDate } : {}),
    missing,
    notes,
  };
}
