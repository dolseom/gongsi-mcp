/**
 * 대규모내부거래 제외 사유·거래유형 특례를 판정에 연결 (P1-6) — B→A 평가 c07·c09·d03·d05, Codex 적대 검토 §3.
 * 테스트 설명에 원문을 인용한다.
 */

import { describe, it, expect } from 'vitest';
import { checkDisclosureDuty } from '../src/tools/check-disclosure-duty.js';

const 억 = 100_000_000;

function ok(r: ReturnType<typeof checkDisclosureDuty>) {
  if ('error' in r) throw new Error(`예상치 못한 에러 응답: ${r.error} ${r.message}`);
  return r;
}

const big = {
  duty: 'large_internal_transaction' as const,
  amount: 50 * 억,
  totalEquity: 400 * 억,
  paidInCapital: 50 * 억,
  amountBasis: 'actual' as const,
};

describe('국외 계열회사 — 법 제26조제1항 "특수관계인(국외 계열회사는 제외한다)" / lit26-020', () => {
  it('직접 거래로 확인되면 not_required', () => {
    const r = ok(checkDisclosureDuty({ ...big, counterpartyForeignAffiliate: true, forSpecialRelatedParty: false }));
    expect(r.verdict).toBe('not_required');
    expect(r.summary).toContain('국외 계열회사');
    expect(r.missing_inputs.filter((m) => m.purpose === 'duty')).toEqual([]);
  });

  it('lit26-020 단서 "국외 계열회사를 통하여 간접적으로 매입하는 등 특수관계인을 위한 대규모 내부거래를 할 경우는 이사회 의결 및 공시의무가 있음" → 금액대로 대상', () => {
    const r = ok(checkDisclosureDuty({ ...big, counterpartyForeignAffiliate: true, forSpecialRelatedParty: true }));
    expect(r.verdict).toBe('required');
    expect(r.notes.join(' ')).toContain('lit26-020');
  });

  it('국외 상대방만 확인되고 거래 실질이 불명이면 대상을 확정하지 않고 되묻는다', () => {
    const r = ok(checkDisclosureDuty({ ...big, counterpartyForeignAffiliate: true }));
    expect(r.verdict).toBe('insufficient_data');
    expect(r.summary).toContain('금액 기준으로는 대상');
    expect(r.missing_inputs.map((m) => m.field)).toContain('forSpecialRelatedParty');
  });
});

describe('장내시장 주식거래 — 매뉴얼 "주식을 계열증권사를 통해 장내시장에서 거래하는 경우 (다만, 장 종료 후 시간외거래는 공시대상임)"', () => {
  it('c07: 계열사 주식 장내 정규 매수는 대상 아님 (고시 제4조제6항제2호)', () => {
    const r = ok(checkDisclosureDuty({ ...big, stockTradeVenue: 'exchange_regular' }));
    expect(r.verdict).toBe('not_required');
    expect(r.summary).toContain('장내시장');
  });

  it('시간외거래는 장내 제외가 없고 나머지 요건(금액)으로 판정한다 — 자동 대상이 아니다', () => {
    const r = ok(checkDisclosureDuty({ ...big, stockTradeVenue: 'exchange_after_hours' }));
    expect(r.verdict).toBe('required');
    expect(r.notes.join(' ')).toContain('시간외거래');
    const small = ok(checkDisclosureDuty({ ...big, amount: 3 * 억, stockTradeVenue: 'exchange_after_hours' }));
    expect(small.verdict).toBe('not_required');
  });

  it('공익법인 — 고시 제4조제6항 단서 "공익법인의 … 국내 회사 주식의 취득 또는 처분 행위는 제외한다": 소속회사 주식이면 금액·장내 무관 대상', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'public_interest_corp',
        amount: 1 * 억,
        totalEquity: 1000 * 억,
        stockTradeVenue: 'exchange_regular',
        picGroupShareTrade: true,
      }),
    );
    expect(r.verdict).toBe('required');
    expect(r.summary).toContain('관계없이');
  });

  it('공익법인 장내거래인데 소속회사 주식 여부를 모르면 제외를 확정하지 않는다 (거짓 안심 방지)', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'public_interest_corp',
        amount: 60 * 억,
        totalEquity: 1000 * 억,
        stockTradeVenue: 'exchange_regular',
      }),
    );
    expect(r.verdict).not.toBe('not_required');
    expect(r.missing_inputs.map((m) => m.field)).toContain('picGroupShareTrade');
  });

  it('공익법인 금액 미달 not_required 에는 "소속회사 주식이면 금액 무관 대상" 조건을 붙인다', () => {
    const r = ok(checkDisclosureDuty({ duty: 'public_interest_corp', amount: 1 * 억, totalEquity: 1000 * 억 }));
    expect(r.verdict).toBe('not_required');
    expect(r.summary).toContain('picGroupShareTrade');
  });
});

