/**
 * 부분 판정 계약(components·missing_inputs) + 검토 메모(review) 회귀.
 *
 * 이 파일이 지키는 것 두 가지:
 *  1) **부족한 입력과 잘못된 입력은 다르다.** 없는 날짜는 그 계산만 미확정, 잘못된 값은 오류.
 *  2) **기한이 없으면 지연·과태료·자진시정을 만들지 않는다.** 가짜 기한으로 "적법"을 내지 않는다.
 */

import { describe, it, expect } from 'vitest';
import { checkDisclosureDuty } from '../src/tools/check-disclosure-duty.js';

const 억 = 100_000_000;

/** 에러가 아님을 확인하고 결과를 좁힌다 */
function ok(r: ReturnType<typeof checkDisclosureDuty>) {
  if ('error' in r) throw new Error(`예상치 못한 에러 응답: ${r.error} ${r.message}`);
  return r;
}

describe('대상 판정과 기한 계산은 독립적이다', () => {
  it('의결일이 없어도 기준금액·대상 판정은 나간다 (QA happy)', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction',
        amount: 80 * 억,
        totalEquity: 1200 * 억,
        amountBasis: 'actual',
      }),
    );
    expect(r.verdict).toBe('required');
    expect(r.threshold?.amount).toBe(60 * 억);
    expect(r.components.duty.status).toBe('evaluated');
    expect(r.components.deadline.status).toBe('insufficient_data');
    expect(r.components.deadline.missing_fields).toEqual(['boardDate', 'listing']);
    // 기한이 없으면 이 세 가지는 만들지 않는다
    expect(r.deadline).toBeUndefined();
    expect(r.compliance).toBeUndefined();
    expect(r.penalty).toBeUndefined();
    expect(r.selfCorrection).toBeUndefined();
  });

  it('자본이 없어도 기한은 나간다 (반대 방향)', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction',
        listing: 'listed',
        boardDate: '20260701',
        today: '20260701',
      }),
    );
    expect(r.deadline?.deadline).toBe('20260706');
    expect(r.components.deadline.status).toBe('evaluated');
    expect(r.components.duty.status).toBe('insufficient_data');
    expect(r.components.duty.missing_fields).toContain('totalEquity');
    expect(r.components.duty.missing_fields).toContain('amount');
    expect(r.verdict).toBe('insufficient_data');
  });

  it('자본금만 줘도 기준금액이 계산된다 — 자본 두 필드는 대안 관계다', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction',
        paidInCapital: 1200 * 억,
        amount: 80 * 억,
      }),
    );
    expect(r.threshold?.amount).toBe(60 * 억);
    // ★ 2026-09-24 변경: 기준금액 = min(100억, max(자본총계, 자본금)×5%) — 미입력 자본총계가 1,600억원을
    //   넘으면 기준이 80억원을 넘어 이 거래는 대상이 아니다. 자본금만으로 "대상" 을 확정하면 거짓 확정이라
    //   대상 판정은 미확정 + 결론을 가르는 값(자본총계)만 되묻는다. 기준금액 계산 자체는 여전히 나간다.
    expect(r.components.duty.status).toBe('insufficient_data');
    expect(r.missing_inputs.some((m) => m.field === 'totalEquity')).toBe(true);

    // 결론이 미입력 값과 무관하면(거래 100억 이상) 자본금만으로 판정이 끝난다 — 대안 관계는 그대로다
    const settled = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction',
        paidInCapital: 1200 * 억,
        amount: 100 * 억,
      }),
    );
    expect(settled.components.duty.status).toBe('evaluated');
    expect(settled.verdict).toBe('required');
    expect(settled.missing_inputs.some((m) => m.field === 'totalEquity')).toBe(false);
  });

  it('공익법인도 같은 분리가 적용된다', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'public_interest_corp',
        amount: 10 * 억,
        totalEquity: 100 * 억,
      }),
    );
    expect(r.components.duty.status).toBe('evaluated');
    expect(r.components.deadline.status).toBe('insufficient_data');
  });

  it('비상장사 중요사항: 사유 발생일 없이도 임계값·대상 판정이 나간다', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'unlisted_material',
        materialItem: 'fixed_asset',
        totalAssets: 500 * 억,
        amount: 60 * 억,
      }),
    );
    expect(r.verdict).toBe('required');
    expect(r.components.duty.status).toBe('evaluated');
    expect(r.components.deadline.missing_fields).toEqual(['occurredDate']);
    expect(r.deadline).toBeUndefined();
  });

  it('약관 금융거래는 경로(의결 필요 여부) 판정이 duty 이고, 경로를 모르면 verdict 도 미확정이다', () => {
    // 2026-09-24 변경: 종전에는 기한 전용 유형(duty not_applicable)으로 보고 "의결 불요"를 무조건 안내했다.
    // 원문(고시 제9조제1항·제2항)상 의결 생략은 금융·보험회사의 일상적 약관거래뿐이라 경로가 곧 판정 대상이다.
    const r = ok(checkDisclosureDuty({ duty: 'omnibus_financial' }));
    expect(r.components.duty.status).toBe('insufficient_data');
    expect(r.components.duty.missing_fields).toEqual(['isFinancialCompany', 'routineFinancialBusiness']);
    expect(r.components.deadline.status).toBe('insufficient_data');
    // ★ "required · 기한을 계산했습니다" 라고 하면 그 문장 자체가 거짓이다
    expect(r.verdict).toBe('insufficient_data');
    expect(r.notes.join(' ')).not.toContain('이사회 의결이 필요 없습니다');
    // 경로를 확정해도 분기말이 없으면 기한은 미확정이다
    const fin = ok(
      checkDisclosureDuty({ duty: 'omnibus_financial', isFinancialCompany: true, routineFinancialBusiness: true }),
    );
    expect(fin.components.duty.status).toBe('evaluated');
    expect(fin.components.deadline.missing_fields).toContain('quarterEnd');
  });

  it('상품·용역 감소 특례도 분기말이 없으면 미확정이다', () => {
    const r = ok(checkDisclosureDuty({ duty: 'goods_services_reduced' }));
    expect(r.verdict).toBe('insufficient_data');
    expect(r.components.deadline.missing_fields).toEqual(['quarterEnd']);
  });

  it('기업집단현황은 기존 기본값을 유지한다 — year 생략은 올해, quarter 생략은 연1회', () => {
    const r = ok(checkDisclosureDuty({ duty: 'group_status', year: 2027 }));
    expect(r.verdict).toBe('required');
    expect(r.deadline?.deadline).toBe('20270531');
    expect(r.components.duty.status).toBe('not_applicable');
    expect(r.components.deadline.status).toBe('evaluated');
    expect(r.missing_inputs).toEqual([]);
  });
});

