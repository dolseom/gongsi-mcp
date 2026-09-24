/**
 * 날짜 없이 "N일 늦었다"만 알 때의 조건부 과태료 (E) — B→A 평가 d09, Codex 적대 검토 §4.
 * 원문: 시행령 별표9 제2호 가목(의결 O·기한 초과: 500만원 + 1일 10만원), 과태료 고시 Ⅵ.2(거래금액 적용비율),
 *       Ⅵ.3.다(4)(나) "공시지연 일수" 3일 이하 75% 등, Ⅴ(기한 만료 다음 날부터 10영업일 내 자진시정 + 사유, 재량).
 */

import { describe, it, expect } from 'vitest';
import { checkDisclosureDuty } from '../src/tools/check-disclosure-duty.js';

const 억 = 100_000_000;
const 만 = 10_000;

function ok(r: ReturnType<typeof checkDisclosureDuty>) {
  if ('error' in r) throw new Error(`예상치 못한 에러 응답: ${r.error} ${r.message}`);
  return r;
}

const d09 = {
  duty: 'large_internal_transaction' as const,
  listing: 'listed' as const,
  amount: 30 * 억,
  totalEquity: 400 * 억,
  amountBasis: 'actual' as const,
  boardResolution: true,
  delayDays: 3,
  delayDayBasis: 'calendar' as const,
  delayFilingState: 'not_yet_filed' as const,
};

describe('지연일수 입력 — 조건부 과태료', () => {
  it('d09: 의결 O·달력일 3일·30억·상장 → (500만+30만)×60% = 318만 → 75% 감경 → 79만원(1만원 미만 절사)', () => {
    const r = ok(checkDisclosureDuty(d09));
    expect(r.delayScenario?.status).toBe('computed');
    const sc = r.delayScenario!.scenarios!;
    expect(sc).toHaveLength(1);
    expect(sc[0]!.penalty.amount).toBe(79 * 만);
    expect(sc[0]!.penalty.standardAmount).toBe(318 * 만);
    expect(r.summary).toContain('79만원');
    // 공시기한은 역산하지 않는다
    expect(r.deadline).toBeUndefined();
    expect(r.compliance).toBeUndefined();
  });

  it('다음 감경 경계는 4일째 — "하루 늦을 때마다"가 아니라 경계(3·7·15·30일)에서 단계적으로 바뀐다', () => {
    const r = ok(checkDisclosureDuty(d09));
    expect(r.delayScenario?.nextBoundary?.fromDays).toBe(4);
    expect(r.delayScenario?.nextBoundary?.note).toContain('50%');
    // penalties 의 nextThreshold(다른 경계 계산)는 섞지 않는다
    expect('nextThreshold' in r.delayScenario!.scenarios![0]!.penalty).toBe(false);
  });

  it('오늘 공시 가정 + 3일 → 자진시정 면제 기간 요건은 충족하나 사유·재량이 함께 필요하다고 알린다 (과태료 고시 Ⅴ)', () => {
    const r = ok(checkDisclosureDuty(d09));
    const s = r.delayScenario!.selfCorrection!;
    expect(s).toContain('10영업일');
    expect(s).toContain('사소한 부주의');
    expect(s).toContain('재량');
  });

  it('의결 여부 미입력이면 "의결 O" 로 가정하지 않고 두 시나리오를 나란히 보인다', () => {
    const { boardResolution: _b, ...rest } = d09;
    const r = ok(checkDisclosureDuty(rest));
    const sc = r.delayScenario!.scenarios!;
    expect(sc.map((x) => x.boardResolution)).toEqual(['passed', 'not_passed']);
    expect(sc[1]!.penalty.amount).toBeGreaterThan(sc[0]!.penalty.amount);
    expect(r.notes.some((n) => n.includes('boardResolution') && n.startsWith('⚠️'))).toBe(true);
  });

  it('영업일 N일은 금액을 만들지 않는다 — 달력일로 짧게 잡으면 과소 산정', () => {
    const r = ok(checkDisclosureDuty({ ...d09, delayDayBasis: 'business' }));
    expect(r.delayScenario?.status).toBe('withheld');
    expect(r.delayScenario?.scenarios).toBeUndefined();
    // 영업일 3일 ≤ 10 이면 자진시정 기간 요건은 판단 가능
    expect(r.delayScenario?.selfCorrection).toContain('충족');
  });

  it('단위 미입력이면 달력일로 가정하고 ⚠️ 로 알린다', () => {
    const { delayDayBasis: _d, ...rest } = d09;
    const r = ok(checkDisclosureDuty(rest));
    expect(r.delayScenario?.basis).toBe('unknown');
    expect(r.notes.some((n) => n.startsWith('⚠️') && n.includes('delayDayBasis'))).toBe(true);
  });

  it('날짜로 계산한 지연과 다르면 조용히 덮지 않고 불일치를 표시한다', () => {
    const r = ok(
      checkDisclosureDuty({
        ...d09,
        boardDate: '20260722', // 상장 3영업일 → 7/27
        actualDisclosureDate: '20260729', // 달력일 2일 지연
      }),
    );
    expect(r.compliance?.delayDays).toBe(2);
    expect(r.delayScenario?.status).toBe('withheld');
    expect(r.notes.some((n) => n.startsWith('⚠️') && n.includes('다릅니다'))).toBe(true);
    // 날짜 기반 과태료는 그대로 남는다
    expect(r.penalty).toBeDefined();
  });

  it('날짜와 일치하면 날짜 기반 결과를 쓰라고만 한다', () => {
    const r = ok(
      checkDisclosureDuty({ ...d09, delayDays: 2, boardDate: '20260722', actualDisclosureDate: '20260729' }),
    );
    expect(r.delayScenario?.status).toBe('consistent_with_dates');
  });

  it('대상이 아니면 지연·과태료를 만들지 않는다', () => {
    const r = ok(checkDisclosureDuty({ ...d09, amount: 5 * 억 }));
    expect(r.verdict).toBe('not_required');
    expect(r.delayScenario).toBeUndefined();
  });

  it('비상장 중요사항(법 제27조)은 의결 칸 없이 한 시나리오 — 100만원 + 1일 5만원', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'unlisted_material',
        materialItem: 'capital_change',
        delayDays: 5,
        delayDayBasis: 'calendar',
        delayFilingState: 'filed',
      }),
    );
    const sc = r.delayScenario!.scenarios!;
    expect(sc).toHaveLength(1);
    expect(sc[0]!.boardResolution).toBe('not_required');
    expect(sc[0]!.penalty.basicTotal).toBe(125 * 만);
    // 이미 제출한 사건에는 자진시정 기간 안내를 붙이지 않는다 (최초 공시 지연 ≠ 재공시)
    expect(r.delayScenario?.selfCorrection).toBeUndefined();
  });
});