describe('부수적 거래 — 고시 제4조제6항제1호 "권리의 행사 또는 의무의 이행에 따라 발생하는 부수적인 거래로서 새로운 거래관계가 성립하지 않는 행위"', () => {
  it('만기 상환 등 부수적 거래는 not_required', () => {
    const r = ok(checkDisclosureDuty({ ...big, incidentalTransaction: true }));
    expect(r.verdict).toBe('not_required');
  });

  it('제외 사실이 입력되지 않은 required 에는 "판정이 달라지는 경우" 조건 목록을 붙인다 (verdict 는 그대로)', () => {
    const r = ok(checkDisclosureDuty(big));
    expect(r.verdict).toBe('required');
    const n = r.notes.find((x) => x.startsWith('판정이 달라지는 경우'));
    expect(n).toContain('국외 계열회사');
    expect(n).toContain('장내시장');
    expect(n).toContain('부수적 거래');
    expect(n).toContain('lit26-003');
  });
});

describe('상품·용역 특례 노출 — 고시 제9조의2', () => {
  it('c09: 분기 합계 100억 용역 → 제9조의2제1항 "거래금액에 대하여 이사회 의결을 1년 이내의 거래기간을 정하여 일괄하여 할 수 있다" 를 안내', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction',
        amount: 100 * 억,
        totalEquity: 3000 * 억,
        paidInCapital: 500 * 억,
        amountBasis: 'quarterly_sum',
      }),
    );
    expect(r.verdict).toBe('required');
    const n = r.notes.find((x) => x.startsWith('상품·용역 거래 특례'))!;
    expect(n).toContain('1년 이내의 거래기간');
    expect(n).toContain('45일'); // 20% 이상 감소
    expect(n).toContain('증가'); // 20% 이상 증가 예상 → 분기 중 재의결
    expect(n).toContain('계약 건별'); // 계약체결방식 (제9조의2제4항)
    expect(n).toContain('제3항'); // 예측 못 한 거래
  });

  it('검토 메모의 상대방 요건에 "발행주식총수의 20% 이상" 을 적는다 — 시행령 제33조제2항 (c08 "지분율 정보 부족" 실패)', () => {
    const r = ok(checkDisclosureDuty({ ...big, amountBasis: 'quarterly_sum' }));
    expect(r.review.unresolved.join(' ')).toContain('20% 이상');
  });

  it('goods_services_reduced: 감소 후 금액이 기준 아래여도 공시 — lit26-072 "이사회 의결은 거치지 아니하고 분기 종료 후 45일 이내에 실제 거래금액을 공시하여야 함"', () => {
    const r = ok(checkDisclosureDuty({ duty: 'goods_services_reduced', quarterEnd: '20260930', amount: 20 * 억 }));
    expect(r.verdict).toBe('required');
    expect(r.review.assumptions.some((a) => a.includes('lit26-072'))).toBe(true);
    expect(r.summary).toContain('20% 이상 감소');
  });
});

describe('부동산 임대차 거래분류 — 매뉴얼 "거래당사자 한쪽에게 상품ㆍ용역거래인 경우에는 양 당사자 모두 상품ㆍ용역거래 거래금액으로 봄"', () => {
  it('not_required 에도 required 에도 거래분류 전환 조건을 붙인다', () => {
    for (const amount of [4 * 억, 50 * 억]) {
      const r = ok(
        checkDisclosureDuty({
          duty: 'large_internal_transaction',
          amount,
          totalEquity: 400 * 억,
          paidInCapital: 50 * 억,
          amountBasis: 'lease_annualized',
        }),
      );
      const n = r.notes.find((x) => x.includes('양 당사자 모두'));
      expect(n).toBeDefined();
      expect(r.review.unresolved).toContain(n);
    }
  });
});
