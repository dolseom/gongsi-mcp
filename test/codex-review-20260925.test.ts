/**
 * Codex 적대적 코드 리뷰(2026-09-25, 범위 80f9b91..78cb624) 결함 재현·수정 테스트.
 * 각 describe 의 번호는 리뷰 번호다. 재현 입력은 리뷰가 제시한 JSON 을 그대로 쓴다.
 */

import { describe, it, expect } from 'vitest';
import { checkDisclosureDuty, checkDisclosureDutyInput } from '../src/tools/check-disclosure-duty.js';
import { estimatePenalty } from '../src/rules/penalties.js';
import { loadManualKb, searchManual } from '../src/kb/manual.js';
import { searchFtcQna } from '../src/tools/search-ftc-qna.js';
import { hasIncorporationSignal } from '../src/tools/duty/lit-conditions.js';

const 억 = 100_000_000;

function run(input: Record<string, unknown>) {
  const r = checkDisclosureDuty(checkDisclosureDutyInput.parse(input));
  if ('error' in r) throw new Error(`예상치 못한 에러 응답: ${r.error} ${r.message}`);
  return r;
}
const fields = (r: { missing_inputs: Array<{ field: string }> }) => r.missing_inputs.map((m) => m.field);

describe('1. [치명] 같은 날 합계를 줬는데 거래시장이 없다고 합계를 버리지 않는다 (lit26-043)', () => {
  it('건별 1억 + 같은 날 합계 150억 → 합계로 판정 (대상)', () => {
    const r = run({ duty: 'large_internal_transaction', amount: 1 * 억, sameDayStockTotal: 150 * 억 });
    expect(r.verdict).toBe('required');
    expect(r.notes.join(' ')).toContain('lit26-043');
  });
});

describe('2. [치명] 공익법인 + 국외 상대방 — 소속 국내회사 주식 여부 확인 전엔 비대상 확정 금지', () => {
  const base = {
    duty: 'public_interest_corp',
    amount: 150 * 억,
    counterpartyForeignAffiliate: true,
    forSpecialRelatedParty: false,
  };
  it('picGroupShareTrade 미입력 → insufficient_data + picGroupShareTrade 요청', () => {
    const r = run({ ...base, situation: '국외 계열회사로부터 소속 국내회사 주식 취득' });
    expect(r.verdict).toBe('insufficient_data');
    expect(fields(r)).toContain('picGroupShareTrade');
  });
  it('picGroupShareTrade:false 면 국외 직접 거래 제외 확정', () => {
    expect(run({ ...base, picGroupShareTrade: false }).verdict).toBe('not_required');
  });
  it('일반 회사(대규모내부거래)는 종전대로 국외 직접 거래 제외', () => {
    expect(run({ ...base, duty: 'large_internal_transaction' }).verdict).toBe('not_required');
  });
});

describe('3. [치명] 미공시 상태의 delayDays 도 기한·오늘 날짜와 대조한다', () => {
  const base = {
    duty: 'large_internal_transaction',
    amount: 150 * 억,
    listing: 'listed',
    boardDate: '20260601',
    boardResolution: true,
    today: '20260630',
    disclosureStatus: 'not_disclosed',
    delayDayBasis: 'calendar',
    delayFilingState: 'not_yet_filed',
  };
  it('기한 20260605 → 오늘 20260630 은 25일인데 3일로 신고 → 산정 보류, 면제 기간 충족 문구 없음', () => {
    const r = run({ ...base, delayDays: 3 });
    expect(r.delayScenario?.status).toBe('withheld');
    expect(r.summary).not.toMatch(/예상 과태료/);
    expect(JSON.stringify(r.delayScenario)).not.toContain('기간 요건');
  });
  it('날짜와 일치하는 25일이면 consistent_with_dates', () => {
    expect(run({ ...base, delayDays: 25 }).delayScenario?.status).toBe('consistent_with_dates');
  });
});

