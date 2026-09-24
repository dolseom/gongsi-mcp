/**
 * 묶음4(f01~f08) 원문 검증 + 추가 결함(8~11)에서 나온 check_disclosure_duty 결함 재현·수정 테스트.
 * 테스트 설명에 원문(고시·공정위 매뉴얼 2026-04·문답 lit26-*)을 인용한다.
 */

import { describe, it, expect } from 'vitest';
import { checkDisclosureDuty, checkDisclosureDutyInput } from '../src/tools/check-disclosure-duty.js';

const 억 = 100_000_000;

function ok(r: ReturnType<typeof checkDisclosureDuty>) {
  if ('error' in r) throw new Error(`예상치 못한 에러 응답: ${r.error} ${r.message}`);
  return r;
}
const fields = (r: { missing_inputs: Array<{ field: string }> }) => r.missing_inputs.map((m) => m.field);

describe('1. 주식 1일 합산 — lit26-043 "주식 거래의 경우에는 … 1일 매입 또는 매도 금액의 총합계를 1회 거래로 봄"', () => {
  const stock = {
    duty: 'large_internal_transaction' as const,
    amount: 3 * 억,
    totalEquity: 100 * 억,
    paidInCapital: 10 * 억,
    stockTradeVenue: 'off_exchange' as const,
    today: '20260924',
  };

  it('건별 3억 < 기준 5억이어도 같은 날 합계를 모르면 not_required 로 확정하지 않는다', () => {
    const r = ok(checkDisclosureDuty(stock));
    expect(r.verdict).toBe('insufficient_data');
    expect(fields(r)).toContain('sameDayStockTotal');
    expect(r.summary + r.notes.join(' ')).toContain('lit26-043');
  });

  it('같은 날 합계 9억 ≥ 기준 5억이면 대상', () => {
    const r = ok(checkDisclosureDuty({ ...stock, sameDayStockTotal: 9 * 억 }));
    expect(r.verdict).toBe('required');
    expect(r.summary).toContain('9억원');
  });

  it('같은 날 합계도 기준 미만이면 not_required', () => {
    const r = ok(checkDisclosureDuty({ ...stock, sameDayStockTotal: 3 * 억 }));
    expect(r.verdict).toBe('not_required');
  });

  it('매뉴얼 "동일 거래상대방과의 동일 거래대상에 대한 1건의 거래행위를 분할하여 거래하는 경우에는 이를 합산하여 1건의 거래행위로 봄" — 금액 미달 not_required 에 분할 합산 안내', () => {
    const r = ok(
      checkDisclosureDuty({ duty: 'large_internal_transaction', amount: 3 * 억, totalEquity: 100 * 억, paidInCapital: 10 * 억 }),
    );
    expect(r.verdict).toBe('not_required');
    expect(r.notes.join(' ')).toContain('분할하여 거래하는 경우에는 이를 합산');
  });
});

