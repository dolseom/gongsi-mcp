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
  isSecuritiesReport,
  isLendingReport,
  looksLikeNaturalPerson,
  itemLikelyNotGoodsService,
  type DetectDeps,
} from '../src/tools/detect-undisclosed-transactions.js';
import { extractCapitals } from '../src/parsers/j004-transactions.js';
import type { Disclosure } from '../src/clients/dart.js';
import type { BatchResult } from '../src/search/batch.js';
import type { DocMeta } from '../src/tools/read-disclosure.js';
import type { Population, PopulationInput } from '../src/tools/audit-group-disclosures.js';
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
  /** resolvePop 이 어떤 입력으로 불렸는지 기록 (rcept_no 경로의 문서 집단명 조회 검증용) */
  popCalls?: PopulationInput[];
}): DetectDeps {
  return {
    loadDoc: async () => ({ markdown: opts.markdown ?? FIXTURE_MD, meta: META }),
    collectList: async (corpCode, detailTy, from, to) => {
      opts.calls?.push({ corpCode, ty: detailTy, from, to });
      if (detailTy === 'J004') return batch(opts.j004 ?? []);
      const j = opts.j001 ?? [];
      return batch(typeof j === 'function' ? j(corpCode) : j, opts.j001Partial ?? false);
    },
    resolvePop: async (input) => {
      opts.popCalls?.push(input);
      // pop 을 주지 않으면 "EGROUP 키 없음·포털 실패" 를 흉내낸다 — rcept_no 경로는 이때
      // 예외 없이 종전 동작(DART 상호 매칭)으로 폴백해야 한다.
      if (!opts.pop) throw new Error('EGROUP_API_KEY 가 설정되지 않았습니다 (테스트 스텁)');
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

describe('품목 성격 분리 (S-6·M6)', () => {
  it('배당·이자·임대차 성격 품목은 caveat 를 받는다', () => {
    expect(itemLikelyNotGoodsService('배당금수익')).toContain('배당');
    expect(itemLikelyNotGoodsService('이자수익')).toContain('이자');
    expect(itemLikelyNotGoodsService('부동산 임대료')).toContain('임대차');
    expect(itemLikelyNotGoodsService('사옥 임차')).toContain('임대차');
  });

  it('키워드가 어미일 때만 분리한다 — 진짜 용역을 부분문자열로 빼지 않는다 (Codex 4차 M6)', () => {
    expect(itemLikelyNotGoodsService('배당전산시스템 구축용역')).toBeNull();
    expect(itemLikelyNotGoodsService('이자율 산출 자문용역')).toBeNull();
    expect(itemLikelyNotGoodsService('임대관리 시스템 유지보수용역')).toBeNull();
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

  it('★ C2: 개별 기준 미달이어도 같은 상대방 연간 합산이 기준 이상이면 "기준 미달"로 단정하지 않는다', async () => {
    // 자본총계 200억 → 기준금액 10억. 4억×3회 분할 차입(합산 12억)은 §4③의
    // "동일 거래상대방과의 동일 거래대상" 기준으로는 공시대상일 수 있다 —
    // 종전엔 3건 전부 below_threshold(거짓 안심)였다.
    const md = [
      '## (2) 회사 재무현황',
      '| (단위 : 백만원, %) |',
      '| --- |',
      '| 계열회사명 |  | 자본금 | 자본총계 |',
      '| --- | --- | --- | --- |',
      '| 비금융회사 | 분할차입사(주) | 5,000 | 20,000 |',
      '## (1) 계열회사간 자금거래 현황',
      '가. 일반 차입',
      '| (단위 : 백만원) |',
      '| --- |',
      '| 차입회사 (소속회사) |  | 거래상대방 | 차입금액 | 차입일 |',
      '| --- | --- | --- | --- | --- |',
      '| 비금융회사 | 분할차입사(주) | 계열사(주) | 400 | 2025-02-01 |',
      '| 비금융회사 | 분할차입사(주) | 계열사(주) | 400 | 2025-05-01 |',
      '| 비금융회사 | 분할차입사(주) | 계열사(주) | 400 | 2025-08-01 |',
      '| 비금융회사 | 분할차입사(주) | 다른계열사(주) | 500 | 2025-03-01 |',
    ].join('\n');
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: md, j001: [] }),
    )) as Record<string, any>;

    // 같은 상대방 3건: 합산 12억 ≥ 10억 → not_judged(aggregation_unknown)
    expect(r['summary'].not_judged).toBe(3);
    const nj = r['not_judged'][0];
    expect(nj.reason).toContain('aggregation_unknown');
    expect(nj.same_counterparty_annual_total).toBe(12 * 억);
    // 다른 상대방 5억 1건: 합산도 5억 < 10억 → below_threshold 유지
    expect(r['summary'].below_threshold).toBe(1);
    expect(r['below_threshold'][0].counterparty).toBe('다른계열사(주)');
    expect(
      (r['scope_caveats'] as string[]).some((c) => c.includes('동일 거래대상')),
    ).toBe(true);
  });

  it('M2: 같은 유형 [공시취소]가 매칭 공시 수 이상이면 "공시 존재"로 판정하지 않는다', async () => {
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
          disc({
            corp_code: '00222222',
            report_nm: '[공시취소]대규모내부거래관련이사회의결및공시(자금차입)',
            rcept_no: '20250225000009',
            rcept_dt: '20250225',
          }),
        ],
      }),
    )) as Record<string, any>;

    // 원공시 1 + 취소 1 → 남은 매칭 공시가 취소된 원공시일 수 있다
    expect(r['summary'].j001_filing_near_date).toBe(0);
    expect(r['summary'].j001_filing_in_window_only).toBe(0);
    expect(r['summary'].not_judged).toBe(2);
    expect(r['not_judged'][0].reason).toContain('filing_cancelled_status_unknown');
    // 대조할 매칭 공시는 함께 준다
    expect(r['not_judged'][0].matching_filings[0].rcept_no).toBe('20250210000123');
  });

  it('S2: 차입일이 오늘 이후면 후보가 아니라 not_judged 다 (원문 기재 오류 가능)', async () => {
    const md = [
      '## (1) 계열회사간 자금거래 현황',
      '가. 일반 차입',
      '| (단위 : 백만원) |',
      '| --- |',
      '| 차입회사 (소속회사) |  | 거래상대방 | 차입금액 | 차입일 |',
      '| --- | --- | --- | --- | --- |',
      '| 비금융회사 | 미래차입사(주) | 계열사(주) | 16,000 | 2027-01-01 |',
    ].join('\n');
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: md, j001: [] }),
    )) as Record<string, any>;

    expect(r['summary'].undisclosed_candidates).toBe(0);
    expect(r['summary'].not_judged).toBe(1);
    expect(r['not_judged'][0].reason).toContain('future_transaction_date');
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
    expect(r['summary'].goods_services_candidates_if_qualified).toBe(1);
    const sig = r['goods_services_signals'][0];
    expect(sig.quarterly_logic).toBe('annual_geq_4x_threshold');
    expect(sig.certainty).toBe('approx_from_j004');
    // ★ Codex 4차 C1: 상대방 요건(총수일가 20%↑ 출자, 법 §26①4호·령 §33②)을 확인할 수
    // 없으므로 "미공시 후보"가 아니라 **조건부 후보**다 — 후보 단정은 오경보 방향.
    expect(sig.status).toBe('candidate_if_counterparty_qualified');
    expect(sig.counterparty_qualification).toBe('not_verified');
    expect(sig.reason).toContain('20%');
    expect(sig.annual_amount_total).toBe(7_189 * 1_000_000);
    expect(sig.items).toHaveLength(2);
    expect(sig.items.map((i: any) => i.item)).toEqual(['골프장운영', '부동산관리']);
    // 합산으로 전부 신호에 들어갔으므로 판정 불가 버킷은 비어 있다
    expect(r['summary'].goods_services_not_judgeable).toBe(0);
    // 합산 단위 해석과 상대방 요건 한정을 caveat 으로 밝힌다
    expect(
      (r['scope_caveats'] as string[]).some((c) => c.includes('연간 합산')),
    ).toBe(true);
    expect(
      (r['scope_caveats'] as string[]).some((c) => c.includes('동일인이 법인인 집단')),
    ).toBe(true);
    expect((r['notes'] as string[]).some((n) => n.includes('조건부 후보'))).toBe(true);
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
    expect(r['summary'].goods_services_candidates_if_qualified).toBe(0);
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

    expect(r['summary'].goods_services_candidates_if_qualified).toBe(0);
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
    expect(r['summary'].goods_services_candidates_if_qualified).toBe(0);
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

  it('M7: DART 폴백 조인이 집단 목록 어디에도 없는 회사를 가리키면 판정하지 않는다', async () => {
    // 포털 소속 목록(조인·미조인 모두)에 와이케이디가 없고, DART 에 동명 회사(00999999)만
    // 있는 상황 — 비계열 동명 회사일 수 있으므로 그 회사의 J001 로 판정하면 안 된다.
    const popNoYkd: Population = {
      corpCodes: new Map([['00111111', '미래에셋캐피탈(주)']]),
      group: { representative_company: '미래에셋캐피탈㈜' },
      unjoined: [],
    };
    const calls: CallLog[] = [];
    const r = (await detectUndisclosedTransactions(
      { group: '미래에셋', year: 2026, today: '20260827' },
      makeDeps({
        pop: popNoYkd,
        j004,
        j001: [],
        calls,
        corps: { 와이케이디벨롭먼트: [{ corpCode: '00999999', corpName: '와이케이디벨롭먼트' }] },
      }),
    )) as Record<string, any>;

    expect(r['summary'].undisclosed_candidates).toBe(0);
    expect(r['summary'].not_judged).toBe(2);
    expect(r['join_failures'][0].reason).toContain('dart_join_unverified');
    expect(calls.filter((c) => c.ty === 'J001')).toHaveLength(0);
  });

  it('M7: 포털 미조인 목록에 있는 이름이면 DART 유일 일치 조인을 허용한다 (실물: 미래에셋금융서비스)', async () => {
    // jurir 미조인이라 corp_code 는 없지만 포털이 소속을 보증하는 이름 — 막으면 실전
    // 신호(보험판매 2054.5억류)가 조인 캐시 상태에 따라 사라진다.
    const popUnjoined: Population = {
      corpCodes: new Map([['00111111', '미래에셋캐피탈(주)']]),
      group: { representative_company: '미래에셋캐피탈㈜' },
      unjoined: ['와이케이디벨롭먼트(주)'],
    };
    const r = (await detectUndisclosedTransactions(
      { group: '미래에셋', year: 2026, today: '20260827' },
      makeDeps({
        pop: popUnjoined,
        j004,
        j001: [],
        corps: { 와이케이디벨롭먼트: [{ corpCode: '00222222', corpName: '와이케이디벨롭먼트' }] },
      }),
    )) as Record<string, any>;

    expect(r['summary'].undisclosed_candidates).toBe(2);
    expect(r['undisclosed_candidates'][0].corp_code).toBe('00222222');
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

  it('유형 공시가 있으면 filing_exists — 약관특례 서식으로도 잡힌다', async () => {
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
      }),
    )) as Record<string, any>;
    const sigs = res.securities_signals as Array<Record<string, unknown>>;
    const over = sigs.find((s) => s.counterparty === '미래에셋 증권(주)')!;
    expect(over.status).toBe('j001_filing_exists');
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

