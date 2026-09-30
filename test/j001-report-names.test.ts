/**
 * J001 보고서명 전수 기준선 (실측 2026-09-05, 전체시장 2024-01-01~2026-09-04).
 *
 * ★ 왜 이 픽스처가 있나 — 백로그였던 "취소↔원공시 연결 정밀화"의 **전제를 검증**하려고
 * 뽑았고, 그 전제가 틀렸음을 확인했다: J001 에 '공시취소' 보고서명은 **존재하지 않는다**.
 * 고시 §8①단서의 거래 취소는 별도 서식이 아니라 정정([기재정정])·변경 공시로 표현된다.
 *
 * 대신 같은 측정에서 **진짜 오탐 원인**이 나왔다 — 보고서명만으로 거래유형을 알 수 없는
 * 서식 두 종이 유형 필터를 통째로 빠져나간다 (isTypeAmbiguousReport 주석의 실물 참조).
 *
 * 이 테스트는 오프라인이다: 픽스처의 내적 정합성과, 그 위에서 성립하는 필터 계약을 고정한다.
 * 기간이 고정이고 rcept_dt 는 소급 추가되지 않으므로 재측정하면 같은 수치가 나와야 한다.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isTypeAmbiguousReport,
  isBorrowingReport,
  isLendingReport,
  isGoodsServicesReport,
  isSecuritiesReport,
} from '../src/tools/detect-undisclosed-transactions.js';

interface Fixture {
  _meta: { period: string; method: string };
  total_rows: number;
  per_window: Array<{ window: string; rows: number }>;
  cancellation_like_report_names: number;
  distinct_report_names: number;
  report_names: Array<{ name: string; count: number }>;
}

const fx = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'j001-report-names-2024-2026.json'), 'utf8'),
) as Fixture;

describe('J001 보고서명 전수 기준선 (2024-01-01~2026-09-04)', () => {
  it('픽스처가 내적으로 정합하다 (창별 합 = 총계 = 이름별 합)', () => {
    expect(fx._meta.period).toBe('20240101~20260904');
    expect(fx.per_window.reduce((a, w) => a + w.rows, 0)).toBe(fx.total_rows);
    expect(fx.report_names.reduce((a, r) => a + r.count, 0)).toBe(fx.total_rows);
    expect(fx.report_names).toHaveLength(fx.distinct_report_names);
    expect(fx.total_rows).toBe(22_794);
    expect(fx.distinct_report_names).toBe(94);
  });

  /**
   * ★ 백로그의 전제를 뒤집은 측정. 2년 8개월 전수에서 0건이다 (함정 8번: recall 판단은
   * 1년 이상 윈도우로만 확정한다).
   */
  it("'공시취소' 보고서명은 존재하지 않는다 — 취소는 정정·변경 공시로 표현된다", () => {
    expect(fx.cancellation_like_report_names).toBe(0);
    for (const r of fx.report_names) {
      expect(/취소|철회|무효|해제/.test(r.name), r.name).toBe(false);
    }
    // 정정은 실재한다 — 취소가 여기에 섞여 있을 수 있다는 뜻이다
    const corrections = fx.report_names
      .filter((r) => r.name.startsWith('[기재정정]'))
      .reduce((a, r) => a + r.count, 0);
    expect(corrections).toBe(1_496);
  });

  /**
   * ★ 유형 필터를 빠져나가는 실측 서식 — 이게 진짜 오탐 원인이다.
   * `특수관계인과의내부거래` 는 실물 20260903000201 에서 **벤처투자조합 출자**를,
   * `약관에의한금융거래시계열금융회사의거래상대방의공시` 는 실물 20260902000068 에서
   * **차입금 415.2억**을 이 이름으로 공시했다.
   */
  it('보고서명만으로 유형을 알 수 없는 서식을 잡아낸다', () => {
    const ambiguous = fx.report_names.filter((r) => isTypeAmbiguousReport(r.name));
    const names = ambiguous.map((r) => r.name).sort();
    expect(names).toEqual([
      '[기재정정]약관에의한금융거래시계열금융회사의거래상대방의공시',
      '[기재정정]특수관계인과의내부거래',
      '약관에의한금융거래시계열금융회사의거래상대방의공시',
      '특수관계인과의내부거래',
    ]);
    // 599 + 433 + 141 + 14 — 전체 22,794건의 5.2%
    expect(ambiguous.reduce((a, r) => a + r.count, 0)).toBe(1_187);

    // 유형이 이름에 드러나는 서식은 하나도 걸리면 안 된다 (걸리면 판정이 통째로 보류된다)
    for (const r of fx.report_names) {
      if (!isTypeAmbiguousReport(r.name)) continue;
      expect(isBorrowingReport(r.name), r.name).toBe(false);
      expect(isLendingReport(r.name), r.name).toBe(false);
      expect(isGoodsServicesReport(r.name), r.name).toBe(false);
      expect(isSecuritiesReport(r.name), r.name).toBe(false);
    }
  });

  /** 유형 필터가 실측 보고서명 위에서 의도대로 동작하는지 — 대표 서식으로 고정한다 */
  it('실측 상위 서식이 의도한 유형 필터에 걸린다', () => {
    const has = (n: string): boolean => fx.report_names.some((r) => r.name === n);
    for (const n of [
      '동일인등출자계열회사와의상품ㆍ용역거래',
      '특수관계인으로부터자금차입',
      '특수관계인에대한자금대여',
      '특수관계인과의수익증권거래',
      '계열금융회사의약관에의한금융거래-[유가증권-채권]',
    ]) {
      expect(has(n), `실측 서식이 사라졌다: ${n}`).toBe(true);
    }
    expect(isGoodsServicesReport('동일인등출자계열회사와의상품ㆍ용역거래')).toBe(true);
    expect(isGoodsServicesReport('동일인등출자계열회사와의상품ㆍ용역거래변경')).toBe(true);
    expect(isBorrowingReport('특수관계인으로부터자금차입')).toBe(true);
    expect(isLendingReport('특수관계인에대한자금대여')).toBe(true);
    expect(isSecuritiesReport('특수관계인과의수익증권거래')).toBe(true);
    expect(isSecuritiesReport('계열금융회사의약관에의한금융거래-[유가증권-채권]')).toBe(true);
    // 담보·보험·부동산은 이 도구가 보지 않는 유형이라 어느 필터에도 걸리지 않아야 한다
    for (const n of ['특수관계인에대한담보제공', '특수관계인과의보험거래', '특수관계인에대한부동산임대']) {
      expect(isBorrowingReport(n) || isGoodsServicesReport(n) || isSecuritiesReport(n), n).toBe(
        false,
      );
    }
  });
});