describe('부족한 입력과 잘못된 입력을 가른다', () => {
  it('분기말이 아닌 quarterEnd 는 여전히 invalid_argument (부족이 아니라 오류)', () => {
    const r = checkDisclosureDuty({ duty: 'omnibus_financial', quarterEnd: '20260731' });
    expect('error' in r && r.error).toBe('invalid_argument');
  });

  it('실존하지 않는 날짜는 스키마에서 거부한다 (20260231)', async () => {
    const { checkDisclosureDutyInput } = await import('../src/tools/check-disclosure-duty.js');
    expect(
      checkDisclosureDutyInput.safeParse({ duty: 'large_internal_transaction', boardDate: '20260231' })
        .success,
    ).toBe(false);
  });

  it('공시일이 기준일보다 앞서면 여전히 invalid_argument', () => {
    const r = checkDisclosureDuty({
      duty: 'large_internal_transaction',
      listing: 'unlisted',
      boardDate: '20260722',
      actualDisclosureDate: '20250728',
      totalEquity: 1200 * 억,
      amount: 80 * 억,
    });
    expect('error' in r && r.error).toBe('invalid_argument');
  });

  it('공시일만 있고 기한을 못 구하면 준수 여부를 만들지 않고 그 사실을 밝힌다 (QA failure)', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction',
        // boardDate·listing 없음 → 기한 미확정
        actualDisclosureDate: '20260801',
        totalEquity: 1200 * 억,
        amount: 80 * 억,
        today: '20260901',
      }),
    );
    expect(r.compliance).toBeUndefined();
    expect(r.penalty).toBeUndefined();
    expect(r.notes.join(' ')).toContain('"기한 내"도 "지연"도 아닙니다');
  });

  it('미공시 상태만 알려도 가짜 기한·지연일을 만들지 않는다', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction',
        disclosureStatus: 'not_disclosed',
        totalEquity: 1200 * 억,
        amount: 80 * 억,
        today: '20260901',
      }),
    );
    expect(r.deadline).toBeUndefined();
    expect(r.selfCorrection).toBeUndefined();
    expect(r.verdict).toBe('required');
  });
});

