/**
 * detect_undisclosed_transactions — 매트릭스 — 유가증권 총괄 (3) · 상품·용역 총괄 (5) · (5)↔(6) 중복·승격 · 상대방(매입·매도) 관점
 * (공용 헬퍼·픽스처 수치는 test/helpers/detect-deps.ts)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  detectUndisclosedTransactions,
  isSecuritiesReport,
} from '../src/tools/detect-undisclosed-transactions.js';
import { normalizeCompanyName } from '../src/parsers/md-table.js';
import type { Disclosure } from '../src/clients/dart.js';
import { 억 } from '../src/rules/thresholds.js';
import {
  FIXTURE_MD,
  disc,
  type CallLog,
  makeDeps,
  YKD_CORPS,
  doc80708,
  doc80754,
  useMemoryStore,
} from './helpers/detect-deps.js';

const HERE = dirname(fileURLToPath(import.meta.url));
useMemoryStore();

/**
 * 유가증권 총괄 매트릭스 — 픽스처의 와이케이디벨롭먼트(기준금액 10억)를 매입회사로 두어
 * 판정 경계를 명확히 만든다. 회사명에 **줄바꿈에서 온 공백**을 그대로 넣었다 (실물 그대로).
 */
const SECURITIES_SECTION = `
## (3) 계열회사간 유가증권거래 현황

| (직전 사업연도 개시일 ~ 종료일 기준, 단위 : 백만원) |
| --- |

| 매입회사 ＼ 매도회사 |  | 계열회사 |  |  |
| --- | --- | --- | --- | --- |
| (소속회사) |  | 미래에셋 증권(주) | 미래에셋 캐피탈(주) | 소계 |
| 비금융회사 | 와이케이 디벨롭먼트(주) | 1,500 | 400 | 1,900 |
| 합 계 |  | 1,500 | 400 | 1,900 |
`;

describe('유가증권 총괄 매트릭스 (Codex 4차 M1)', () => {
  const MD = FIXTURE_MD + SECURITIES_SECTION;

  /**
   * ★ 실측 보고서명으로 고정한다 (미래에셋 계열 J001, 2026).
   * 특히 약관특례(트랙 B)의 '계열금융회사의약관에의한금융거래-[유가증권-채권]' 를 놓치면
   * 정상 공시한 금융회사들이 통째로 미공시 후보가 된다 — 실행해 보니 실제로 걸리는 공시의
   * 절반 이상이 이 서식이었다.
   */
  it('유가증권 유형 필터 — 개별 서식과 약관특례 서식을 모두 잡는다', () => {
    expect(isSecuritiesReport('특수관계인과의수익증권거래')).toBe(true);
    expect(isSecuritiesReport('특수관계인에대한출자')).toBe(true);
    expect(isSecuritiesReport('[기재정정]특수관계인에대한출자')).toBe(true);
    expect(isSecuritiesReport('계열금융회사의약관에의한금융거래-[유가증권-채권]')).toBe(true);
    expect(isSecuritiesReport('계열금융회사의약관에의한금융거래-[유가증권-주식]')).toBe(true);
    expect(isSecuritiesReport('특수관계인에대한유상증자참여')).toBe(true);
    // 다른 유형까지 삼키면 "공시 존재"로 잘못 안심시킨다
    expect(isSecuritiesReport('대규모내부거래관련이사회의결및공시(자금차입)')).toBe(false);
    expect(isSecuritiesReport('대규모내부거래관련이사회의결및공시(상품ㆍ용역거래)')).toBe(false);
    expect(isSecuritiesReport('특수관계인에대한담보제공')).toBe(false);
  });

  it('기준 이상 + 유형 공시 부재 → candidate_aggregate_only (미공시 후보로 단정하지 않는다)', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: MD, j001: [], corps: YKD_CORPS }),
    )) as Record<string, any>;
    const sigs = res.securities_signals as Array<Record<string, unknown>>;
    const over = sigs.find((s) => s.counterparty === '미래에셋 증권(주)')!;
    expect(over.status).toBe('candidate_aggregate_only');
    expect(over.annual_amount).toBe(15 * 억);
    // §4③(동일 거래상대방과의 동일 거래대상) 때문에 연간 총액만으로는 단정할 수 없다
    expect(String(over.reason)).toContain('동일 거래대상');
    expect(res.summary.securities_candidates_aggregate_only).toBe(1);
  });

  it('연간 총액이 기준 미만이면 개별 거래도 미만이다 — below_threshold', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: MD, j001: [], corps: YKD_CORPS }),
    )) as Record<string, any>;
    const below = res.securities_below_threshold as Array<Record<string, unknown>>;
    expect(below).toHaveLength(1);
    expect(below[0]!.counterparty).toBe('미래에셋 캐피탈(주)');
    expect(below[0]!.annual_amount).toBe(4 * 억);
    expect(res.summary.securities_below_threshold).toBe(1);
  });

  it('유형 공시가 있으면 filing_exists — 약관특례 서식으로도 잡힌다 (상대방명 열 대조)', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        markdown: MD,
        j001: [
          disc({
            report_nm: '계열금융회사의약관에의한금융거래-[유가증권-수익증권]',
            rcept_dt: '20250714',
            rcept_no: '20250714000001',
          }),
        ],
        corps: YKD_CORPS,
        // 트랙 B 는 상대방이 여러 행이다 — '상대방명' 열에서 전부 읽고 그중 하나가 맞으면 확인이다
        docs: { '20250714000001': doc80754('미래에셋자산운용', '미래에셋증권(주)') },
      }),
    )) as Record<string, any>;
    const sigs = res.securities_signals as Array<Record<string, unknown>>;
    const over = sigs.find((s) => s.counterparty === '미래에셋 증권(주)')!;
    expect(over.status).toBe('j001_filing_exists');
    expect(over.counterparty_confirmed_by_document).toBe(true);
    expect((over.matching_filings as Array<Record<string, unknown>>)[0]!.doc_counterparties).toEqual([
      '미래에셋자산운용',
      '미래에셋증권(주)',
    ]);
    expect(res.summary.securities_candidates_aggregate_only).toBe(0);
  });

  it('약관특례 원문의 상대방이 이 거래 상대방과 다르면 filing_exists 가 아니라 보류다', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        markdown: MD,
        j001: [
          disc({
            report_nm: '계열금융회사의약관에의한금융거래-[유가증권-수익증권]',
            rcept_dt: '20250714',
            rcept_no: '20250714000001',
          }),
        ],
        corps: YKD_CORPS,
        // 같은 유형·같은 창이지만 **다른 상대방**과의 거래 공시다
        docs: { '20250714000001': doc80754('미래에셋자산운용') },
      }),
    )) as Record<string, any>;
    const sigs = res.securities_signals as Array<Record<string, unknown>>;
    const over = sigs.find((s) => s.counterparty === '미래에셋 증권(주)')!;
    expect(over.status).toBe('not_judged');
    expect(String(over.reason)).toContain('type_filing_present_counterparty_unconfirmed');
    expect(over.counterparty_confirmed_by_document).toBeUndefined();
    expect(over.matching_filings_unconfirmed).toHaveLength(1);
    // 후보로 내려가지 않는다 — 표기 차이일 수 있다 (제9호 ↔ 제구호)
    expect(res.summary.securities_candidates_aggregate_only).toBe(0);
  });

  /**
   * 매트릭스 표의 회사명에는 열 폭 때문에 공백이 섞인다('와이케이 디벨롭먼트(주)').
   * 공백을 흡수하지 못하면 모든 유가증권 신호가 join_failed 로 빠진다 (실물에서 11건 전원).
   */
  it('회사명에 섞인 줄바꿈 공백이 조인을 막지 않는다', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: MD, j001: [], corps: YKD_CORPS }),
    )) as Record<string, any>;
    expect(res.join_failures ?? []).toHaveLength(0);
    const sigs = res.securities_signals as Array<Record<string, unknown>>;
    expect(sigs.every((s) => s.corp_code === '00222222')).toBe(true);
  });

  it('유가증권 절이 없는 문서는 신호 없이 조용히 지나간다', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ j001: [], corps: YKD_CORPS }),
    )) as Record<string, any>;
    expect(res.summary.securities_pairs_extracted).toBe(0);
    expect(res.securities_signals).toBeUndefined();
  });
});

