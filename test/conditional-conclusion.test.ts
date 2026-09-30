/**
 * 결론 조건형 · 공휴일 경고 구간 — Codex astra 교차검토(2026-09-30)가 첫 대응에서 재현한 반례를 고정한다.
 * 외부 검토 §3-3(요건 미확인인데 단정)·§3-2(공휴일 데이터 없는 연도) 후속.
 */
import { describe, expect, it } from 'vitest';
import { checkDisclosureDuty } from '../src/tools/check-disclosure-duty.js';
import { omnibusQuarterlyDeadline } from '../src/rules/deadlines.js';
import { selfCorrectionWindow } from '../src/rules/self-correction.js';

const 억 = 100_000_000;

function ok(input: Parameters<typeof checkDisclosureDuty>[0]) {
  const r = checkDisclosureDuty(input);
  if ('error' in r) throw new Error('error 응답');
  return r;
}

describe('불변조건 — required 결론과 [불충족] 요건은 함께 나오지 않는다', () => {
  const cases: Array<[string, Parameters<typeof checkDisclosureDuty>[0]]> = [
    [
      '당일 장외 주식 합산으로 대상 (건별 10억·합산 50억)',
      {
        duty: 'large_internal_transaction',
        amount: 10 * 억,
        sameDayStockTotal: 50 * 억,
        stockTradeVenue: 'off_exchange',
        amountBasis: 'actual',
        totalEquity: 500 * 억,
        paidInCapital: 100 * 억,
      },
    ],
    ['자본 입력 없이 100억 이상', { duty: 'large_internal_transaction', amount: 120 * 억 }],
    ['일반 거래', { duty: 'large_internal_transaction', amount: 50 * 억, totalEquity: 500 * 억, paidInCapital: 100 * 억 }],
    ['공익법인', { duty: 'public_interest_corp', amount: 50 * 억, totalEquity: 500 * 억, paidInCapital: 100 * 억 }],
  ];
  for (const [name, input] of cases) {
    it(name, () => {
      const r = ok(input);
      expect(r.verdict).toBe('required');
      expect(r.review.answer).not.toContain('[불충족]');
      expect(r.summary.startsWith('적용 요건 중 [미확인] ')).toBe(true);
    });
  }
});

describe('공익법인·약관거래도 조건형', () => {
  it('공익법인: 자신의 지위(법 제29조제1항) [미확인] — "공시 대상입니다"로 단정하지 않는다', () => {
    const r = ok({ duty: 'public_interest_corp', amount: 50 * 억, totalEquity: 500 * 억, paidInCapital: 100 * 억 });
    expect(r.review.answer).toContain('[미확인] 공익법인 **자신**이 "공시대상기업집단에 속하는 회사를 지배하는 동일인의 특수관계인');
    expect(r.review.answer.split('\n')[0]).toContain('[요건 충족 시 공시 대상]');
  });
  it('공익법인 소속 국내회사 주식: 제1호 요건은 [확인됨], 지위 요건만 [미확인]', () => {
    const r = ok({ duty: 'public_interest_corp', picGroupShareTrade: true });
    expect(r.verdict).toBe('required');
    expect(r.review.answer).toContain('[확인됨] "해당 공시대상기업집단에 속하는 국내 회사 주식의 취득 또는 처분"');
    expect(r.summary).toContain('[미확인] 1개');
  });
  it('약관거래(계열 금융회사 약관거래 경로): 집단 소속 [미확인]', () => {
    const r = ok({ duty: 'omnibus_financial', isFinancialCompany: false, listing: 'listed' });
    expect(r.review.answer).toContain('[미확인] 거래하는 회사 **자신**이 공시대상기업집단에 속하는 국내 회사일 것');
    if (r.verdict === 'required') expect(r.summary.startsWith('적용 요건 중 [미확인] ')).toBe(true);
  });
});

describe('발췌되는 다른 필드에도 조건', () => {
  const base = {
    duty: 'large_internal_transaction' as const,
    amount: 50 * 억,
    totalEquity: 500 * 억,
    paidInCapital: 100 * 억,
    listing: 'unlisted' as const,
    boardDate: '20260722',
  };
  it('evidence 의 지연·과태료 줄', () => {
    const r = ok({ ...base, actualDisclosureDate: '20260810', today: '20260812' });
    const ev = r.review.evidence.join('\n');
    expect(ev).toMatch(/실제 공시 20260810 — 10일 지연 \(\[미확인\] 요건이 모두 충족될 경우\)/);
    expect(ev).toMatch(/과태료 산식\(\[미확인\] 요건이 모두 충족될 경우\)/);
  });
  it('미공시 "즉시 공시하세요" note 와 그 unresolved 사본', () => {
    const r = ok({ ...base, disclosureStatus: 'not_disclosed', today: '20260805' });
    const actionNotes = r.notes.filter((n) => n.includes('즉시 공시'));
    expect(actionNotes.length).toBeGreaterThan(0);
    for (const n of actionNotes) expect(n.startsWith('[적용 요건 중 [미확인] ')).toBe(true);
    for (const u of r.review.unresolved.filter((x) => x.includes('즉시 공시'))) {
      expect(u.startsWith('[적용 요건 중 [미확인] ')).toBe(true);
    }
  });
});

describe('공휴일 경고 구간', () => {
  it('기산일 자체는 세지 않는다 — 2025-12-31 분기말 기한은 2026년만 세므로 2025년 경고 없음', () => {
    const d = omnibusQuarterlyDeadline('20251231');
    expect(d.warnings.join(' ')).not.toContain('2025년');
  });
  it('자진시정 창이 데이터 없는 해로 넘어가면 경고한다 (기한 2027-12-24 → 창 2028년)', () => {
    const w = selfCorrectionWindow('20271224', 'art26_29', '20280110');
    expect((w.warnings ?? []).join(' ')).toContain('2028년 공휴일 데이터가 없어');
  });
  it('창이 데이터 있는 해 안이면 경고가 없다', () => {
    expect(selfCorrectionWindow('20260731', 'art26_29', '20260805').warnings).toBeUndefined();
  });
});
