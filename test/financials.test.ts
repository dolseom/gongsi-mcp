/**
 * get_financials 정규화 로직 테스트 — financial.py 이식분의 핵심 회귀 고정
 */

import { describe, expect, it } from 'vitest';
import {
  comparisonFields,
  extractKeyMetrics,
  normalizeAccount,
  parseAmount,
} from '../src/tools/get-financials.js';

describe('금액 파싱', () => {
  it('쉼표·괄호 음수·결측 표기를 처리한다', () => {
    expect(parseAmount('1,234,567')).toBe(1_234_567);
    expect(parseAmount('(123)')).toBe(-123);
    expect(parseAmount('-500')).toBe(-500);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('-')).toBeNull();
    expect(parseAmount('N/A')).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });

  it('해석 불가는 조용히 0 이 아니라 예외다', () => {
    expect(() => parseAmount('abc')).toThrow('금액으로 해석할 수 없습니다');
  });
});

describe('전기 대비 증감 — flow 누적 필드 폴백 (v0.6.0 버그픽스 이식)', () => {
  it('BS 는 당기/전기 필드를 쓴다', () => {
    const a = normalizeAccount(
      { sj_div: 'BS', account_nm: '자산총계', thstrm_amount: '200', frmtrm_amount: '100' },
      1,
    );
    expect(a.change).not.toBeNull();
    expect(a.change!.amount).toBe(100);
    expect(a.change!.rate_percent).toBe(100);
    expect(a.change!.current_field).toBe('thstrm_amount');
  });

  it('IS 는 누적 필드가 둘 다 있으면 누적 기준이다', () => {
    const fields = comparisonFields('IS', {
      thstrm_add_amount: { raw: '300', value: 300, display: 300 },
      frmtrm_add_amount: { raw: '150', value: 150, display: 150 },
    });
    expect(fields).toEqual(['thstrm_add_amount', 'frmtrm_add_amount']);
  });

  it('사업보고서가 thstrm_add_amount="" 로 오면 당기/전기로 폴백한다 — 없으면 연간 증감 전멸', () => {
    const a = normalizeAccount(
      {
        sj_div: 'IS',
        account_nm: '매출액',
        thstrm_amount: '1000',
        thstrm_add_amount: '',
        frmtrm_amount: '800',
        frmtrm_add_amount: '750',
      },
      1,
    );
    expect(a.change).not.toBeNull();
    expect(a.change!.current_field).toBe('thstrm_amount');
    expect(a.change!.amount).toBe(200);
  });

  it('raw 는 원문 그대로, display 만 단위 환산한다', () => {
    const a = normalizeAccount(
      { sj_div: 'BS', account_nm: '자본총계', thstrm_amount: '1,500,000,000' },
      1_000_000,
    );
    expect(a.amounts['thstrm_amount']!.raw).toBe('1,500,000,000');
    expect(a.amounts['thstrm_amount']!.value).toBe(1_500_000_000);
    expect(a.amounts['thstrm_amount']!.display).toBe(1_500);
  });
});

describe('판정용 핵심 지표 추출', () => {
  it('자본총계·자본금·자산총계를 BS 에서 뽑는다 (account_id 우선, 이름 폴백)', () => {
    const bs = [
      { sj_div: 'BS', account_id: 'ifrs-full_Equity', account_nm: '자본총계', thstrm_amount: '5000000000' },
      { sj_div: 'BS', account_id: '-표준계정코드 미사용-', account_nm: '자 본 금', thstrm_amount: '1000000000' },
      { sj_div: 'BS', account_id: 'ifrs-full_Assets', account_nm: '자산총계', thstrm_amount: '9000000000' },
    ].map((r) => normalizeAccount(r, 1));
    const m = extractKeyMetrics(bs);
    expect(m['total_equity']).toBe(5_000_000_000);
    expect(m['paid_in_capital']).toBe(1_000_000_000); // 공백 낀 이름도 잡는다
    expect(m['total_assets']).toBe(9_000_000_000);
  });

  it('연결(CFS) 값에는 "그대로 쓸 수 있다"고 말하지 않는다 (P2-마 21)', () => {
    // 연결 자본총계는 비지배지분 포함이라 기준금액이 과대해져 "공시의무 없음"으로 기우는 위험 방향
    const bs = [
      { sj_div: 'BS', account_id: 'ifrs-full_Equity', account_nm: '자본총계', thstrm_amount: '5000000000' },
    ].map((r) => normalizeAccount(r, 1));
    const cfs = extractKeyMetrics(bs, { fsDiv: 'CFS', report: 'annual' });
    expect(String(cfs['note'])).not.toContain('그대로 쓸 수 있습니다');
    expect((cfs['caveats'] as string[]).join(' ')).toContain('연결');

    const quarterly = extractKeyMetrics(bs, { fsDiv: 'OFS', report: 'q1' });
    expect((quarterly['caveats'] as string[]).join(' ')).toContain('사업연도말');

    // 별도 + 연차만 무조건 문구를 유지한다
    const ofsAnnual = extractKeyMetrics(bs, { fsDiv: 'OFS', report: 'annual' });
    expect(String(ofsAnnual['note'])).toContain('그대로 쓸 수 있습니다');
    expect(ofsAnnual['caveats']).toBeUndefined();
  });
});