describe('검토 메모 (review)', () => {
  it('결론·전제·근거·미확인·다음 행동이 계산 결과와 일치한다', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction',
        listing: 'unlisted',
        boardDate: '20260722',
        totalEquity: 1200 * 억,
        amount: 80 * 억,
        amountBasis: 'actual',
        today: '20260723',
      }),
    );
    expect(r.review.conclusion).toContain('공시 대상');
    // 근거는 실제 계산된 산식·기한에서 온다
    expect(r.review.evidence.join(' ')).toContain(r.threshold!.formula);
    expect(r.review.evidence.join(' ')).toContain(r.deadline!.deadline);
    // 금액 기준 충족이 모든 요건 확인은 아니라는 사실을 남긴다
    expect(r.review.unresolved.join(' ')).toContain('금액 기준 충족');
    // 원본 근거는 그대로 남아 있다 (검토 메모가 대체하지 않는다)
    expect(r.threshold?.inputs).toEqual({ totalEquity: 1200 * 억, paidInCapital: undefined });
    expect(r.deadline?.legalBasis.length).toBeGreaterThan(0);
    expect(r.disclaimer).toContain('공정거래위원회의 공식 유권해석이 아닙니다');
  });

  it('미확정 입력은 목적을 구분해 다음 행동으로 나온다 — 대상만 물었으면 의결일을 강요하지 않는다', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction',
        amount: 80 * 억,
        totalEquity: 1200 * 억,
      }),
    );
    const deadlineAction = r.review.next_actions.find((a) => a.includes('공시기한을 계산하려면'));
    expect(deadlineAction).toBeDefined();
    expect(deadlineAction).toContain('기한 계산 전용 입력');
    // 대상 판정은 이미 끝났으므로 그쪽 요구는 없다
    expect(r.review.next_actions.some((a) => a.includes('대상 판정을 마치려면'))).toBe(false);
  });

  it('대상 판정이 미확정이면 "not_disclosed 를 주면 골든타임까지 계산" 이라고 약속하지 않는다', () => {
    // 2026-09-13 자연어 실행(deadline-without-capital)에서 모델이 이 안내대로 다시 불렀지만
    // selfCorrection 은 verdict=required 일 때만 붙어 **아무것도 오지 않았다** — 다음 행동이 거짓 약속이었다.
    const r = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction',
        listing: 'unlisted',
        boardDate: '20260722',
        today: '20260913',
      }),
    );
    expect(r.components.deadline.status).toBe('evaluated');
    expect(r.components.duty.status).toBe('insufficient_data');
    const actions = r.review.next_actions.join('\n');
    expect(actions).not.toContain('지연 여부·자진시정 골든타임까지 계산합니다');
    expect(actions).toContain('대상 판정이 확정된 뒤');

    // 실제 동작과 일치하는지 — 안내대로 불러도 골든타임은 붙지 않는다
    const again = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction',
        listing: 'unlisted',
        boardDate: '20260722',
        today: '20260913',
        disclosureStatus: 'not_disclosed',
      }),
    );
    expect(again.selfCorrection).toBeUndefined();
  });

  it('대상 판정이 끝났으면 종전 안내(공시일·미공시 상태를 주면 골든타임까지)를 유지한다', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction',
        listing: 'unlisted',
        boardDate: '20260722',
        totalEquity: 1200 * 억,
        amount: 80 * 억,
        today: '20260913',
      }),
    );
    expect(r.review.next_actions.join('\n')).toContain('지연 여부·자진시정 골든타임까지 계산합니다');
  });

  it('대상 미확정인데 공시일이 늦어 지연·과태료를 계산하면 "대상으로 확정될 경우" 조건을 붙인다 (계산값은 그대로)', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction',
        listing: 'unlisted',
        boardDate: '20260722',
        actualDisclosureDate: '20260810',
        today: '20260913',
      }),
    );
    // 계산은 변경 전과 같다 — 2026-09-14 변경 전 빌드(dist)로 같은 입력을 돌려 채취한 값
    expect(r.verdict).toBe('insufficient_data');
    expect(r.deadline?.deadline).toBe('20260731');
    expect(r.compliance).toEqual({ onTime: false, delayDays: 10, actualDisclosureDate: '20260810' });
    expect(r.penalty).toMatchObject({ amount: 4_200_000, isUpperBound: true });

    const conditional = '공시 대상으로 확정될 경우';
    expect(r.review.conclusion).toContain(conditional);
    expect(r.review.unresolved.join('\n')).toContain(conditional);
    expect(r.notes.join('\n')).toContain(conditional);
    expect(r.review.evidence.find((e) => e.startsWith('과태료 산식'))).toContain(conditional);
    expect(r.review.evidence.find((e) => e.startsWith('실제 공시'))).toContain(conditional);
  });

  it('대상이 확정된 경우에는 지연·과태료에 조건 문구를 붙이지 않는다', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction',
        listing: 'unlisted',
        boardDate: '20260722',
        totalEquity: 1200 * 억,
        amount: 80 * 억,
        actualDisclosureDate: '20260810',
        today: '20260913',
      }),
    );
    expect(r.verdict).toBe('required');
    expect(r.penalty).toBeDefined();
    expect(JSON.stringify(r.review) + r.notes.join('\n')).not.toContain('공시 대상으로 확정될 경우');
  });

  it('과태료 상한선 여부를 검토 메모에도 남긴다', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction',
        listing: 'listed',
        boardDate: '20260722',
        totalEquity: 1200 * 억,
        // amount 없음 → 거래금액별 적용비율 미적용 → 상한선
        actualDisclosureDate: '20260810',
        today: '20260811',
      }),
    );
    // amount 가 없으면 대상 판정 자체가 미확정이라 지연 판정도 붙지 않는다 — 그 사실을 확인한다
    expect(r.verdict).toBe('insufficient_data');
    expect(r.review.unresolved.join(' ')).toContain('amount');

    const withAmount = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction',
        listing: 'listed',
        boardDate: '20260722',
        totalEquity: 1200 * 억,
        amount: 80 * 억,
        actualDisclosureDate: '20260810',
        today: '20260811',
      }),
    );
    expect(withAmount.penalty).toBeDefined();
    expect(withAmount.review.evidence.join(' ')).toContain('과태료 산식');
  });

  it('대상회사 미확정 전제가 review.assumptions 에 남는다', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'unlisted_material',
        materialItem: 'gift',
        occurredDate: '20260722',
        amount: 10 * 억,
        totalEquity: 100 * 억,
        paidInCapital: 50 * 억,
      }),
    );
    expect(r.review.assumptions.some((a) => a.includes('대상회사임을 전제'))).toBe(true);
  });
});