describe('2. DART 18:00 규칙 — 현황 소속회사용 매뉴얼 "18:00 이후에 제출할 경우 다음 업무 일에 공시한 것으로 처리됨", 비상장사 매뉴얼 "18:00 이후 제출 시 다음 업무일에 공시처리됨"', () => {
  it('기업집단현황: 기한 당일 공시(시각 미입력)면 "지켰습니다" 단정 대신 18:00 조건을 붙인다', () => {
    const r = ok(checkDisclosureDuty({ duty: 'group_status', year: 2026, quarter: 3, actualDisclosureDate: '20261130', today: '20260924' }));
    expect(r.deadline?.deadline).toBe('20261130');
    expect(r.summary).toContain('18:00');
  });

  it('기업집단현황: 기한 당일 18:30 제출이면 다음 업무일 공시로 보아 지연', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'group_status', year: 2026, quarter: 3, actualDisclosureDate: '20261130', actualDisclosureTime: '18:30', today: '20260924',
      }),
    );
    expect(r.compliance?.onTime).toBe(false);
    expect(r.compliance?.delayDays).toBeGreaterThan(0);
  });

  it('기업집단현황: 기한 당일 17:59 제출이면 기한 내', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'group_status', year: 2026, quarter: 3, actualDisclosureDate: '20261130', actualDisclosureTime: '17:59', today: '20260924',
      }),
    );
    expect(r.compliance?.onTime).toBe(true);
  });

  it('비상장 중요사항: 기한 당일 18:30 제출이면 지연', () => {
    const base = { duty: 'unlisted_material' as const, materialItem: 'capital_change' as const, occurredDate: '20260901', listing: 'unlisted' as const, today: '20260924' };
    const dl = ok(checkDisclosureDuty(base)).deadline!.deadline;
    const r = ok(checkDisclosureDuty({ ...base, actualDisclosureDate: dl, actualDisclosureTime: '18:30' }));
    expect(r.compliance?.onTime).toBe(false);
  });

  it('대규모내부거래: 매뉴얼에 18:00 기재가 없으므로 시각으로 지연을 확정하지 않고 "원문 미확인" 조건부', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction', amount: 30 * 억, totalEquity: 100 * 억, paidInCapital: 10 * 억, listing: 'listed',
        boardDate: '20260901', actualDisclosureDate: '20260904', actualDisclosureTime: '18:30', today: '20260924',
      }),
    );
    expect(r.compliance?.onTime).toBe(true);
    const all = r.notes.join(' ');
    expect(all).toContain('18:00');
    expect(all).toContain('원문 미확인');
  });

  it('기한 전 D-day 안내에도 "마지막 날은 18:00 전 제출"(현황·비상장)', () => {
    const r = ok(checkDisclosureDuty({ duty: 'group_status', year: 2026, quarter: 3, today: '20260924' }));
    expect(r.notes.join(' ')).toContain('18:00');
  });

  it('시각 형식이 틀리면 오류', () => {
    const p = checkDisclosureDutyInput.safeParse({ duty: 'group_status', actualDisclosureTime: '25:00' });
    expect(p.success).toBe(false);
  });
});

describe('3. 공익법인 주식 — 고시 제4조제2항제1호·제6항 단서, lit26-010 ※ "공익법인이 … 국내회사의 주식을 취득·처분하는 경우에는 거래상대방, 거래금액 등과 관계없이 이사회 의결 및 공시의무가 있음"', () => {
  const pic = { duty: 'public_interest_corp' as const, amount: 1 * 억, totalEquity: 500 * 억, paidInCapital: 10 * 억, today: '20260924' };
  it('장외 주식 거래 + picGroupShareTrade 미입력 + 금액 미달 → not_required 확정 금지', () => {
    const r = ok(checkDisclosureDuty({ ...pic, stockTradeVenue: 'off_exchange' }));
    expect(r.verdict).toBe('insufficient_data');
    expect(fields(r)).toContain('picGroupShareTrade');
  });
  it('장내 정규 매매도 같다 (단서 때문에 장내 제외가 적용되지 않을 수 있음)', () => {
    const r = ok(checkDisclosureDuty({ ...pic, stockTradeVenue: 'exchange_regular' }));
    expect(r.verdict).toBe('insufficient_data');
    expect(fields(r)).toContain('picGroupShareTrade');
  });
  it('picGroupShareTrade:false 면 금액대로 not_required', () => {
    const r = ok(checkDisclosureDuty({ ...pic, stockTradeVenue: 'off_exchange', picGroupShareTrade: false, sameDayStockTotal: 1 * 억 }));
    expect(r.verdict).toBe('not_required');
  });
});

