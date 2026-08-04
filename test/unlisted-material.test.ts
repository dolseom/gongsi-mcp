import { describe, expect, it } from 'vitest';
import { checkUnlistedSubjectCompany } from '../src/rules/unlisted-material.js';
import { unlistedMajorShareholderDeadline } from '../src/rules/deadlines.js';
import { checkDisclosureDuty } from '../src/tools/check-disclosure-duty.js';
import { 억 } from '../src/rules/thresholds.js';

describe('비상장사 중요사항 — 대상회사 판정 (고시 §2②)', () => {
  it('자산총액 100억 이상이면 대상이다', () => {
    const r = checkUnlistedSubjectCompany({ totalAssets: 100 * 억 });
    expect(r.subject).toBe(true);
  });

  it('상장회사는 제외된다', () => {
    const r = checkUnlistedSubjectCompany({ isListed: true, totalAssets: 500 * 억 });
    expect(r.subject).toBe(false);
  });

  it('금융·보험사는 제외된다', () => {
    const r = checkUnlistedSubjectCompany({ isFinancialOrInsurance: true, totalAssets: 500 * 억 });
    expect(r.subject).toBe(false);
  });

  it('자산 100억 미만 + 동일인·친족 20% 소유면 대상이다 (§2②2호)', () => {
    const r = checkUnlistedSubjectCompany({ totalAssets: 50 * 억, specialRelated20pct: true });
    expect(r.subject).toBe(true);
  });

  it('자산 100억 미만 + 20% 소유 미해당이면 대상이 아니다', () => {
    const r = checkUnlistedSubjectCompany({ totalAssets: 50 * 억, specialRelated20pct: false });
    expect(r.subject).toBe(false);
  });

  it('20% 소유 경로라도 청산·휴업 중이면 제외된다 (§2②2호 단서)', () => {
    const r = checkUnlistedSubjectCompany({
      totalAssets: 50 * 억,
      specialRelated20pct: true,
      inLiquidationOrDormant: true,
    });
    expect(r.subject).toBe(false);
  });

  it('자산 100억 이상은 청산·휴업이어도 제외되지 않는다 (단서는 2호에만 붙는다)', () => {
    const r = checkUnlistedSubjectCompany({ totalAssets: 200 * 억, inLiquidationOrDormant: true });
    expect(r.subject).toBe(true);
  });

  it('자산총액 미제공이면 insufficient_data', () => {
    expect(checkUnlistedSubjectCompany({}).subject).toBe('insufficient_data');
  });

  it('자산 100억 미만 + 지분 정보 미제공이면 insufficient_data', () => {
    expect(checkUnlistedSubjectCompany({ totalAssets: 50 * 억 }).subject).toBe('insufficient_data');
  });
});

describe('비상장사 중요사항 — 주요주주 분기 기한 (§5의2④ 단서)', () => {
  it('2분기 중 변동은 8/31 기한이다', () => {
    const d = unlistedMajorShareholderDeadline('20260515');
    expect(d.deadline).toBe('20260831');
  });

  it('4분기 중 변동은 익년 2월 말 기한 — 2/28(일)·3/1(삼일절) 넘어 3/2(화)', () => {
    const d = unlistedMajorShareholderDeadline('20261101');
    // 2027-02-28은 일요일, 3/1은 삼일절. 2027 공휴일 데이터 검증 완료(2026-08-05)로
    // 이월이 정확히 계산되고 데이터 없음 경고도 사라져야 한다.
    // (검증 전엔 3/1이 영업일로 취급돼 20270301 + 경고였다 — 데이터 추가로 교정된 케이스)
    expect(d.deadline).toBe('20270302');
    expect(d.warnings).toEqual([]);
  });
});

