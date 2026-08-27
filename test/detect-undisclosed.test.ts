/**
 * detect_undisclosed_transactions 판정 로직 테스트
 *
 * 픽스처(test/fixtures/j004-transactions.md)의 실측 수치:
 *  - 와이케이디벨롭먼트(주): 자본금 50억 / 자본총계 200억 → 기준금액 10억
 *  - 차입 160억(2025-02-19)·120억(2025-06-30) — 둘 다 100억 상한 이상 = 자본 무관 확실
 *  - 상품·용역 연간 58.9억(≥ 4×10억 → 신호) / 12.99억(< 40억 → 원리상 판정 불가)
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

function batch(rows: Disclosure[]): BatchResult {
  return {
    rows,
    diagnostics: {
      measure_calls: 1,
      collect_calls: 1,
      measure_budget_exhausted: false,
      date_chunks: [],
      chunks_failed: 0,
      partial_results: false,
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
      return batch(typeof j === 'function' ? j(corpCode) : j);
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

describe('기준금액 판정', () => {
  const thresholds = buildThresholdMap(extractCapitals(FIXTURE_MD));

  it('자본총계 200억 → 기준금액 10억', () => {
    const t = thresholds.get('와이케이디벨롭먼트')!;
    expect(t.value).toBe(10 * 억);
  });

  it('자본총계가 "자본잠식"이어도 자본금만으로 계산한다 (하한 5억)', () => {
    const t = thresholds.get('자본잠식회사')!;
    expect(t.value).toBe(5 * 억);
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
    // 검색창: 거래일·사업연도를 아우르는 넓은 창
    const w = cands[0].j001_search;
    expect(w.from < '20250101').toBe(true);
    expect(w.to >= '20251231').toBe(true);
    // 접수일이 미래로 열리지 않는다
    expect(w.to <= '20260827').toBe(true);
  });

  it('자금차입 J001 이 있으면 j001_filing_exists — 단 내용 대조는 아니라고 말한다', async () => {
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
    expect(r['summary'].j001_filing_exists).toBe(2);
    expect(r['j001_filing_exists'][0].matching_filings[0].rcept_no).toBe('20250210000123');
    expect(
      (r['scope_caveats'] as string[]).some((c) => c.includes('커버함을 대조한 것이 아닙니다')),
    ).toBe(true);
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

  it('상품·용역: 연간 ≥ 4×기준금액만 신호, 미만은 원리상 판정 불가로 분리한다', async () => {
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ corps: YKD_CORPS, j001: [] }),
    )) as Record<string, any>;

    // 58.9억 ≥ 40억 → 신호 (자본 기반 근사)
    expect(r['summary'].goods_services_candidates).toBe(1);
    const sig = r['goods_services_signals'][0];
    expect(sig.quarterly_logic).toBe('annual_geq_4x_threshold');
    expect(sig.certainty).toBe('approx_from_j004');
    expect(sig.status).toBe('undisclosed_candidate');
    // 12.99억 < 40억 → 판정 불가 (미공시 아님·공시됨 아님 어느 쪽도 아니다)
    expect(r['summary'].goods_services_not_judgeable).toBe(1);
    expect(r['goods_services_not_judgeable'][0].quarterly_logic).toBe('annual_below_4x_threshold');
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

  it('배당 품목은 4×기준금액 이상이어도 후보로 올리지 않는다 (비거래 가능성)', async () => {
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
    ].join('\n');
    const calls: CallLog[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: md, j001: [], calls }),
    )) as Record<string, any>;

    // 500억 ≥ 4×10억이지만 배당 품목이라 후보가 아니다 — J001 조회도 하지 않는다
    expect(r['summary'].goods_services_candidates).toBe(0);
    expect(r['summary'].goods_services_not_judgeable).toBe(1);
    expect(r['goods_services_not_judgeable'][0].item_caveat).toContain('배당');
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