describe('4. 자회사 설립 출자 — lit26-003 "자회사를 설립하기 위하여 출자하는 경우에는 특수관계인을 상대방으로 하거나 특수관계인을 위한 거래가 아니므로 … 이사회 의결 및 공시의무가 없음"', () => {
  const inv = { duty: 'large_internal_transaction' as const, amount: 50 * 억, totalEquity: 500 * 억, paidInCapital: 50 * 억, listing: 'listed' as const, today: '20260924' };
  it('subsidiaryIncorporation:true → not_required', () => {
    const r = ok(checkDisclosureDuty({ ...inv, subsidiaryIncorporation: true }));
    expect(r.verdict).toBe('not_required');
    expect(r.summary).toContain('lit26-003');
  });
  it('상황에 "설립"이 있고 입력이 없으면 required 확정 대신 조건 안내', () => {
    const r = ok(checkDisclosureDuty({ ...inv, situation: '100% 자회사를 새로 설립하면서 50억 출자' }));
    expect(r.verdict).toBe('insufficient_data');
    expect(fields(r)).toContain('subsidiaryIncorporation');
  });
  it('설립 이후 추가 출자는 lit26-003 범위 밖 — 원문 미확인 표시', () => {
    const r = ok(checkDisclosureDuty({ ...inv, subsidiaryIncorporation: true }));
    expect(r.notes.join(' ')).toMatch(/설립 이후.*원문 미확인/);
  });
});

describe('5. 이사회 불성립 회사 — lit26-041 "이사회를 구성할 수 없는 회사일 경우에는 대규모내부거래 이사회 의결 의무는 없으나 거래에 대한 공시의무는 있음 ※ 공시기한은 거래행위를 하기 전까지"', () => {
  const lit = { duty: 'large_internal_transaction' as const, amount: 30 * 억, totalEquity: 100 * 억, paidInCapital: 10 * 억, listing: 'unlisted' as const, today: '20260924' };
  it('noBoardCompany:true → 공시 대상, 의결 의무 없음, 기한은 거래 전까지 (의결일 기산 아님)', () => {
    const r = ok(checkDisclosureDuty({ ...lit, noBoardCompany: true }));
    expect(r.verdict).toBe('required');
    expect(r.summary).toContain('거래행위를 하기 전까지');
    expect(r.summary).not.toContain('이사회 사전 의결이 필요합니다');
    expect(fields(r)).not.toContain('boardDate');
    expect(r.deadline).toBeUndefined();
    expect(r.components.deadline.status).toBe('not_applicable');
    // 원문에 없는 주총 대체 요건을 권고하지 않는다
    expect(r.summary + r.notes.join(' ')).not.toMatch(/주주총회 결의(로|를) (대신|거쳐)/);
  });
  it('상황에 "이사가 1명" 신호가 있고 입력이 없으면 noBoardCompany 를 되묻는다', () => {
    const r = ok(checkDisclosureDuty({ ...lit, situation: '이사가 1명뿐이라 이사회 구성 불가' }));
    expect(fields(r)).toContain('noBoardCompany');
  });
});

describe('6·11. 거래금액 산정 안내', () => {
  const base = { duty: 'large_internal_transaction' as const, amount: 30 * 억, totalEquity: 100 * 억, paidInCapital: 10 * 억 };
  it('lit26-046 "부가가치세와 관리비는 포함되지 않음 다만 … 관리비가 매출로 인식이 된다면 거래금액에 포함"', () => {
    const r = ok(checkDisclosureDuty({ ...base, amountBasis: 'lease_annualized' }));
    expect(r.threshold?.amountBasisNote).toContain('관리비');
    expect(r.threshold?.amountBasisNote).toContain('lit26-046');
  });
  it('lit26-032 퇴직연금 "보험료 납입금액의 누적액이 … 납입할 시점 이전에 이사회 의결 및 공시" · lit26-039 "개인부담금액을 제외하고 회사부담금액을 기준"', () => {
    const r = ok(checkDisclosureDuty({ ...base, amountBasis: 'insurance_premium_total' }));
    const n = r.threshold?.amountBasisNote ?? '';
    expect(n).toContain('lit26-032');
    expect(n).toContain('회사부담');
    expect(n).toContain('원문 미확인');
  });
});