describe('4. [치명] 제출 시각 처리가 불확실하면 준수를 확정하지 않는다', () => {
  it('기업집단현황 기한 당일 정각 18:00 → onTimeConditional + 요약에 미확정', () => {
    const r = run({ duty: 'group_status', year: 2026, actualDisclosureDate: '20260601', actualDisclosureTime: '18:00' });
    expect(r.compliance?.onTimeConditional).toMatch(/정각 18:00/);
    expect(r.summary).toContain('최종 준수는 미확정');
    expect(r.review.unresolved.join(' ')).toContain('기한 준수 미확정');
  });
  it('기한 당일 시각 미입력도 조건부', () => {
    const r = run({ duty: 'group_status', year: 2026, actualDisclosureDate: '20260601' });
    expect(r.compliance?.onTimeConditional).toBeDefined();
  });
  it('대규모내부거래 기한 당일 18:01 → 날짜 이동은 안 하지만(원문 미확인) 준수는 조건부', () => {
    const r = run({
      duty: 'large_internal_transaction',
      boardDate: '20260601',
      listing: 'listed',
      amount: 150 * 억,
      actualDisclosureDate: '20260605',
      actualDisclosureTime: '18:01',
    });
    expect(r.compliance?.onTime).toBe(true);
    expect(r.compliance?.onTimeConditional).toMatch(/원문 미확인/);
  });
  it('기한 전날 제출·18:00 전 제출은 확정 (조건 없음)', () => {
    const r = run({ duty: 'group_status', year: 2026, actualDisclosureDate: '20260601', actualDisclosureTime: '17:59' });
    expect(r.compliance?.onTime).toBe(true);
    expect(r.compliance?.onTimeConditional).toBeUndefined();
  });
});

describe('5. [치명] 약관 금융거래 — 계산 가능한 기한 하나로 공시 종류를 추정하지 않는다', () => {
  it('omnibusFiling 미지정 + 실제 공시일 → 준수 판정 보류', () => {
    const r = run({
      duty: 'omnibus_financial',
      isFinancialCompany: false,
      standardTermsContract: true,
      shortTermDemandProduct: true,
      listing: 'listed',
      transactionDate: '20260401',
      actualDisclosureDate: '20260410',
      boardResolution: true,
      situation: '분기 사전 이사회 의결내용을 4월 10일에 공시했습니다',
    });
    expect(r.compliance).toBeUndefined();
    expect(fields(r)).toContain('omnibusFiling');
  });
});

describe('6·11. 관련 문답 개정판 대체 — 조건이 다르거나 답변이 없는 항목으로 바꾸지 않는다', () => {
  it('지분율 조건이 다른 2008판(lit-094)을 2026판(lit26-066)으로 대체하지 않는다', () => {
    const r = run({
      duty: 'large_internal_transaction',
      amount: 150 * 억,
      situation:
        'A사 발행주식의 30%를, C사 발행주식의 25%를 소유하고, A사는 B사 발행주식의 51% 동일인 및 친족은 25% 모두 비상장법인 상품용역거래',
    });
    const qs = (r.relatedOfficialQna ?? []).map((q) => q.question);
    expect(qs.some((q) => q.includes('A사 발행주식의 30%를'))).toBe(true);
  });
  it('답변 있는 문답(2015 보험 자산운용)을 답변 null 인 2016 아카이브로 대체하지 않는다', () => {
    const r = run({ duty: 'large_internal_transaction', amount: 150 * 억, situation: '보험회사에서 자산운용차원에서 금융거래' });
    const first = (r.relatedOfficialQna ?? [])[0];
    expect(first?.answer).toContain('약관에 의한 금융거래에 포함됨');
  });
});

describe('7. 매뉴얼 기재요령 — 표지 다음 줄까지 이어 담는다', () => {
  it('임원현황 기재요령에 "중임된 경우는 최초 취임일" 이 들어 있다', () => {
    const kb = loadManualKb();
    const hit = kb.passages.find((p) => p.docKey === 'group_affiliate' && p.text.includes('중임된 경우는 최초 취임일'));
    expect(hit?.kind).toBe('form_note');
  });
});

describe('8. 매뉴얼 약한 일치 — 희소 낱말 하나로 걸린 구절은 weak 로 표시', () => {
  it('"점심 메뉴 추천" → 전부 weak, 안내문이 "관련 구절을 찾았다"고 하지 않는다', () => {
    const m = searchManual('점심 메뉴 추천');
    expect(m.every((x) => x.weak)).toBe(true);
    const r = searchFtcQna({ query: '점심 메뉴 추천', manual_limit: 3 });
    expect(r.notes[0]).not.toContain('관련 구절');
    expect(r.manualPassages.every((p) => p.weak_match)).toBe(true);
  });
  it('실무 질의는 weak 가 아니다', () => {
    const top = searchManual('현황공시 6시 넘어서 제출')[0];
    expect(top?.weak).toBeUndefined();
  });
  it('"비상장회사 공시의무" 최상위가 도입배경("특별한 공시의무가 없음")이 아니다', () => {
    const top = searchManual('비상장회사 공시의무', { limit: 1 })[0];
    expect(top?.passage.heading).not.toMatch(/도입배경/);
  });
});

