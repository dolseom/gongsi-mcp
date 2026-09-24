/**
 * `check_disclosure_duty` 의 **부분 판정 계약**과 **검토 메모** 조립기.
 *
 * 왜 따로 있나 — 두 가지를 한 곳에 모아 둔다:
 *
 *  1) **대상 판정과 기한 계산은 입력 의존성이 다르다.** 종전에는 기한 계산이 앞에 있어
 *     이사회 의결일이 없으면 `invalid_argument` 로 응답 전체가 사라졌다. 그러면 "자본 1,200억에
 *     80억 거래인데 공시 대상이야?" 라는, 날짜가 아직 없는 **첫 질문**에 답이 없다.
 *     → 없는 입력은 **오류가 아니라 그 계산의 미확정 사유**다. 제공했지만 잘못된 값
 *     (실존하지 않는 날짜·분기말 아님·공시일이 기준일보다 앞섬)은 종전대로 오류다.
 *
 *  2) **답변 순서**. 결론 → 적용 전제 → 근거 → 미확인 사항 → 다음 행동. 모델이 긴 판정
 *     페이로드에서 무엇을 먼저 말할지 고르지 않아도 되게 도구가 순서를 정해 준다.
 *
 * ★ 이 모듈은 **새 법률 해석을 만들지 않는다.** 전부 이미 계산된 값(기준금액 산식·기한 규칙·
 *   과태료 산식·notes)에서 문장을 고르거나 필드명을 옮겨 적을 뿐이다.
 */

import type { Verdict } from '../rules/types.js';

/**
 * 계산 단위(대상 판정 / 기한 계산)의 상태.
 *
 * ⚠️ `evaluated` 는 **그 계산을 수행했다**는 뜻이다 — 법적 적용 전제가 전부 확정됐다는 뜻이
 * 아니다 (예: 상품·용역은 상대방 지분 요건이 남고, 비상장사 중요사항은 대상회사 판정이 남는다).
 * 그 남은 전제는 `review.assumptions`·`notes` 에 그대로 있다.
 */
export type ComponentStatus = 'evaluated' | 'insufficient_data' | 'not_applicable';

/** 지금 질문에 답하려면 무엇이 더 필요한가 — 목적(duty/deadline)까지 함께 말한다 */
export interface MissingInput {
  /** 입력 필드명 (그대로 다시 호출에 넣을 수 있는 이름) */
  field: string;
  /** 이 값이 없어서 못 한 계산 */
  purpose: 'duty' | 'deadline';
  /** 사람에게 물을 말 */
  label: string;
  /**
   * 이 필드 대신 줘도 되는 필드들. 자본총계·자본금처럼 **둘 중 하나만 있으면** 되는 관계를
   * "둘 다 필수" 로 오해하지 않게 한다.
   */
  alternatives?: string[];
}

export interface DutyComponent {
  status: ComponentStatus;
  missing_fields: string[];
}

export interface DutyComponents {
  /** 공시 대상 여부·기준금액 */
  duty: DutyComponent;
  /** 공시기한 */
  deadline: DutyComponent;
}

/**
 * 검토 메모 — 모델이 사용자에게 **이 순서로** 말하도록 만든 요약.
 * 원본 근거(threshold·deadline·penalty·notes·disclaimer)는 응답에 그대로 남아 있다.
 */
export interface ReviewMemo {
  conclusion: string;
  assumptions: string[];
  evidence: string[];
  unresolved: string[];
  next_actions: string[];
}

/** 미확정 목적별 필드명 목록 (중복 제거, 입력 순서 유지) */
export function missingFieldsFor(
  missing: readonly MissingInput[],
  purpose: MissingInput['purpose'],
): string[] {
  const out: string[] = [];
  for (const m of missing) {
    if (m.purpose !== purpose || out.includes(m.field)) continue;
    out.push(m.field);
  }
  return out;
}

/** 사람이 읽는 미확정 필드 문구 — "boardDate(이사회 의결일), listing(상장 여부)" */
export function missingLabelList(
  missing: readonly MissingInput[],
  purpose: MissingInput['purpose'],
): string {
  return missing
    .filter((m) => m.purpose === purpose)
    .map((m) => `${m.field}(${m.label.split(' — ')[0]})`)
    .join(', ');
}

/** 검토 메모 조립에 필요한, **이미 계산된** 값들 */
export interface ReviewSource {
  duty: string;
  verdict: Verdict;
  summary: string;
  components: DutyComponents;
  missingInputs: readonly MissingInput[];
  notes: readonly string[];
  thresholdFormula?: string;
  amountBasisNote?: string;
  deadline?: { deadline: string; rule: string; dDay?: number; legalBasis: Array<{ source: string }> };
  compliance?: { onTime: boolean; delayDays: number; actualDisclosureDate: string };
  penalty?: { amount: number; formula: string; isUpperBound: boolean };
  selfCorrection?: { status: string; windowEnd: string; businessDaysRemaining?: number };
  relatedQnaCount?: number;
  /** 상황 서술이 들어와 Q&A 를 붙였는지 — 다음 행동 문구가 갈린다 */
  hasSituation: boolean;
}