describe('rcept_no 경로 포털 population 로드 (E-1)', () => {
  const POP: Population = {
    corpCodes: new Map([
      ['00111111', '미래에셋캐피탈(주)'],
      ['00222222', '와이케이디벨롭먼트(주)'],
    ]),
    group: { representative_company: '미래에셋캐피탈㈜' },
    unjoined: ['미래에셋컨설팅(주)'],
    joinedGroupAt: new Map([['00222222', '20161001']]),
  };

  it('문서의 기업집단명으로 포털 소속회사 목록을 불러온다 (year_month = 접수연도 05)', async () => {
    const popCalls: PopulationInput[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ pop: POP, popCalls, j001: [] }),
    )) as Record<string, any>;

    expect(popCalls).toEqual([{ group: '미래에셋', year_month: '202605' }]);
    expect(r['diagnostics'].population_source).toBe('portal');
    expect(r['diagnostics'].population.from_document).toBe(true);
    expect(r['diagnostics'].population.joined_companies).toBe(2);
    expect(r['diagnostics'].population.unjoined_companies).toBe(1);
    // 포털 이름으로 조인되므로 DART 인덱스(corps 스텁 없음) 없이도 차입회사가 이어진다
    expect(r['undisclosed_candidates'][0].corp_code).toBe('00222222');
  });

  it('EGROUP 키가 없거나 포털이 실패하면 예외 없이 기존 동작으로 폴백한다', async () => {
    // pop 미지정 = resolvePop 이 throw (키 없음 흉내). README 약속: DART 키 하나면 동작한다.
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ corps: YKD_CORPS, j001: [] }),
    )) as Record<string, any>;

    expect(r['diagnostics'].population_source).toBe('none');
    expect(r['diagnostics'].population.reason).toContain('portal_unavailable');
    // 종전 동작 그대로 — DART 상호 완전일치로 조인해 후보 2건
    expect(r['summary'].undisclosed_candidates).toBe(2);
    expect(r['undisclosed_candidates'][0].corp_code).toBe('00222222');
    expect(
      (r['scope_caveats'] as string[]).some((c) => c.includes('포털 소속회사 목록 없이')),
    ).toBe(true);
  });

  it('문서에 기업집단명 행이 없으면 포털을 조회하지 않고 사유를 남긴다', async () => {
    const md = [
      '## (2) 회사 재무현황',
      '| (단위 : 백만원, %) |',
      '| --- |',
      '| 계열회사명 |  | 자본금 | 자본총계 |',
      '| --- | --- | --- | --- |',
      '| 비금융회사 | 무명사(주) | 5,000 | 20,000 |',
    ].join('\n');
    const popCalls: PopulationInput[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: md, popCalls, j001: [] }),
    )) as Record<string, any>;

    expect(popCalls).toHaveLength(0);
    expect(r['diagnostics'].population_source).toBe('none');
    expect(r['diagnostics'].population.reason).toContain('group_name_not_found');
  });

  it('포털을 불러오면 rcept_no 경로에서도 계열편입일 이전 차입을 분리한다', async () => {
    const popLate: Population = {
      ...POP,
      joinedGroupAt: new Map([['00222222', '20250401']]),
    };
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ pop: popLate, j001: [] }),
    )) as Record<string, any>;

    expect(r['summary'].no_duty_before_joining).toBe(1);
    expect(r['no_duty_before_joining'][0].date).toBe('20250219');
  });

  it('포털 목록에 있는 계열사인데 DART 조인이 안 되면 그 사실을 조인 실패 사유에 밝힌다', async () => {
    // 포털은 소속을 보증하지만(unjoined) DART 인덱스에 상호가 없다 — 실물의
    // 미래에셋생명보험(DART 상호는 '미래에셋생명') 유형. "없음"이 아니라 캐시 문제임을 말해야 한다.
    const popNoYkd: Population = {
      corpCodes: new Map([['00111111', '미래에셋캐피탈(주)']]),
      group: { representative_company: '미래에셋캐피탈㈜' },
      unjoined: ['와이케이디벨롭먼트(주)'],
    };
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ pop: popNoYkd, j001: [] }),
    )) as Record<string, any>;

    expect(r['join_failures'][0].reason).toContain('포털 소속회사 목록에 있는');
    expect(r['join_failures'][0].reason).toContain('fetchJurirNo');
  });
});

