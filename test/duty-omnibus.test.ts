/**
 * 약관 금융거래 특례(고시 제9조) 경로 재설계 회귀 — B→A 평가 d04·c11, Codex 적대 검토 §1.
 * 테스트 설명에 원문을 인용한다 (대규모내부거래 고시 제9조, 공정위 매뉴얼 2026-04 11-1절).
 */

import { describe, it, expect } from 'vitest';
import { checkDisclosureDuty } from '../src/tools/check-disclosure-duty.js';

const 억 = 100_000_000;

function ok(r: ReturnType<typeof checkDisclosureDuty>) {
  if ('error' in r) throw new Error(`예상치 못한 에러 응답: ${r.error} ${r.message}`);
  return r;
}

describe('약관 금융거래 경로 재설계 — 고시 제9조 (P0-1)', () => {
  it('d04: 제조업 상장사가 계열 증권사 CMA 에 약관대로 입출금 → 의결 면제 아님, 분기별 일괄 사전 의결 가능 — 제9조제2항 "제1항에 해당하지 않는 사유로 계열 금융회사와 약관에 의한 금융거래행위를 하고자 하는 때에는 이사회 의결을 분기별로 일괄하여 할 수 있다"', () => {
    const r = ok(
      checkDisclosureDuty({ duty: 'omnibus_financial', isFinancialCompany: false, listing: 'listed' }),
    );
    expect(r.omnibus?.path).toBe('affiliate_terms');
    expect(r.omnibus?.boardResolutionRequired).toBe(true);
    expect(r.summary).toContain('이사회 의결이 필요합니다');
    expect(r.summary).toContain('분기별로');
    expect(r.summary).not.toContain('의결이 필요 없습니다');
    // 단기금융상품 여부(제9조제5항 세 요건)를 되묻는다 — 공시 시기가 갈린다
    const st = r.missing_inputs.find((m) => m.field === 'shortTermDemandProduct');
    expect(st?.purpose).toBe('deadline');
    // 수익증권 여부 미입력이면 1년 일괄은 수익증권만이라는 조건을 붙인다 (제9조제2항 단서)
    const board = r.omnibus!.scenarios[0]!.boardResolution;
    expect(board).toContain('수익증권');
    expect(board).toContain('1년');
  });

  it('금융·보험회사라도 일상적 거래분야가 아니면 제9조제2항 경로 — 매뉴얼 "C사의 일상적인 거래분야에서의 거래행위가 아니라면 거래건별로 이사회의결 및 공시하거나 금융·보험사가 아닌 회사에 대한 특례를 적용할 수도 있음"', () => {
    const r = ok(
      checkDisclosureDuty({ duty: 'omnibus_financial', isFinancialCompany: true, routineFinancialBusiness: false }),
    );
    expect(r.omnibus?.path).toBe('affiliate_terms');
    expect(r.omnibus?.boardResolutionRequired).toBe(true);
  });

  it('경로 미입력: 의결 불요를 단정하지 않고 두 경로를 조건부로, 늦은 공시일도 지연·과태료를 확정하지 않는다', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'omnibus_financial',
        listing: 'listed',
        transactionDate: '20260702',
        actualDisclosureDate: '20260810',
      }),
    );
    expect(r.verdict).toBe('insufficient_data');
    expect(r.omnibus?.path).toBe('undetermined');
    expect(r.omnibus?.scenarios.map((s) => s.path)).toEqual(['financial_routine', 'affiliate_terms']);
    expect(r.compliance).toBeUndefined();
    expect(r.penalty).toBeUndefined();
    // 경로별 조건부 준수 여부는 준다: 경로 A 분기 기한(3분기 → 10월 중순) 안, 경로 B 원칙(3영업일)은 지연
    const a = r.omnibus!.scenarios[0]!.filings[0]!;
    expect(a.ifDisclosedOn?.onTime).toBe(true);
    const tx = r.omnibus!.scenarios[1]!.filings.find((f) => f.kind === 'transaction')!;
    expect(tx.ifDisclosedOn?.onTime).toBe(false);
  });

  it('제9조제4항 "해당 행위 후 3영업일 이내" — 상장사 거래일 7/1 → 7/6, 단기금융상품 미확인이면 지연 확정 안 함', () => {
    const base = {
      duty: 'omnibus_financial' as const,
      isFinancialCompany: false,
      listing: 'listed' as const,
      transactionDate: '20260701',
      actualDisclosureDate: '20260710',
      amount: 30 * 억,
    };
    const unknown = ok(checkDisclosureDuty(base));
    expect(unknown.deadline?.deadline).toBe('20260706');
    expect(unknown.omnibus?.mainDeadlineConditional).toBe(true);
    expect(unknown.compliance).toBeUndefined();
    expect(unknown.penalty).toBeUndefined();
    expect(unknown.notes.some((n) => n.includes('확정하지 않았습니다'))).toBe(true);

    // 세 요건을 충족하지 않는다고 확인되면 원칙 기한으로 지연 확정 + 과태료
    const notShort = ok(checkDisclosureDuty({ ...base, shortTermDemandProduct: false }));
    expect(notShort.compliance?.onTime).toBe(false);
    expect(notShort.penalty).toBeDefined();

    // 제9조제5항 "만기와 중도환매수수료가 없고 수시입출금이 가능한 단기금융상품 … 익월 10영업일까지 분기별로 일괄하여 공시할 수 있다"
    const shortTerm = ok(checkDisclosureDuty({ ...base, shortTermDemandProduct: true }));
    expect(shortTerm.omnibus?.mainFiling).toBe('quarterly_option');
    expect(shortTerm.deadline?.deadline).toBe('20261016'); // 10/5 개천절 대체공휴일·10/9 한글날 제외
    expect(shortTerm.compliance?.onTime).toBe(true);
  });

  it('원칙 기한 안에 공시했으면 상품 속성과 무관하게 기한 내로 확정한다', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'omnibus_financial',
        isFinancialCompany: false,
        listing: 'listed',
        transactionDate: '20260701',
        actualDisclosureDate: '20260703',
      }),
    );
    expect(r.omnibus?.mainDeadlineConditional).toBe(false);
    expect(r.compliance?.onTime).toBe(true);
  });

  it('사전 의결내용 공시 — 매뉴얼 "미리 분기별로 일괄하여 이사회 의결을 거친 후 공시(의결 후 상장 3영업일, 비상장회사 및 공익법인 7영업일 이내)"', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'omnibus_financial',
        isFinancialCompany: false,
        listing: 'unlisted',
        boardDate: '20260625',
      }),
    );
    expect(r.omnibus?.mainFiling).toBe('resolution');
    expect(r.deadline?.businessDays).toBe(7);
    expect(r.deadline?.legalBasis[0]!.source).toContain('제9조제2항');
  });

  it('두 공시 기한을 다 계산할 수 있는데 공시일이 어느 공시인지 모르면 추측하지 않고 omnibusFiling 을 되묻는다', () => {
    const base = {
      duty: 'omnibus_financial' as const,
      isFinancialCompany: false,
      listing: 'listed' as const,
      boardDate: '20260625',
      transactionDate: '20260701',
      shortTermDemandProduct: false,
      actualDisclosureDate: '20260702',
    };
    const r = ok(checkDisclosureDuty(base));
    expect(r.missing_inputs.map((m) => m.field)).toContain('omnibusFiling');
    expect(r.compliance).toBeUndefined();
    const picked = ok(checkDisclosureDuty({ ...base, omnibusFiling: 'transaction' }));
    expect(picked.compliance?.onTime).toBe(true);
  });

  it('거래 후 공시일이 분기말보다 앞서도 거부하지 않는다 — 종전 하한(분기말 고정) 오류', () => {
    const r = checkDisclosureDuty({
      duty: 'omnibus_financial',
      isFinancialCompany: false,
      listing: 'listed',
      transactionDate: '20260701',
      quarterEnd: '20260930',
      shortTermDemandProduct: false,
      actualDisclosureDate: '20260702',
    });
    expect('error' in r).toBe(false);
  });

  it('거래일이 quarterEnd 분기에 없으면 오류 — 조용히 한쪽을 고르지 않는다', () => {
    const r = checkDisclosureDuty({
      duty: 'omnibus_financial',
      isFinancialCompany: false,
      transactionDate: '20260701',
      quarterEnd: '20260630',
    });
    expect('error' in r && r.error).toBe('invalid_argument');
  });

  it('약관거래가 아니면 특례 없음 — 매뉴얼 "거래당사자가 협의하여 거래조건을 정하는 경우는 약관에 의한 거래에 해당하지 않음"', () => {
    const r = ok(
      checkDisclosureDuty({ duty: 'omnibus_financial', standardTermsContract: false, isFinancialCompany: true }),
    );
    expect(r.omnibus?.path).toBe('not_standard_terms');
    expect(r.summary).toContain('large_internal_transaction');
    expect(r.verdict).toBe('insufficient_data');
  });

  it('금융사 일상업무 경로의 과태료는 의결 요건이 없으므로 "의결 X" 칸·의결 가정 caveat 를 쓰지 않는다 (제9조제1항)', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'omnibus_financial',
        isFinancialCompany: true,
        routineFinancialBusiness: true,
        quarterEnd: '20260630',
        actualDisclosureDate: '20260720',
        amount: 30 * 억,
      }),
    );
    expect(r.compliance?.onTime).toBe(false);
    const p = r.penalty as { caveats: string[]; formula: string };
    expect(p.formula).not.toContain('의결 X');
    expect(p.caveats.some((c) => c.includes('boardResolution'))).toBe(false);
  });

  it('[전제] 로 약관거래·대규모내부거래 요건을 review.assumptions 에 올린다 — 유형 선택만으로 대상 확정하지 않음', () => {
    const r = ok(
      checkDisclosureDuty({ duty: 'omnibus_financial', isFinancialCompany: false, listing: 'listed' }),
    );
    expect(r.review.assumptions.some((a) => a.includes('기준금액 미만'))).toBe(true);
    expect(r.review.assumptions.some((a) => a.includes('약관규제법'))).toBe(true);
  });
});