/** 대상 판정 미확정 상태에서 계산한 지연·과태료에 붙이는 조건 문구 */
const IF_DUTY_CONFIRMED = '공시 대상으로 확정될 경우';

/** duty별 "자료 조회" 다음 행동에 쓸 이름 — 회사명은 **자료 조회 때만** 필요하다 */
const CAPITAL_LOOKUP_HINT =
  'get_financials 로 자본총계·자본금을 조회하려면 그때 회사명(또는 종목코드)이 필요합니다.';

/**
 * 검토 메모를 만든다.
 *
 * 규칙:
 *  - `conclusion` 은 계산된 verdict·summary 를 그대로 옮긴다 (새 단정을 만들지 않는다).
 *  - `assumptions` 는 notes 중 **전제·가정**에 해당하는 것을 고른다.
 *  - `evidence` 는 산식·기한 규칙·조문 출처처럼 **재현 가능한 근거**만.
 *  - `unresolved` 는 미확정 입력 + 상한선 여부 + 확인되지 않은 전제.
 *  - `next_actions` 는 미확정을 메우는 구체적 호출.
 */
export function buildReview(src: ReviewSource): ReviewMemo {
  const assumptions: string[] = [];
  const evidence: string[] = [];
  const unresolved: string[] = [];
  const nextActions: string[] = [];

  // ── 결론 ──
  const verdictWord =
    src.verdict === 'required'
      ? '공시 대상'
      : src.verdict === 'not_required'
        ? '공시 대상 아님'
        : '현재 입력으로는 판정 불가';
  // 대상 판정이 미확정인데 지연·과태료를 계산한 경우(기존 게이트는 not_required 만 제외한다) —
  // 금액·기한·산식은 그대로 두고 **조건**을 문장으로 붙인다. 법령 규칙·게이트는 바꾸지 않는다.
  const conditionalOnDuty =
    src.verdict === 'insufficient_data' && Boolean(src.compliance || src.penalty);
  const conclusion =
    `[${verdictWord}] ${src.summary}` +
    (conditionalOnDuty
      ? ` — 위 지연 여부·과태료는 ${IF_DUTY_CONFIRMED}의 값입니다(대상이 아니면 지연도 과태료도 없습니다).`
      : '');

  // ── 전제 ──
  if (src.amountBasisNote) {
    assumptions.push(src.amountBasisNote);
  } else if (src.notes.some((n) => n.includes('amountBasis'))) {
    assumptions.push(
      'amountBasis(거래금액 산정 방식)를 지정하지 않았습니다 — 담보제공·부동산임대차·보험·상품용역은 ' +
        '산정 방식이 달라 이 판정이 뒤집힐 수 있습니다.',
    );
  }
  for (const n of src.notes) {
    // 대상회사 미확정·자본금 대체 적용·이사회 의결 가정처럼 **판정의 전제**인 note 만 올린다.
    if (
      n.startsWith('[전제]') ||
      n.includes('전제한 참고값') ||
      n.includes('대상회사임을 전제') ||
      n.includes('자본금을 자기자본으로 보아')
    ) {
      assumptions.push(n);
    }
  }
  if (src.components.duty.status === 'not_applicable') {
    assumptions.push(
      '이 유형은 금액 기준 판정 없이, 입력한 사실(의무 유형의 전제)을 바탕으로 기한만 계산합니다 ' +
        '(components.duty = not_applicable) — 전제가 틀리면 결론도 달라집니다.',
    );
  }

  // ── 근거 ──
  if (src.thresholdFormula) evidence.push(`기준금액 산식: ${src.thresholdFormula}`);
  if (src.deadline) {
    evidence.push(
      `기한 ${src.deadline.deadline} — ${src.deadline.rule}` +
        (src.deadline.dDay !== undefined ? ` (남은 영업일 ${src.deadline.dDay}일)` : ''),
    );
    const sources = src.deadline.legalBasis.map((b) => b.source).filter(Boolean);
    if (sources.length) evidence.push(`기한 근거: ${sources.join(' / ')}`);
  }
  const ifDuty = conditionalOnDuty ? ` (${IF_DUTY_CONFIRMED})` : '';
  if (src.compliance) {
    evidence.push(
      (src.compliance.onTime
        ? `실제 공시 ${src.compliance.actualDisclosureDate} — 기한 내`
        : `실제 공시 ${src.compliance.actualDisclosureDate} — ${src.compliance.delayDays}일 지연`) + ifDuty,
    );
  }
  if (src.penalty) {
    evidence.push(
      `과태료 산식${conditionalOnDuty ? `(${IF_DUTY_CONFIRMED})` : ''}: ${src.penalty.formula}`,
    );
  }
  if (src.selfCorrection?.status === 'open') {
    evidence.push(
      `자진시정 골든타임 ${src.selfCorrection.windowEnd} 까지` +
        (src.selfCorrection.businessDaysRemaining !== undefined
          ? ` (남은 영업일 ${src.selfCorrection.businessDaysRemaining}일)`
          : ''),
    );
  }
  if (src.relatedQnaCount) {
    evidence.push(
      `유사 공정위 공식 Q&A ${src.relatedQnaCount}건을 relatedOfficialQna 로 첨부했습니다 (원문·출처 포함).`,
    );
  }

  // ── 미확인 ──
  for (const m of src.missingInputs) {
    const alt = m.alternatives?.length ? ` (또는 ${m.alternatives.join(' / ')})` : '';
    unresolved.push(
      `${m.purpose === 'duty' ? '대상 판정' : '기한 계산'} 미확정 — ${m.field}${alt}: ${m.label}`,
    );
  }
  if (conditionalOnDuty) {
    unresolved.push(
      `대상 판정이 끝나지 않았습니다 — 지연 여부·과태료는 ${IF_DUTY_CONFIRMED}에만 의미가 있습니다. ` +
        '위 대상 판정 입력을 채워 확정하세요.',
    );
  }
  if (src.components.deadline.status === 'insufficient_data') {
    unresolved.push(
      '기한을 계산하지 못했으므로 지연 여부·지연일수·과태료·자진시정 골든타임은 이 응답에 없습니다 — ' +
        '"기한 내"도 "지연"도 아닙니다.',
    );
  }
  if (src.penalty?.isUpperBound) {
    unresolved.push(
      '과태료 금액은 확정 추정치가 아니라 **상한선**입니다 (거래금액별 적용비율 미적용 — penalty.isUpperBound=true).',
    );
  }
  if (src.duty === 'large_internal_transaction' && src.verdict === 'required') {
    unresolved.push(
      '금액 기준 충족은 대규모내부거래 요건의 일부입니다 — 상대방이 특수관계인인지, 상품·용역이면 ' +
        '상대방 지분 요건(법 §26①4호)에 해당하는지는 이 도구가 확인하지 않습니다.',
    );
  }
  for (const n of src.notes) {
    if (n.startsWith('⚠️') && !assumptions.includes(n) && !unresolved.includes(n)) unresolved.push(n);
  }

  // ── 다음 행동 ──
  const dutyMissing = missingFieldsFor(src.missingInputs, 'duty');
  const deadlineMissing = missingFieldsFor(src.missingInputs, 'deadline');
  if (dutyMissing.length) {
    nextActions.push(`대상 판정을 마치려면 ${dutyMissing.join(', ')} 를 알려주세요.`);
    if (dutyMissing.includes('totalEquity') || dutyMissing.includes('paidInCapital')) {
      nextActions.push(CAPITAL_LOOKUP_HINT);
    }
  }
  if (deadlineMissing.length) {
    nextActions.push(
      `공시기한을 계산하려면 ${deadlineMissing.join(', ')} 를 알려주세요 — 기한 계산 전용 입력입니다.`,
    );
  }
  if (src.deadline && !src.compliance) {
    if (src.verdict === 'required') {
      nextActions.push(
        '이미 공시했다면 actualDisclosureDate 를, 아직 공시 전이면 disclosureStatus:"not_disclosed" 를 주면 ' +
          '지연 여부·자진시정 골든타임까지 계산합니다.',
      );
    } else if (src.verdict === 'insufficient_data') {
      // ★ 자진시정 골든타임은 대상 판정이 required 로 확정된 경우에만 붙는다(check-disclosure-duty).
      //   대상 미확정인데 "not_disclosed 를 주면 골든타임까지" 라고 안내하면, 그대로 다시 불러도
      //   아무것도 오지 않는 **거짓 약속**이 된다 (2026-09-13 자연어 실행에서 실제로 일어났다).
      nextActions.push(
        '이미 공시했다면 actualDisclosureDate 를 주면 기한 대비 지연 여부를 계산합니다. 아직 공시 전이라면 ' +
          '자진시정 골든타임은 **대상 판정이 확정된 뒤**(위 대상 판정 입력을 채운 뒤)에 계산합니다.',
      );
    }
  }
  if (!src.hasSituation) {
    nextActions.push(
      '거래 성격이 경계사례라면 situation 에 상황을 서술하면 유사한 공정위 공식 Q&A를 근거로 첨부합니다.',
    );
  }

  return {
    conclusion,
    assumptions,
    evidence,
    unresolved,
    next_actions: nextActions,
  };
}
