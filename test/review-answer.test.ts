import { describe, expect, it } from 'vitest';
import { checkDisclosureDuty } from '../src/tools/check-disclosure-duty.js';

// review.answer — 모델이 요약·표를 새로 쓰지 않고 옮기게 하는 인용용 결론 블록 (held-out 조건 변경 대응, 2026-09-29)
function answerOf(input: Parameters<typeof checkDisclosureDuty>[0]): string {
  const r = checkDisclosureDuty(input);
  if ('error' in r) throw new Error('error 응답');
  return r.review.answer;
}

describe('review.answer 적용 요건 체크리스트', () => {
  it('비상장사 중요사항: 공시하는 회사 자신의 집단 소속을 요건으로 적고 입력 없으면 [미확인]', () => {
    const a = answerOf({ duty: 'unlisted_material', materialItem: 'other_corp_stock' });
    expect(a.startsWith('결론: ')).toBe(true);
    expect(a).toContain('[미확인] 공시하는 회사 **자신**이 공정위가 지정한 공시대상기업집단에 속하는 회사일 것');
    expect(a).toContain('거래상대방·주주·발행회사의 소속이 아니라');
    expect(a).toContain('다른 법인(계열회사는 제외한다)');
  });

  it('입력한 사실은 요건 상태에 반영된다 (상장=불충족, 자산 100억 이상=확인됨)', () => {
    const listed = answerOf({ duty: 'unlisted_material', materialItem: 'gift', listing: 'listed' });
    expect(listed).toContain('[불충족] 주권상장법인이 아닐 것');
    const big = answerOf({ duty: 'unlisted_material', materialItem: 'gift', listing: 'unlisted', totalAssets: 200e8 });
    expect(big).toContain('[확인됨] 주권상장법인이 아닐 것');
    expect(big).toContain('[확인됨] 다음 중 하나일 것');
  });

  it('최대주주 정의는 조건("최다출자자가 되는 경우") 포함 원문으로만 준다', () => {
    const a = answerOf({ duty: 'unlisted_material', materialItem: 'shareholding_change', shareholderType: 'largest' });
    expect(a).toContain('최다출자자가 되는 경우에는 그 동일인 및 동일인관련자를 포함한다');
    expect(a).toContain('동일인측이 최대주주가 아닌 경우에는');
    const full = JSON.stringify(checkDisclosureDuty({ duty: 'unlisted_material', materialItem: 'shareholding_change', shareholderType: 'largest' }));
    expect(full).not.toContain('동일인과 동일인관련자를 모두 포함');
  });

  it('대규모내부거래: 기준금액이 하한값이면 금액 요건을 확정하지 않는다', () => {
    const lower = answerOf({ duty: 'large_internal_transaction', amount: 80e8, totalEquity: 1200e8 });
    expect(lower).toContain('[미확인] 거래금액이 기준금액');
    const both = answerOf({ duty: 'large_internal_transaction', amount: 80e8, totalEquity: 1200e8, paidInCapital: 100e8 });
    expect(both).toContain('[확인됨] 거래금액이 기준금액');
    const below = answerOf({ duty: 'large_internal_transaction', amount: 3e8, totalEquity: 1200e8 });
    expect(below).toContain('[불충족] 거래금액이 기준금액');
  });

  it('대규모내부거래: 국외 계열 직접 거래(특수관계인을 위한 거래 아님)는 상대방 요건 불충족', () => {
    const a = answerOf({
      duty: 'large_internal_transaction',
      amount: 80e8,
      totalEquity: 1200e8,
      counterpartyForeignAffiliate: true,
      forSpecialRelatedParty: false,
    });
    expect(a).toContain('[불충족] "특수관계인(국외 계열회사는 제외한다');
  });
});

describe('[미확인] 요건이 남은 required 결론은 조건형 (외부 검토 2026-09-30 §3-3)', () => {
  const input = {
    duty: 'large_internal_transaction' as const,
    amount: 50e8,
    totalEquity: 500e8,
    paidInCapital: 100e8,
    listing: 'unlisted' as const,
    boardDate: '20260722',
    actualDisclosureDate: '20260810',
    today: '20260812',
  };
  it('summary·결론 줄이 단정하지 않고, 기한·과태료 줄에도 조건을 붙인다 — verdict 는 그대로', () => {
    const r = checkDisclosureDuty(input);
    if ('error' in r) throw new Error('error 응답');
    expect(r.verdict).toBe('required');
    expect(r.summary.startsWith('적용 요건 중 [미확인] ')).toBe(true);
    expect(r.summary).not.toMatch(/(^|[^경우 ])이사회 사전 의결이 필요합니다/);
    expect(r.summary).toContain('그 경우 이사회 사전 의결이 필요합니다');
    const a = r.review.answer;
    expect(a.split('\n')[0]).toContain('[요건 충족 시 공시 대상]');
    expect(a).toMatch(/^기한\(\[미확인\] 요건이 모두 충족될 경우\): /m);
    expect(a).toMatch(/^과태료\(\[미확인\] 요건이 모두 충족될 경우\)/m);
  });
  it('not_required 결론은 요건 미확인과 무관하게 그대로다', () => {
    const r = checkDisclosureDuty({ ...input, amount: 10e8 });
    if ('error' in r) throw new Error('error 응답');
    expect(r.verdict).toBe('not_required');
    expect(r.summary.startsWith('공시 대상이 아닙니다')).toBe(true);
  });
});