describe('대여회사(상대방) 관점 자금대여 대조 (E-2)', () => {
  it('보고서명 필터 — 자금대여만 잡고 자금차입은 거른다', () => {
    expect(
      isLendingReport('대규모내부거래관련이사회의결및공시(특수관계인에대한자금대여)'),
    ).toBe(true);
    expect(isLendingReport('[기재정정]대규모내부거래관련 이사회 의결 및 공시 (자금 대여)')).toBe(
      true,
    );
    expect(isLendingReport('대규모내부거래관련이사회의결및공시(자금차입)')).toBe(false);
  });

  it('자연인 추정은 한글 2~4자 이름 형태에만 적용한다', () => {
    expect(looksLikeNaturalPerson('박현주')).toBe(true);
    expect(looksLikeNaturalPerson('김 철 수')).toBe(true);
    expect(looksLikeNaturalPerson('미래에셋컨설팅(주)')).toBe(false);
    expect(looksLikeNaturalPerson('대한물산')).toBe(false); // 조직 어미
    expect(looksLikeNaturalPerson('오딘제8차(유)')).toBe(false);
  });

  /** 대여회사 자본을 재무현황에 넣은 문서 — 대여회사 기준금액을 계산할 수 있게 한다 */
  function mdWithLender(opts: {
    /** '자본금 | 자본총계' (백만원) */
    lenderCapital: string;
    borrowings: Array<[counterparty: string, amountMillion: string, date: string]>;
  }): string {
    return [
      '| 기업집단명 : | 테스트집단 |',
      '| --- | --- |',
      '## (2) 회사 재무현황',
      '| (단위 : 백만원, %) |',
      '| --- |',
      '| 계열회사명 |  | 자본금 | 자본총계 |',
      '| --- | --- | --- | --- |',
      '| 비금융회사 | 차입회사(주) | 5,000 | 20,000 |',
      `| 비금융회사 | 대여계열사(주) | ${opts.lenderCapital} |`,
      '## (1) 계열회사간 자금거래 현황',
      '가. 일반 차입',
      '| (단위 : 백만원) |',
      '| --- |',
      '| 차입회사 (소속회사) |  | 거래상대방 | 차입금액 | 차입일 |',
      '| --- | --- | --- | --- | --- |',
      ...opts.borrowings.map(
        ([cp, amt, d]) => `| 비금융회사 | 차입회사(주) | ${cp} | ${amt} | ${d} |`,
      ),
    ].join('\n');
  }

  const LENDER_CORPS = {
    차입회사: [{ corpCode: '00222222', corpName: '차입회사' }],
    대여계열사: [{ corpCode: '00333333', corpName: '대여계열사' }],
  };

  it('대여회사에 근접 자금대여 공시가 있으면 j001_filing_near_date', async () => {
    const md = mdWithLender({
      lenderCapital: '1,000 | 4,000', // 자본총계 40억 → 기준금액 5억(하한)
      borrowings: [['대여계열사(주)', '16,000', '2025-02-19']],
    });
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        markdown: md,
        corps: LENDER_CORPS,
        j001: (corpCode) =>
          corpCode === '00333333'
            ? [
                disc({
                  corp_code: '00333333',
                  report_nm: '대규모내부거래관련이사회의결및공시(특수관계인에대한자금대여)',
                  rcept_no: '20250214000777',
                  rcept_dt: '20250214',
                }),
              ]
            : [],
      }),
    )) as Record<string, any>;

    const side = r['undisclosed_candidates'][0].lender_side;
    expect(side.company).toBe('대여계열사(주)');
    expect(side.corp_code).toBe('00333333');
    expect(side.status).toBe('j001_filing_near_date');
    expect(side.nearest_filing_gap_days).toBe(-5);
    expect(side.threshold.value).toBe(5 * 억);
    expect(r['summary'].lender_side.j001_filing_near_date).toBe(1);
    // 차입회사 쪽은 공시가 없어 여전히 후보다 — 두 판정은 독립이다
    expect(r['summary'].undisclosed_candidates).toBe(1);
  });

  it('대여회사에 자금대여 공시가 없으면 대여회사 쪽도 미공시 후보다', async () => {
    const md = mdWithLender({
      lenderCapital: '1,000 | 4,000',
      borrowings: [['대여계열사(주)', '16,000', '2025-02-19']],
    });
    const calls: CallLog[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: md, corps: LENDER_CORPS, j001: [], calls }),
    )) as Record<string, any>;

    const side = r['undisclosed_candidates'][0].lender_side;
    expect(side.status).toBe('undisclosed_candidate');
    expect(side.reason).toContain('j001_lending_absent');
    expect(r['summary'].lender_side.undisclosed_candidate).toBe(1);
    expect((r['notes'] as string[]).some((n) => n.includes('대여회사 쪽'))).toBe(true);
    // 차입회사·대여회사 각 1콜
    expect(calls.filter((c) => c.ty === 'J001')).toHaveLength(2);
  });

  it('대여회사 기준금액에 미달하면 below_threshold (차입회사 판정과 독립)', async () => {
    // 대여회사 자본총계 2,000억 → 기준금액 100억 상한. 차입회사 기준금액은 10억.
    // 60억 차입은 차입회사 기준으론 초과, 대여회사 기준으론 미달이다.
    const md = mdWithLender({
      lenderCapital: '10,000 | 200,000',
      borrowings: [['대여계열사(주)', '6,000', '2025-02-19']],
    });
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: md, corps: LENDER_CORPS, j001: [] }),
    )) as Record<string, any>;

    const side = r['undisclosed_candidates'][0].lender_side;
    expect(side.status).toBe('below_threshold');
    expect(side.threshold.value).toBe(100 * 억);
    expect(r['summary'].lender_side.below_threshold).toBe(1);
  });

  it('대여회사를 corp_code 로 잇지 못하면 counterparty_not_joined — "공시 없음"이 아니다', async () => {
    const md = mdWithLender({
      lenderCapital: '1,000 | 4,000',
      borrowings: [['대여계열사(주)', '16,000', '2025-02-19']],
    });
    const calls: CallLog[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      // 차입회사만 조인된다
      makeDeps({ markdown: md, corps: { 차입회사: LENDER_CORPS.차입회사 }, j001: [], calls }),
    )) as Record<string, any>;

    const side = r['undisclosed_candidates'][0].lender_side;
    expect(side.status).toBe('counterparty_not_joined');
    expect(side.corp_code).toBeUndefined();
    expect(r['summary'].lender_side.counterparty_not_joined).toBe(1);
    // 조인 못 한 회사는 조회하지 않는다
    expect(calls.filter((c) => c.ty === 'J001')).toHaveLength(1);
  });

  it('거래상대방이 자연인(동일인·친족)으로 보이면 counterparty_not_company', async () => {
    const md = mdWithLender({
      lenderCapital: '1,000 | 4,000',
      borrowings: [['박현주', '16,000', '2025-02-19']],
    });
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: md, corps: { 차입회사: LENDER_CORPS.차입회사 }, j001: [] }),
    )) as Record<string, any>;

    const side = r['undisclosed_candidates'][0].lender_side;
    expect(side.status).toBe('counterparty_not_company');
    expect(side.reason).toContain('추정');
    expect(r['summary'].lender_side.counterparty_not_company).toBe(1);
  });

  /**
   * ★ 자연인 추정은 **조인 실패 + 소속 확인 실패** 뒤에만 써야 한다.
   * 한글 2~4자 상호는 실재하고(예: '한샘'), 조인은 DART 인덱스 캐시 사정만으로도 실패한다 —
   * 재무현황 표가 회사임을 보증하는 이름을 자연인으로 분류하면 그 계열사의 자금대여 미공시가
   * counterparty_not_company 로 조용히 사라진다 (거짓 안심).
   */
  it('재무현황 표에 있는 이름이면 조인에 실패해도 자연인으로 분류하지 않는다', async () => {
    const md = [
      '| 기업집단명 : | 테스트집단 |',
      '| --- | --- |',
      '## (2) 회사 재무현황',
      '| (단위 : 백만원, %) |',
      '| --- |',
      '| 계열회사명 |  | 자본금 | 자본총계 |',
      '| --- | --- | --- | --- |',
      '| 비금융회사 | 차입회사(주) | 5,000 | 20,000 |',
      '| 비금융회사 | 한샘 | 1,000 | 4,000 |',
      '## (1) 계열회사간 자금거래 현황',
      '가. 일반 차입',
      '| (단위 : 백만원) |',
      '| --- |',
      '| 차입회사 (소속회사) |  | 거래상대방 | 차입금액 | 차입일 |',
      '| --- | --- | --- | --- | --- |',
      '| 비금융회사 | 차입회사(주) | 한샘 | 16,000 | 2025-02-19 |',
    ].join('\n');
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      // 차입회사만 DART 인덱스에 있다 — '한샘' 은 조인 실패한다
      makeDeps({ markdown: md, corps: { 차입회사: LENDER_CORPS.차입회사 }, j001: [] }),
    )) as Record<string, any>;

    const side = r['undisclosed_candidates'][0].lender_side;
    expect(side.status).toBe('counterparty_not_joined');
    expect(side.reason).toContain('재무현황 표에 있는 **계열회사**');
    expect(r['summary'].lender_side.counterparty_not_company).toBe(0);
    expect(r['summary'].lender_side.counterparty_not_joined).toBe(1);
  });

  it('개별 미달이어도 같은 상대방 연간 합산이 대여회사 기준 이상이면 단정하지 않는다', async () => {
    // 대여회사 기준금액 5억. 3억씩 2건(합산 6억) — 같은 약정의 분할 실행이면 공시대상일 수 있다.
    const md = mdWithLender({
      lenderCapital: '1,000 | 4,000',
      borrowings: [
        ['대여계열사(주)', '300', '2025-02-19'],
        ['대여계열사(주)', '300', '2025-06-30'],
      ],
    });
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: md, corps: LENDER_CORPS, j001: [] }),
    )) as Record<string, any>;

    const sides = (r['below_threshold'] as Array<Record<string, any>>).map((b) => b.lender_side);
    expect(sides).toHaveLength(2);
    expect(sides.every((s) => s.status === 'not_judged')).toBe(true);
    expect(sides[0].reason).toContain('aggregation_unknown');
    expect(sides[0].same_counterparty_annual_total).toBe(6 * 억);
    expect(r['summary'].lender_side.not_judged).toBe(2);
  });

  it('scope_caveats·coverage 가 대여회사 대조를 실제 동작으로 설명한다', async () => {
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ corps: YKD_CORPS, j001: [] }),
    )) as Record<string, any>;

    expect(
      (r['scope_caveats'] as string[]).some((c) => c.includes('자금 차입은 **양쪽 관점**')),
    ).toBe(true);
    expect(r['coverage'].transaction_types_checked).toContain(
      '자금 대여 — 대여회사(거래상대방) 관점 (같은 차입 건을 대여회사 자본 기준으로 재판정)',
    );
    expect(r['coverage'].undetectable.other_transaction_types).not.toContain(
      '자금 대여(상대방 관점)',
    );
  });
});

