/**
 * detect_undisclosed_transactions 판정 로직 테스트
 *
 * 픽스처(test/fixtures/j004-transactions.md)의 실측 수치:
 *  - 와이케이디벨롭먼트(주): 자본금 50억 / 자본총계 200억 → 기준금액 10억
 *  - 차입 160억(2025-02-19)·120억(2025-06-30) — 둘 다 100억 상한 이상 = 자본 무관 확실
 *  - 상품·용역: 같은 상대방(미래에셋증권)에게 58.9억 + 12.99억 = **상대방별 합산 71.89억**
 *    (≥ 4×10억 → 신호. 행 단위로 보면 12.99억이 미달로 빠진다 — 교차검토 M-4의 재현 구조)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  detectUndisclosedTransactions,
  buildThresholdMap,
  judgeOverThreshold,
  isBorrowingReport,
  isGoodsServicesReport,
  itemLikelyNotGoodsService,
  type DetectDeps,
} from '../src/tools/detect-undisclosed-transactions.js';
import { extractCapitals } from '../src/parsers/j004-transactions.js';
import type { Disclosure } from '../src/clients/dart.js';
import type { BatchResult } from '../src/search/batch.js';
import type { DocMeta } from '../src/tools/read-disclosure.js';
import type { Population } from '../src/tools/audit-group-disclosures.js';
import { ToolError } from '../src/lib/errors.js';
import { 억 } from '../src/rules/thresholds.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_MD = readFileSync(join(HERE, 'fixtures', 'j004-transactions.md'), 'utf-8');

function disc(over: Partial<Disclosure>): Disclosure {
  return {
    corp_code: '00000000',
    corp_name: '',
    corp_cls: 'E',
    report_nm: '',
    rcept_no: '20250101000001',
    flr_nm: '',
    rcept_dt: '20250101',
    rm: '공',
    ...over,
  };
}

function batch(rows: Disclosure[], partial = false): BatchResult {
  return {
    rows,
    diagnostics: {
      measure_calls: 1,
      collect_calls: 1,
      measure_budget_exhausted: false,
      date_chunks: [],
      chunks_failed: 0,
      partial_results: partial,
      truncated: false,
      dedup_dropped: 0,
      total_count_reported: rows.length,
    },
  };
}

const META: DocMeta = {
  acode: '80622',
  aregcik: null,
  formulaVersion: null,
  encoding: 'utf-8',
  attachments: [],
  bodyParsable: true,
  boardDate: null,
  pickedEntry: null,
};

interface CallLog {
  corpCode: string;
  ty: string;
  from: string;
  to: string;
}

function makeDeps(opts: {
  markdown?: string;
  j001?: Disclosure[] | ((corpCode: string) => Disclosure[]);
  j001Partial?: boolean;
  j004?: Disclosure[];
  corps?: Record<string, Array<{ corpCode: string; corpName: string }>>;
  pop?: Population;
  calls?: CallLog[];
}): DetectDeps {
  return {
    loadDoc: async () => ({ markdown: opts.markdown ?? FIXTURE_MD, meta: META }),
    collectList: async (corpCode, detailTy, from, to) => {
      opts.calls?.push({ corpCode, ty: detailTy, from, to });
      if (detailTy === 'J004') return batch(opts.j004 ?? []);
      const j = opts.j001 ?? [];
      return batch(typeof j === 'function' ? j(corpCode) : j, opts.j001Partial ?? false);
    },
    resolvePop: async () => {
      if (!opts.pop) throw new Error('resolvePop 이 호출되면 안 되는 테스트입니다');
      return opts.pop;
    },
    findCorps: (name) => opts.corps?.[name] ?? [],
  };
}

const YKD_CORPS = {
  와이케이디벨롭먼트: [{ corpCode: '00222222', corpName: '와이케이디벨롭먼트' }],
};

describe('보고서명 유형 필터', () => {
  it('자금차입 — 공백·정정 접두사·가운뎃점 변형을 흡수한다', () => {
    expect(isBorrowingReport('대규모내부거래관련이사회의결및공시(자금차입)')).toBe(true);
    expect(isBorrowingReport('[기재정정]대규모내부거래관련 이사회 의결 및 공시 (자금차입)')).toBe(true);
    expect(isBorrowingReport('대규모내부거래관련이사회의결및공시(자금대여)')).toBe(false);
  });

  it('상품·용역 — 변경 공시도 잡고 무관 유형은 거른다', () => {
    expect(isGoodsServicesReport('대규모내부거래관련이사회의결및공시(상품ㆍ용역거래)')).toBe(true);
    expect(isGoodsServicesReport('대규모내부거래관련이사회의결및공시(상품·용역거래변경)')).toBe(true);
    expect(isGoodsServicesReport('대규모내부거래관련이사회의결및공시(자금차입)')).toBe(false);
  });
});

describe('품목 성격 분리 (S-6)', () => {
  it('배당·이자·임대차 성격 품목은 caveat 를 받는다', () => {
    expect(itemLikelyNotGoodsService('배당금수익')).toContain('배당');
    expect(itemLikelyNotGoodsService('이자수익')).toContain('이자');
    expect(itemLikelyNotGoodsService('부동산 임대료')).toContain('임대차');
    expect(itemLikelyNotGoodsService('사옥 임차')).toContain('임대차');
  });

  it('일반 상품·용역 품목은 통과한다', () => {
    expect(itemLikelyNotGoodsService('골프장운영')).toBeNull();
    expect(itemLikelyNotGoodsService('전산시스템 운영용역')).toBeNull();
  });
});

describe('기준금액 판정', () => {
  const { map: thresholds } = buildThresholdMap(extractCapitals(FIXTURE_MD));

  it('자본총계 200억 → 기준금액 10억', () => {
    const t = thresholds.get('와이케이디벨롭먼트')!;
    expect(t.value).toBe(10 * 억);
  });

  it('자본총계가 "자본잠식"이어도 자본금만으로 계산한다 (하한 5억)', () => {
    const t = thresholds.get('자본잠식회사')!;
    expect(t.value).toBe(5 * 억);
  });

  it('정규화 동명인데 자본이 다르면 둘 다 버리고 conflicts 로 보고한다 (S-3)', () => {
    const { map, conflicts } = buildThresholdMap([
      { company: '동명회사(주)', paidInCapital: 50 * 억, totalEquity: 200 * 억 },
      { company: '동명회사 주식회사', paidInCapital: 10 * 억, totalEquity: 40 * 억 },
      { company: '동명회사(주)', paidInCapital: 50 * 억, totalEquity: 200 * 억 }, // 3번째도 부활 금지
    ]);
    expect(map.has('동명회사')).toBe(false);
    expect(conflicts).toEqual(['동명회사']);
  });

  it('같은 이름·같은 값의 중복 행은 충돌이 아니다', () => {
    const { map, conflicts } = buildThresholdMap([
      { company: '중복회사(주)', paidInCapital: 50 * 억, totalEquity: 200 * 억 },
      { company: '중복회사(주)', paidInCapital: 50 * 억, totalEquity: 200 * 억 },
    ]);
    expect(map.get('중복회사')!.value).toBe(10 * 억);
    expect(conflicts).toEqual([]);
  });

  it('100억 이상 거래는 자본을 몰라도 확실하다 (령 §33①1호 상한)', () => {
    expect(judgeOverThreshold(160 * 억, undefined)).toEqual({
      over: true,
      certainty: 'certain_by_cap',
    });
  });

  it('100억 미만 + 자본 미상이면 판정하지 않는다', () => {
    expect(judgeOverThreshold(50 * 억, undefined)).toEqual({ over: null });
  });

  it('100억 미만은 근사 기준금액으로 판정하고 근사임을 표시한다', () => {
    const th = { value: 10 * 억, formula: '', source_row: '' };
    expect(judgeOverThreshold(50 * 억, th)).toEqual({
      over: true,
      certainty: 'approx_from_j004',
    });
    expect(judgeOverThreshold(9 * 억, th)).toEqual({ over: false });
  });
});

describe('rcept_no 경로 — 미공시 후보 판정', () => {
  it('J001 이 없으면 차입 2건 모두 미공시 후보 (둘 다 100억 이상 = 확실)', async () => {
    const calls: CallLog[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ corps: YKD_CORPS, j001: [], calls }),
    )) as Record<string, any>;

    expect(r['summary'].undisclosed_candidates).toBe(2);
    const cands = r['undisclosed_candidates'];
    expect(cands.map((c: any) => c.certainty)).toEqual(['certain_by_cap', 'certain_by_cap']);
    expect(cands[0].date).toBe('20250219');
    expect(cands[0].amount).toBe(160 * 억);
    expect(cands[0].corp_code).toBe('00222222');
    // 회사당 1회만 검색한다 (J001 1콜 — 같은 회사 차입 2건 + 상품용역 신호 1건이 공유)
    expect(calls.filter((c) => c.ty === 'J001')).toHaveLength(1);
    // 검색창: 거래일·사업연도를 아우르는 넓은 창, 상한은 **오늘** (M-5)
    const w = cands[0].j001_search;
    expect(w.from < '20250101').toBe(true);
    expect(w.to).toBe('20260827');
  });

  it('★ C-1: 공시 1건이 그 회사의 모든 차입을 "공시됨"으로 만들지 않는다 — 건별 근접 대조', async () => {
    // 2/19 차입 직전(2/14 아닌 2/10로 가정) 공시 1건뿐 — 6/30 차입 근방에는 공시가 없다.
    // 종전 동작: 둘 다 j001_filing_exists (부분 공시 은폐 = 거짓 안심 최악 방향).
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [
          disc({
            corp_code: '00222222',
            report_nm: '대규모내부거래관련이사회의결및공시(자금차입)',
            rcept_no: '20250210000123',
            rcept_dt: '20250210',
          }),
        ],
      }),
    )) as Record<string, any>;

    expect(r['summary'].undisclosed_candidates).toBe(0);
    expect(r['summary'].j001_filing_near_date).toBe(1);
    expect(r['summary'].j001_filing_in_window_only).toBe(1);

    const near = r['j001_filing_near_date'][0];
    expect(near.date).toBe('20250219');
    expect(near.nearest_filing_gap_days).toBe(-9);
    expect(near.matching_filings[0].rcept_no).toBe('20250210000123');

    const windowOnly = r['j001_filing_in_window_only'][0];
    expect(windowOnly.date).toBe('20250630');
    expect(windowOnly.nearest_filing_gap_days).toBe(-140);
    expect(windowOnly.reason).toContain('부분 공시');

    // 같은 회사에서 일부 차입만 근접 공시 → 우선 확인 대상 경고
    expect(
      (r['notes'] as string[]).some((n) => n.includes('일부 차입에만 근접 공시')),
    ).toBe(true);
    // 내용 대조는 아니라는 caveat 유지
    expect(
      (r['scope_caveats'] as string[]).some((c) => c.includes('커버함을 대조한 것이 아닙니다')),
    ).toBe(true);
  });

  it('M-5: 회계연도말 +90일 밖의 자진시정 공시도 창에 들어온다 (to = 오늘)', async () => {
    // 2026-06-10 지연 공시(자진시정) — 종전 창 상한(2026-03-31경)이면 못 보고 후보로 지목했다
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [
          disc({
            corp_code: '00222222',
            report_nm: '대규모내부거래관련이사회의결및공시(자금차입)',
            rcept_no: '20260610000777',
            rcept_dt: '20260610',
          }),
        ],
      }),
    )) as Record<string, any>;

    expect(r['summary'].undisclosed_candidates).toBe(0);
    // 근접 창(−90~+30일) 밖이므로 near 는 아니다 — in_window_only 로 확인 대상
    expect(r['summary'].j001_filing_in_window_only).toBe(2);
  });

  it("S-5: '[공시취소]' 접수분은 공시 존재의 근거가 아니다", async () => {
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [
          disc({
            corp_code: '00222222',
            report_nm: '[공시취소]대규모내부거래관련이사회의결및공시(자금차입)',
            rcept_no: '20250225000001',
            rcept_dt: '20250225',
          }),
        ],
      }),
    )) as Record<string, any>;

    expect(r['summary'].undisclosed_candidates).toBe(2);
    expect(r['undisclosed_candidates'][0].other_j001_in_window).toBe(1);
    expect((r['notes'] as string[]).some((n) => n.includes('공시취소'))).toBe(true);
  });

  it('M-7: 수집이 불완전하면 "공시 없음"을 후보로 단정하지 않는다', async () => {
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ corps: YKD_CORPS, j001: [], j001Partial: true }),
    )) as Record<string, any>;

    expect(r['summary'].undisclosed_candidates).toBe(0);
    expect(r['summary'].not_judged).toBe(2);
    expect(r['not_judged'][0].reason).toContain('list_incomplete');
    // 상품·용역 신호도 같은 이유로 not_judged
    expect(r['summary'].goods_services_not_judged).toBe(1);
  });

  it('M-7: 수집이 불완전해도 공시를 찾았으면 판정하되 search_partial 을 밝힌다', async () => {
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001Partial: true,
        j001: [
          disc({
            corp_code: '00222222',
            report_nm: '대규모내부거래관련이사회의결및공시(자금차입)',
            rcept_no: '20250210000123',
            rcept_dt: '20250210',
          }),
        ],
      }),
    )) as Record<string, any>;

    expect(r['summary'].j001_filing_near_date).toBe(1);
    expect(r['j001_filing_near_date'][0].search_partial).toBe(true);
  });

  it('다른 유형 J001 만 있으면 미공시 후보 + 그 공시들을 함께 보여준다', async () => {
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [
          disc({
            corp_code: '00222222',
            report_nm: '대규모내부거래관련이사회의결및공시(자금대여)',
            rcept_no: '20250301000001',
            rcept_dt: '20250301',
          }),
        ],
      }),
    )) as Record<string, any>;

    const cand = r['undisclosed_candidates'][0];
    expect(cand.status).toBe('undisclosed_candidate');
    expect(cand.other_j001_in_window).toBe(1);
    expect(cand.other_j001_sample[0].report_nm).toContain('자금대여');
  });

  it('★ M-4: 상품·용역은 (회사, 상대방) 연간 합산으로 4× 판정한다 — 품목 행 단위가 아니다', async () => {
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ corps: YKD_CORPS, j001: [] }),
    )) as Record<string, any>;

    // 58.9억 + 12.99억 = 71.89억 ≥ 4×10억 → 상대방별 합산 신호 1건 (품목 2행 동봉).
    // 행 단위였으면 12.99억이 annual_below_4x 로 빠졌다.
    expect(r['summary'].goods_services_candidates).toBe(1);
    const sig = r['goods_services_signals'][0];
    expect(sig.quarterly_logic).toBe('annual_geq_4x_threshold');
    expect(sig.certainty).toBe('approx_from_j004');
    expect(sig.status).toBe('undisclosed_candidate');
    expect(sig.annual_amount_total).toBe(7_189 * 1_000_000);
    expect(sig.items).toHaveLength(2);
    expect(sig.items.map((i: any) => i.item)).toEqual(['골프장운영', '부동산관리']);
    // 합산으로 전부 신호에 들어갔으므로 판정 불가 버킷은 비어 있다
    expect(r['summary'].goods_services_not_judgeable).toBe(0);
    // 합산 단위 해석을 caveat 으로 밝힌다
    expect(
      (r['scope_caveats'] as string[]).some((c) => c.includes('연간 합산')),
    ).toBe(true);
  });

  it('상품·용역: 합산이 4×기준금액 미만이면 원리상 판정 불가로 분리한다', async () => {
    const md = [
      '## (2) 회사 재무현황',
      '| (단위 : 백만원, %) |',
      '| --- |',
      '| 계열회사명 |  | 자본금 | 자본총계 |',
      '| --- | --- | --- | --- |',
      '| 비금융회사 | 소소한회사(주) | 5,000 | 20,000 |',
      '## (6) 계열회사간 주요 상품ㆍ용역거래 내역',
      '| (단위 : 백만원) |',
      '| --- |',
      '| 소속회사명 |  | 거래상대방 | 품목 | 매출액 |',
      '| --- | --- | --- | --- | --- |',
      '| 비금융회사 | 소소한회사(주) | 계열사(주) | 경비용역 | 1,000 |',
      '| 비금융회사 | 소소한회사(주) | 계열사(주) | 청소용역 | 1,500 |',
    ].join('\n');
    const calls: CallLog[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: md, j001: [], calls }),
    )) as Record<string, any>;

    // 합산 25억 < 4×10억 → 판정 불가 (J001 조회도 하지 않는다)
    expect(r['summary'].goods_services_candidates).toBe(0);
    expect(r['summary'].goods_services_not_judgeable).toBe(1);
    const nj = r['goods_services_not_judgeable'][0];
    expect(nj.quarterly_logic).toBe('annual_below_4x_threshold');
    expect(nj.annual_amount_total).toBe(2_500 * 1_000_000);
    expect(calls.filter((c) => c.ty === 'J001')).toHaveLength(0);
  });

  it('상품·용역 J001 이 있으면 신호가 j001_filing_exists 로 이동한다', async () => {
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [
          disc({
            corp_code: '00222222',
            report_nm: '대규모내부거래관련이사회의결및공시(상품ㆍ용역거래)',
            rcept_no: '20250401000009',
            rcept_dt: '20250401',
          }),
        ],
      }),
    )) as Record<string, any>;

    expect(r['summary'].goods_services_candidates).toBe(0);
    expect(r['summary'].goods_services_filing_exists).toBe(1);
    // 차입 쪽은 자금차입 공시가 없으므로 여전히 후보다 — 유형 필터가 섞이지 않는다
    expect(r['summary'].undisclosed_candidates).toBe(2);
  });

  it('조인 실패는 not_judged 로 분리하고 J001 을 조회하지 않는다', async () => {
    const calls: CallLog[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ corps: {}, j001: [], calls }),
    )) as Record<string, any>;

    expect(r['summary'].undisclosed_candidates).toBe(0);
    expect(r['summary'].not_judged).toBe(2);
    expect(r['not_judged'][0].reason).toContain('join_failed');
    expect(r['join_failures']).toHaveLength(1);
    expect(calls.filter((c) => c.ty === 'J001')).toHaveLength(0);
    expect((r['notes'] as string[]).some((n) => n.includes('확인하지 못한 것'))).toBe(true);
    // 상품·용역 신호도 조용히 사라지지 않고 not_judged 로 남는다
    expect(r['summary'].goods_services_not_judged).toBe(1);
    const gs = r['goods_services_signals'];
    expect(gs).toHaveLength(1);
    expect(gs[0].status).toBe('not_judged');
  });

  it('배당 품목은 4×기준금액 이상이어도 후보로 올리지 않고 합산에도 넣지 않는다', async () => {
    const md = [
      '## (2) 회사 재무현황',
      '| (단위 : 백만원, %) |',
      '| --- |',
      '| 계열회사명 |  | 자본금 | 자본총계 |',
      '| --- | --- | --- | --- |',
      '| 비금융회사 | 배당수령사(주) | 5,000 | 20,000 |',
      '## (6) 계열회사간 주요 상품ㆍ용역거래 내역',
      '| (단위 : 백만원) |',
      '| --- |',
      '| 소속회사명 |  | 거래상대방 | 품목 | 매출액 |',
      '| --- | --- | --- | --- | --- |',
      '| 비금융회사 | 배당수령사(주) | 계열사(주) | 배당금수익 | 50,000 |',
      '| 비금융회사 | 배당수령사(주) | 계열사(주) | 경비용역 | 1,000 |',
    ].join('\n');
    const calls: CallLog[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: md, j001: [], calls }),
    )) as Record<string, any>;

    // 배당 500억은 후보·합산 어느 쪽에도 없다 — 배당이 합산을 부풀려 만드는 오경보 차단
    expect(r['summary'].goods_services_candidates).toBe(0);
    expect(r['summary'].goods_services_item_caveats).toBe(1);
    expect(r['goods_services_item_caveats'][0].item_caveat).toContain('배당');
    // 경비용역 10억만 합산 → 4×10억 미만 → 판정 불가
    expect(r['summary'].goods_services_not_judgeable).toBe(1);
    expect(calls.filter((c) => c.ty === 'J001')).toHaveLength(0);
    expect(
      (r['notes'] as string[]).some((n) => n.includes('거래의 대가가 아닐 가능성')),
    ).toBe(true);
  });

  it('후보 0건에는 "미공시 없음 확인이 아니다" 안내가 붙는다', async () => {
    const md = [
      '## (2) 회사 재무현황',
      '| (단위 : 백만원, %) |',
      '| --- |',
      '| 계열회사명 |  | 자본금 | 자본총계 |',
      '| --- | --- | --- | --- |',
      '| 비금융회사 | 소소한회사(주) | 5,000 | 20,000 |',
      '## (1) 계열회사간 자금거래 현황',
      '가. 일반 차입',
      '| (단위 : 백만원) |',
      '| --- |',
      '| 차입회사 (소속회사) |  | 거래상대방 | 차입금액 | 차입일 |',
      '| --- | --- | --- | --- | --- |',
      '| 비금융회사 | 소소한회사(주) | 계열사(주) | 500 | 2025-03-01 |',
    ].join('\n');
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: md, j001: [] }),
    )) as Record<string, any>;

    // 5억 차입 < 기준금액 10억 → below_threshold
    expect(r['summary'].below_threshold).toBe(1);
    expect(r['summary'].undisclosed_candidates).toBe(0);
    expect((r['notes'] as string[]).some((n) => n.includes('"미공시 없음"의 확인이 아닙니다'))).toBe(
      true,
    );
    // below 도 근사 기준임을 caveat 으로 밝힌다
    expect(
      (r['scope_caveats'] as string[]).some((c) => c.includes('기준 미달 = 공시의무 없음 확정')),
    ).toBe(true);
  });

  it('자본 미상 + 100억 미만은 threshold_unknown 으로 판정하지 않는다', async () => {
    const md = [
      '## (1) 계열회사간 자금거래 현황',
      '가. 일반 차입',
      '| (단위 : 백만원) |',
      '| --- |',
      '| 차입회사 (소속회사) |  | 거래상대방 | 차입금액 | 차입일 |',
      '| --- | --- | --- | --- | --- |',
      '| 비금융회사 | 자본미상회사(주) | 계열사(주) | 5,000 | 2025-03-01 |',
    ].join('\n');
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: md, j001: [] }),
    )) as Record<string, any>;

    expect(r['summary'].not_judged).toBe(1);
    expect(r['not_judged'][0].reason).toContain('threshold_unknown');
    // 재무현황 절 자체가 없다는 사실을 침묵하지 않는다
    expect((r['notes'] as string[]).some((n) => n.includes('절을 찾지 못했습니다'))).toBe(true);
  });

  it('rcept_no 경로에는 fiscal_year 가 추정임을 알리는 안내가 붙는다 (S-2)', async () => {
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ corps: YKD_CORPS, j001: [] }),
    )) as Record<string, any>;
    expect((r['notes'] as string[]).some((n) => n.includes('접수월 기반 추정'))).toBe(true);
  });

  it('S-1: today 가 원천 문서 접수일보다 앞서면 오타로 보고 거부한다', async () => {
    await expect(
      detectUndisclosedTransactions(
        { rcept_no: '20260601001646', today: '20260101' },
        makeDeps({ corps: YKD_CORPS, j001: [] }),
      ),
    ).rejects.toThrow('접수일');
  });

  it('입력 검증 — rcept_no 와 group·year 조합 규칙', async () => {
    await expect(detectUndisclosedTransactions({}, makeDeps({}))).rejects.toThrow(ToolError);
    await expect(
      detectUndisclosedTransactions({ rcept_no: '20260601001646', group: '미래에셋' }, makeDeps({})),
    ).rejects.toThrow('동시에');
    await expect(
      detectUndisclosedTransactions({ rcept_no: '20260601001646', year: 2026 }, makeDeps({})),
    ).rejects.toThrow('group 경로');
  });
});

describe('group 경로 — 대표회사 연1회 서식 자동 탐색', () => {
  const pop: Population = {
    corpCodes: new Map([
      ['00111111', '미래에셋캐피탈(주)'],
      ['00222222', '와이케이디벨롭먼트(주)'],
    ]),
    group: { representative_company: '미래에셋캐피탈㈜' },
    unjoined: [],
  };
  const j004 = [
    disc({
      corp_code: '00111111',
      report_nm: '대규모기업집단현황공시[연1회공시및1/4분기용(대표회사)]',
      rcept_no: '20260531000001',
      rcept_dt: '20260531',
    }),
    disc({
      corp_code: '00111111',
      report_nm: '[기재정정]대규모기업집단현황공시[연1회공시및1/4분기용(대표회사)]',
      rcept_no: '20260601001646',
      rcept_dt: '20260601',
    }),
    disc({
      corp_code: '00111111',
      report_nm: '대규모기업집단현황공시[분기별공시(대표회사용)]',
      rcept_no: '20260831000001',
      rcept_dt: '20260831',
    }),
  ];

  it('정정 반영 최신 연1회 서식을 고르고, 소속회사 이름으로 조인한다', async () => {
    const calls: CallLog[] = [];
    const r = (await detectUndisclosedTransactions(
      { group: '미래에셋', year: 2026, today: '20260827' },
      makeDeps({ pop, j004, j001: [], calls }),
    )) as Record<string, any>;

    expect(r['scope'].source_rcept_no).toBe('20260601001646');
    expect(r['scope'].fiscal_year).toBe(2025);
    // 정정본을 읽었음을 밝힌다
    expect((r['notes'] as string[]).some((n) => n.includes('정정 접수분(최신본)'))).toBe(true);
    // J004 탐색 1콜 + 와이케이디 J001 1콜
    expect(calls.map((c) => c.ty)).toEqual(['J004', 'J001']);
    // corps 인덱스 없이 포털 이름으로 조인됐다
    expect(r['undisclosed_candidates'][0].corp_code).toBe('00222222');
    // 편입일 데이터가 없으면 없다고 말한다 (M-6)
    expect((r['notes'] as string[]).some((n) => n.includes('계열편입일'))).toBe(true);
  });

  it('M-6: 계열편입일 이전 차입은 no_duty_before_joining 으로 분리한다', async () => {
    const popJoined: Population = {
      ...pop,
      joinedGroupAt: new Map([['00222222', '20250401']]),
    };
    const r = (await detectUndisclosedTransactions(
      { group: '미래에셋', year: 2026, today: '20260827' },
      makeDeps({ pop: popJoined, j004, j001: [] }),
    )) as Record<string, any>;

    // 2/19 차입은 편입(4/1) 전 → 의무 없음 분리, 6/30 차입은 편입 후 → 여전히 후보
    expect(r['summary'].no_duty_before_joining).toBe(1);
    expect(r['no_duty_before_joining'][0].date).toBe('20250219');
    expect(r['no_duty_before_joining'][0].joined_group_at).toBe('20250401');
    expect(r['no_duty_before_joining'][0].reason).toContain('편입');
    expect(r['summary'].undisclosed_candidates).toBe(1);
    expect(r['undisclosed_candidates'][0].date).toBe('20250630');
    // 지정 연혁은 확인하지 않는다는 caveat
    expect(
      (r['scope_caveats'] as string[]).some((c) => c.includes('지정 연혁')),
    ).toBe(true);
  });

  it('같은 날 원본+정정 동시 접수면 접수번호가 큰 쪽(정정)을 고른다', async () => {
    const sameDay = [
      disc({
        corp_code: '00111111',
        report_nm: '대규모기업집단현황공시[연1회공시및1/4분기용(대표회사)]',
        rcept_no: '20260531000001',
        rcept_dt: '20260531',
      }),
      disc({
        corp_code: '00111111',
        report_nm: '[기재정정]대규모기업집단현황공시[연1회공시및1/4분기용(대표회사)]',
        rcept_no: '20260531000900',
        rcept_dt: '20260531',
      }),
    ];
    const r = (await detectUndisclosedTransactions(
      { group: '미래에셋', year: 2026, today: '20260827' },
      makeDeps({ pop, j004: sameDay, j001: [] }),
    )) as Record<string, any>;
    expect(r['scope'].source_rcept_no).toBe('20260531000900');
  });

  it('연1회 서식이 없으면 document_not_found + 직접 지정 안내', async () => {
    await expect(
      detectUndisclosedTransactions(
        { group: '미래에셋', year: 2026, today: '20260827' },
        makeDeps({ pop, j004: [j004[2]!], j001: [] }),
      ),
    ).rejects.toThrow('연1회 J004 를 찾지 못했습니다');
  });

  it('대표회사 조인 실패는 rcept_no 직접 지정을 안내한다', async () => {
    const badPop: Population = {
      corpCodes: new Map([['00222222', '와이케이디벨롭먼트(주)']]),
      group: { representative_company: '미래에셋캐피탈㈜' },
      unjoined: ['미래에셋캐피탈(주)'],
    };
    await expect(
      detectUndisclosedTransactions(
        { group: '미래에셋', year: 2026, today: '20260827' },
        makeDeps({ pop: badPop, j004, j001: [] }),
      ),
    ).rejects.toThrow('rcept_no');
  });
});