describe('check_disclosure_duty — 비상장사 중요사항 확장', () => {
  it('증자 결정은 금액 무관 공시 대상이다', () => {
    const r = checkDisclosureDuty({
      duty: 'unlisted_material',
      materialItem: 'capital_change',
      occurredDate: '20260722',
      totalAssets: 200 * 억,
    });
    if ('error' in r) throw new Error('예상치 못한 에러');
    expect(r.verdict).toBe('required');
    expect(r.summary).toContain('금액과 무관');
    expect(r.deadline?.deadline).toBe('20260731'); // 7영업일
  });

  it('최대주주 지분 1%p 이상 변동은 공시 대상, 미만은 아니다', () => {
    const yes = checkDisclosureDuty({
      duty: 'unlisted_material',
      materialItem: 'shareholding_change',
      shareholderType: 'largest',
      shareChangePct: 1.5,
      occurredDate: '20260722',
      totalAssets: 200 * 억,
    });
    if ('error' in yes) throw new Error('에러');
    expect(yes.verdict).toBe('required');

    const no = checkDisclosureDuty({
      duty: 'unlisted_material',
      materialItem: 'shareholding_change',
      shareholderType: 'largest',
      shareChangePct: 0.5,
      occurredDate: '20260722',
      totalAssets: 200 * 억,
    });
    if ('error' in no) throw new Error('에러');
    expect(no.verdict).toBe('not_required');
  });

  it('주요주주 지분변동은 분기별 기한으로 계산된다', () => {
    const r = checkDisclosureDuty({
      duty: 'unlisted_material',
      materialItem: 'shareholding_change',
      shareholderType: 'major',
      shareChangePct: 2,
      occurredDate: '20260515',
      totalAssets: 200 * 억,
    });
    if ('error' in r) throw new Error('에러');
    expect(r.deadline?.deadline).toBe('20260831');
    expect(r.deadline?.rule).toContain('분기');
  });

  it('상장회사는 대상회사가 아니라고 판정한다', () => {
    const r = checkDisclosureDuty({
      duty: 'unlisted_material',
      materialItem: 'gift',
      listing: 'listed',
      occurredDate: '20260722',
      amount: 10 * 억,
      totalEquity: 100 * 억,
      paidInCapital: 50 * 억,
    });
    if ('error' in r) throw new Error('에러');
    expect(r.verdict).toBe('not_required');
    expect(r.summary).toContain('공시대상비상장회사가 아닙니다');
  });

  it('자산 100억 미만 + 20% 미소유 회사도 대상이 아니다', () => {
    const r = checkDisclosureDuty({
      duty: 'unlisted_material',
      materialItem: 'gift',
      listing: 'unlisted',
      occurredDate: '20260722',
      amount: 10 * 억,
      totalAssets: 50 * 억,
      specialRelated20pct: false,
      totalEquity: 100 * 억,
      paidInCapital: 50 * 억,
    });
    if ('error' in r) throw new Error('에러');
    expect(r.verdict).toBe('not_required');
  });

  it('대상회사 정보가 없으면 판정은 유지하되 전제를 노트로 알린다', () => {
    const r = checkDisclosureDuty({
      duty: 'unlisted_material',
      materialItem: 'gift',
      occurredDate: '20260722',
      amount: 10 * 억,
      totalEquity: 100 * 억,
      paidInCapital: 50 * 억,
    });
    if ('error' in r) throw new Error('에러');
    expect(r.verdict).toBe('required');
    expect(r.notes.some((n) => n.includes('대상회사임을 전제'))).toBe(true);
  });

  it('shareholderType 미지정 지분변동은 에러다 — 유형에 따라 기한이 완전히 달라진다', () => {
    const r = checkDisclosureDuty({
      duty: 'unlisted_material',
      materialItem: 'shareholding_change',
      shareChangePct: 2,
      occurredDate: '20260722',
      totalAssets: 200 * 억,
    });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.message).toContain('shareholderType');
  });

  it('지분 감소(음수 입력)도 절댓값으로 판정한다', () => {
    const r = checkDisclosureDuty({
      duty: 'unlisted_material',
      materialItem: 'shareholding_change',
      shareholderType: 'largest',
      shareChangePct: -2,
      occurredDate: '20260722',
      totalAssets: 200 * 억,
    });
    if ('error' in r) throw new Error('에러');
    expect(r.verdict).toBe('required');
  });

  it('대상 아님(not_required) 판정에는 지연·과태료를 붙이지 않는다', () => {
    const r = checkDisclosureDuty({
      duty: 'unlisted_material',
      materialItem: 'gift',
      listing: 'listed',
      occurredDate: '20260701',
      actualDisclosureDate: '20260801',
      amount: 10 * 억,
      totalEquity: 100 * 억,
      paidInCapital: 50 * 억,
    });
    if ('error' in r) throw new Error('에러');
    expect(r.verdict).toBe('not_required');
    expect(r.compliance).toBeUndefined();
    expect(r.penalty).toBeUndefined();
  });
});