/**
 * 상품·용역 총괄 (5) 매트릭스 보완 — 백로그 2.
 *
 * 판정의 주 원천인 (6) '주요 상품ㆍ용역거래 **내역**' 은 서식상 "거래한 금액이 일정 규모
 * 이상인 경우"만 싣는다. 그 규모 기준은 우리가 계산하는 기준금액(령 §33①)과 다르므로
 * (6)만 보면 공시대상 쌍을 놓칠 수 있다. (5) 총괄표는 전 쌍을 담아 그 구멍을 메운다.
 *
 * 픽스처는 **실물 표 그대로**다 (미래에셋 대표회사 20260819000341 의 (3)(4)(5)(6) 절).
 */
describe('상품·용역 총괄 (5) 매트릭스 보완', () => {
  const MATRIX_MD = readFileSync(join(HERE, 'fixtures', 'j004-matrix.md'), 'utf8');
  /** 차입·상품용역 픽스처(재무현황·(6) 내역 포함) + 실물 매트릭스 절들 */
  const FULL_MD = FIXTURE_MD + '\n' + MATRIX_MD;
  const 백만 = 1_000_000;

  const FULL_CORPS: Record<string, Array<{ corpCode: string; corpName: string }>> = {
    와이케이디벨롭먼트: [{ corpCode: '00222222', corpName: '와이케이디벨롭먼트' }],
    미래에셋캐피탈: [{ corpCode: '00111111', corpName: '미래에셋캐피탈' }],
    미래에셋자산운용: [{ corpCode: '00333333', corpName: '미래에셋자산운용' }],
    미래에셋금융서비스: [{ corpCode: '00444444', corpName: '미래에셋금융서비스' }],
    미래에셋증권: [{ corpCode: '00555555', corpName: '미래에셋증권' }],
    미래에셋생명보험: [{ corpCode: '00666666', corpName: '미래에셋생명보험' }],
  };

  async function run(
    j001?: Disclosure[] | ((corpCode: string) => Disclosure[]),
    docs?: Record<string, string | Error>,
  ): Promise<Record<string, any>> {
    return (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        markdown: FULL_MD,
        corps: FULL_CORPS,
        j001: j001 ?? [],
        ...(docs ? { docs } : {}),
      }),
    )) as Record<string, any>;
  }

  /** (5) 보완 신호에서 한 쌍을 찾는다 (표기 흔들림을 정규화로 흡수) */
  function findPair(
    r: Record<string, any>,
    company: string,
    counterparty: string,
  ): Record<string, any> | undefined {
    const all = [
      ...((r['goods_services_matrix_signals'] ?? []) as Array<Record<string, any>>),
      ...((r['goods_services_matrix_below_threshold'] ?? []) as Array<Record<string, any>>),
      ...((r['goods_services_matrix_foreign_affiliate'] ?? []) as Array<Record<string, any>>),
    ];
    return all.find(
      (m) =>
        normalizeCompanyName(String(m['company'])) === normalizeCompanyName(company) &&
        normalizeCompanyName(String(m['counterparty'])) === normalizeCompanyName(counterparty),
    );
  }

  /**
   * ★ 회귀 고정 — (5) 통합이 기존 세 경로(차입·(6) 주요 내역·유가증권)를 건드리지 않았음을
   * 못 박는다. 같은 문서에서 (5) 절만 지우고 돌린 결과와 아래 값이 전부 같았다.
   */
  it('기존 차입·(6) 주요 내역·유가증권 판정을 바꾸지 않는다', async () => {
    const r = await run();
    expect(r['summary'].undisclosed_candidates).toBe(2);
    expect(r['summary'].goods_services_candidates_if_qualified).toBe(1);
    expect(r['summary'].goods_services_not_judged).toBe(0);
    expect(r['summary'].securities_pairs_extracted).toBe(36);
    expect(r['summary'].securities_candidates_aggregate_only).toBe(10);
    expect(r['summary'].securities_below_threshold).toBe(4);
    expect(r['summary'].securities_not_judged).toBe(22);
  });

  /**
   * 상대방 관점(매입회사·매도회사) 분포 고정 — 판매·매입 쪽 판정은 위 테스트가 이미 고정한다.
   * 조인 실패가 많은 것은 픽스처의 corps 스텁이 6개사뿐이기 때문이고, 그 자체가
   * "확인하지 못한 것"으로 드러나야 하는 값이다 (0건이면 거짓 안심).
   */
  it('상대방 관점 분포를 고정한다 (국외 열에는 만들지 않는다)', async () => {
    const r = await run();
    expect(r['summary'].counterparty_side).toEqual({
      candidate_if_counterparty_qualified: 1,
      candidate_aggregate_only: 10,
      j001_filing_exists: 0,
      below_threshold: 12,
      not_judged: 23,
      counterparty_not_joined: 43,
      counterparty_not_company: 0,
    });
    // (5) 62쌍 중 국외 9쌍은 제외 → 상대방 관점은 (6) 2 + 유가증권 36 + (5) 49 = 89건
    const total = Object.values(
      r['summary'].counterparty_side as Record<string, number>,
    ).reduce((a, b) => a + b, 0);
    expect(total).toBe(89);
  });

  it('(5) 전 쌍을 읽고 (6)에 있는 쌍만 빼고 보완한다', async () => {
    const r = await run();
    expect(r['summary'].goods_services_matrix_pairs_extracted).toBe(62);
    expect(r['summary'].goods_services_matrix_pairs_also_in_major_detail).toBe(1);
    expect(r['summary'].goods_services_matrix_pairs_supplemented).toBe(61);
    // 파서 진단 — 실물은 열이 많아 표가 4개로 쪼개져 있고 단위 캡션은 첫 표에만 있다
    const d = r['diagnostics'].goods_services_matrix;
    expect(d.tables).toBe(4);
    expect(d.unit_inherited_tables).toBe(3);
    expect(d.tables_unrecognized).toBe(0);
    expect(d.tables_without_unit).toBe(0);
    expect(d.duplicate_pairs).toBe(0);
  });

  /**
   * ★ 중복 제거의 핵심 사례 — (5)는 '와이케이 디벨롭먼트(주)'·'미래에셋 증권(주)'(공백 있음),
   * (6)은 '와이케이디벨롭먼트(주)'·'미래에셋증권'(공백·법인격 없음)으로 같은 거래를 적는다.
   * 쌍 키를 정규화하지 않으면 71.89억 한 건이 두 바구니에 서로 다른 강도로 실린다.
   */
  it('(6)에 있는 쌍은 (5)에서 중복 생성하지 않는다 (와이케이디벨롭먼트→미래에셋증권 7,189백만)', async () => {
    const r = await run();
    const g6 = (r['goods_services_signals'] as Array<Record<string, any>>).find(
      (g) =>
        normalizeCompanyName(String(g['counterparty'])) === normalizeCompanyName('미래에셋증권'),
    )!;
    expect(g6['annual_amount_total']).toBe(7_189 * 백만);
    expect(g6['source']).toBe('(6)주요내역');
    expect(g6['status']).toBe('candidate_if_counterparty_qualified');
    // 같은 쌍이 (5) 어느 바구니에도 없어야 한다
    expect(findPair(r, '와이케이 디벨롭먼트(주)', '미래에셋 증권(주)')).toBeUndefined();
  });

  /**
   * 비둘기집: 연간 총액 ≥ 4×기준금액이면 네 분기가 전부 기준 미만일 수 없다.
   * 미래에셋금융서비스 → 미래에셋생명보험 205,454백만(2,054.54억) ≥ 4×100억.
   */
  it('연간 총액 ≥ 4×기준금액이면 (6)과 같은 강도의 조건부 후보다', async () => {
    const r = await run();
    const m = findPair(r, '미래에셋 금융서비스(주)', '미래에셋 생명보험(주)')!;
    expect(m['annual_amount']).toBe(205_454 * 백만);
    expect(m['quarterly_logic']).toBe('annual_geq_4x_threshold');
    expect(m['certainty']).toBe('certain_by_cap');
    expect(m['status']).toBe('candidate_if_counterparty_qualified');
    expect(m['source']).toBe('(5)총괄');
    // 상대방 요건 미확인 한계는 (6)과 똑같이 적용된다
    expect(m['counterparty_qualification']).toBe('not_verified');
    expect(r['summary'].goods_services_matrix_candidates_if_qualified).toBe(1);
  });

  /**
   * ★ 총액만 기준을 넘은 경우는 후보가 아니라 **확인 대상**이다.
   * 미래에셋자산운용 → 미래에셋증권 23,509백만(235.09억)은 100억 상한 기준으로 확실히
   * 초과지만 4×(400억)에는 못 미쳐, 네 분기로 나누면 전부 미달일 수 있다.
   */
  it('총액만 기준 이상이면 candidate_aggregate_only — 비둘기집이 서지 않는다', async () => {
    const r = await run();
    const m = findPair(r, '미래에셋 자산운용(주)', '미래에셋 증권(주)')!;
    expect(m['annual_amount']).toBe(23_509 * 백만);
    expect(m['quarterly_logic']).toBe('annual_geq_threshold');
    expect(m['status']).toBe('candidate_aggregate_only');
    expect(String(m['reason'])).toContain('분기 합계액');
    expect(r['summary'].goods_services_matrix_candidates_aggregate_only).toBe(3);
  });

  /**
   * 반대 방향만 확실하다 — 분기 합계는 연간 총액을 넘지 못하므로 연간 총액이 기준 미만이면
   * 어느 분기도 미달이다. 와이케이디벨롭먼트(기준금액 10억) → 미래에셋금융서비스 505백만.
   */
  it('연간 총액이 기준 미만이면 below_threshold 로 확정한다', async () => {
    const r = await run();
    const m = findPair(r, '와이케이 디벨롭먼트(주)', '미래에셋 금융서비스(주)')!;
    expect(m['annual_amount']).toBe(505 * 백만);
    expect(m['threshold'].value).toBe(10 * 억);
    expect(m['status']).toBe('below_threshold');
    // 전건 공통인 문구·논리는 `_shared` 로 한 번만 실린다 (같은 문장을 항목마다 반복하지 않는다).
    // 정보는 버리지 않는다 — 값이 하나라도 다르면 항목에 그대로 남는다.
    const shared = r['goods_services_matrix_below_threshold_shared'];
    expect(shared['quarterly_logic']).toBe('annual_below_threshold');
    expect(m['quarterly_logic']).toBeUndefined();
    expect(String(shared['reason'])).toContain('annual_total_below_threshold');
    expect(r['summary'].goods_services_matrix_below_threshold).toBe(7);
  });

  it('기준금액을 모르면 not_judged — "후보 아님"으로 흘리지 않는다', async () => {
    const r = await run();
    // 미래에셋증권은 이 문서 재무현황 표에 자본이 없다 (픽스처는 3개사만 싣는다)
    const m = findPair(r, '미래에셋 증권(주)', '미래에셋 캐피탈(주)')!;
    expect(m['quarterly_logic']).toBe('threshold_unknown');
    expect(m['status']).toBe('not_judged');
    expect(String(m['reason'])).toContain('threshold_unknown');
    expect(r['summary'].goods_services_matrix_not_judged).toBe(41);
    expect(
      (r['notes'] as string[]).some((n) => n.includes('(5) 총괄 보완 신호') && n.includes('41건')),
    ).toBe(true);
  });

  it('상품·용역 유형 J001 이 있으면 filing_exists 로 내려간다', async () => {
    const r = await run(
      (corpCode) =>
        corpCode === '00444444'
          ? [
              disc({
                corp_code: '00444444',
                report_nm: '대규모내부거래관련이사회의결및공시(상품ㆍ용역거래)',
                rcept_no: '20250310000001',
                rcept_dt: '20250310',
              }),
            ]
          : [],
      // (5) 총괄 쌍의 매입회사 = 미래에셋 생명보험(주) — 원문 상대방까지 맞아야 filing_exists 다
      { '20250310000001': doc80708('미래에셋생명보험(주)', '보험판매 용역') },
    );
    const m = findPair(r, '미래에셋 금융서비스(주)', '미래에셋 생명보험(주)')!;
    expect(m['status']).toBe('j001_filing_exists');
    expect(m['matching_filings']).toHaveLength(1);
    expect(m['counterparty_confirmed_by_document']).toBe(true);
    expect(r['summary'].goods_services_matrix_candidates_if_qualified).toBe(0);
    expect(r['summary'].goods_services_matrix_filing_exists).toBe(1);
  });

  /**
   * ★ 실측 집계 열 이름은 한 가지가 아니다 ('소계'·'계'·'국내계열사계'·'국내 매출액'·'해외 매출액').
   * 하나라도 회사로 새면 **없는 거래**가 후보로 올라간다.
   */
  it('집계 열을 거래상대방으로 만들어내지 않는다', async () => {
    const r = await run();
    const all = [
      ...(r['goods_services_matrix_signals'] as Array<Record<string, any>>),
      ...(r['goods_services_matrix_below_threshold'] as Array<Record<string, any>>),
    ];
    const names = new Set(all.map((m) => normalizeCompanyName(String(m['counterparty']))));
    for (const bad of ['소계', '계', '국내계열사계', '국내 매출액', '해외 매출액', '합계']) {
      expect(names.has(normalizeCompanyName(bad)), bad).toBe(false);
    }
  });

  /**
   * ★ 국외 계열회사 상대 거래에는 공시의무가 **없다** (법 §26①·고시 §2③2호·공정위 매뉴얼
   * lit26-020 원문 확인 2026-09-04). 그래서 후보가 아니라 별도 상태로 분리한다.
   * 판별은 **원문 표의 그룹 헤더('해외계열사')로만** 한다 — 국내 법인도 영문 상호를 쓰므로
   * 회사명 모양으로 추측하면 안 된다. 버리지는 않고 금액·근거와 함께 남긴다.
   */
  it('국외 계열회사 열은 후보가 아니라 not_applicable_foreign_affiliate 다', async () => {
    const r = await run();
    const m = findPair(r, '미래에셋 캐피탈(주)', 'Mirae Asset Finance Company (Vietnam)')!;
    expect(m['annual_amount']).toBe(10_439 * 백만);
    expect(m['status']).toBe('not_applicable_foreign_affiliate');
    expect(m['column_group']).toContain('해외계열사');
    // 근거 조문은 전건 공통이라 `_shared` 에 한 번 실린다 (버려지지 않는다)
    const fShared = r['goods_services_matrix_foreign_affiliate_shared'];
    expect(String(fShared['reason'])).toContain('국외 계열회사는 제외한다');
    expect(String(fShared['reason'])).toContain('간접적으로');
    // 실물 (5)의 해외계열사 열은 9개다 — 국내 열은 하나도 섞이지 않아야 한다
    expect(r['summary'].goods_services_matrix_foreign_affiliate).toBe(9);
    expect(r['goods_services_matrix_foreign_affiliate']).toHaveLength(9);
    for (const f of r['goods_services_matrix_foreign_affiliate'] as Array<Record<string, any>>) {
      expect(String(f['counterparty']), String(f['counterparty'])).toMatch(/^(Mirae|MAC)/);
    }
    // 유가증권 (3) 표는 '국내 계열회사' 전용이라 해외 열이 없다
    expect(r['summary'].securities_foreign_affiliate).toBe(0);
  });

  it('국외 판정 근거를 scope_caveats 에 조문으로 싣는다', async () => {
    const r = await run();
    const c = (r['scope_caveats'] as string[]).find((x) =>
      x.includes('국외(해외) 계열회사 상대 거래에는 공시의무가 없습니다'),
    );
    expect(c).toBeDefined();
    expect(String(c)).toContain('법 §26①');
    expect(String(c)).toContain('고시 §2③2호');
    expect(String(c)).toContain('2026-04-27');
  });

  it('(5)만의 한계를 caveat 로 매 신호에 동봉한다', async () => {
    const r = await run();
    const m = findPair(r, '미래에셋 금융서비스(주)', '미래에셋 생명보험(주)')!;
    expect(String(m['caveat'])).toContain('연간 총액');
    expect(String(m['caveat'])).toContain('분기 합계액');
    expect(String(m['caveat'])).toContain('품목이 없어');
    expect(
      (r['scope_caveats'] as string[]).some((c) => c.includes('상품·용역은 두 표를 함께 봅니다')),
    ).toBe(true);
    expect(r['coverage'].transaction_types_checked).toContain(
      '상품·용역 총괄 (5) 매트릭스 — (6)에 없는 쌍만 보완 (상대방별 연간 총액)',
    );
  });

  it('(5) 절이 없는 문서는 신호 없이 조용히 지나간다', async () => {
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ corps: YKD_CORPS, j001: [] }),
    )) as Record<string, any>;
    expect(r['summary'].goods_services_matrix_pairs_extracted).toBe(0);
    expect(r['goods_services_matrix_signals']).toBeUndefined();
  });
});