describe('7. relatedOfficialQna — 연도만 다른 같은 문답은 최신판 하나만', () => {
  it('자회사 설립 출자 문답(2009·2015·2026판)은 한 칸만, 그것은 2026판', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction', amount: 50 * 억, totalEquity: 500 * 억, paidInCapital: 50 * 억, today: '20260924',
        situation: '100% 자회사를 새로 설립하면서 50억 출자',
      }),
    );
    const hits = (r.relatedOfficialQna ?? []).filter((q) => q.question.includes('자회사를 설립'));
    expect(hits.length).toBe(1);
    expect(hits[0]!.source.docYear).toBe(2026);
  });
  it('외국인 이사 문답(2009·2015·2026판)도 한 칸만', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction', amount: 30 * 억, totalEquity: 100 * 억, paidInCapital: 10 * 억, today: '20260924',
        situation: '이사가 1명뿐이라 이사회 구성 불가 주총으로 대신',
      }),
    );
    const hits = (r.relatedOfficialQna ?? []).filter((q) => q.question.includes('외국인 이사'));
    expect(hits.length).toBeLessThanOrEqual(1);
  });
});

describe('8. 최대주주 구성원 간 변동 — 비상장사 매뉴얼 "동일인측 최대주주(동일인 및 동일인 관련자)의 주식수나 지분율 합계의 변동이 없더라도 그 구성원 간 주식의 비율이 100분의 1이상 변동이 있을 때에는 공시"', () => {
  const sh = { duty: 'unlisted_material' as const, materialItem: 'shareholding_change' as const, occurredDate: '20260901', listing: 'unlisted' as const, today: '20260924' };
  it('최대주주 합계 0%p 만 주면 not_required 확정 금지', () => {
    const r = ok(checkDisclosureDuty({ ...sh, shareholderType: 'largest', shareChangePct: 0 }));
    expect(r.verdict).toBe('insufficient_data');
    expect(fields(r)).toContain('memberShareShiftPct');
  });
  it('구성원 간 1.5%p 이동이면 합계 0 이어도 대상', () => {
    const r = ok(checkDisclosureDuty({ ...sh, shareholderType: 'largest', shareChangePct: 0, memberShareShiftPct: 1.5 }));
    expect(r.verdict).toBe('required');
  });
  it('구성원 간 이동도 1%p 미만이면 not_required', () => {
    const r = ok(checkDisclosureDuty({ ...sh, shareholderType: 'largest', shareChangePct: 0.2, memberShareShiftPct: 0.3 }));
    expect(r.verdict).toBe('not_required');
  });
  it('주요주주는 구성원 간 규칙이 없다', () => {
    const r = ok(checkDisclosureDuty({ ...sh, shareholderType: 'major', shareChangePct: 0.5 }));
    expect(r.verdict).toBe('not_required');
  });
  it('shareholderType 설명에 "최대주주 = 동일인 및 동일인관련자" 정의 (주요주주 분기공시는 최대주주 측 제외)', () => {
    const d = checkDisclosureDutyInput.shape.shareholderType.description ?? '';
    expect(d).toContain('동일인관련자');
    expect(d).toContain('제외');
  });
});

describe('9. 공익법인 기한 — 고시 제6조제1항 "상장회사가 아니거나 공익법인인 경우에는 … 이사회 의결 후 7영업일 이내"', () => {
  const pic = { duty: 'public_interest_corp' as const, amount: 30 * 억, totalEquity: 100 * 억, paidInCapital: 10 * 억, boardDate: '20260901', today: '20260924' };
  it('listing 없이도 7영업일 기한을 계산하고 listing 을 묻지 않는다', () => {
    const r = ok(checkDisclosureDuty(pic));
    expect(fields(r)).not.toContain('listing');
    expect(r.deadline?.businessDays).toBe(7);
  });
  it('listing:listed 를 넣어도 공익법인은 7영업일', () => {
    const r = ok(checkDisclosureDuty({ ...pic, listing: 'listed' }));
    expect(r.deadline?.businessDays).toBe(7);
  });
});

describe('10. 고시 제10조 "자본시장법에 따라 신고·공시하면 본 규정에 따른 공시의무를 이행한 것으로 본다. 다만, 공정거래법상의 공시의무사항에도 해당되는 사항임을 표시"', () => {
  it('대규모내부거래 대상 판정에 제10조 안내', () => {
    const r = ok(checkDisclosureDuty({ duty: 'large_internal_transaction', amount: 30 * 억, totalEquity: 100 * 억, paidInCapital: 10 * 억 }));
    const all = r.notes.join(' ');
    expect(all).toContain('제10조');
    expect(all).toContain('이사회 의결');
  });
});