describe('9. 자회사 설립 신호 — "공장 신설" 은 신호가 아니다 (하위호환)', () => {
  it('공장 신설을 위한 자금 대여 → 종전대로 required', () => {
    const r = run({
      duty: 'large_internal_transaction',
      amount: 150 * 억,
      totalEquity: 2000 * 억,
      paidInCapital: 100 * 억,
      situation: '기존 계열사의 공장 신설을 위한 자금 대여',
    });
    expect(r.verdict).toBe('required');
    expect(fields(r)).not.toContain('subsidiaryIncorporation');
  });
  it.each([
    ['100% 자회사를 새로 설립하면서 50억 출자', true],
    ['신설 법인에 출자', true],
    ['합작법인 설립 출자', true],
    ['기존 계열사의 공장 신설을 위한 자금 대여', false],
    ['물류센터 신설 공사 도급', false],
  ])('"%s" → %s', (s, want) => {
    expect(hasIncorporationSignal(s)).toBe(want);
  });
});

describe('10. 비상장 최대주주 구성원 간 1%p 이동은 합계 입력 없이도 충분조건', () => {
  it('memberShareShiftPct 5 + shareChangePct 미입력 → required', () => {
    const r = run({
      duty: 'unlisted_material',
      listing: 'unlisted',
      isFinancialCompany: false,
      totalAssets: 150 * 억,
      materialItem: 'shareholding_change',
      shareholderType: 'largest',
      memberShareShiftPct: 5,
    });
    expect(r.verdict).toBe('required');
    expect(fields(r)).not.toContain('shareChangePct');
  });
  it('주요주주(major)는 구성원 규칙이 없다 — 합계 요청 유지', () => {
    const r = run({
      duty: 'unlisted_material',
      listing: 'unlisted',
      isFinancialCompany: false,
      totalAssets: 150 * 억,
      materialItem: 'shareholding_change',
      shareholderType: 'major',
      memberShareShiftPct: 5,
    });
    expect(r.verdict).toBe('insufficient_data');
  });
});

describe('12. 보완 사건은 최초 공시지연 감경 경계를 전망하지 않는다', () => {
  it('filingDelayDays 3 + 보완 경과 20일 → nextThreshold 없음', () => {
    const p = estimatePenalty({
      regime: 'art27_28',
      disclosed: true,
      onTime: false,
      hasOmissionOrFalse: true,
      supplemented: true,
      filingDelayDays: 3,
      supplementationElapsedDays: 20,
    });
    expect(p.nextThreshold).toBeUndefined();
  });
});

describe('b2a f02 (Codex 4차 판정) — 비상장 타법인 주식: 발행회사가 계열회사면 이 항목이 아니다', () => {
  const base = {
    duty: 'unlisted_material',
    listing: 'unlisted',
    isFinancialCompany: false,
    totalAssets: 1000 * 억,
    materialItem: 'other_corp_stock',
    totalEquity: 100 * 억,
    amount: 9 * 억,
  };
  it('계열 여부 미입력 + 금액 이상 → required 확정 대신 조건부', () => {
    const r = run(base);
    expect(r.verdict).toBe('insufficient_data');
    expect(fields(r)).toContain('issuerIsAffiliate');
  });
  it('발행회사가 계열회사 → 이 항목 비대상 + 대규모내부거래 안내', () => {
    const r = run({ ...base, issuerIsAffiliate: true });
    expect(r.verdict).toBe('not_required');
    expect(r.summary).toContain('large_internal_transaction');
  });
  it('계열회사 아님 → 금액 기준대로 required', () => {
    expect(run({ ...base, issuerIsAffiliate: false }).verdict).toBe('required');
  });
  it('금액 미달이면 계열 여부와 무관하게 not_required', () => {
    expect(run({ ...base, amount: 1 * 억 }).verdict).toBe('not_required');
  });
});

describe('held-out 기준선(2026-09-26)에서 나온 일반 개선', () => {
  it('매뉴얼 구절은 통째로 준다 — 구절 끝의 예외 문장까지 (h013 "출연금·기부금 … 공시대상이 아님")', () => {
    const r = searchFtcQna({ query: '재단 출연금 기부금 공시대상', manual_limit: 5 });
    expect(r.manualPassages.some((p) => p.truncated)).toBe(false);
  });
  it('대규모내부거래 금액 미확인(insufficient)이어도 상대방 요건을 다음 행동·미확인에 넣는다 (h001·h011)', () => {
    const r = run({ duty: 'large_internal_transaction', situation: '모회사로부터 운영자금 차입' });
    expect(r.verdict).toBe('insufficient_data');
    expect(r.review.next_actions.join(' ')).toMatch(/국외 계열회사/);
    expect(r.review.unresolved.join(' ')).toMatch(/상대방이 특수관계인/);
  });
});