/**
 * ★ 실물에서 잡은 결함 — (6)과 (5)가 같은 회사를 다르게 적으면 쌍 키 정규화가 듣지 않는다.
 *
 * 미래에셋 20260819000341 실호출에서 발견: 같은 205,454백만 보험판매 거래를
 * (6)은 '미래에셋생명(주)', (5)는 '미래에셋 생명보험(주)' 로 적는다. 공백·법인격을 지워도
 * '미래에셋생명' ≠ '미래에셋생명보험' 이라 중복 제거를 비껴가 같은 거래가 양쪽에
 * candidate_if_counterparty_qualified 로 올랐다.
 *
 * 버리는 쪽(같은 매출회사 + 같은 금액이면 제거)은 우연히 금액이 같은 별개 거래를 조용히
 * 지운다 — 거짓 안심 방향이라 채택하지 않았다. 대신 표시한다.
 * 아래 문서는 실물의 그 두 행을 이름·금액 그대로 옮긴 것이다.
 */
describe('(5)↔(6) 회사명 표기 차이로 중복 제거를 비껴가는 경우 (실물 20260819000341)', () => {
  const 백만 = 1_000_000;
  const DUP_MD = [
    '| 기업집단명 : | 테스트집단 |',
    '| --- | --- |',
    '## (2) 회사 재무현황',
    '| (단위 : 백만원, %) |',
    '| --- |',
    '| 계열회사명 |  | 자본금 | 자본총계 |',
    '| --- | --- | --- | --- |',
    '| 금융회사 | 미래에셋금융서비스(주) | 1,000 | 89,639 |',
    '| 금융회사 | 미래에셋생명보험(주) | 1,000 | 4,000 |',
    '## (5) 계열회사간 상품ㆍ용역거래 현황',
    '| (직전 사업연도 개시일 ~ 종료일 기준, 단위 : 백만원) |',
    '| --- |',
    '| 매출 / 매입회사 |  | 금융회사 |  |  |',
    '| --- | --- | --- | --- | --- |',
    // 실물 (5) 표기 — 공백 있는 '미래에셋 생명보험(주)'
    '| (소속회사) |  | 미래에셋 생명보험(주) | 미래에셋 증권(주) | 소계 |',
    '| 금융회사 | 미래에셋 금융서비스(주) | 205,454 | - | 205,454 |',
    '| 합 계 |  | 205,454 | - | 205,454 |',
    '## (6) 계열회사간 주요 상품ㆍ용역거래 내역',
    '나. 비상장회사와 그 계열회사간 주요 상품ㆍ용역거래 내역 (연1회)',
    '| (직전 사업연도 개시일 ~ 종료일 기준, 단위 : 백만원) |',
    '| --- |',
    '| 소속회사명 |  | 거래상대방 | 업종 | 품목 | 대금지급조건 | 거래상대방 선정방식 | 매출액 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    // 실물 (6) 표기 — '미래에셋생명(주)' ('보험' 이 없다)
    '| 금융회사 | 미래에셋금융서비스(주) | 미래에셋생명(주) | K6620(보험및연금관련서비스업) | 보험판매 | 현금 | 수의계약 | 205,454 |',
  ].join('\n');

  const DUP_CORPS = {
    미래에셋금융서비스: [{ corpCode: '01041305', corpName: '미래에셋금융서비스' }],
  };

  async function run(): Promise<Record<string, any>> {
    return (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: DUP_MD, corps: DUP_CORPS, j001: [] }),
    )) as Record<string, any>;
  }

  it('쌍 키로는 중복이 걸러지지 않는다 (표기가 다르다) — 그 사실 자체를 고정한다', async () => {
    const r = await run();
    expect(r['summary'].goods_services_matrix_pairs_also_in_major_detail).toBe(0);
    expect(r['summary'].goods_services_matrix_pairs_supplemented).toBe(1);
    // (6) 쪽 신호는 그대로 살아 있다
    expect(r['summary'].goods_services_candidates_if_qualified).toBe(1);
  });

  it('같은 매출회사·같은 금액이면 중복 의심으로 **표시**한다 (버리지 않는다)', async () => {
    const r = await run();
    const m = (r['goods_services_matrix_signals'] as Array<Record<string, any>>)[0]!;
    expect(m['company']).toBe('미래에셋 금융서비스(주)');
    expect(m['counterparty']).toBe('미래에셋 생명보험(주)');
    expect(m['annual_amount']).toBe(205_454 * 백만);
    const dup = m['possible_duplicate_of_major_detail'];
    expect(dup).toBeDefined();
    expect(dup.major_detail_counterparty).toBe('미래에셋생명(주)');
    expect(String(dup.note)).toContain('같은 거래');
    expect(r['summary'].goods_services_matrix_possible_duplicates).toBe(1);
    expect(r['diagnostics'].goods_services_matrix.possible_duplicates).toBe(1);
  });

  it('중복 의심을 notes 와 caveat 로 사용자에게 알린다', async () => {
    const r = await run();
    expect(
      (r['notes'] as string[]).some(
        (n) => n.includes('(5) 보완 신호 1건') && n.includes('같은 금액'),
      ),
    ).toBe(true);
    const m = (r['goods_services_matrix_signals'] as Array<Record<string, any>>)[0]!;
    // caveat ③ 이 "중복되지 않습니다" 라고 단정하면 안 된다 (실물에서 거짓이었다)
    expect(String(m['caveat'])).not.toContain('중복되지 않습니다');
    expect(String(m['caveat'])).toContain('possible_duplicate_of_major_detail');
    expect(
      (r['scope_caveats'] as string[]).some((c) => c.includes('그 키가 듣지 않습니다')),
    ).toBe(true);
  });

  it('금액이 다르면 중복 의심 표시를 붙이지 않는다', async () => {
    const md = DUP_MD.replace(
      '| 금융회사 | 미래에셋금융서비스(주) | 미래에셋생명(주) | K6620(보험및연금관련서비스업) | 보험판매 | 현금 | 수의계약 | 205,454 |',
      '| 금융회사 | 미래에셋금융서비스(주) | 미래에셋생명(주) | K6620(보험및연금관련서비스업) | 보험판매 | 현금 | 수의계약 | 100,000 |',
    );
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: md, corps: DUP_CORPS, j001: [] }),
    )) as Record<string, any>;
    const m = (r['goods_services_matrix_signals'] as Array<Record<string, any>>)[0]!;
    expect(m['possible_duplicate_of_major_detail']).toBeUndefined();
    expect(r['summary'].goods_services_matrix_possible_duplicates).toBe(0);
  });
});

/**
 * 상품·용역 **매입회사** 관점 / 유가증권 **매도회사** 관점 (백로그 1).
 *
 * ★ 근거 — 공정위 공시 업무 매뉴얼(2026-04-27) lit26-001:
 *   "거래규모가 거래당사자 **모두에게** 대규모내부거래에 해당되는 경우 이사회 의결 및
 *    공시의무는 거래당사자 모두에게 있음. 만일 거래규모가 일방당사자에게만 해당되는
 *    경우에는 해당되는 거래당사자에게만 있음."
 *   → 기준금액을 **각자의 자본**으로 계산해 따로 판정한다 (차입의 lender_side 와 같은 원리).
 *
 * ★ 실측 J001 보고서명이 방향 중립이라 유형 필터를 그대로 쓴다 —
 *   '특수관계인과의수익증권거래' · '계열금융회사의약관에의한금융거래-[유가증권-채권]' ·
 *   '상품ㆍ용역거래'. 방향이 박힌 이름은 자금거래 쪽('…에대한자금대여'/'…으로부터자금차입')뿐이다.
 */
describe('상대방 관점 — 상품·용역 매입회사 / 유가증권 매도회사 (백로그 1)', () => {
  const 백만 = 1_000_000;

  /**
   * 판매회사 기준금액 10억(자본총계 200억) / 매입회사 기준금액 5억(자본총계 40억).
   * 거래 30억은 판매회사 4×(40억)에는 못 미치고 매입회사 4×(20억)은 넘는다 —
   * **한쪽만 비둘기집이 서는** 상황이라 양쪽을 따로 봐야 하는 이유가 그대로 드러난다.
   */
  const MD = [
    '| 기업집단명 : | 테스트집단 |',
    '| --- | --- |',
    '## (2) 회사 재무현황',
    '| (단위 : 백만원, %) |',
    '| --- |',
    '| 계열회사명 |  | 자본금 | 자본총계 |',
    '| --- | --- | --- | --- |',
    '| 비금융회사 | 판매회사(주) | 1,000 | 20,000 |',
    '| 금융회사 | 매입회사(주) | 1,000 | 4,000 |',
    '| 금융회사 | 제3사(주) | 1,000 | 4,000 |',
    '## 7. 계열회사와 특수관계인간 거래현황',
    '## (6) 계열회사간 주요 상품ㆍ용역거래 내역',
    '나. 비상장회사와 그 계열회사간 주요 상품ㆍ용역거래 내역 (연1회)',
    '| (단위 : 백만원) |',
    '| --- |',
    '| 소속회사명 |  | 거래상대방 | 업종 | 품목 | 대금지급조건 | 거래상대방 선정방식 | 매출액 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| 비금융회사 | 판매회사(주) | 매입회사(주) | R9112 | 용역 | 현금 | 수의계약 | 3,000 |',
  ].join('\n');

  const CORPS = {
    판매회사: [{ corpCode: '00111111', corpName: '판매회사' }],
    매입회사: [{ corpCode: '00222222', corpName: '매입회사' }],
    제3사: [{ corpCode: '00333333', corpName: '제3사' }],
  };

  async function run(over: Record<string, unknown> = {}): Promise<Record<string, any>> {
    return (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: MD, corps: CORPS, j001: [], ...over }),
    )) as Record<string, any>;
  }

  it('판매회사는 비둘기집이 안 서도 매입회사 기준으로는 조건부 후보가 된다', async () => {
    const r = await run();
    // 판매회사 쪽: 30억 < 4×10억 → 원리상 판정 불가 (종전 동작 그대로)
    const seller = (r['goods_services_not_judgeable'] as Array<Record<string, any>>)[0]!;
    expect(seller['company']).toBe('판매회사(주)');
    expect(seller['quarterly_logic']).toBe('annual_below_4x_threshold');

    // 매입회사 쪽: 30억 ≥ 4×5억 → 비둘기집이 선다
    const buyer = seller['buyer_side'];
    expect(buyer.company).toBe('매입회사(주)');
    expect(buyer.corp_code).toBe('00222222');
    expect(buyer.threshold.value).toBe(5 * 억);
    expect(buyer.quarterly_logic).toBe('annual_geq_4x_threshold');
    expect(buyer.status).toBe('candidate_if_counterparty_qualified');
    // 상품·용역은 양쪽 다 상대방 지분 요건이 전제다 (고시 §4①4호)
    expect(buyer.counterparty_qualification).toBe('not_verified');
    expect(r['summary'].counterparty_side.candidate_if_counterparty_qualified).toBe(1);
    expect((r['notes'] as string[]).some((n) => n.includes('상대방 쪽'))).toBe(true);
  });

  it('매입회사에 상품·용역 J001 이 있으면 filing_exists — 유형 필터는 방향 중립이다', async () => {
    const r = await run({
      j001: (corpCode: string) =>
        corpCode === '00222222'
          ? [
              disc({
                corp_code: '00222222',
                report_nm: '대규모내부거래관련이사회의결및공시(상품ㆍ용역거래)',
                rcept_no: '20250310000001',
                rcept_dt: '20250310',
              }),
            ]
          : [],
      // 매입회사 관점의 대조 상대방은 **판매회사**다
      docs: { '20250310000001': doc80708('판매회사(주)', '용역') },
    });
    const buyer = (r['goods_services_not_judgeable'] as Array<Record<string, any>>)[0]!['buyer_side'];
    expect(buyer.status).toBe('j001_filing_exists');
    expect(buyer.matching_filings).toHaveLength(1);
    expect(buyer.counterparty_confirmed_by_document).toBe(true);
    expect(r['summary'].counterparty_side.j001_filing_exists).toBe(1);
  });

  it('매입회사 기준으로도 미달이면 below_threshold — 분기 합계는 연간 총액을 넘지 못한다', async () => {
    // 거래 3억: 매입회사 기준 5억에도 미달
    const md = MD.replace(
      '| 비금융회사 | 판매회사(주) | 매입회사(주) | R9112 | 용역 | 현금 | 수의계약 | 3,000 |',
      '| 비금융회사 | 판매회사(주) | 매입회사(주) | R9112 | 용역 | 현금 | 수의계약 | 300 |',
    );
    const r = await run({ markdown: md });
    const buyer = (r['goods_services_not_judgeable'] as Array<Record<string, any>>)[0]!['buyer_side'];
    expect(buyer.status).toBe('below_threshold');
    expect(buyer.quarterly_logic).toBe('annual_below_threshold');
    expect(r['summary'].counterparty_side.below_threshold).toBe(1);
  });

  it('매입회사를 조인하지 못하면 counterparty_not_joined — "공시 없음"이 아니다', async () => {
    const r = await run({ corps: { 판매회사: CORPS.판매회사 } });
    const buyer = (r['goods_services_not_judgeable'] as Array<Record<string, any>>)[0]!['buyer_side'];
    expect(buyer.status).toBe('counterparty_not_joined');
    expect(buyer.corp_code).toBeUndefined();
    expect(String(buyer.reason)).toContain('확인하지 못한 것');
    expect(r['summary'].counterparty_side.counterparty_not_joined).toBe(1);
  });

  /** 유가증권은 상대방 지분 요건이 없어 각자의 기준금액만 본다 (고시 §4①2호) */
  const SEC_MD = [
    MD,
    '## (3) 계열회사간 유가증권거래 현황',
    '| (단위 : 백만원) |',
    '| --- |',
    '| 매입회사 ＼ 매도회사 |  | 계열회사 |  |  |',
    '| --- | --- | --- | --- | --- |',
    '| (소속회사) |  | 매입회사(주) | 제3사(주) | 소계 |',
    '| 비금융회사 | 판매회사(주) | 1,500 | 100 | 1,600 |',
    '| 합 계 |  | 1,500 | 100 | 1,600 |',
  ].join('\n');

  it('유가증권은 매도회사 쪽도 각자의 기준금액으로 판정한다 (seller_side)', async () => {
    const r = await run({ markdown: SEC_MD });
    const sec = (r['securities_signals'] as Array<Record<string, any>>)[0]!;
    // 매입회사(행) = 판매회사(주), 기준 10억. 15억 ≥ 10억 → 확인 대상
    expect(sec['company']).toBe('판매회사(주)');
    expect(sec['annual_amount']).toBe(15 * 억);
    expect(sec['status']).toBe('candidate_aggregate_only');
    // 매도회사(열) = 매입회사(주), 기준 5억 → 이 회사 기준으로도 초과
    const seller = sec['seller_side'];
    expect(seller.company).toBe('매입회사(주)');
    expect(seller.threshold.value).toBe(5 * 억);
    expect(seller.status).toBe('candidate_aggregate_only');
    // 유가증권에는 상대방 지분 요건이 없다
    expect(seller.counterparty_qualification).toBeUndefined();
    expect(String(seller.reason)).toContain('동일 거래대상');
  });

  it('같은 회사가 판매·매입 양쪽에 걸려도 J001 조회는 1회뿐이다 (예산·캐시 공유)', async () => {
    const calls: CallLog[] = [];
    await run({ markdown: SEC_MD, calls });
    // 판매회사·매입회사 각 1회 — 관점이 넷(상품 판매/매입, 유가증권 매입/매도)이어도 2회다
    expect(calls.filter((c) => c.ty === 'J001')).toHaveLength(2);
  });

  it('국외 계열회사 열에는 상대방 관점을 만들지 않는다 (양쪽 다 의무가 없다)', async () => {
    const MATRIX_MD = readFileSync(join(HERE, 'fixtures', 'j004-matrix.md'), 'utf8');
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: `${FIXTURE_MD}\n${MATRIX_MD}`, corps: YKD_CORPS, j001: [] }),
    )) as Record<string, any>;
    const foreign = r['goods_services_matrix_foreign_affiliate'] as Array<Record<string, any>>;
    expect(foreign).toHaveLength(9);
    expect(foreign.every((m) => m['buyer_side'] === undefined)).toBe(true);
  });
});

/**
 * ★ (5) 총괄표가 (6) 주요 내역보다 큰 금액을 적는 경우 (Codex ④ — 실물 40문서로 확인)
 *
 * (6)은 서식상 "국내 계열회사와 상품ㆍ용역을 거래한 금액이 **일정 규모 이상**인 경우"의
 * 내역만 싣고, 그 규모 기준은 우리가 계산하는 기준금액(령 §33①)과 다르다. 그래서 같은 쌍이라도
 * (5) 총괄표의 연간 총액이 (6) 합산보다 클 수 있다.
 *
 * 실측(2026-09-08, 2026-05~06 J004 40문서): 두 표에 함께 나온 149쌍 중 **30쌍**이 그랬고,
 * 최대는 ㈜케이티 → ㈜케이티에스테이트의 (5) 664.90억 vs (6) 4.04억(164배)이다.
 * 종전에는 (6)에 쌍이 있으면 (5) 값을 **비교 없이 버려서** 그 664.90억이 4.04억으로 판정됐다.
 */
describe('(5) 총괄이 (6) 합산보다 크면 그 값으로 판정한다', () => {
  const 백만 = 1_000_000;
  /** 기준금액 = min(100억, max(5억, max(자본총계 100억, 자본금 10억) × 5%)) = 5억 → 4× = 20억 */
  const HEAD = [
    '| 기업집단명 : | 테스트집단 |',
    '| --- | --- |',
    '## (2) 회사 재무현황',
    '| (단위 : 백만원, %) |',
    '| --- |',
    '| 계열회사명 |  | 자본금 | 자본총계 |',
    '| --- | --- | --- | --- |',
    '| 비금융회사 | 갑회사(주) | 1,000 | 10,000 |',
  ];
  /** (5) 총괄표 — 갑회사 행 × 을회사 열 */
  const matrix = (amount: string): string[] => [
    '## (5) 계열회사간 상품ㆍ용역거래 현황',
    '| (직전 사업연도 개시일 ~ 종료일 기준, 단위 : 백만원) |',
    '| --- |',
    // 열 회사가 2개 이상이어야 파서가 교차표로 인정한다 (pickNameRow: 고유 셀 3 이상)
    '| 매출 / 매입회사 |  | 비금융회사 |  |  |',
    '| --- | --- | --- | --- | --- |',
    '| (소속회사) |  | 을회사(주) | 병회사(주) | 소계 |',
    `| 비금융회사 | 갑회사(주) | ${amount} | - | ${amount} |`,
  ];
  /** (6) 주요 내역 — 표 라벨을 갈아 끼울 수 있게 */
  const detail = (rows: Array<{ label: string; amount: string }>): string[] => {
    const out = ['## (6) 계열회사간 주요 상품ㆍ용역거래 내역'];
    for (const r of rows) {
      out.push(
        r.label,
        '| (직전 사업연도 개시일 ~ 종료일 기준, 단위 : 백만원) |',
        '| --- |',
        '| 소속회사명 |  | 거래상대방 | 업종 | 품목 | 대금지급조건 | 거래상대방 선정방식 | 매출액 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        `| 비금융회사 | 갑회사(주) | 을회사(주) | C1000(제조업) | 부품 | 현금 | 수의계약 | ${r.amount} |`,
      );
    }
    return out;
  };
  const CORPS = { 갑회사: [{ corpCode: '00000001', corpName: '갑회사' }] };
  const 연1회 = '나. 비상장회사와 그 계열회사간 주요 상품ㆍ용역거래 내역 (연1회)';
  const 분기 = '가. 상장회사와 그 계열회사간 주요 상품ㆍ용역거래 내역 (분기)';

  async function run(md: string[]): Promise<Record<string, any>> {
    return (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: md.join('\n'), corps: CORPS, j001: [] }),
    )) as Record<string, any>;
  }

  it('(6) 4억 · (5) 30억 → 판정 불가에서 조건부 후보로 올라간다 (두 값을 모두 남긴다)', async () => {
    const r = await run([
      ...HEAD,
      ...matrix('3,000'),
      ...detail([{ label: 연1회, amount: '400' }]),
    ]);
    // (6) 합산 4억 하나만 봤다면 4×기준(20억) 미달이라 **판정 불가**로 끝났다
    expect(r['summary'].goods_services_candidates_if_qualified).toBe(1);
    expect(r['summary'].goods_services_not_judgeable).toBe(0);
    const g = (r['goods_services_signals'] as Array<Record<string, any>>)[0]!;
    expect(g['status']).toBe('candidate_if_counterparty_qualified');
    expect(g['quarterly_logic']).toBe('annual_geq_4x_threshold');
    // 두 값이 **모두** 남는다 — 사용자가 차액의 성격을 원문으로 확인할 수 있어야 한다
    expect(g['annual_amount_total']).toBe(400 * 백만);
    expect(g['matrix_annual_total']).toBe(3_000 * 백만);
    expect(g['judged_on']).toBe('(5)총괄');
    expect(String(g['matrix_caveat'])).toContain('일정 규모 이상');
    expect(String(g['matrix_caveat'])).toContain('품목이 없어');
    expect(r['diagnostics'].goods_services_matrix.pairs_promoted_to_major_detail).toBe(1);
    expect(r['diagnostics'].goods_services_matrix.largest_promotion.excess_display).toBe('26억원');
  });

  it('승격을 notes 로 알린다', async () => {
    const r = await run([
      ...HEAD,
      ...matrix('3,000'),
      ...detail([{ label: 연1회, amount: '400' }]),
    ]);
    expect(
      (r['notes'] as string[]).some(
        (n) => n.includes('(5) 총괄표가 더 큰 금액') && n.includes('갑회사(주) → 을회사(주)'),
      ),
    ).toBe(true);
  });

  it('판정을 바꾸지 않는 **미세한 차이**(5% 이내)는 승격하지 않는다 — caveat 만 늘지 않게', async () => {
    // (6) 3,000백만 vs (5) 3,010백만 = 0.33%. 둘 다 4×기준 이상이라 판정도 같다.
    const r = await run([
      ...HEAD,
      ...matrix('3,010'),
      ...detail([{ label: 연1회, amount: '3,000' }]),
    ]);
    const g = (r['goods_services_signals'] as Array<Record<string, any>>)[0]!;
    expect(g['status']).toBe('candidate_if_counterparty_qualified');
    expect(g['judged_on']).toBe('(6)합산');
    expect(g['matrix_annual_total']).toBeUndefined();
    expect(g['annual_amount_total']).toBe(3_000 * 백만);
    expect(r['diagnostics'].goods_services_matrix.pairs_promoted_to_major_detail).toBe(0);
  });

  it('(5)가 더 작으면 종전대로 (6) 합산으로 판정한다', async () => {
    const r = await run([
      ...HEAD,
      ...matrix('1,000'),
      ...detail([{ label: 연1회, amount: '3,000' }]),
    ]);
    const g = (r['goods_services_signals'] as Array<Record<string, any>>)[0]!;
    expect(g['judged_on']).toBe('(6)합산');
    expect(g['annual_amount_total']).toBe(3_000 * 백만);
    expect(g['matrix_annual_total']).toBeUndefined();
  });

  /**
   * ★ 실물(케이티 20260617000447)에서 잡은 별개 결함 — 같은 쌍이 (6)의 '가.(분기)' 표와
   * '나.(연1회)' 표에 **모두** 실린다. 종전에는 그냥 더해서 ㈜케이뱅크 → 비씨카드㈜ 가
   * 분기 89.39억 + 연1회 244.69억 = 334.08억으로 계상됐는데, 같은 문서 (5) 총괄표의 그 쌍은
   * **244.69억**이라 연1회 값만이 연간 총액임이 확인된다. 더하면 이중 계상이다.
   */
  it('같은 쌍이 분기 표와 연1회 표에 모두 있으면 **더하지 않고** 큰 쪽만 쓴다', async () => {
    const r = await run([
      ...HEAD,
      ...matrix('3,000'),
      ...detail([
        { label: 분기, amount: '1,000' },
        { label: 연1회, amount: '3,000' },
      ]),
    ]);
    const g = (r['goods_services_signals'] as Array<Record<string, any>>)[0]!;
    // 4,000백만(합)이 아니라 3,000백만(큰 쪽)
    expect(g['annual_amount_total']).toBe(3_000 * 백만);
    expect(g['label_overlap']).toBeDefined();
    expect(g['label_overlap'].quarterly_display).toBe('10억원');
    expect(g['label_overlap'].annual_display).toBe('30억원');
    expect(String(g['label_overlap'].note)).toContain('이중 계상');
    expect(r['diagnostics'].goods_services_matrix.pairs_in_both_major_detail_tables).toBe(1);
    // (5)와 같은 값이 됐으므로 승격은 일어나지 않는다
    expect(g['judged_on']).toBe('(6)합산');
    expect(
      (r['notes'] as string[]).some((n) => n.includes("'가.(분기)' 표와")),
    ).toBe(true);
  });

  it('한 표에만 있으면 종전대로 합산한다 (라벨 분리가 정상 합산을 깨지 않는다)', async () => {
    const r = await run([
      ...HEAD,
      ...matrix('1,000'),
      ...detail([
        { label: 연1회, amount: '2,000' },
        { label: 연1회, amount: '1,000' },
      ]),
    ]);
    const g = (r['goods_services_signals'] as Array<Record<string, any>>)[0]!;
    expect(g['annual_amount_total']).toBe(3_000 * 백만);
    expect(g['label_overlap']).toBeUndefined();
    expect(r['diagnostics'].goods_services_matrix.pairs_in_both_major_detail_tables).toBe(0);
  });
});
