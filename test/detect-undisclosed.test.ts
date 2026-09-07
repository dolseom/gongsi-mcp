/**
 * detect_undisclosed_transactions 판정 로직 테스트
 *
 * 픽스처(test/fixtures/j004-transactions.md)의 실측 수치:
 *  - 와이케이디벨롭먼트(주): 자본금 50억 / 자본총계 200억 → 기준금액 10억
 *  - 차입 160억(2025-02-19)·120억(2025-06-30) — 둘 다 100억 상한 이상 = 자본 무관 확실
 *  - 상품·용역: 같은 상대방(미래에셋증권)에게 58.9억 + 12.99억 = **상대방별 합산 71.89억**
 *    (≥ 4×10억 → 신호. 행 단위로 보면 12.99억이 미달로 빠진다 — 교차검토 M-4의 재현 구조)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  detectUndisclosedTransactions,
  detectUndisclosedTransactionsInput,
  buildThresholdMap,
  judgeOverThreshold,
  isBorrowingReport,
  isGoodsServicesReport,
  isSecuritiesReport,
  isLendingReport,
  looksLikeNaturalPerson,
  itemLikelyNotGoodsService,
  type DetectDeps,
  parseAmbiguousFilingDoc,
  parseFilingCounterparties,
  classifyAmbiguousSubject,
} from '../src/tools/detect-undisclosed-transactions.js';
import { extractCapitals } from '../src/parsers/j004-transactions.js';
import { normalizeCompanyName } from '../src/parsers/md-table.js';
import type { Disclosure } from '../src/clients/dart.js';
import type { BatchResult } from '../src/search/batch.js';
import type { DocMeta } from '../src/tools/read-disclosure.js';
import {
  resolvePopulation,
  type Population,
  type PopulationInput,
} from '../src/tools/audit-group-disclosures.js';
import type { JurirNoFetch } from '../src/resolver/corp-index.js';
import { ToolError } from '../src/lib/errors.js';
import { __resetConfig } from '../src/lib/config.js';
import { Store, __setStore } from '../src/lib/store.js';
import { 억 } from '../src/rules/thresholds.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_MD = readFileSync(join(HERE, 'fixtures', 'j004-transactions.md'), 'utf-8');

/**
 * 자동 워밍이 30일 억제 기록을 저장소에 쓰므로 **메모리 저장소로 격리**한다 —
 * 그러지 않으면 테스트가 사용자의 실제 캐시 DB(`~/.gongsi-mcp/cache.db`)에 'warm:' 키를 남긴다.
 */
let store: Store;
beforeEach(() => {
  store = new Store(':memory:');
  __setStore(store);
});
afterEach(() => {
  store.close();
  __setStore(null);
});

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
  /**
   * 상호 **부분일치** 검색 결과 (자동 워밍의 후보 탐색용) — 조각 → 후보.
   * 주지 않으면 0건이라 워밍은 후보를 못 찾고 아무 조회도 하지 않는다.
   */
  searchCorps?: Record<string, Array<{ corpCode: string; corpName: string }>>;
  /** searchCorps 가 어떤 조각으로 불렸는지 */
  searchCalls?: string[];
  /** corp_code → 기업개황 법인등록번호 응답 (동명 2건 확정 검증용) */
  jurir?: Record<string, JurirNoFetch>;
  /** fetchJurirNo 가 어떤 corp_code 로 몇 번 불렸는지 (호출 예산·캐시 검증용) */
  jurirCalls?: string[];
  /**
   * 법인등록번호가 **이미 캐시에 있는** corp_code — 주면 선택적 dep `isJurirCached` 를 주입하고
   * `fetchJurirNo` 도 그 건에 `cached: true` 를 달아 돌려준다 (콜이 나가지 않았다는 표시).
   * 주지 않으면 그 dep 을 아예 주입하지 않아 **종전 동작**(전부 비캐시)이 된다.
   */
  cachedJurir?: Set<string>;
  /** 접수번호별 원문 (J001 상대방 대조용). Error 를 주면 loadDoc 이 던진다 */
  docs?: Record<string, string | Error>;
  /** loadDoc 이 어떤 접수번호로 불렸는지 (원문 열기 예산 검증용) */
  docCalls?: string[];
  /**
   * 캐시에 이미 있다고 볼 접수번호 — 주면 `isDocCached` 가 이 집합으로만 답한다.
   * 주지 않으면 `docs` 에 있는 접수번호를 캐시로 본다 (스텁 원문은 콜 없이 즉시 돌아오므로).
   */
  cachedDocs?: Set<string>;
  /** 주입 시계 (시간 예산 테스트용) — 주지 않으면 도구가 Date.now 를 쓴다 */
  now?: () => number;
  /**
   * 이어보기(continuation) kv 저장소. **호출 사이에 이어 쓰려면 같은 Map 을 넘겨야 한다** —
   * 주지 않으면 makeDeps 마다 빈 저장소라 토큰이 남지 않는다.
   */
  kv?: Map<string, string>;
  /** kvGet 이 어떤 키로 불렸는지 (토큰 없는 호출이 캐시를 읽지 않는지 검증용) */
  kvGets?: string[];
}): DetectDeps {
  const kv = opts.kv ?? new Map<string, string>();
  return {
    ...(opts.now ? { now: opts.now } : {}),
    kvGet: (key) => {
      opts.kvGets?.push(key);
      return kv.get(key) ?? null;
    },
    kvSet: (key, value) => void kv.set(key, value),
    kvDeletePrefix: (prefix) => {
      for (const k of [...kv.keys()]) if (k.startsWith(prefix)) kv.delete(k);
    },
    isDocCached: (rceptNo) =>
      opts.cachedDocs ? opts.cachedDocs.has(rceptNo) : opts.docs?.[rceptNo] !== undefined,
    loadDoc: async (rceptNo) => {
      opts.docCalls?.push(rceptNo);
      const d = opts.docs?.[rceptNo];
      if (d instanceof Error) throw d;
      if (typeof d === 'string') return { markdown: d, meta: { ...META, acode: '80708' } };
      return { markdown: opts.markdown ?? FIXTURE_MD, meta: META };
    },
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
    searchCorps: (fragment) => {
      opts.searchCalls?.push(fragment);
      return opts.searchCorps?.[fragment] ?? [];
    },
    ...(opts.cachedJurir
      ? { isJurirCached: (corpCode: string) => opts.cachedJurir!.has(corpCode) }
      : {}),
    fetchJurirNo: async (corpCode) => {
      opts.jurirCalls?.push(corpCode);
      const r: JurirNoFetch = opts.jurir?.[corpCode] ?? { status: 'absent' };
      // 실구현(corp-index.ts)과 같다 — 저장소에서 나온 건은 콜이 없었다는 표시를 달고 온다
      return opts.cachedJurir?.has(corpCode) && r.status === 'ok' ? { ...r, cached: true } : r;
    },
  };
}

const YKD_CORPS = {
  와이케이디벨롭먼트: [{ corpCode: '00222222', corpName: '와이케이디벨롭먼트' }],
};

/**
 * 80708 `특수관계인과의 내부거래` 세로형 최소 원문 — 상대방만 바꿔 가며 쓴다.
 *
 * ★ **보고서명 경로에도 원문 대조가 붙었으므로**(Codex P0) "공시 존재"를 기대하는 테스트는
 *   매칭 공시의 원문을 반드시 함께 준다. 주지 않으면 makeDeps 의 기본 loadDoc 이 J004 픽스처를
 *   돌려주고 상대방 필드가 없어 no_counterparty_field → 보류가 된다. 그건 판정 규칙이 옳게
 *   동작한 것이지 테스트가 옳은 것이 아니다.
 */
function doc80708(counterparty: string, subject = '출자증권', amount = '1,600'): string {
  return [
    '특수관계인과의내부거래',
    '## 특수관계인과의 내부거래',
    '',
    `| 1. 거래상대방 |  |  |  | ${counterparty} | 회사와의 관계 | 계열회사 |`,
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| 2. 거래내용 | 가. 거래일자 |  |  | 2025.02.19 |  |  |',
    `| 2. 거래내용 | 다. 거래대상 |  |  | ${subject} |  |  |`,
    `| 2. 거래내용 | 라. 거래금액 |  |  | ${amount} |  |  |`,
    '| 4. 이사회 의결일 |  |  |  | 2025.02.19 |  |  |',
  ].join('\n');
}

/** 80718 `특수관계인으로부터 자금차입` 최소 원문 — 라벨이 '나. 차입처' 인 세로형 (실물 20260724000153) */
function doc80718(counterparty: string): string {
  return [
    '특수관계인으로부터자금차입',
    '## 특수관계인으로부터 자금차입',
    '',
    '| 1. 차입유형 |  | 장기차입 |  |  |',
    '| --- | --- | --- | --- | --- |',
    '| 2. 차입 내역 |  |  |  |  |',
    '| 가. 계약체결일 |  | 2025.02.19 |  |  |',
    `| 나. 차입처 |  | ${counterparty} | 회사와의 관계 | 계열회사 |`,
    '| 라. 차입금액 |  | 16,000 |  |  |',
    "| 4. 거래상대방과의 차입총계 (해당 사업연도 기준) |  | 239,000 |  |  |",
    '| 5. 이사회 의결일 |  | 2025.02.19 |  |  |',
  ].join('\n');
}

/**
 * 80754 계열(트랙 B) `계열 금융회사의 약관에 의한 금융거래` 최소 원문 — 2단 헤더 가로형.
 * 상대방은 **`상대방명` 열**에서 읽는다. 같은 표의 `발행자명` 열(비계열 발행자)은 상대방이 아니다.
 */
function doc80754(...counterparties: string[]): string {
  return [
    '계열금융회사의약관에의한금융거래-[유가증권-채권]',
    '## 계열 금융회사의 약관에 의한 금융거래 -[유가증권-채권]',
    '',
    '| 발행자 |  | 거래일자 | 거래상대방 |  | 거래금액 |  | 채권내역 |  | 거래목적 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '| 발행자명 | 관계 | 거래일자 | 상대방명 | 관계 | 매입 | 매도 | 채권종류(종목명) | 총권면금액 | 거래목적 |',
    ...counterparties.map(
      (c, i) =>
        `| 기획재정부 | 비계열회사 | 2025-04-0${i + 1} | ${c} | 계열회사 | - | 498 | ` +
        `재정증권 2025-009${i}-0063 | 25,000 | 장외거래 |`,
    ),
    '| 기획재정부 |  | 소 계 |  |  | - | 498 |  |  |  |',
    '| 총 계 |  |  |  |  | - | 498 |  |  |  |',
  ].join('\n');
}

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
        // 원문 차입처 = 이 거래 상대방 — 보고서명 경로도 상대방까지 확인해야 "공시 존재"다
        docs: { '20250210000123': doc80718('미래에셋컨설팅(주)') },
      }),
    )) as Record<string, any>;

    expect(r['summary'].undisclosed_candidates).toBe(0);
    expect(r['summary'].j001_filing_near_date).toBe(1);
    expect(r['summary'].j001_filing_in_window_only).toBe(1);
    expect(r['j001_filing_near_date'][0].counterparty_confirmed_by_document).toBe(true);

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
    // 상대방까지는 대조했고 금액·기간은 대조하지 않았다는 caveat 유지
    expect(
      (r['scope_caveats'] as string[]).some((c) =>
        c.includes('상대방까지만 대조한 것이지 금액·거래기간·거래대상이 이 거래와 같음을 대조한 것은'),
      ),
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
        docs: { '20260610000777': doc80718('미래에셋컨설팅(주)') },
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
        docs: { '20250210000123': doc80718('미래에셋컨설팅(주)') },
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
        // (6) 주요 내역의 상대방은 '미래에셋증권' — 원문 상대방까지 맞아야 filing_exists 다
        docs: { '20250401000009': doc80708('미래에셋증권(주)', '골프장 운영용역') },
      }),
    )) as Record<string, any>;

    expect(r['summary'].goods_services_candidates_if_qualified).toBe(0);
    expect(r['summary'].goods_services_filing_exists).toBe(1);
    expect(r['goods_services_signals'][0].counterparty_confirmed_by_document).toBe(true);
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

    // allowEmptyJoin — detect 는 조인 0건에도 포털 명단을 받아 워밍으로 채운다 (audit 는 안 쓴다)
    expect(popCalls).toEqual([
      { group: '미래에셋', year_month: '202605', allowEmptyJoin: true },
    ]);
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
        // 대여회사 관점의 대조 상대방은 **차입회사**다
        docs: { '20250214000777': doc80708('차입회사(주)', '대여금') },
      }),
    )) as Record<string, any>;

    const side = r['undisclosed_candidates'][0].lender_side;
    expect(side.company).toBe('대여계열사(주)');
    expect(side.counterparty_confirmed_by_document).toBe(true);
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
    expect(m['quarterly_logic']).toBe('annual_below_threshold');
    expect(m['status']).toBe('below_threshold');
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
    expect(String(m['reason'])).toContain('국외 계열회사는 제외한다');
    expect(String(m['reason'])).toContain('간접적으로');
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
 * ★ DART 상호 동명 2건 이상을 **법인등록번호로** 확정한다.
 *
 * 이 프로젝트의 원래 조인 설계가 법인등록번호 직접 조인이다 — 포털은 한글 음차,
 * DART 는 영문 약어라 이름 매칭이 성립하지 않는다. 실측(미래에셋 20260819000341):
 * '미래에셋 증권(주)' 는 DART 상호가 동명 2건이라 jurir 캐시를 채워도 자동 선택되지 않았고,
 * 그 결과 유가증권 신호가 통째로 join_failed 로 빠졌다.
 */
describe('동명 2건 법인등록번호 확정 (백로그 2)', () => {
  const 백만 = 1_000_000;
  /** 차입회사 1곳 + 동명 2건인 대여회사 1곳 */
  const MD = [
    '| 기업집단명 : | 테스트집단 |',
    '| --- | --- |',
    '## (2) 회사 재무현황',
    '| (단위 : 백만원, %) |',
    '| --- |',
    '| 계열회사명 |  | 자본금 | 자본총계 |',
    '| --- | --- | --- | --- |',
    '| 비금융회사 | 차입회사(주) | 5,000 | 20,000 |',
    '| 금융회사 | 동명증권(주) | 1,000 | 4,000 |',
    '## (1) 계열회사간 자금거래 현황',
    '가. 일반 차입',
    '| (단위 : 백만원) |',
    '| --- |',
    '| 차입회사 (소속회사) |  | 거래상대방 | 차입금액 | 차입일 |',
    '| --- | --- | --- | --- | --- |',
    '| 비금융회사 | 차입회사(주) | 동명증권(주) | 16,000 | 2025-02-19 |',
  ].join('\n');

  /** '동명증권' 은 DART 인덱스에 2건 — 이름으로는 고를 수 없다 */
  const CORPS = {
    차입회사: [{ corpCode: '00222222', corpName: '차입회사' }],
    동명증권: [
      { corpCode: '00311030', corpName: '동명증권' },
      { corpCode: '00999999', corpName: '동명증권' },
    ],
  };

  /** 포털 소속회사 목록 — 동명증권의 법인등록번호를 알고 있다 */
  function popWith(jurirNoByName: Map<string, string>): Population {
    return {
      corpCodes: new Map([['00222222', '차입회사(주)']]),
      group: { representative_company: '차입회사(주)' },
      unjoined: ['동명증권(주)'],
      jurirNoByName,
    };
  }
  const POP = popWith(new Map([['동명증권', '1101110011111']]));

  async function run(over: Record<string, unknown> = {}): Promise<Record<string, any>> {
    return (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: MD, corps: CORPS, pop: POP, j001: [], ...over }),
    )) as Record<string, any>;
  }

  it('후보 중 포털 jurirno 와 일치하는 것이 정확히 1건이면 확정한다', async () => {
    const jurirCalls: string[] = [];
    const r = await run({
      jurirCalls,
      jurir: {
        '00311030': { status: 'ok', jurirNo: '1101110011111' }, // 포털과 일치
        '00999999': { status: 'ok', jurirNo: '1101110022222' }, // 불일치
      },
    });

    const side = r['undisclosed_candidates'][0].lender_side;
    expect(side.corp_code).toBe('00311030');
    expect(side.status).not.toBe('counterparty_not_joined');
    expect(r['join_failures'] ?? []).toHaveLength(0);

    const d = r['diagnostics'].jurir_disambiguation;
    expect(d.lookups).toBe(2);
    expect(d.resolved).toEqual([
      { company: '동명증권(주)', corp_code: '00311030', jurir_no: '1101110011111', candidates: 2 },
    ]);
    expect(jurirCalls).toEqual(['00311030', '00999999']);
    expect(
      (r['notes'] as string[]).some((n) => n.includes('법인등록번호') && n.includes('확정')),
    ).toBe(true);
  });

  it('일치가 0건이면 확정하지 않는다 — 후보 목록과 일치 건수를 사유에 남긴다', async () => {
    const r = await run({
      jurir: {
        '00311030': { status: 'ok', jurirNo: '1101110033333' },
        '00999999': { status: 'ok', jurirNo: '1101110022222' },
      },
    });
    const side = r['undisclosed_candidates'][0].lender_side;
    expect(side.status).toBe('counterparty_not_joined');
    expect(String(side.reason)).toContain('동명 법인 2건');
    expect(String(side.reason)).toContain('동명증권(00311030)');
    expect(String(side.reason)).toContain('일치 0건');
    expect(r['diagnostics'].jurir_disambiguation.resolved).toEqual([]);
  });

  it('일치가 2건 이상이면 확정하지 않는다 (같은 법인등록번호에 corp_code 가 여럿)', async () => {
    const r = await run({
      jurir: {
        '00311030': { status: 'ok', jurirNo: '1101110011111' },
        '00999999': { status: 'ok', jurirNo: '1101110011111' },
      },
    });
    const side = r['undisclosed_candidates'][0].lender_side;
    expect(side.status).toBe('counterparty_not_joined');
    expect(String(side.reason)).toContain('일치 2건');
  });

  /** 조회 실패를 "불일치"로 뭉개면 재시도 안내가 거짓말이 된다 */
  it('기업개황 조회 실패는 불일치와 구분해 사유에 센다', async () => {
    const r = await run({
      jurir: {
        '00311030': { status: 'error', message: '조회 실패' },
        '00999999': { status: 'ok', jurirNo: '1101110022222' },
      },
    });
    const side = r['undisclosed_candidates'][0].lender_side;
    expect(String(side.reason)).toContain('조회 실패 1건');
  });

  it('포털 모집단이 없으면 종전대로 ambiguous — 기업개황을 부르지 않는다', async () => {
    const jurirCalls: string[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      // pop 미지정 = 포털 실패(EGROUP 키 없음)
      makeDeps({ markdown: MD, corps: CORPS, j001: [], jurirCalls }),
    )) as Record<string, any>;
    const side = r['undisclosed_candidates'][0].lender_side;
    expect(side.status).toBe('counterparty_not_joined');
    expect(String(side.reason)).toContain('포털 소속회사 목록이 없어');
    expect(jurirCalls).toHaveLength(0);
    expect(r['diagnostics'].jurir_disambiguation.lookups).toBe(0);
  });

  it('포털 목록에 그 이름의 법인등록번호가 없으면 대조하지 않는다', async () => {
    const jurirCalls: string[] = [];
    const r = await run({ jurirCalls, pop: popWith(new Map([['다른회사', '1101110011111']])) });
    const side = r['undisclosed_candidates'][0].lender_side;
    expect(side.status).toBe('counterparty_not_joined');
    expect(String(side.reason)).toContain('법인등록번호를 찾지 못했습니다');
    expect(jurirCalls).toHaveLength(0);
  });

  it('후보가 상한(5개)을 넘으면 대조하지 않고 그 사실을 밝힌다', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      corpCode: `0099999${i}`,
      corpName: '동명증권',
    }));
    const jurirCalls: string[] = [];
    const r = await run({ jurirCalls, corps: { ...CORPS, 동명증권: many } });
    const side = r['undisclosed_candidates'][0].lender_side;
    expect(String(side.reason)).toContain('상한 5개를 넘어');
    expect(jurirCalls).toHaveLength(0);
  });

  it('같은 이름이 여러 번 나와도 기업개황은 한 번만 부른다 (조인 캐시)', async () => {
    const md = MD.replace(
      '| 비금융회사 | 차입회사(주) | 동명증권(주) | 16,000 | 2025-02-19 |',
      '| 비금융회사 | 차입회사(주) | 동명증권(주) | 16,000 | 2025-02-19 |\n' +
        '| 비금융회사 | 차입회사(주) | 동명증권(주) | 12,000 | 2025-06-30 |',
    );
    const jurirCalls: string[] = [];
    const r = await run({
      markdown: md,
      jurirCalls,
      jurir: {
        '00311030': { status: 'ok', jurirNo: '1101110011111' },
        '00999999': { status: 'ok', jurirNo: '1101110022222' },
      },
    });
    expect(r['summary'].undisclosed_candidates).toBe(2);
    // 차입 2건 × 후보 2개 = 4회가 아니라 2회여야 한다
    expect(jurirCalls).toEqual(['00311030', '00999999']);
    expect(r['diagnostics'].jurir_disambiguation.lookups).toBe(2);
  });

  it('법인등록번호 확정은 소속 검증 실패를 이유로 거부되지 않는다', async () => {
    // 포털 corpCodes 에 없고 unjoined 이름과도 정규화가 다른 경우 — 종전 verifyMembership
    // 이라면 dart_join_unverified 로 막혔겠지만, jurirno 일치는 그보다 강한 근거다.
    const pop: Population = {
      corpCodes: new Map([['00222222', '차입회사(주)']]),
      group: { representative_company: '차입회사(주)' },
      unjoined: ['전혀다른표기(주)'],
      jurirNoByName: new Map([['동명증권', '1101110011111']]),
    };
    const r = await run({
      pop,
      jurir: {
        '00311030': { status: 'ok', jurirNo: '1101110011111' },
        '00999999': { status: 'ok', jurirNo: '1101110022222' },
      },
    });
    expect(r['undisclosed_candidates'][0].lender_side.corp_code).toBe('00311030');
    expect(r['diagnostics'].jurir_disambiguation.resolved).toHaveLength(1);
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
 * 보고서명만으로 유형을 알 수 없는 J001 이 창 안에 있으면 후보로 단정하지 않는다.
 *
 * ★ 실측 근거 (전체시장 2024-01~2026-09 J001 22,794건, test/j001-report-names.test.ts):
 *   '특수관계인과의내부거래' 740건 · '약관에의한금융거래시계열금융회사의거래상대방의공시' 447건.
 *   전자는 실물 20260903000201 에서 **벤처투자조합 출자**를, 후자는 실물 20260902000068 에서
 *   **차입금 415.2억**을 이 이름으로 공시했다 — 우리 유형 필터에 하나도 걸리지 않는다.
 */
describe('유형 미상 J001 이 있으면 판정을 보류한다', () => {
  it('자금차입 후보가 유형 미상 공시 때문에 not_judged 로 내려간다', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [
          disc({
            corp_code: '00222222',
            // 실물 서식명 — 차입을 이 이름으로 공시한 사례가 있다
            report_nm: '약관에의한금융거래시계열금융회사의거래상대방의공시',
            rcept_no: '20250220000111',
            rcept_dt: '20250220',
          }),
        ],
      }),
    )) as Record<string, any>;

    expect(res['summary'].undisclosed_candidates).toBe(0);
    expect(res['summary'].not_judged).toBe(2);
    const nj = (res['not_judged'] as Array<Record<string, any>>)[0]!;
    expect(String(nj['reason'])).toContain('type_ambiguous_filing_present');
    expect(String(nj['reason'])).toContain('공시 있음"으로 확인한 것이 아닙니다');
    expect(nj['type_ambiguous_filings']).toHaveLength(1);
    expect(nj['type_ambiguous_filings'][0].rcept_no).toBe('20250220000111');
  });

  it('유형이 이름에 드러나는 공시는 종전대로 filing 으로 처리한다', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인으로부터자금차입',
            rcept_no: '20250214000777',
            rcept_dt: '20250214',
          }),
        ],
        // 유형이 이름으로 확정돼도 **상대방까지** 원문으로 확인해야 "공시 존재"다 (Codex P0)
        docs: { '20250214000777': doc80718('미래에셋컨설팅(주)') },
      }),
    )) as Record<string, any>;
    expect(res['summary'].j001_filing_near_date).toBe(1);
    expect(res['summary'].not_judged).toBe(0);
  });

  it('유형이 이름에 드러나도 원문 상대방이 다르면 후보가 아니라 보류다 (Codex P0)', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인으로부터자금차입',
            rcept_no: '20250214000777',
            rcept_dt: '20250214',
          }),
        ],
        // 같은 회사·같은 유형·같은 창이지만 **다른 상대방**에게서 빌린 건의 공시다
        docs: { '20250214000777': doc80718('전혀다른계열사(주)') },
      }),
    )) as Record<string, any>;
    expect(res['summary'].j001_filing_near_date).toBe(0);
    // ★ 후보로 내리지 않는다 — 표기 차이일 수 있다 (제9호 ↔ 제구호)
    expect(res['summary'].undisclosed_candidates).toBe(0);
    expect(res['summary'].not_judged).toBe(2);
    const nj = (res['not_judged'] as Array<Record<string, any>>)[0]!;
    expect(String(nj['reason'])).toContain('type_filing_present_counterparty_unconfirmed');
    expect(String(nj['reason'])).toContain('전혀다른계열사(주)');
    expect(nj['counterparty_confirmed_by_document']).toBeUndefined();
    expect(nj['matching_filings_unconfirmed']).toHaveLength(1);
    expect(nj['matching_filings_unconfirmed'][0].covers_this_counterparty).toBe(false);
    expect(res['diagnostics'].filing_docs.typed_unconfirmed).toBeGreaterThanOrEqual(1);
    // 종전에는 이 건이 "공시 존재"로 나갔다 — 조용히 보류로 바뀌면 안 되므로 notes 로 드러낸다
    expect(
      (res['notes'] as string[]).some((n) => n.includes('원문 거래상대방이 이 거래 상대방과 확인되지')),
    ).toBe(true);
  });

  it('매칭 2건 중 1건만 상대방이 맞으면 그 1건만 근거로 삼는다', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인으로부터자금차입',
            rcept_no: '20250214000777',
            rcept_dt: '20250214',
          }),
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인으로부터자금차입',
            rcept_no: '20250217000888',
            rcept_dt: '20250217',
          }),
        ],
        docs: {
          '20250214000777': doc80718('미래에셋컨설팅(주)'),
          '20250217000888': doc80718('다른대여사(주)'),
        },
      }),
    )) as Record<string, any>;
    expect(res['summary'].j001_filing_near_date).toBe(1);
    const near = (res['j001_filing_near_date'] as Array<Record<string, any>>)[0]!;
    expect(near['counterparty_confirmed_by_document']).toBe(true);
    expect(near['matching_filings']).toHaveLength(1);
    expect(near['matching_filings'][0].rcept_no).toBe('20250214000777');
    expect(near['matching_filings_unconfirmed']).toHaveLength(1);
    expect(near['matching_filings_unconfirmed'][0].rcept_no).toBe('20250217000888');
    // ★ 근접 대조도 확인된 공시만으로 한다 — 02-17 이 더 가깝지만 그 공시는 다른 상대방 건이다
    expect(near['nearest_filing_gap_days']).toBe(-5);
  });

  it('매칭 3건 중 확인되는 즉시 멈춘다 — 나머지는 불일치가 아니라 "읽지 않음"이다', async () => {
    const docCalls: string[] = [];
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        // 차입일 2025-02-19 기준 근접순은 02-18(−1) → 02-14(−5) → 02-10(−9) 이다
        j001: [
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인으로부터자금차입',
            rcept_no: '20250210000111',
            rcept_dt: '20250210',
          }),
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인으로부터자금차입',
            rcept_no: '20250214000222',
            rcept_dt: '20250214',
          }),
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인으로부터자금차입',
            rcept_no: '20250218000333',
            rcept_dt: '20250218',
          }),
        ],
        // 가장 가까운 02-18 이 바로 일치 → 나머지 2건은 열 이유가 없다
        docs: {
          '20250210000111': doc80718('미래에셋컨설팅(주)'),
          '20250214000222': doc80718('미래에셋컨설팅(주)'),
          '20250218000333': doc80718('미래에셋컨설팅(주)'),
        },
        docCalls,
      }),
    )) as Record<string, any>;

    // ★ 실물에서 유가증권 유형은 한 회사에 76·95건씩 매칭된다 — 전부 여는 설계는 성립하지 않는다
    const opened = docCalls.filter((n) => n !== '20260601001646');
    expect(opened).toEqual(['20250218000333']);
    const near = (res['j001_filing_near_date'] as Array<Record<string, any>>)[0]!;
    expect(near['counterparty_confirmed_by_document']).toBe(true);
    expect(near['matching_filings']).toHaveLength(1);
    expect(near['matching_filings'][0].rcept_no).toBe('20250218000333');
    expect(near['nearest_filing_gap_days']).toBe(-1);
    // 창 안의 같은 유형 공시가 3건이라는 사실은 그대로 밝힌다
    expect(near['matching_filings_total']).toBe(3);
    expect(near['matching_filings_not_examined_total']).toBe(2);
    // 열지 않은 건은 "상대방이 다른 공시"가 아니므로 unconfirmed 에 넣지 않는다
    expect(near['matching_filings_unconfirmed']).toBeUndefined();
  });

  it('캐시에 있는 원문은 새로 내려받기 예산을 쓰지 않는다', async () => {
    const filings: Disclosure[] = [];
    const docs: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      const no = `202502${String(i + 10).padStart(2, '0')}000900`;
      filings.push(
        disc({
          corp_code: '00222222',
          report_nm: '특수관계인으로부터자금차입',
          rcept_no: no,
          rcept_dt: no.slice(0, 8),
        }),
      );
      docs[no] = doc80718('전혀다른계열사(주)'); // 전부 불일치 — 5건을 끝까지 연다
    }
    // 3건만 캐시에 있다 — 나머지 2건만 콜이 나간다
    const cachedDocs = new Set(['20250210000900', '20250211000900', '20250212000900']);
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ corps: YKD_CORPS, j001: filings, docs, cachedDocs }),
    )) as Record<string, any>;
    expect(res['diagnostics'].filing_docs).toMatchObject({
      filings_needed: 5,
      fetches: 2,
      cached_reads: 3,
      over_budget: 0,
    });
  });

  it('보고서명 매칭이 불일치여도 유형 미상 공시가 이 거래를 덮으면 "공시 존재"다 (폴스루)', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [
          // 같은 유형·같은 창이지만 **다른 상대방** 건 — 이것만 보면 보류로 끝났다
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인으로부터자금차입',
            rcept_no: '20250213000444',
            rcept_dt: '20250213',
          }),
          // 이 거래를 실제로 덮는 공시가 유형 미상 서식으로 나갔다
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인과의내부거래',
            rcept_no: '20250214000555',
            rcept_dt: '20250214',
          }),
        ],
        docs: {
          '20250213000444': doc80718('전혀다른계열사(주)'),
          '20250214000555': doc80708('미래에셋컨설팅(주)', '차입금'),
        },
      }),
    )) as Record<string, any>;

    expect(res['summary'].j001_filing_near_date).toBe(1);
    expect(res['summary'].undisclosed_candidates).toBe(0);
    const near = (res['j001_filing_near_date'] as Array<Record<string, any>>)[0]!;
    expect(near['type_ambiguous_resolved_by_document']).toBe(true);
    expect(near['matching_filings'][0].rcept_no).toBe('20250214000555');
    expect(near['nearest_filing_gap_days']).toBe(-5);
    expect(res['diagnostics'].filing_docs.ambiguous_resolved_to_exists).toBeGreaterThanOrEqual(1);
  });

  it('매칭 공시의 원문을 못 열면 "공시 존재"가 아니라 보류다 — 확인하지 못한 것이다', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인으로부터자금차입',
            rcept_no: '20250214000777',
            rcept_dt: '20250214',
          }),
        ],
        docs: { '20250214000777': new Error('DART 원문 다운로드 실패 (테스트 스텁)') },
      }),
    )) as Record<string, any>;
    expect(res['summary'].j001_filing_near_date).toBe(0);
    expect(res['summary'].undisclosed_candidates).toBe(0);
    expect(res['summary'].not_judged).toBe(2);
    const nj = (res['not_judged'] as Array<Record<string, any>>)[0]!;
    expect(String(nj['reason'])).toContain('type_filing_present_counterparty_unconfirmed');
    expect(String(nj['reason'])).toContain('doc_read: error');
    expect(nj['matching_filings'][0].doc_read).toBe('error');
    expect(res['diagnostics'].filing_docs.typed_unread).toBeGreaterThanOrEqual(1);
  });

  it('유형 미상 공시가 없으면 종전대로 후보가 나온다 (보류가 남발되지 않는다)', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인에대한담보제공', // 다른 유형 — 보류 대상이 아니다
            rcept_no: '20250220000112',
            rcept_dt: '20250220',
          }),
        ],
      }),
    )) as Record<string, any>;
    expect(res['summary'].undisclosed_candidates).toBe(2);
    expect(res['summary'].not_judged).toBe(0);
  });
});

/**
 * 유형 미상 J001 의 **원문 거래상대방**으로 보류를 판정으로 바꾼다.
 *
 * ★ 실물 근거 (미래에셋 20260819000341, 2026-09-05): 보류 5건의 원문 11건은 전부 ACODE 80708
 *   (`특수관계인과의 내부거래`)이고 '1. 거래상대방'이 구조화돼 있었다. 상대방이 이 거래와 같은
 *   3건은 "공시 존재"로, 다른 2건(브랜드 사용료 ↔ 보험판매 / 제9호 ↔ 제구호)은 보류로 남았다.
 *   불일치를 "공시 없음"으로 내리지 않는 이유가 그 마지막 사례다 — 표기만 다른 같은 법인일 수 있다.
 */
describe('유형 미상 J001 — 원문 거래상대방 대조', () => {
  const DOC_80708 = readFileSync(join(HERE, 'fixtures', 'j001-ambiguous-80708.md'), 'utf8');
  const DOC_80708_CORR = readFileSync(
    join(HERE, 'fixtures', 'j001-ambiguous-80708-correction.md'),
    'utf8',
  );
  const DOC_80757 = readFileSync(join(HERE, 'fixtures', 'j001-ambiguous-80757.md'), 'utf8');

  describe('parseAmbiguousFilingDoc — 실물 서식 2종', () => {
    it('80708 세로형: 거래상대방·거래대상·거래금액(텍스트 그대로)', () => {
      const f = parseAmbiguousFilingDoc(DOC_80708);
      expect(f.counterparties).toEqual(['미래에셋네이버아시아그로쓰사모투자합자회사']);
      expect(f.subjects).toEqual(['미래에셋네이버아시아그로쓰사모투자합자회사의 지분']);
      // 억원 표기 — 숫자화하지 않는다 (같은 서식의 다른 실물은 백만원 단위 숫자만 적는다)
      expect(f.amount_text).toBe('217 억원');
    });

    it('80708 정정본: 정정사유·정정전·정정후 열이 있어도 상대방을 읽는다', () => {
      const f = parseAmbiguousFilingDoc(DOC_80708_CORR);
      expect(f.counterparties).toEqual(['미래에셋자산운용(주)']);
      expect(f.subjects).toContain('"미래에셋" 브랜드 사용');
      expect(f.amount_text).toBe('약 65.8억 원');
    });

    it('80757 가로형(약관 상대방 공시): 거래상대방 열·거래목적물 열을 읽고 합계 행은 뺀다', () => {
      const f = parseAmbiguousFilingDoc(DOC_80757);
      expect(f.counterparties).toEqual(['농협은행 주식회사']);
      expect(f.subjects).toEqual(['차입금']);
    });

    it('어느 서식도 아니면 빈 배열 — 대조 불가이지 불일치가 아니다', () => {
      const f = parseAmbiguousFilingDoc(FIXTURE_MD);
      expect(f.counterparties).toEqual([]);
    });

    it('parseAmbiguousFilingDoc 는 parseFilingCounterparties 의 별칭이다 (기존 호출부 호환)', () => {
      expect(parseAmbiguousFilingDoc).toBe(parseFilingCounterparties);
    });
  });

  /**
   * 보고서명으로 유형이 **확정된** 서식들의 거래상대방 위치 — 전부 실물 원문(2026, 미래에셋 계열)이다.
   * 이 파서가 틀리면 "공시 존재" 근거가 통째로 무너지므로 서식마다 고정한다.
   */
  describe('parseFilingCounterparties — 보고서명으로 유형이 확정된 실물 서식 6종', () => {
    const typed = (acode: string) =>
      readFileSync(join(HERE, 'fixtures', `j001-typed-${acode}.md`), 'utf8');

    it("80718 자금차입 세로형: 라벨이 '나. 차입처' 다 (금액 라벨 '4. 거래상대방과의 차입총계' 는 아니다)", () => {
      const f = parseFilingCounterparties(typed('80718'));
      expect(f.counterparties).toEqual(['미래에셋컨설팅(주)']);
    });

    it('80719 자금대여 정정본: 정정표의 금액 라벨이 아니라 본문 1. 거래상대방을 읽는다', () => {
      const f = parseFilingCounterparties(typed('80719'));
      // 정정표에 '다. 거래상대방 총 잔액'(금액) 행이 있지만 상대방으로 오르지 않는다
      expect(f.counterparties).toEqual(['와이케이디벨롭먼트(주)']);
    });

    it('80706 수익증권거래 세로형: 1. 거래상대방', () => {
      expect(parseFilingCounterparties(typed('80706')).counterparties).toEqual([
        '미래에셋벤처투자(주)',
      ]);
    });

    it("80732 출자 세로형: '라. 출자상대방 총출자액'(금액)이 아니라 1. 거래상대방", () => {
      expect(parseFilingCounterparties(typed('80732')).counterparties).toEqual(['미래에셋증권(주)']);
    });

    it('80702 상품·용역 분기공시 가로형: 헤더 다음 행부터 첫 칸, 다음 항목번호 행에서 끝난다', () => {
      const f = parseFilingCounterparties(typed('80702'));
      // '5. 상품ㆍ용역 거래내역' 이후의 계약명·거래대상 행이 상대방으로 새지 않는다
      expect(f.counterparties).toEqual(['미래에셋 컨설팅']);
    });

    it("80754 트랙 B 가로형: '상대방명' 열로 읽고 '발행자명' 열(비계열)은 상대방이 아니다", () => {
      const f = parseFilingCounterparties(typed('80754'));
      expect(f.counterparties).toEqual(['미래에셋자산운용']);
      expect(f.counterparties).not.toContain('기획재정부');
      // 소계·총계 행은 상대방 칸이 비어 자연히 빠진다
      expect(f.counterparties).not.toContain('총 계');
      expect(f.subjects).toEqual([
        '재정증권 2026-0090-0063',
        '국고채권 03250-3512(25-11)',
        '국고채권 03875-2612(23-10)',
      ]);
    });

    it('J004 원문에는 상대방 필드가 없다 — 미확인 서식은 no_counterparty_field 로 남는다', () => {
      // (J004 의 '거래상대방'·'거래상대방 선정방식' 은 **표의 열 이름**이지 값이 아니다)
      expect(parseFilingCounterparties(FIXTURE_MD).counterparties).toEqual([]);
      expect(
        parseFilingCounterparties(readFileSync(join(HERE, 'fixtures', 'j004-matrix.md'), 'utf8'))
          .counterparties,
      ).toEqual([]);
    });
  });

  const AMBIG = disc({
    corp_code: '00222222',
    report_nm: '특수관계인과의내부거래',
    rcept_no: '20250220000111',
    rcept_dt: '20250220',
  });

  it('원문 상대방이 이 거래 상대방과 일치하면 "공시 존재"로 올리고 근접 대조까지 한다', async () => {
    const docCalls: string[] = [];
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [AMBIG],
        // 픽스처 차입 상대방은 '미래에셋컨설팅(주)' — 원문은 띄어쓰기·(주) 가 달라도 정규화로 잇는다
        docs: { '20250220000111': doc80708('미래에셋 컨설팅 주식회사', '차입금') },
        docCalls,
      }),
    )) as Record<string, any>;
    // 차입 2건(02-19·06-30) 모두 exists → 02-19 건은 접수 02-20 으로 근접, 06-30 건은 창 안에만
    expect(res['summary'].not_judged).toBe(0);
    expect(res['summary'].undisclosed_candidates).toBe(0);
    expect(res['summary'].j001_filing_near_date).toBe(1);
    expect(res['summary'].j001_filing_in_window_only).toBe(1);
    const near = (res['j001_filing_near_date'] as Array<Record<string, any>>)[0]!;
    expect(near['type_ambiguous_resolved_by_document']).toBe(true);
    expect(near['matching_filings'][0].rcept_no).toBe('20250220000111');
    const ref = near['type_ambiguous_filings'][0];
    expect(ref.doc_read).toBe('ok');
    expect(ref.covers_this_counterparty).toBe(true);
    expect(ref.doc_counterparties).toEqual(['미래에셋 컨설팅 주식회사']);
    expect(ref.doc_subjects).toEqual(['차입금']);
    expect(ref.doc_subject_class).toBe('funds');
    expect(ref.covers_this_transaction).toBe(true);
    expect(ref.doc_amount_text).toBe('1,600');
    // 같은 원문은 한 번만 연다 (차입 2건 + 대여회사 관점이 같은 접수번호를 본다)
    expect(docCalls.filter((n) => n === '20250220000111')).toHaveLength(1);
    // makeDeps 기본 스텁은 docs 에 있는 원문을 **캐시된 것**으로 본다 — 콜 예산을 쓰지 않는다
    expect(res['diagnostics'].filing_docs).toMatchObject({
      filings_needed: 1,
      fetches: 0,
      cached_reads: 1,
      over_budget: 0,
      read_errors: 0,
    });
    expect(res['diagnostics'].filing_docs.ambiguous_resolved_to_exists).toBeGreaterThanOrEqual(1);
  });

  it('상대방은 맞아도 거래대상이 다른 유형이면 올리지 않는다 — 같은 쌍의 다른 유형 공시 (Codex ①)', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [AMBIG],
        // 차입 판정인데 원문 거래대상은 출자증권 — 상대방만 같다
        docs: { '20250220000111': doc80708('미래에셋컨설팅(주)', '출자증권') },
      }),
    )) as Record<string, any>;
    expect(res['summary'].undisclosed_candidates).toBe(0);
    expect(res['summary'].not_judged).toBe(2);
    const nj = (res['not_judged'] as Array<Record<string, any>>)[0]!;
    expect(String(nj['reason'])).toContain('거래대상이 이 유형(자금차입, funds)으로 분류되지 않았습니다');
    expect(nj['type_ambiguous_resolved_by_document']).toBeUndefined();
    const ref = nj['type_ambiguous_filings'][0];
    expect(ref.covers_this_counterparty).toBe(true);
    expect(ref.doc_subject_class).toBe('securities');
    expect(ref.covers_this_transaction).toBe(false);
  });

  it('정정본은 정정후 상대방만 대조한다 — 정정전 상대방으로 "일치"를 만들지 않는다 (Codex ②)', () => {
    const corrected = [
      '특수관계인과의내부거래',
      '## 특수관계인과의 내부거래',
      '',
      '| 1. 거래상대방 | 상대방 정정 | 미래에셋컨설팅(주) | 미래에셋자산운용(주) | 회사와의 관계 | 계열회사 |',
      '| --- | --- | --- | --- | --- | --- |',
      '| 2. 거래내용 다. 거래대상 | 정정 | 차입금 | 대여금 |',
    ].join('\n');
    const f = parseAmbiguousFilingDoc(corrected);
    expect(f.counterparties).toEqual(['미래에셋자산운용(주)']);
    expect(f.superseded_counterparties).toEqual(['미래에셋컨설팅(주)']);
    expect(f.subjects).toEqual(['대여금']);
  });

  it('classifyAmbiguousSubject — 한 유형만 걸릴 때만 분류하고 복합·공백은 unknown', () => {
    expect(classifyAmbiguousSubject(['"미래에셋" 브랜드 사용'])).toBe('goods');
    expect(classifyAmbiguousSubject(['미래에셋네이버아시아그로쓰사모투자합자회사의 지분'])).toBe('securities');
    expect(classifyAmbiguousSubject(['출자증권'])).toBe('securities');
    expect(classifyAmbiguousSubject(['차입금'])).toBe('funds');
    expect(classifyAmbiguousSubject(['출자증권 매입 용역'])).toBe('unknown'); // securities + goods
    expect(classifyAmbiguousSubject([])).toBe('unknown');
    expect(classifyAmbiguousSubject(['기타'])).toBe('unknown');
  });

  it('원문 상대방이 다르면 "공시 없음"으로 내리지 않고 보류를 유지하되 원문 값을 보여 준다', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [AMBIG],
        docs: { '20250220000111': doc80708('미래에셋자산운용(주)', '"미래에셋" 브랜드 사용') },
      }),
    )) as Record<string, any>;
    expect(res['summary'].undisclosed_candidates).toBe(0);
    expect(res['summary'].not_judged).toBe(2);
    const nj = (res['not_judged'] as Array<Record<string, any>>)[0]!;
    expect(String(nj['reason'])).toContain('type_ambiguous_filing_present');
    expect(String(nj['reason'])).toContain('정규화 일치하는 공시는 없었습니다');
    expect(String(nj['reason'])).toContain('미래에셋자산운용(주)');
    expect(nj['type_ambiguous_resolved_by_document']).toBeUndefined();
    const ref = nj['type_ambiguous_filings'][0];
    expect(ref.doc_read).toBe('ok');
    expect(ref.covers_this_counterparty).toBe(false);
    expect(ref.doc_counterparties).toEqual(['미래에셋자산운용(주)']);
    expect(ref.doc_subjects).toEqual(['"미래에셋" 브랜드 사용']);
  });

  it('원문을 못 열면(오류) 보류를 유지하고 doc_read: error 를 남긴다', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [AMBIG],
        docs: { '20250220000111': new Error('DART 원문 다운로드 실패 (테스트 스텁)') },
      }),
    )) as Record<string, any>;
    expect(res['summary'].undisclosed_candidates).toBe(0);
    expect(res['summary'].not_judged).toBe(2);
    const nj = (res['not_judged'] as Array<Record<string, any>>)[0]!;
    expect(String(nj['reason'])).toContain('원문 0/1건에서 거래상대방을 읽었고');
    const ref = nj['type_ambiguous_filings'][0];
    expect(ref.doc_read).toBe('error');
    expect(ref.doc_error).toContain('테스트 스텁');
    expect(res['diagnostics'].filing_docs.read_errors).toBe(1);
  });

  it('상대방 필드가 없는 원문은 no_counterparty_field — 불일치와 구분한다', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ corps: YKD_CORPS, j001: [AMBIG] }), // loadDoc 이 J004 픽스처를 돌려준다
    )) as Record<string, any>;
    expect(res['summary'].not_judged).toBe(2);
    const nj = (res['not_judged'] as Array<Record<string, any>>)[0]!;
    expect(nj['type_ambiguous_filings'][0].doc_read).toBe('no_counterparty_field');
    expect(nj['type_ambiguous_filings'][0].covers_this_counterparty).toBe(false);
  });

  it('새로 내려받기 예산(40건)을 넘으면 최신 접수분부터 열고 나머지는 budget_exceeded 로 보류한다', async () => {
    const docs: Record<string, string> = {};
    const filings: Disclosure[] = [];
    for (let i = 0; i < 41; i++) {
      const no = `202502${String(i + 1).padStart(2, '0')}000200`;
      filings.push(
        disc({
          corp_code: '00222222',
          report_nm: '특수관계인과의내부거래',
          rcept_no: no,
          rcept_dt: no.slice(0, 8),
        }),
      );
      docs[no] = doc80708('미래에셋자산운용(주)'); // 전부 불일치 — 예산 경로만 본다
    }
    const docCalls: string[] = [];
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      // 전부 콜드(캐시 없음) — 그래야 새로 내려받기 예산을 쓴다
      makeDeps({ corps: YKD_CORPS, j001: filings, docs, docCalls, cachedDocs: new Set() }),
    )) as Record<string, any>;
    const ambiguousReads = docCalls.filter((n) => n !== '20260601001646'); // 원천 문서 로드 제외
    expect(ambiguousReads).toHaveLength(40);
    // 가장 오래된 접수분(02-01)이 잘린다
    expect(ambiguousReads).not.toContain('20250201000200');
    expect(res['diagnostics'].filing_docs).toMatchObject({
      filings_needed: 41,
      fetches: 40,
      cached_reads: 0,
      fetch_budget: 40,
      over_budget: 1,
    });
    expect(res['summary'].not_judged).toBe(2);
    // ★ 예산 안내는 이제 참이다 — 받아 둔 원문이 캐시에 남아 재실행이 이어서 대조한다
    expect(
      (res['notes'] as string[]).some((n) => n.includes('다시 실행하면 그만큼은 예산을 쓰지 않고')),
    ).toBe(true);
    const nj = (res['not_judged'] as Array<Record<string, any>>)[0]!;
    expect(String(nj['reason'])).toContain('원문 40/41건에서 거래상대방을 읽었고');
    expect(String(nj['reason'])).toContain('다시 실행하면 나머지를 이어서 대조합니다');
  });

  it('대여회사 관점도 같은 규칙으로 풀린다 — 차입회사가 대조 상대방이다', async () => {
    const md = [
      '| 기업집단명 : | 테스트집단 |',
      '| --- | --- |',
      '## (2) 회사 재무현황',
      '| (단위 : 백만원, %) |',
      '| --- |',
      '| 계열회사명 |  | 자본금 | 자본총계 |',
      '| --- | --- | --- | --- |',
      '| 비금융회사 | 차입회사(주) | 5,000 | 20,000 |',
      '| 비금융회사 | 대여계열사(주) | 1,000 | 4,000 |',
      '## (1) 계열회사간 자금거래 현황',
      '가. 일반 차입',
      '| (단위 : 백만원) |',
      '| --- |',
      '| 차입회사 (소속회사) |  | 거래상대방 | 차입금액 | 차입일 |',
      '| --- | --- | --- | --- | --- |',
      '| 비금융회사 | 차입회사(주) | 대여계열사(주) | 16,000 | 2025-02-19 |',
    ].join('\n');
    const corps = {
      차입회사: [{ corpCode: '00222222', corpName: '차입회사' }],
      대여계열사: [{ corpCode: '00333333', corpName: '대여계열사' }],
    };
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        markdown: md,
        corps,
        j001: (corpCode) =>
          corpCode === '00333333'
            ? [
                disc({
                  corp_code: '00333333',
                  report_nm: '특수관계인과의내부거래', // 대여회사가 유형 미상 서식으로 냈다
                  rcept_no: '20250214000777',
                  rcept_dt: '20250214',
                }),
              ]
            : [],
        // 원문 상대방 = 차입회사 → 대여회사 관점에서 "공시 존재", 접수 02-14 는 차입일 02-19 의 5일 전
        docs: { '20250214000777': doc80708('차입회사 주식회사', '대여금') },
      }),
    )) as Record<string, any>;
    const side = r['undisclosed_candidates'][0].lender_side;
    expect(side.status).toBe('j001_filing_near_date');
    expect(side.nearest_filing_gap_days).toBe(-5);
    expect(side.type_ambiguous_resolved_by_document).toBe(true);
    expect(side.type_ambiguous_filings[0].covers_this_counterparty).toBe(true);
    expect(side.type_ambiguous_filings[0].doc_subjects).toEqual(['대여금']);
    // 차입회사 쪽은 자금차입 공시가 없어 여전히 후보 — 두 판정은 독립이다
    expect(r['summary'].undisclosed_candidates).toBe(1);
    expect(r['summary'].lender_side.j001_filing_near_date).toBe(1);
  });
});

/**
 * 포털 조인 0건 예외 제거 + **첫 실행 자동 워밍** (작업 3)
 *
 * 이 프로젝트의 조인 키는 법인등록번호다(포털 한글 음차 vs DART 영문 약어라 이름으로는 못 잇는다).
 * 그 번호는 DART 기업개황을 회사별로 불러야 얻어지는데, 종전에는 사용자가
 * `resolve_entity(fetchJurirNo=true)` 로 손수 채워야 했고 안 채우면 판정이 통째로 "확인 못 함"이
 * 됐다 (실측 콜드 캐시: joined 0·unjoined 24 → counterparty_not_joined 28).
 *
 * ★ 확정 근거는 **법인등록번호 정확히 1건 일치**뿐이다. 이름은 후보를 좁히는 데만 쓴다 —
 *   실측(미래에셋증권)에서 이름으로 골랐다면 절반의 확률로 2016년 합병으로 사라진 옛 법인을
 *   잡았고, 폐지 법인의 공시를 "공시 존재" 근거로 삼는 것이 전형적인 거짓 안심이다.
 */
describe('포털 조인 0건 + 자동 워밍 (작업 3)', () => {
  const MD = [
    '| 기업집단명 : | 테스트집단 |',
    '| --- | --- |',
    '## (2) 회사 재무현황',
    '| (단위 : 백만원, %) |',
    '| --- |',
    '| 계열회사명 |  | 자본금 | 자본총계 |',
    '| --- | --- | --- | --- |',
    '| 비금융회사 | 차입회사(주) | 5,000 | 20,000 |',
    '| 금융회사 | 대여증권(주) | 1,000 | 4,000 |',
    '## (1) 계열회사간 자금거래 현황',
    '가. 일반 차입',
    '| (단위 : 백만원) |',
    '| --- |',
    '| 차입회사 (소속회사) |  | 거래상대방 | 차입금액 | 차입일 |',
    '| --- | --- | --- | --- | --- |',
    '| 비금융회사 | 차입회사(주) | 대여증권(주) | 16,000 | 2025-02-19 |',
  ].join('\n');

  const JURIR_차입 = '1101110011111';
  const JURIR_대여 = '1101110022222';

  /** 콜드 캐시 — 포털 목록은 있는데 DART corp_code 조인이 **0건**이다 */
  const EMPTY_POP: Population = {
    corpCodes: new Map(),
    group: { representative_company: '차입회사(주)' },
    unjoined: ['차입회사(주)', '대여증권(주)'],
    jurirNoByName: new Map([
      ['차입회사', JURIR_차입],
      ['대여증권', JURIR_대여],
    ]),
  };

  /** 차입회사만 조인된 상태 — 워밍 대상은 대여증권 하나뿐이다 */
  function coldPop(): Population {
    return {
      corpCodes: new Map([['00222222', '차입회사(주)']]),
      group: { representative_company: '차입회사(주)' },
      unjoined: ['대여증권(주)'],
      jurirNoByName: new Map([['대여증권', JURIR_대여]]),
    };
  }

  /** 워밍으로 대여증권이 조인된 뒤의 모집단 (재호출이 돌려주는 값) */
  function warmedPop(): Population {
    return {
      corpCodes: new Map([
        ['00222222', '차입회사(주)'],
        ['00311030', '대여증권(주)'],
      ]),
      group: { representative_company: '차입회사(주)' },
      unjoined: [],
      jurirNoByName: new Map([['대여증권', JURIR_대여]]),
    };
  }

  it('DART 조인 0건이어도 예외 없이 결과를 낸다 — 한계는 caveat 로 분리해 밝힌다', async () => {
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: MD, pop: EMPTY_POP, j001: [] }),
    )) as Record<string, any>;

    expect(r['diagnostics'].population.joined_companies).toBe(0);
    expect(r['diagnostics'].population.unjoined_companies).toBe(2);
    // "포털 목록 자체가 없다" 와 "목록은 있는데 조인이 0" 은 한계가 다르다 — 문구가 갈려야 한다
    const caveat = (r['scope_caveats'] as string[]).find((c) =>
      c.includes('조인된 회사가 한 곳도 없습니다'),
    );
    expect(caveat).toBeDefined();
    // 조인 0건에서는 편입일 대조도 불가능하다 — '가능하다'고 쓰면 그 자체가 거짓 안심이다
    expect(String(caveat)).toContain('계열편입일 대조도 하지 못합니다');
    expect(
      (r['scope_caveats'] as string[]).some((c) => c.includes('포털 소속회사 목록 없이')),
    ).toBe(false);
    // 후보 탐색이 전부 0건이라 조회는 하지 않았지만 시도 자체는 수치로 남는다
    expect(r['diagnostics'].population.warming.no_candidates).toBe(2);
    expect(r['diagnostics'].population.warming.lookups).toBe(0);
  });

  it('완전일치가 없으면 부분일치 후보를 법인등록번호로 대조해 조인한다 (모집단 재호출 1회)', async () => {
    const popCalls: PopulationInput[] = [];
    const jurirCalls: string[] = [];
    const searchCalls: string[] = [];
    const deps = makeDeps({
      markdown: MD,
      j001: [],
      corps: {}, // DART 상호 완전일치 0건 — 포털 표기와 DART 상호가 다르다
      searchCorps: {
        대여증권: [
          { corpCode: '00311030', corpName: '대여증권' },
          { corpCode: '00999999', corpName: '옛대여증권' },
        ],
      },
      searchCalls,
      jurirCalls,
      jurir: {
        '00311030': { status: 'ok', jurirNo: JURIR_대여 }, // 포털과 일치
        '00999999': { status: 'ok', jurirNo: '1101110099999' }, // 합병 전 옛 법인
      },
    });
    let n = 0;
    deps.resolvePop = async (i) => {
      popCalls.push(i);
      n++;
      return n === 1 ? coldPop() : warmedPop();
    };

    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      deps,
    )) as Record<string, any>;

    const w = r['diagnostics'].population.warming;
    expect(w.attempted).toBe(1);
    expect(w.joined).toBe(1);
    expect(w.lookups).toBe(2);
    expect(w.resolved).toEqual([
      { company: '대여증권(주)', corp_code: '00311030', jurir_no: JURIR_대여, candidates: 2 },
    ]);
    expect(searchCalls).toEqual(['대여증권']);
    expect(jurirCalls).toEqual(['00311030', '00999999']);
    // 조인이 늘었으므로 모집단을 **한 번만** 다시 받는다 (포털 응답은 캐시 히트)
    expect(popCalls).toHaveLength(2);
    expect(popCalls[1]).toEqual(popCalls[0]);
    expect(r['diagnostics'].population.joined_companies).toBe(2);
    // 워밍 결과가 실제 판정에 쓰인다 — 대여회사 관점이 corp_code 로 이어진다
    expect(r['undisclosed_candidates'][0].lender_side.corp_code).toBe('00311030');
    expect(
      (r['notes'] as string[]).some((x) => x.includes('자동 워밍') && x.includes('1개사')),
    ).toBe(true);
    // 재시도 억제 기록은 법인등록번호로 남는다 (표기는 흔들려도 번호는 안정적이다)
    // 억제 키에는 **탐색 로직 버전**이 박힌다 — 탐색 규칙을 고치면 구버전 기록이 신로직을 막지 않는다
    expect(store.get(`warm:v3:${JURIR_대여}`)).toBe('20260827');
  });

  /**
   * ★ 실측 반례 1 — 포털 이름이 DART 상호보다 **길면** 부분일치가 무력하다.
   * 포털 '미래에셋 생명보험(주)' → 조각 '미래에셋생명보험' 으로는 DART 상호 '미래에셋생명' 을
   * 찾을 수 없다(포함 방향이 반대). 실측: 두 글자만 줄이면 1건으로 잡힌다.
   */
  it('조각이 0건이면 뒤에서 한 글자씩 줄여 다시 찾는다 (포털 이름이 더 긴 경우)', async () => {
    const searchCalls: string[] = [];
    const jurirCalls: string[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        markdown: MD,
        j001: [],
        pop: {
          corpCodes: new Map([['00222222', '차입회사(주)']]),
          group: { representative_company: '차입회사(주)' },
          unjoined: ['미래에셋 생명보험(주)'],
          jurirNoByName: new Map([['미래에셋생명보험', '1101110033333']]),
        },
        corps: {},
        // DART 상호는 '미래에셋생명' — 조각을 두 글자 줄여야 걸린다
        searchCorps: { 미래에셋생명: [{ corpCode: '00112332', corpName: '미래에셋생명' }] },
        searchCalls,
        jurirCalls,
        jurir: { '00112332': { status: 'ok', jurirNo: '1101110033333' } },
      }),
    )) as Record<string, any>;

    expect(searchCalls).toEqual(['미래에셋생명보험', '미래에셋생명보', '미래에셋생명']);
    const w = r['diagnostics'].population.warming;
    expect(w.joined).toBe(1);
    expect(w.resolved).toEqual([
      {
        company: '미래에셋 생명보험(주)',
        corp_code: '00112332',
        jurir_no: '1101110033333',
        candidates: 1,
      },
    ]);
    expect(jurirCalls).toEqual(['00112332']);
  });

  it('4자 밑으로는 줄이지 않는다 — 그 아래 조각은 너무 흔하다', async () => {
    const searchCalls: string[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        markdown: MD,
        j001: [],
        pop: {
          corpCodes: new Map([['00222222', '차입회사(주)']]),
          group: { representative_company: '차입회사(주)' },
          unjoined: ['가나다라마(주)'],
          jurirNoByName: new Map([['가나다라마', '1101110044444']]),
        },
        corps: {},
        searchCorps: {},
        searchCalls,
      }),
    )) as Record<string, any>;

    expect(searchCalls).toEqual(['가나다라마', '가나다라']);
    expect(r['diagnostics'].population.warming.no_candidates).toBe(1);
    expect(r['diagnostics'].population.warming.skipped).toEqual([
      { company: '가나다라마(주)', reason: 'no_candidates' },
    ]);
  });

  /**
   * ★ 실측 회귀 — 4자 하한을 **원본 조각**에 걸었더니 '시니안(유)'(조각 3자)가 검색조차 되지
   * 않아 종전에 조인되던 회사를 잃었다 (DART 상호 '시니안' 00755252). 하한은 *절단해 내려갈
   * 때의* 바닥일 뿐이다 — 짧은 상호는 실재한다.
   */
  it('조각이 4자 미만이어도 원본 그대로는 반드시 검색한다 (시니안 회귀)', async () => {
    const searchCalls: string[] = [];
    const jurirCalls: string[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        markdown: MD,
        j001: [],
        pop: {
          corpCodes: new Map([['00222222', '차입회사(주)']]),
          group: { representative_company: '차입회사(주)' },
          unjoined: ['시니안(유)'],
          jurirNoByName: new Map([['시니안', '1101110055555']]),
        },
        corps: {}, // 완전일치 '시니안(유)' 는 0건 — DART 상호는 '시니안'
        searchCorps: { 시니안: [{ corpCode: '00755252', corpName: '시니안' }] },
        searchCalls,
        jurirCalls,
        jurir: { '00755252': { status: 'ok', jurirNo: '1101110055555' } },
      }),
    )) as Record<string, any>;

    // 3자 조각으로 정확히 한 번 검색한다 (절단 단계는 없다)
    expect(searchCalls).toEqual(['시니안']);
    const w = r['diagnostics'].population.warming;
    expect(w.joined).toBe(1);
    expect(w.resolved[0].corp_code).toBe('00755252');
    expect(jurirCalls).toEqual(['00755252']);
  });

  it('법인격만 남은 이름은 빈 조각으로 검색하지 않는다', async () => {
    const searchCalls: string[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        markdown: MD,
        j001: [],
        pop: {
          corpCodes: new Map([['00222222', '차입회사(주)']]),
          group: { representative_company: '차입회사(주)' },
          unjoined: ['(주)'],
          jurirNoByName: new Map([['', '1101110066666']]),
        },
        corps: {},
        searchCalls,
      }),
    )) as Record<string, any>;

    expect(searchCalls).toEqual([]);
    expect(r['diagnostics'].population.warming.no_candidates).toBe(1);
  });

  /**
   * ★ 실측 반례 2 — 부분일치가 상한에 걸려도 **정답이 그 안에** 있을 수 있다.
   * '미래에셋증권' 부분일치는 사모투자 회사들에 밀려 5건이 되는데 그중 하나가 찾던 회사다.
   * 이름으로 확정하는 게 아니라 **후보를 1건으로 좁힐 뿐**이고, 확정은 법인등록번호가 한다.
   */
  it('상한에 걸린 목록이라도 정규화 완전일치가 정확히 1건이면 그것만 후보로 삼는다', async () => {
    const jurirCalls: string[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        markdown: MD,
        j001: [],
        pop: {
          corpCodes: new Map([['00222222', '차입회사(주)']]),
          group: { representative_company: '차입회사(주)' },
          unjoined: ['미래에셋 증권(주)'],
          jurirNoByName: new Map([['미래에셋증권', '1101110011679']]),
        },
        corps: {},
        searchCorps: {
          미래에셋증권: [
            { corpCode: '00900001', corpName: '미래에셋증권사모투자전문회사일호녹색성장이천구' },
            { corpCode: '00111722', corpName: '미래에셋증권' },
            { corpCode: '00900002', corpName: '미래에셋증권코리아제일호사모투자' },
            { corpCode: '00900003', corpName: '미래에셋증권제이호사모투자' },
            { corpCode: '00900004', corpName: '미래에셋증권제삼호사모투자' },
          ],
        },
        jurirCalls,
        jurir: { '00111722': { status: 'ok', jurirNo: '1101110011679' } },
      }),
    )) as Record<string, any>;

    const w = r['diagnostics'].population.warming;
    expect(w.skipped_too_many_candidates).toBe(0);
    expect(w.joined).toBe(1);
    expect(w.resolved[0].corp_code).toBe('00111722');
    // 나머지 4건은 조회조차 하지 않는다 — 후보를 좁힌 것이지 넓힌 게 아니다
    expect(jurirCalls).toEqual(['00111722']);
  });

  it('상한 목록에 정규화 완전일치가 2건이면 종전대로 건너뛴다 (추측 금지)', async () => {
    const jurirCalls: string[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        markdown: MD,
        j001: [],
        pop: {
          corpCodes: new Map([['00222222', '차입회사(주)']]),
          group: { representative_company: '차입회사(주)' },
          unjoined: ['미래에셋 증권(주)'],
          jurirNoByName: new Map([['미래에셋증권', '1101110011679']]),
        },
        corps: {},
        searchCorps: {
          미래에셋증권: [
            { corpCode: '00111722', corpName: '미래에셋증권' },
            { corpCode: '00311030', corpName: '미래에셋증권(주)' }, // 정규화하면 같은 이름
            { corpCode: '00900002', corpName: '미래에셋증권코리아제일호사모투자' },
            { corpCode: '00900003', corpName: '미래에셋증권제이호사모투자' },
            { corpCode: '00900004', corpName: '미래에셋증권제삼호사모투자' },
          ],
        },
        jurirCalls,
      }),
    )) as Record<string, any>;

    const w = r['diagnostics'].population.warming;
    expect(w.skipped_too_many_candidates).toBe(1);
    expect(w.skipped).toEqual([
      { company: '미래에셋 증권(주)', reason: 'too_many_candidates', candidates: 5 },
    ]);
    expect(jurirCalls).toHaveLength(0);
  });

  it('후보가 검색 상한(5건)만큼 나오면 이름 조각이 흔한 것이라 대조하지 않는다', async () => {
    const jurirCalls: string[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        markdown: MD,
        j001: [],
        pop: coldPop(),
        corps: {},
        searchCorps: {
          대여증권: Array.from({ length: 5 }, (_, i) => ({
            corpCode: `0090000${i}`,
            corpName: `대여증권${i}`,
          })),
        },
        jurirCalls,
      }),
    )) as Record<string, any>;

    const w = r['diagnostics'].population.warming;
    expect(w.skipped_too_many_candidates).toBe(1);
    expect(w.attempted).toBe(0);
    // 잘못 좁혀 엉뚱한 회사를 확정하느니 미조인이 낫다 — 기업개황을 한 번도 부르지 않는다
    expect(jurirCalls).toHaveLength(0);
  });

  it('최근 30일 안에 시도한 법인등록번호는 다시 조회하지 않는다', async () => {
    store.set(`warm:v3:${JURIR_대여}`, '20260820'); // 7일 전
    const jurirCalls: string[] = [];
    const searchCalls: string[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        markdown: MD,
        j001: [],
        pop: coldPop(),
        corps: {},
        searchCorps: { 대여증권: [{ corpCode: '00311030', corpName: '대여증권' }] },
        jurirCalls,
        searchCalls,
      }),
    )) as Record<string, any>;

    const w = r['diagnostics'].population.warming;
    expect(w.skipped_suppressed).toBe(1);
    expect(w.lookups).toBe(0);
    expect(jurirCalls).toHaveLength(0);
    expect(searchCalls).toHaveLength(0);
  });

  /**
   * ★ 억제 키에 **탐색 로직 버전**이 없으면 개선이 기존 사용자에게 한 달간 도달하지 않는다.
   * 구버전이 "후보 0건"으로 남긴 기록이 점진 절단·상한 속 완전일치 같은 새 규칙까지 막는다
   * (사용자가 캐시를 손으로 지울 방법도 없다).
   */
  it('구버전 억제 키(warm:<jurir>)는 새 탐색 로직을 막지 못한다', async () => {
    store.set(`warm:${JURIR_대여}`, '20260826'); // 어제 남긴 구버전 기록
    const jurirCalls: string[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        markdown: MD,
        j001: [],
        pop: coldPop(),
        corps: {},
        searchCorps: { 대여증권: [{ corpCode: '00311030', corpName: '대여증권' }] },
        jurirCalls,
        jurir: { '00311030': { status: 'ok', jurirNo: JURIR_대여 } },
      }),
    )) as Record<string, any>;

    const w = r['diagnostics'].population.warming;
    expect(w.skipped_suppressed).toBe(0);
    expect(w.joined).toBe(1);
    expect(jurirCalls).toEqual(['00311030']);
    // 새 기록은 버전이 박힌 키로만 남는다
    expect(store.get(`warm:v3:${JURIR_대여}`)).toBe('20260827');
    expect(store.get(`warm:${JURIR_대여}`)).toBe('20260826');
  });

  it('억제 기간(30일)이 지난 기록은 다시 시도한다', async () => {
    store.set(`warm:v3:${JURIR_대여}`, '20260701'); // 57일 전
    const jurirCalls: string[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        markdown: MD,
        j001: [],
        pop: coldPop(),
        corps: {},
        searchCorps: { 대여증권: [{ corpCode: '00311030', corpName: '대여증권' }] },
        jurirCalls,
        jurir: { '00311030': { status: 'ok', jurirNo: JURIR_대여 } },
      }),
    )) as Record<string, any>;

    expect(r['diagnostics'].population.warming.skipped_suppressed).toBe(0);
    expect(jurirCalls).toEqual(['00311030']);
  });

  it('조회 예산(40회)을 넘으면 이름 단위로 끊는다 — 남은 회사는 다음 실행에서 이어 채운다', async () => {
    // 이름 21개 × 후보 2개 = 42회 > 예산 40 → 20개까지만 대조하고 나머지는 건드리지 않는다
    const names = Array.from({ length: 21 }, (_, i) => `회사${String(i).padStart(2, '0')}(주)`);
    const pop: Population = {
      corpCodes: new Map([['00222222', '차입회사(주)']]),
      group: { representative_company: '차입회사(주)' },
      unjoined: names,
      jurirNoByName: new Map(
        names.map((n, i) => [n.replace('(주)', ''), `110111000${String(i).padStart(4, '0')}`]),
      ),
    };
    const searchCorps: Record<string, Array<{ corpCode: string; corpName: string }>> = {};
    for (const [i, n] of names.entries()) {
      searchCorps[n.replace('(주)', '')] = [
        { corpCode: `009${String(i).padStart(5, '0')}`, corpName: n },
        { corpCode: `008${String(i).padStart(5, '0')}`, corpName: n },
      ];
    }
    const jurirCalls: string[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: MD, j001: [], pop, corps: {}, searchCorps, jurirCalls }),
    )) as Record<string, any>;

    const w = r['diagnostics'].population.warming;
    expect(w.over_budget).toBe(true);
    expect(w.budget).toBe(40);
    expect(w.lookups).toBe(40);
    expect(w.attempted).toBe(20);
    expect(jurirCalls).toHaveLength(40);
    // 못 본 회사는 이름과 사유가 남는다 — 수치만으로는 손으로 보충할 수 없다
    expect(w.skipped).toEqual([{ company: '회사20(주)', reason: 'over_budget', candidates: 2 }]);
    // 시도하지 않았으므로 억제 기록도 없다 → 다음 실행이 이어받는다
    expect(store.get('warm:v3:1101110000020')).toBeNull();
    expect((r['scope_caveats'] as string[]).some((c) => c.includes('이어서 채웁니다'))).toBe(
      true,
    );
  });

  it('후보 1건짜리를 먼저 소진한다 — 예산이 모자라도 확실한 조인부터 확보한다', async () => {
    // 후보 5건짜리가 포털 목록에서 **앞에** 있지만 예산(40)은 뒤쪽 1건짜리들을 먼저 채워야 한다
    const many = Array.from({ length: 8 }, (_, i) => `다건회사${i}(주)`);
    const few = Array.from({ length: 9 }, (_, i) => `단건회사${i}(주)`);
    const pop: Population = {
      corpCodes: new Map([['00222222', '차입회사(주)']]),
      group: { representative_company: '차입회사(주)' },
      unjoined: [...many, ...few],
      jurirNoByName: new Map([
        ...many.map((n, i) => [n.replace('(주)', ''), `220111000${String(i).padStart(4, '0')}`] as const),
        ...few.map((n, i) => [n.replace('(주)', ''), `330111000${String(i).padStart(4, '0')}`] as const),
      ]),
    };
    const searchCorps: Record<string, Array<{ corpCode: string; corpName: string }>> = {};
    const jurir: Record<string, JurirNoFetch> = {};
    for (const [i, n] of many.entries()) {
      // 상한 미만(4건)이라 전부 후보로 남는다
      searchCorps[n.replace('(주)', '')] = Array.from({ length: 4 }, (_, k) => ({
        corpCode: `71${String(i).padStart(3, '0')}${k}`,
        corpName: n,
      }));
    }
    for (const [i, n] of few.entries()) {
      const code = `72${String(i).padStart(6, '0')}`;
      searchCorps[n.replace('(주)', '')] = [{ corpCode: code, corpName: n }];
      jurir[code] = { status: 'ok', jurirNo: `330111000${String(i).padStart(4, '0')}` };
    }
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: MD, j001: [], pop, corps: {}, searchCorps, jurir }),
    )) as Record<string, any>;

    const w = r['diagnostics'].population.warming;
    // 단건 9개(9회) 먼저 → 남은 31회로 다건 7개(28회), 8번째는 예산 초과
    expect(w.joined).toBe(9);
    expect(w.resolved.map((x: Record<string, unknown>) => x['company'])).toEqual(few);
    expect(w.lookups).toBe(37);
    expect(w.over_budget).toBe(true);
    expect(w.skipped).toEqual([{ company: '다건회사7(주)', reason: 'over_budget', candidates: 4 }]);
  });

  it('법인등록번호 일치가 2건이면 조인하지 않는다 (같은 번호에 corp_code 가 여럿)', async () => {
    const jurirCalls: string[] = [];
    const popCalls: PopulationInput[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        markdown: MD,
        j001: [],
        pop: coldPop(),
        corps: {},
        searchCorps: {
          대여증권: [
            { corpCode: '00311030', corpName: '대여증권' },
            { corpCode: '00999999', corpName: '대여증권' },
          ],
        },
        jurirCalls,
        popCalls,
        jurir: {
          '00311030': { status: 'ok', jurirNo: JURIR_대여 },
          '00999999': { status: 'ok', jurirNo: JURIR_대여 },
        },
      }),
    )) as Record<string, any>;

    const w = r['diagnostics'].population.warming;
    expect(w.attempted).toBe(1);
    expect(w.joined).toBe(0);
    expect(w.resolved).toEqual([]);
    expect(jurirCalls).toHaveLength(2);
    // 새로 조인된 회사가 없으므로 모집단 재호출도 없다
    expect(popCalls).toHaveLength(1);
    expect(r['undisclosed_candidates'][0].lender_side.status).toBe('counterparty_not_joined');
  });

  it('조회 실패는 불일치와 구분해 센다 — 실패를 "다른 회사"로 뭉개지 않는다', async () => {
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        markdown: MD,
        j001: [],
        pop: coldPop(),
        corps: {},
        searchCorps: { 대여증권: [{ corpCode: '00311030', corpName: '대여증권' }] },
        jurir: { '00311030': { status: 'error', message: '조회 실패' } },
      }),
    )) as Record<string, any>;

    const w = r['diagnostics'].population.warming;
    expect(w.lookup_errors).toBe(1);
    expect(w.joined).toBe(0);
  });

  it('포털이 법인등록번호를 주지 않은 이름은 후보 탐색조차 하지 않는다 (대조 기준이 없다)', async () => {
    const searchCalls: string[] = [];
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        markdown: MD,
        j001: [],
        pop: {
          corpCodes: new Map([['00222222', '차입회사(주)']]),
          group: { representative_company: '차입회사(주)' },
          unjoined: ['대여증권(주)', '번호없는회사(주)'],
          jurirNoByName: new Map([['대여증권', JURIR_대여]]),
        },
        corps: {},
        searchCorps: { 대여증권: [] },
        searchCalls,
      }),
    )) as Record<string, any>;

    const w = r['diagnostics'].population.warming;
    expect(w.skipped_no_portal_jurir).toBe(1);
    expect(searchCalls).toEqual(['대여증권']);
  });
});

/**
 * audit 두 도구의 계약 — **조인 0건은 여전히 예외**다.
 * 빈 모집단으로 감사가 "지연 0건"·"미제출 0건"을 내면 거짓 안심이다. `allowEmptyJoin` 은
 * detect 전용 옵션이며, 이 테스트가 그 경계를 고정한다.
 */
describe('resolvePopulation — allowEmptyJoin 경계 (작업 3)', () => {
  const YM = '202605';
  const GROUP = { unityGrupNm: '테스트집단', unityGrupCode: 'K9999999', smerNm: '홍길동', repreCmpny: '차입회사(주)', sumCmpnyCo: '1', invstmntLmtt: 'N' };
  const AFFILIATE = { entrprsNm: '차입회사(주)', jurirno: '110111-0011111', bizrno: '1018100001', rprsntvNm: '홍길동', fondDe: '20000101', grinil: '20240501' };

  let prevKey: string | undefined;
  beforeEach(() => {
    // 포털 응답은 캐시로 먹인다 — 실제 API 를 부르지 않는다 (키는 클라이언트 생성에만 필요)
    prevKey = process.env['EGROUP_API_KEY'];
    process.env['EGROUP_API_KEY'] = 'test-key';
    __resetConfig();
    store.set(`egroup_groups:${YM}`, JSON.stringify([GROUP]));
    store.set(`egroup_affiliates:${YM}:K9999999`, JSON.stringify([AFFILIATE]));
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env['EGROUP_API_KEY'];
    else process.env['EGROUP_API_KEY'] = prevKey;
    __resetConfig();
  });

  it('조인 0건이면 예외를 던진다 (audit 경로 — 옵션 없음)', async () => {
    await expect(
      resolvePopulation({ group: '테스트집단', year_month: YM }),
    ).rejects.toThrow(ToolError);
  });

  it('allowEmptyJoin 이면 빈 조인으로도 포털 명단·법인등록번호를 그대로 준다 (detect 경로)', async () => {
    const pop = await resolvePopulation({
      group: '테스트집단',
      year_month: YM,
      allowEmptyJoin: true,
    });
    expect(pop.corpCodes.size).toBe(0);
    expect(pop.unjoined).toEqual(['차입회사(주)']);
    // 워밍의 대조 기준 — 이게 살아 있어야 자동 조인이 가능하다
    expect(pop.jurirNoByName?.get('차입회사')).toBe('1101110011111');
  });
});

/**
 * 모집단 실패 **사유 코드가 실제 원인과 맞아야** 한다.
 * 실측(2026-09-06): 포털은 캐시 히트로 정상 응답했는데 조인이 0건이라 예외가 났고, 사유는
 * `portal_unavailable — 포털 소속회사 목록을 불러오지 못했습니다` 로 표시됐다. 사용자가
 * 포털 장애·키 문제를 의심하며 시간을 쓰게 만드는 오표기다.
 */
describe('모집단 실패 사유 코드 (rcept_no 경로)', () => {
  const MD = [
    '| 기업집단명 : | 테스트집단 |',
    '| --- | --- |',
    '## (2) 회사 재무현황',
    '| (단위 : 백만원, %) |',
    '| --- |',
    '| 계열회사명 |  | 자본금 | 자본총계 |',
    '| --- | --- | --- | --- |',
    '| 비금융회사 | 차입회사(주) | 5,000 | 20,000 |',
    '## (1) 계열회사간 자금거래 현황',
    '가. 일반 차입',
    '| (단위 : 백만원) |',
    '| --- |',
    '| 차입회사 (소속회사) |  | 거래상대방 | 차입금액 | 차입일 |',
    '| --- | --- | --- | --- | --- |',
    '| 비금융회사 | 차입회사(주) | 대여증권(주) | 16,000 | 2025-02-19 |',
  ].join('\n');

  async function runWith(err: Error): Promise<Record<string, any>> {
    const deps = makeDeps({ markdown: MD, j001: [], corps: {} });
    deps.resolvePop = async () => {
      throw err;
    };
    return (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      deps,
    )) as Record<string, any>;
  }

  it('조인 0건(corp_not_found)은 join_empty 다 — "포털을 못 불러왔다"가 아니다', async () => {
    const r = await runWith(
      new ToolError('corp_not_found', "'테스트집단' 소속회사 중 DART corp_code 가 조인된 회사가 없습니다."),
    );
    const reason = String(r['diagnostics'].population.reason);
    expect(reason).toContain('join_empty');
    expect(reason).toContain('포털 소속회사 목록은 응답했으나');
    expect(reason).not.toContain('portal_unavailable');
  });

  it('통신·파싱 실패는 그대로 portal_unavailable 이다', async () => {
    const r = await runWith(
      new ToolError('egroup_api_error', '기업집단포털 요청에 실패했습니다 (TypeError: fetch failed — UND_ERR_CONNECT_TIMEOUT).'),
    );
    const reason = String(r['diagnostics'].population.reason);
    expect(reason).toContain('portal_unavailable');
    expect(reason).toContain('UND_ERR_CONNECT_TIMEOUT');
  });
});

describe('시간 예산 — 60초 벽 (작업 4)', () => {
  /**
   * J001 검색이 필요한 회사가 **셋**인 문서.
   *  - 에이사(주) 차입 160억 / 비사(주) 차입 120억  (둘 다 100억 상한 이상 = 자본 무관 확실)
   *  - 씨사(주) 는 그 둘의 **대여회사** — 자기 자본 기준으로 따로 판정하므로 검색이 하나 더 는다
   *  - 디사(주) 차입 1억 = **기준 미달 확정** — 예산이 끊겨도 이 판정은 남아 있어야 한다
   * 검색 순서는 금액 상위부터라 에이사(160) → 씨사(160) → 비사(120) 이다.
   */
  const MD = [
    '| 기업집단명 : | 테스트집단 |',
    '| --- | --- |',
    '## (2) 회사 재무현황',
    '| (단위 : 백만원, %) |',
    '| --- |',
    '| 계열회사명 |  | 자본금 | 자본총계 |',
    '| --- | --- | --- | --- |',
    '| 비금융회사 | 에이사(주) | 1,000 | 20,000 |',
    '| 비금융회사 | 비사(주) | 1,000 | 20,000 |',
    '| 비금융회사 | 씨사(주) | 1,000 | 20,000 |',
    '| 비금융회사 | 디사(주) | 1,000 | 20,000 |',
    '## (1) 계열회사간 자금거래 현황',
    '가. 일반 차입',
    '| (단위 : 백만원) |',
    '| --- |',
    '| 차입회사 (소속회사) |  | 거래상대방 | 차입금액 | 차입일 |',
    '| --- | --- | --- | --- | --- |',
    '| 비금융회사 | 에이사(주) | 씨사(주) | 16,000 | 2025-02-19 |',
    '| 비금융회사 | 비사(주) | 씨사(주) | 12,000 | 2025-06-30 |',
    '| 비금융회사 | 디사(주) | 에이사(주) | 100 | 2025-03-05 |',
  ].join('\n');

  const CORPS = {
    에이사: [{ corpCode: '00111111', corpName: '에이사' }],
    비사: [{ corpCode: '00222222', corpName: '비사' }],
    씨사: [{ corpCode: '00333333', corpName: '씨사' }],
    디사: [{ corpCode: '00444444', corpName: '디사' }],
  };

  /** 손으로 굴리는 시계 — 실제 sleep 없이 예산을 소진시킨다 */
  function fakeClock(): { now: () => number; advance: (ms: number) => void } {
    let t = 1_700_000_000_000;
    return { now: () => t, advance: (ms) => void (t += ms) };
  }

  it('★ 예산이 끊겨도 예외를 던지지 않고 부분 결과를 낸다 — 이미 만든 판정은 그대로 남는다', async () => {
    const c = fakeClock();
    const calls: CallLog[] = [];
    const deps = makeDeps({ markdown: MD, corps: CORPS, j001: [], calls, now: c.now });
    const inner = deps.collectList;
    // 목록 수집 1회 = 25초 (예산 50초) → 두 번째 회사까지만 검색하고 세 번째는 시작하지 않는다
    deps.collectList = async (...args) => {
      c.advance(25_000);
      return inner(...args);
    };

    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      deps,
    )) as Record<string, any>;

    // ① 예외가 아니라 결과가 돌아온다
    expect(r['summary']).toBeDefined();
    // ② 잘렸다는 사실이 최상위에 드러난다 (요약·coverage·caveat·notes 네 곳)
    expect(r['summary'].time_budget_truncated).toBe(true);
    expect(r['summary'].time_budget_skipped.companies_not_searched).toBe(1);
    expect(r['coverage'].not_examined_due_to_time_budget).toBeDefined();
    // 맨 앞은 **아직 온전하지 않다**(작업 5 이어보기), 그 다음이 시간 예산 잘림이다 —
    // 순서가 중요하다: 이어서 부르면 된다는 사실을 먼저 알아야 부분 결과를 오독하지 않는다.
    expect(String(r['scope_caveats'][0])).toContain('아직 온전하지 않습니다');
    expect(String(r['scope_caveats'][1])).toContain('범위 자체가 잘렸습니다');
    expect((r['notes'] as string[]).some((n) => n.includes('시간 예산으로 중단된 부분 결과'))).toBe(
      true,
    );

    const b = r['diagnostics'].budget;
    expect(b.expired).toBe(true);
    expect(b.stopped_at).toBe('j001_search');
    expect(b.truncated).toBe(true);
    expect(b.budget_ms).toBe(50_000);
    expect(b.elapsed_ms).toBe(50_000);
    expect(b.stages.j001_search).toBe(50_000);

    // ⑤ 남은 예산이 임계 미만이면 **새 상류 호출을 시작하지 않는다** — 3개사 중 2개사만 검색
    expect(calls.filter((x) => x.ty === 'J001')).toHaveLength(2);

    // ③ 이미 만든 판정은 보존된다 — 먼저 본 회사의 후보도, 검색이 필요 없던 기준 미달도
    expect(r['summary'].undisclosed_candidates).toBe(1);
    expect(r['undisclosed_candidates'][0].company).toBe('에이사(주)');
    expect(r['summary'].below_threshold).toBe(1);
    expect(r['below_threshold'][0].company).toBe('디사(주)');

    // 못 본 회사는 "공시 없음"이 아니라 **미판정**이다
    const notJudged = r['not_judged'] as Array<Record<string, any>>;
    const skipped = notJudged.find((x) => x['company'] === '비사(주)')!;
    expect(skipped['status']).toBe('not_judged');
    expect(String(skipped['reason'])).toContain('time_budget_exceeded');
    // 재실행 안내는 **참인 것만** 쓴다 — 이제 이어보기 토큰으로 이 회사부터 이어서 본다
    // (종전 문구 "다시 실행해도 처음부터"는 작업 5 로 거짓이 됐다)
    expect(String(skipped['reason'])).toContain('continuation.token');
    expect(String(skipped['reason'])).not.toContain('처음부터');
  });

  it('예산 안에 완주하면 잘림 표시도 caveat 도 붙지 않는다 (불필요한 경고는 진짜 경고를 묻는다)', async () => {
    const c = fakeClock();
    const calls: CallLog[] = [];
    const deps = makeDeps({ markdown: MD, corps: CORPS, j001: [], calls, now: c.now });
    const inner = deps.collectList;
    deps.collectList = async (...args) => {
      c.advance(1_000); // 회사당 1초 — 3개사 전부 여유
      return inner(...args);
    };

    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      deps,
    )) as Record<string, any>;

    expect(calls.filter((x) => x.ty === 'J001')).toHaveLength(3);
    expect(r['summary'].time_budget_truncated).toBeUndefined();
    expect(r['coverage'].not_examined_due_to_time_budget).toBeUndefined();
    expect(r['diagnostics'].budget.expired).toBe(false);
    expect(r['diagnostics'].budget.stopped_at).toBeNull();
    expect(r['diagnostics'].budget.truncated).toBe(false);
    expect((r['scope_caveats'] as string[]).some((x) => x.includes('범위 자체가 잘렸습니다'))).toBe(
      false,
    );
    expect((r['notes'] as string[]).some((n) => n.includes('시간 예산'))).toBe(false);

    // 계측 — 어느 구간이 예산을 먹는지 실물에서 보려면 단계가 전부 잡혀야 한다
    expect(Object.keys(r['diagnostics'].budget.stages).sort()).toEqual([
      'aggregate',
      'j001_search',
      'judge',
      'parse',
      'population',
      'source_document',
      'threshold_join',
    ]);
    // 이 실행에서 시간을 쓴 곳은 목록 수집(3개사 × 1초)뿐이다
    expect(r['diagnostics'].budget.stages.j001_search).toBe(3_000);
    expect(r['diagnostics'].budget.elapsed_ms).toBe(3_000);
  });

  it('예산이 끊기면 J001 원문을 새로 열지 않는다 — 보류로 남기고 사유를 시간으로 밝힌다', async () => {
    const c = fakeClock();
    const docCalls: string[] = [];
    const deps = makeDeps({
      markdown: MD,
      corps: CORPS,
      j001: (corpCode: string) =>
        corpCode === '00111111'
          ? [
              disc({
                corp_code: '00111111',
                report_nm: '대규모내부거래관련이사회의결및공시(자금차입)',
                rcept_no: '20250210000123',
                rcept_dt: '20250210',
              }),
            ]
          : [],
      docs: { '20250210000123': doc80718('씨사(주)') },
      // 캐시에 없는 원문이라 콜이 나간다 — 시간 예산 대상이다
      cachedDocs: new Set<string>(),
      docCalls,
      now: c.now,
    });
    const inner = deps.collectList;
    deps.collectList = async (...args) => {
      c.advance(49_000); // 남은 1초 — 소형 호출 임계(1.5초)에도 못 미친다
      return inner(...args);
    };

    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      deps,
    )) as Record<string, any>;

    // 원천 J004 는 예산이 넉넉할 때 읽었고, J001 원문은 열지 않았다
    expect(docCalls).toContain('20260601001646');
    expect(docCalls).not.toContain('20250210000123');
    expect(r['diagnostics'].filing_docs.over_deadline).toBe(1);

    const notJudged = r['not_judged'] as Array<Record<string, any>>;
    const a = notJudged.find((x) => x['company'] === '에이사(주)')!;
    expect(String(a['reason'])).toContain('type_filing_present_counterparty_unconfirmed');
    expect(String(a['reason'])).toContain('시간 예산');
    expect(a['matching_filings'][0].doc_read).toBe('deadline_exceeded');
    // 상대방을 확인하지 못했으므로 "공시 존재"로 올리지 않는다 (거짓 안심 금지)
    expect(r['summary'].j001_filing_near_date).toBe(0);
  });

  it('예산이 없으면 자동 워밍이 기업개황을 부르지 않는다 — 시도하지 않은 이름은 다음 실행이 채운다', async () => {
    const c = fakeClock();
    const jurirCalls: string[] = [];
    const pop: Population = {
      corpCodes: new Map([['00111111', '에이사(주)']]),
      group: { representative_company: '에이사(주)' },
      unjoined: ['씨사(주)'],
      jurirNoByName: new Map([['씨사', '1101110033333']]),
    };
    const deps = makeDeps({
      markdown: MD,
      corps: CORPS,
      pop,
      j001: [],
      jurir: { '00333333': { status: 'ok', jurirNo: '1101110033333' } },
      jurirCalls,
      now: c.now,
    });
    const innerDoc = deps.loadDoc;
    // 원천 문서를 읽는 데 55초가 걸린 상황 — 워밍은 시작하지 않아야 한다
    deps.loadDoc = async (rceptNo) => {
      c.advance(55_000);
      return innerDoc(rceptNo);
    };

    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      deps,
    )) as Record<string, any>;

    const warming = r['diagnostics'].population.warming;
    expect(warming.over_deadline).toBe(true);
    expect(warming.skipped_deadline).toBe(1);
    expect(warming.lookups).toBe(0);
    expect(jurirCalls).toHaveLength(0); // 기업개황 콜이 나가지 않았다
    expect(warming.skipped[0].reason).toBe('deadline');
    expect(r['diagnostics'].budget.stopped_at).toBe('warming');
    expect((r['notes'] as string[]).some((n) => n.includes('법인등록번호를 대조하지 못했습니다'))).toBe(
      true,
    );
  });
});


/**
 * ★ 시간 예산 env override (`GONGSI_TIME_BUDGET_MS`)
 *
 * 도구 **입력**으로는 열지 않았다(60초 벽은 클라이언트의 성질이다). 대신 환경변수로
 * **낮추는 것만** 허용해 "예산이 끊겼을 때 부분 결과가 정직하게 나오는가"를 실물에서
 * 재현할 수 있게 했다. 여기서 보는 것은 **적용값이 그대로 진단·문구에 드러나는가**다 —
 * 안내 문구가 "50초"라고 말하는데 실제는 8초였다면 사용자가 부분 결과를 재현할 수 없다.
 */
describe('시간 예산 env override — GONGSI_TIME_BUDGET_MS', () => {
  const MD = [
    '| 기업집단명 : | 테스트집단 |',
    '| --- | --- |',
    '## (2) 회사 재무현황',
    '| (단위 : 백만원, %) |',
    '| --- |',
    '| 계열회사명 |  | 자본금 | 자본총계 |',
    '| --- | --- | --- | --- |',
    '| 비금융회사 | 에이사(주) | 1,000 | 20,000 |',
    '| 비금융회사 | 씨사(주) | 1,000 | 20,000 |',
    '## (1) 계열회사간 자금거래 현황',
    '가. 일반 차입',
    '| (단위 : 백만원) |',
    '| --- |',
    '| 차입회사 (소속회사) |  | 거래상대방 | 차입금액 | 차입일 |',
    '| --- | --- | --- | --- | --- |',
    '| 비금융회사 | 에이사(주) | 씨사(주) | 16,000 | 2025-02-19 |',
  ].join('\n');

  const CORPS = {
    에이사: [{ corpCode: '00111111', corpName: '에이사' }],
    씨사: [{ corpCode: '00333333', corpName: '씨사' }],
  };

  function fakeClock(): { now: () => number; advance: (ms: number) => void } {
    let t = 1_700_000_000_000;
    return { now: () => t, advance: (ms) => void (t += ms) };
  }

  async function runWithBudgetEnv(value: string | undefined): Promise<Record<string, any>> {
    if (value === undefined) delete process.env['GONGSI_TIME_BUDGET_MS'];
    else process.env['GONGSI_TIME_BUDGET_MS'] = value;
    __resetConfig();
    const c = fakeClock();
    const deps = makeDeps({ markdown: MD, corps: CORPS, j001: [], now: c.now });
    const inner = deps.collectList;
    // 목록 수집 1회 = 30초. 기본 50초이면 둘 다 보고, 8초로 낮추면 첫 건에서 끊긴다.
    deps.collectList = async (...args) => {
      c.advance(30_000);
      return inner(...args);
    };
    return (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      deps,
    )) as Record<string, any>;
  }

  afterEach(() => {
    delete process.env['GONGSI_TIME_BUDGET_MS'];
    __resetConfig();
  });

  it('env 없으면 기본 50초/준비 20초 · budget_source=default', async () => {
    const b = (await runWithBudgetEnv(undefined))['diagnostics'].budget;
    expect(b.budget_ms).toBe(50_000);
    expect(b.prep_budget_ms).toBe(20_000);
    expect(b.budget_source).toBe('default');
  });

  it('★ env=8000 이면 8초가 적용되고 준비 예산은 40% 비율을 유지한다 (3,200ms)', async () => {
    const r = await runWithBudgetEnv('8000');
    const b = r['diagnostics'].budget;
    expect(b.budget_ms).toBe(8_000);
    expect(b.prep_budget_ms).toBe(3_200);
    expect(b.budget_source).toBe('env');
    // 실제로 끊겼고, 부분 결과가 그 사실을 드러낸다
    expect(b.expired).toBe(true);
    expect(r['summary'].time_budget_truncated).toBe(true);
  });

  it('★ 안내 문구는 상수가 아니라 **실제 적용값**을 말한다 — "8초"이지 "50초"이 아니다', async () => {
    const r = await runWithBudgetEnv('8000');
    const all = [...(r['notes'] as string[]), ...(r['scope_caveats'] as string[])].join('\n');
    expect(all).toContain('8초');
    expect(all).not.toContain('50초');
  });

  it('env 값은 config 가 가두어 들어온다 — 90000 은 50초, 1000 은 5초', async () => {
    expect((await runWithBudgetEnv('90000'))['diagnostics'].budget.budget_ms).toBe(50_000);
    const low = (await runWithBudgetEnv('1000'))['diagnostics'].budget;
    expect(low.budget_ms).toBe(5_000);
    // 준비 예산 2,000ms ≥ MIN_SMALL_CALL_MS(1,500) — 하한을 5초로 잡은 이유다
    expect(low.prep_budget_ms).toBe(2_000);
  });

  it('숨자가 아니면 기본값을 쓴다 (budget_source=default)', async () => {
    const b = (await runWithBudgetEnv('abc'))['diagnostics'].budget;
    expect(b.budget_ms).toBe(50_000);
    expect(b.budget_source).toBe('default');
  });
});


/**
 * ★ 이어보기(continuation) — 한 번에 끝나지 않는 점검을 **여러 호출로 온전하게** 끝낸다 (작업 5)
 *
 * 이 장치가 지켜야 할 약속은 하나다: **이어서 부른 마지막 결과가 한 번에 완주한 결과와 같다.**
 * 다르면 이어보기는 쓸 수 없다 — 사용자에게는 어느 쪽이 맞는지 가릴 방법이 없기 때문이다.
 * 그래서 이 블록의 중심은 ③(두 경로 1:1 대조)이고, 나머지는 그 약속을 떠받치는 방어선이다:
 * 토큰 없는 호출은 캐시를 읽지 않는다(설계 불변식 "공시 목록 미캐시") / 어긋난 토큰은 관대하게
 * 무시하지 않고 거절한다 / 제자리걸음이면 그렇다고 말한다.
 *
 * 시간 의존은 전부 **주입 시계**로 만든다 (실제 sleep 없음).
 */
describe('이어보기 — 여러 호출로 온전한 답 (작업 5)', () => {
  /** 손으로 굴리는 시계 — 실제 sleep 없이 예산을 소진시킨다 */
  function fakeClock(startAt = 1_700_000_000_000): {
    now: () => number;
    advance: (ms: number) => void;
  } {
    let t = startAt;
    return { now: () => t, advance: (ms) => void (t += ms) };
  }

  interface Loan {
    borrower: string;
    lender: string;
    /** 백만원 */
    amount: number;
    date: string;
  }

  /** 백만원 정수를 표 표기(천단위 쉼표)로 */
  const thousands = (n: number): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  /**
   * 차입 표 하나짜리 J004 문서를 만든다.
   *
   * ★ J001 검색 대상은 **차입회사 + 대여회사 둘 다**다 — 거래 한 건에 공시의무자가 둘이고
   *   기준금액을 각자의 자본으로 계산하기 때문이다. 그래서 검색 대상 수를 늘리려면 차입 행을
   *   늘리면 된다. 금액은 전부 100억 이상이라 자본과 무관하게 기준 초과가 확정된다.
   */
  function makeMd(loans: Loan[]): string {
    const names = [...new Set(loans.flatMap((l) => [l.borrower, l.lender]))];
    return [
      '| 기업집단명 : | 테스트집단 |',
      '| --- | --- |',
      '## (2) 회사 재무현황',
      '| (단위 : 백만원, %) |',
      '| --- |',
      '| 계열회사명 |  | 자본금 | 자본총계 |',
      '| --- | --- | --- | --- |',
      ...names.map((n) => `| 비금융회사 | ${n} | 1,000 | 20,000 |`),
      '## (1) 계열회사간 자금거래 현황',
      '가. 일반 차입',
      '| (단위 : 백만원) |',
      '| --- |',
      '| 차입회사 (소속회사) |  | 거래상대방 | 차입금액 | 차입일 |',
      '| --- | --- | --- | --- | --- |',
      ...loans.map(
        (l) => `| 비금융회사 | ${l.borrower} | ${l.lender} | ${thousands(l.amount)} | ${l.date} |`,
      ),
    ].join('\n');
  }

  function corpsOf(codes: Record<string, string>): Record<
    string,
    Array<{ corpCode: string; corpName: string }>
  > {
    return Object.fromEntries(
      Object.entries(codes).map(([name, corpCode]) => [name, [{ corpCode, corpName: name }]]),
    );
  }

  const BASE = { rcept_no: '20260601001646', today: '20260827' };
  /** kv 에 남은 이어보기 키만 (다른 키와 섞이지 않게) */
  const contKeys = (kv: Map<string, string>): string[] =>
    [...kv.keys()].filter((k) => k.startsWith('cont:')).sort();

  /* ── 검색 대상 3개사 ─────────────────────────────────────────────────────────
   * 에이사(160억 차입) → 씨사(160억, 대여회사 관점) → 비사(120억 차입) 순으로 돈다
   * (금액 상위부터, 동액이면 먼저 발견된 순). 이 순서가 매 호출 같아야 이어보기가 성립한다.
   */
  const CODE3 = { 에이사: '10000001', 비사: '10000002', 씨사: '10000003' };
  const CORPS3 = corpsOf(CODE3);
  const MD3 = makeMd([
    { borrower: '에이사(주)', lender: '씨사(주)', amount: 16_000, date: '2025-02-19' },
    { borrower: '비사(주)', lender: '씨사(주)', amount: 12_000, date: '2025-06-30' },
  ]);
  /** 에이사만 자금차입 J001 이 있다 — 원문 상대방까지 맞아 '공시 존재(근접)'가 된다 */
  const J001_3 = (corpCode: string): Disclosure[] =>
    corpCode === CODE3.에이사
      ? [
          disc({
            corp_code: CODE3.에이사,
            report_nm: '대규모내부거래관련이사회의결및공시(자금차입)',
            rcept_no: '20250210000123',
            rcept_dt: '20250210',
          }),
        ]
      : [];
  const DOCS3 = { '20250210000123': doc80718('씨사(주)') };

  /** 3개사 픽스처로 deps 를 만들고 목록 수집 1회당 `perCallMs` 를 태운다 */
  function deps3(opts: {
    kv: Map<string, string>;
    calls?: CallLog[];
    kvGets?: string[];
    now: () => number;
    advance: (ms: number) => void;
    perCallMs: number;
  }): DetectDeps {
    const d = makeDeps({
      markdown: MD3,
      corps: CORPS3,
      j001: J001_3,
      docs: DOCS3,
      ...(opts.calls ? { calls: opts.calls } : {}),
      ...(opts.kvGets ? { kvGets: opts.kvGets } : {}),
      kv: opts.kv,
      now: opts.now,
    });
    const inner = d.collectList;
    d.collectList = async (...args) => {
      opts.advance(opts.perCallMs);
      return inner(...args);
    };
    return d;
  }

  const j001Calls = (calls: CallLog[]): CallLog[] => calls.filter((x) => x.ty === 'J001');

  /**
   * 시간 예산으로 잘린 1회차를 만들어 토큰을 받는다 (3개사 중 2개사만 검색).
   * 회사당 24초 × 2 = 48초 → 3번째는 목록 수집 임계(3초)에 못 미쳐 시작하지 못한다.
   */
  async function truncatedFirstCall(kv: Map<string, string>): Promise<{
    result: Record<string, any>;
    token: string;
    calls: CallLog[];
  }> {
    const c = fakeClock();
    const calls: CallLog[] = [];
    const deps = deps3({ kv, calls, now: c.now, advance: c.advance, perCallMs: 24_000 });
    const result = (await detectUndisclosedTransactions(BASE, deps)) as Record<string, any>;
    return { result, token: result['continuation'].token as string, calls };
  }

  /* ────────────────────────────── 1 ────────────────────────────── */

  it('토큰 없이 완주하면 이어보기 흔적이 남지 않는다 — complete:true · 토큰 없음 · 저장소에 cont: 키 0개', async () => {
    const c = fakeClock();
    const kv = new Map<string, string>();
    const calls: CallLog[] = [];
    const deps = deps3({ kv, calls, now: c.now, advance: c.advance, perCallMs: 1_000 });

    const r = (await detectUndisclosedTransactions(BASE, deps)) as Record<string, any>;

    expect(j001Calls(calls)).toHaveLength(3);
    const cont = r['continuation'];
    expect(cont.complete).toBe(true);
    expect(cont.token).toBeUndefined();
    expect(cont.expires_at).toBeUndefined();
    expect(cont.call_index).toBe(1);
    expect(cont.incomplete_reasons).toEqual([]);
    expect(cont.progress.companies_to_search_total).toBe(3);
    expect(cont.progress.companies_searched_cumulative).toBe(3);
    expect(cont.progress.companies_remaining).toBe(0);
    expect(String(cont.next_step)).toContain('온전한 답');
    // summary 에도 같은 값이 있어야 한다 — 요약만 보는 독자가 부분 결과를 완주로 읽으면 안 된다
    expect(r['summary'].complete).toBe(true);
    // ★ 완주한 첫 호출은 저장소를 **건드리지 않는다** (종전과 동일한 동작·동일한 저장소 상태)
    expect(contKeys(kv)).toEqual([]);
    // 완주했으니 미완주 경고도 붙지 않는다
    expect((r['scope_caveats'] as string[]).some((x) => x.includes('아직 온전하지 않습니다'))).toBe(
      false,
    );
  });

  /* ────────────────────────────── 2 ────────────────────────────── */

  it('시간 예산으로 잘리면 토큰을 발급하고 **온전히 받은 목록만** 저장한다 (실패·부분 수집은 다음 호출이 다시 시도한다)', async () => {
    /* 검색 대상 5개사: 에이사(160억) → 씨사(160억 대여) → 비사(120억) → 이사(110억) →
     * 에프사(110억 대여). 회사당 15초라 4개사에서 예산(50초)이 마르고 5번째는 시작하지 못한다.
     * 씨사는 상류 오류, 비사는 부분 수집 — 둘 다 캐시에 넣으면 안 되는 결과다. */
    const CODE5 = {
      에이사: '10000001',
      비사: '10000002',
      씨사: '10000003',
      이사: '10000004',
      에프사: '10000005',
    };
    const MD5 = makeMd([
      { borrower: '에이사(주)', lender: '씨사(주)', amount: 16_000, date: '2025-02-19' },
      { borrower: '비사(주)', lender: '씨사(주)', amount: 12_000, date: '2025-06-30' },
      { borrower: '이사(주)', lender: '에프사(주)', amount: 11_000, date: '2025-08-11' },
    ]);
    const c = fakeClock();
    const kv = new Map<string, string>();
    const calls: CallLog[] = [];
    const deps = makeDeps({ markdown: MD5, corps: corpsOf(CODE5), j001: [], kv, now: c.now });
    deps.collectList = async (corpCode, ty, from, to) => {
      calls.push({ corpCode, ty, from, to });
      c.advance(15_000);
      if (corpCode === CODE5.씨사) throw new Error('상류 오류 (테스트)');
      return batch([], corpCode === CODE5.비사);
    };

    const r = (await detectUndisclosedTransactions(BASE, deps)) as Record<string, any>;

    // 4개사까지 시도하고 5번째(에프사)는 시작조차 못 했다
    expect(j001Calls(calls).map((x) => x.corpCode)).toEqual([
      CODE5.에이사,
      CODE5.씨사,
      CODE5.비사,
      CODE5.이사,
    ]);
    const cont = r['continuation'];
    expect(cont.complete).toBe(false);
    expect(r['summary'].complete).toBe(false);
    const token = cont.token as string;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(cont.incomplete_reasons).toContain('companies_over_time_budget');
    expect(cont.progress.companies_to_search_total).toBe(5);
    expect(cont.expires_at).toBeDefined();

    // ★ 저장된 것은 meta + **온전히 받은 두 회사**뿐이다.
    //   씨사(오류)·비사(부분 수집)를 캐시에 굳히면 다음 호출이 그 누락을 물려받아 재시도할
    //   기회가 영영 사라진다. 에프사는 아예 검색하지 않았으니 저장할 것이 없다.
    expect(contKeys(kv)).toEqual(
      [`cont:${token}:meta`, `cont:${token}:s:에이사`, `cont:${token}:s:이사`].sort(),
    );
    const meta = JSON.parse(kv.get(`cont:${token}:meta`)!) as Record<string, unknown>;
    expect(meta['rcept_no']).toBe(BASE.rcept_no);
    expect(meta['today']).toBe(BASE.today);
    expect(meta['calls']).toBe(1);
    // 토큰에는 판정 결과가 실리지 않는다 — 불투명한 실행 ID 하나다
    expect(Object.keys(meta).sort()).toEqual(
      ['calls', 'created_at', 'fiscal_year', 'rcept_no', 'today'].sort(),
    );
  });

  /* ────────────────────────────── 3 (핵심) ────────────────────────────── */

  it('★ 이어서 부른 마지막 결과 = 한 번에 완주한 결과 (판정이 달라지면 이어보기는 쓸 수 없다)', async () => {
    // ① 한 번에 완주 — 회사당 1초라 3개사를 전부 본다
    const cA = fakeClock();
    const callsA: CallLog[] = [];
    const once = (await detectUndisclosedTransactions(
      BASE,
      deps3({
        kv: new Map(),
        calls: callsA,
        now: cA.now,
        advance: cA.advance,
        perCallMs: 1_000,
      }),
    )) as Record<string, any>;
    expect(j001Calls(callsA)).toHaveLength(3);
    expect(once['continuation'].complete).toBe(true);

    // ② 예산을 좁혀 두 번에 나눠 부른다 — 1회차는 2개사에서 끊긴다
    const kv = new Map<string, string>();
    const first = await truncatedFirstCall(kv);
    expect(first.result['continuation'].complete).toBe(false);
    expect(j001Calls(first.calls).map((x) => x.corpCode)).toEqual([CODE3.에이사, CODE3.씨사]);
    expect(contKeys(kv)).toEqual(
      [`cont:${first.token}:meta`, `cont:${first.token}:s:에이사`, `cont:${first.token}:s:씨사`].sort(),
    );

    // ③ 같은 인자 + 토큰으로 이어 부른다 (시계는 새로 — 새 호출이니 예산도 새것이다)
    const cB = fakeClock();
    const callsB: CallLog[] = [];
    const resumed = (await detectUndisclosedTransactions(
      { ...BASE, continuation_token: first.token },
      deps3({ kv, calls: callsB, now: cB.now, advance: cB.advance, perCallMs: 1_000 }),
    )) as Record<string, any>;

    // 캐시에 있던 두 회사는 목록을 **다시 받지 않는다** — 그러지 않으면 예산만 쓰고 진전이 없다
    expect(j001Calls(callsB).map((x) => x.corpCode)).toEqual([CODE3.비사]);
    const cont = resumed['continuation'];
    expect(cont.complete).toBe(true);
    expect(cont.token).toBeUndefined();
    expect(cont.call_index).toBe(2);
    expect(cont.progress.companies_reused_from_token).toBe(2);
    expect(cont.progress.companies_searched_this_call).toBe(1);
    expect(cont.progress.companies_searched_cumulative).toBe(3);
    expect(cont.progress.companies_remaining).toBe(0);

    // ★★ 판정이 1:1 로 같다 — 이 블록 전체가 지키려는 단 하나의 약속이다
    expect(resumed['summary']).toEqual(once['summary']);
    expect(resumed['undisclosed_candidates']).toEqual(once['undisclosed_candidates']);
    expect(resumed['below_threshold']).toEqual(once['below_threshold']);
    expect(resumed['not_judged'] ?? null).toEqual(once['not_judged'] ?? null);
    expect(resumed['goods_services_signals']).toEqual(once['goods_services_signals']);
    expect(resumed['join_failures'] ?? null).toEqual(once['join_failures'] ?? null);
    expect(resumed['coverage']).toEqual(once['coverage']);
    // 캐시에서 되살린 목록이 진짜로 판정에 쓰였다 — 에이사의 '공시 존재(근접)'는 1회차가 받은
    // 목록에서만 나온다 (2회차는 에이사를 조회하지 않았다)
    expect(once['summary'].j001_filing_near_date).toBe(1);

    // 완주했으니 이 토큰의 키는 전부 거둬진다 (다시 쓸 수 없다 — 아래 5번이 그것도 본다)
    expect(contKeys(kv)).toEqual([]);
  });

  /* ────────────────────────────── 4 ────────────────────────────── */

  it('건수 상한(20개사)은 "이 도구가 볼 수 있는 회사 수"가 아니라 **한 호출에서 새로 볼 회사 수**다 — 25개사가 두 번에 끝난다', async () => {
    /* 차입회사 24 + 공통 대여회사 1 = 검색 대상 25개사.
     * 금액을 100씩 낮춰 순서를 못 박는다 (동액이면 발견 순서에 기대게 된다). */
    const loans: Loan[] = [...Array(24)].map((_, i) => ({
      borrower: `가사${String(i + 1).padStart(2, '0')}(주)`,
      lender: '엘사(주)',
      amount: 16_000 - i * 100,
      date: '2025-02-19',
    }));
    const MD25 = makeMd(loans);
    const CODE25: Record<string, string> = {
      ...Object.fromEntries(
        loans.map((l, i) => [normalizeCompanyName(l.borrower), String(20_000_001 + i)]),
      ),
      엘사: '29999999',
    };
    const CORPS25 = corpsOf(CODE25);

    const kv = new Map<string, string>();
    const c1 = fakeClock();
    const calls1: CallLog[] = [];
    const d1 = makeDeps({
      markdown: MD25,
      corps: CORPS25,
      j001: [],
      calls: calls1,
      kv,
      now: c1.now,
    });
    const inner1 = d1.collectList;
    d1.collectList = async (...args) => {
      c1.advance(100); // 시간은 넉넉하다 — 여기서 끊는 것은 **건수** 상한이다
      return inner1(...args);
    };

    const r1 = (await detectUndisclosedTransactions(BASE, d1)) as Record<string, any>;

    expect(j001Calls(calls1)).toHaveLength(20);
    expect(r1['diagnostics'].budget.truncated).toBe(false); // 시간 때문이 아니다
    expect(r1['continuation'].complete).toBe(false);
    expect(r1['continuation'].incomplete_reasons).toContain('companies_over_count_budget');
    expect(r1['continuation'].progress.companies_to_search_total).toBe(25);
    expect(r1['continuation'].progress.companies_searched_this_call).toBe(20);
    expect(r1['continuation'].progress.companies_remaining).toBe(5);
    // 토큰 없이 한 번만 부르고 마는 사용자에게는 **종전과 같은** 미판정 어휘가 남는다
    const overflow = (r1['not_judged'] as Array<Record<string, any>>).filter((x) =>
      String(x['reason']).startsWith('company_budget_exceeded'),
    );
    expect(overflow).toHaveLength(5);
    expect(String(overflow[0]!['reason'])).toContain('continuation.token');

    const token = r1['continuation'].token as string;
    expect(contKeys(kv)).toHaveLength(21); // meta 1 + 검색 성공 20

    // 2회차 — 캐시 20개사는 콜 없이, 남은 5개사만 새로 본다
    const c2 = fakeClock();
    const calls2: CallLog[] = [];
    const d2 = makeDeps({
      markdown: MD25,
      corps: CORPS25,
      j001: [],
      calls: calls2,
      kv,
      now: c2.now,
    });
    const r2 = (await detectUndisclosedTransactions(
      { ...BASE, continuation_token: token },
      d2,
    )) as Record<string, any>;

    expect(j001Calls(calls2)).toHaveLength(5);
    expect(r2['continuation'].complete).toBe(true);
    expect(r2['continuation'].call_index).toBe(2);
    expect(r2['continuation'].progress.companies_reused_from_token).toBe(20);
    expect(r2['continuation'].progress.companies_searched_this_call).toBe(5);
    expect(r2['continuation'].progress.companies_remaining).toBe(0);
    expect(r2['summary'].complete).toBe(true);
    // 1회차에 미판정으로 남았던 5개사가 이번엔 전부 판정됐다
    expect((r2['not_judged'] ?? []) as unknown[]).toHaveLength(0);
    expect(r2['summary'].undisclosed_candidates).toBe(24);
    expect(contKeys(kv)).toEqual([]);
  });

  /* ────────────────────────────── 5 ────────────────────────────── */

  describe('어긋난 토큰은 거절한다 — 관대하게 무시하면 영원히 1번 회사부터 돈다', () => {
    it('그런 토큰이 없으면 continuation_invalid', async () => {
      const c = fakeClock();
      const deps = deps3({
        kv: new Map(),
        now: c.now,
        advance: c.advance,
        perCallMs: 1_000,
      });
      await expect(
        detectUndisclosedTransactions({ ...BASE, continuation_token: '0'.repeat(32) }, deps),
      ).rejects.toMatchObject({ code: 'continuation_invalid' });
    });

    it('수명 6시간을 넘긴 토큰은 거절하고 **그 자리에서 거둔다** (죽은 키를 남기지 않는다)', async () => {
      const kv = new Map<string, string>();
      const { token } = await truncatedFirstCall(kv);
      const createdAt = Date.parse(
        (JSON.parse(kv.get(`cont:${token}:meta`)!) as { created_at: string }).created_at,
      );
      // 발급 시각 + 6시간 + 1ms
      const c = fakeClock(createdAt + 6 * 60 * 60 * 1000 + 1);
      const deps = deps3({ kv, now: c.now, advance: c.advance, perCallMs: 1_000 });

      await expect(
        detectUndisclosedTransactions({ ...BASE, continuation_token: token }, deps),
      ).rejects.toMatchObject({ code: 'continuation_invalid' });
      expect(contKeys(kv)).toEqual([]);
    });

    it('rcept_no 가 바뀌면 거절한다 — 다른 문서의 캐시를 섞어 쓰면 판정이 뒤섞인다', async () => {
      const kv = new Map<string, string>();
      const { token } = await truncatedFirstCall(kv);
      const c = fakeClock();
      const deps = deps3({ kv, now: c.now, advance: c.advance, perCallMs: 1_000 });

      await expect(
        detectUndisclosedTransactions(
          { rcept_no: '20260601001647', today: BASE.today, continuation_token: token },
          deps,
        ),
      ).rejects.toMatchObject({ code: 'continuation_invalid' });
      // 이 토큰은 아직 살아 있다 — 올바른 인자로 다시 부르면 쓸 수 있다
      expect(contKeys(kv).length).toBeGreaterThan(0);
    });

    it('today 가 바뀌면 거절한다 — 검색창 상한이 밀리면 앞 호출과 같은 실행이 아니다', async () => {
      const kv = new Map<string, string>();
      const { token } = await truncatedFirstCall(kv);
      const c = fakeClock();
      const deps = deps3({ kv, now: c.now, advance: c.advance, perCallMs: 1_000 });

      await expect(
        detectUndisclosedTransactions(
          { ...BASE, today: '20260828', continuation_token: token },
          deps,
        ),
      ).rejects.toMatchObject({ code: 'continuation_invalid' });
    });

    it('today 를 생략하면 앞 호출의 기준일을 그대로 이어받는다 (시스템 날짜로 다시 잡지 않는다)', async () => {
      const kv = new Map<string, string>();
      const { token } = await truncatedFirstCall(kv);
      const c = fakeClock();
      const deps = deps3({ kv, now: c.now, advance: c.advance, perCallMs: 1_000 });

      const r = (await detectUndisclosedTransactions(
        { rcept_no: BASE.rcept_no, continuation_token: token },
        deps,
      )) as Record<string, any>;

      expect(r['scope'].judged_at).toBe(BASE.today);
      expect(r['continuation'].complete).toBe(true);
    });

    it('토큰 형식(32자리 16진수)은 입력 스키마가 막는다 — 아무 문자열이나 저장소 키가 되지 않는다', () => {
      const bad = detectUndisclosedTransactionsInput.safeParse({
        rcept_no: BASE.rcept_no,
        continuation_token: 'not-a-token',
      });
      expect(bad.success).toBe(false);
      const good = detectUndisclosedTransactionsInput.safeParse({
        rcept_no: BASE.rcept_no,
        continuation_token: 'a'.repeat(32),
      });
      expect(good.success).toBe(true);
    });
  });

  /* ────────────────────────────── 6 ────────────────────────────── */

  it('제자리걸음이면 stalled 로 알린다 — 새 검색 0·새 원문 0인데 미완주면 더 불러도 같은 자리다', async () => {
    const kv = new Map<string, string>();
    const { token } = await truncatedFirstCall(kv);

    // 2회차: 원천 문서를 읽는 데 예산을 다 써 버린 상황 — 캐시 2개사는 되살리지만
    // 남은 1개사는 검색을 시작하지 못한다. 진전이 0이므로 반복해도 소용이 없다.
    const c = fakeClock();
    const deps = deps3({ kv, now: c.now, advance: c.advance, perCallMs: 1_000 });
    const innerDoc = deps.loadDoc;
    deps.loadDoc = async (rceptNo) => {
      if (rceptNo === BASE.rcept_no) c.advance(55_000);
      return innerDoc(rceptNo);
    };

    const r = (await detectUndisclosedTransactions(
      { ...BASE, continuation_token: token },
      deps,
    )) as Record<string, any>;

    const cont = r['continuation'];
    expect(cont.complete).toBe(false);
    expect(cont.stalled).toBe(true);
    expect(cont.token).toBe(token); // 같은 실행이 이어진다 — 새 토큰을 만들지 않는다
    expect(cont.call_index).toBe(2);
    expect(cont.progress.companies_searched_this_call).toBe(0);
    expect(cont.progress.companies_reused_from_token).toBe(2);
    expect(cont.progress.filing_docs_fetched_this_call).toBe(0);

    // 미완주 안내가 notes 맨 앞에 오고, 그 안에 개별 조회 권고가 붙는다
    const firstNote = String((r['notes'] as string[])[0]);
    expect(firstNote).toContain('아직 온전한 답이 아닙니다');
    expect(firstNote).toContain('새로 검색한 회사도 새로 연 원문도 0건');
    expect(firstNote).toContain('search_disclosures');
  });

  it('★ 매번 같은 이유로 실패하는 회사가 있으면 stalled 로 알린다 (시도가 아니라 성공을 세야 잡힌다)', async () => {
    /* 이어보기가 끝나지 않는 가장 나쁜 모양: 한 회사의 검색이 **매 호출 같은 이유로** 실패한다.
     * 나머지는 캐시에서 되살아나므로 2회차부터는 카운터가 완전히 같은 채로 반복된다.
     * `newSearchesPerformed` 가 시도를 세면 이 실행은 "진전 중"으로 보여 complete:false 인 채
     * stalled 이 영원히 false 다 — 도구는 "다시 호출하세요"만 반복하고 사용자는 갇힌다. */
    const failing = (kv: Map<string, string>, calls: CallLog[]): DetectDeps => {
      const c = fakeClock();
      const d = deps3({ kv, calls, now: c.now, advance: c.advance, perCallMs: 1_000 });
      const inner = d.collectList;
      d.collectList = async (corpCode, ty, from, to) => {
        if (corpCode === CODE3.비사) {
          calls.push({ corpCode, ty, from, to }); // 시도는 했다 — 기록에 남긴다
          throw new ToolError('deadline_exceeded', '이 회사는 늘 같은 이유로 실패한다 (테스트)');
        }
        return inner(corpCode, ty, from, to);
      };
      return d;
    };

    const kv = new Map<string, string>();

    // 1회차 — 두 회사는 받았고 한 회사만 실패했다. **진전이 있었으므로 stalled 이 아니다.**
    const calls1: CallLog[] = [];
    const r1 = (await detectUndisclosedTransactions(BASE, failing(kv, calls1))) as Record<
      string,
      any
    >;
    expect(r1['continuation'].complete).toBe(false);
    expect(r1['continuation'].stalled).toBeUndefined();
    expect(r1['continuation'].progress.companies_searched_this_call).toBe(2);
    expect(r1['continuation'].incomplete_reasons).toContain('company_search_failed_retryable');
    const token = r1['continuation'].token as string;

    // 2회차 — 캐시 2개사 재사용 + 같은 실패 1건. 시도는 1회지만 **받아 낸 목록은 0**이다.
    const calls2: CallLog[] = [];
    const r2 = (await detectUndisclosedTransactions(
      { ...BASE, continuation_token: token },
      failing(kv, calls2),
    )) as Record<string, any>;

    expect(j001Calls(calls2).map((x) => x.corpCode)).toEqual([CODE3.비사]); // 시도는 했다
    expect(r2['continuation'].progress.companies_searched_this_call).toBe(0); // 성공은 0
    expect(r2['continuation'].progress.companies_reused_from_token).toBe(2);
    expect(r2['continuation'].complete).toBe(false);
    expect(r2['continuation'].stalled).toBe(true);
    const note2 = String((r2['notes'] as string[])[0]);
    expect(note2).toContain('새로 검색한 회사도 새로 연 원문도 0건');
    expect(note2).toContain('search_disclosures');

    // 3회차 — 2회차와 완전히 같은 자리다. 반복해도 끝나지 않는다는 사실이 매번 드러나야 한다.
    const calls3: CallLog[] = [];
    const r3 = (await detectUndisclosedTransactions(
      { ...BASE, continuation_token: token },
      failing(kv, calls3),
    )) as Record<string, any>;

    expect(r3['continuation'].stalled).toBe(true);
    expect(r3['continuation'].token).toBe(token); // 같은 실행이 이어진다
    expect(r3['continuation'].call_index).toBe(3);
    expect(r3['continuation'].progress).toEqual({
      ...r2['continuation'].progress,
      // 진행 카운터가 2회차와 한 글자도 다르지 않다 — 그래서 stalled 이 필요하다
    });
  });

  /* ────────────────────────────── 7 ────────────────────────────── */

  it('토큰 없는 호출은 이어보기 캐시를 읽지 않는다 — "공시 목록 미캐시" 불변식은 신규 점검에 그대로 성립한다', async () => {
    const kv = new Map<string, string>();
    const { token } = await truncatedFirstCall(kv);
    expect(contKeys(kv).length).toBeGreaterThan(1); // 쓸 수 있는 캐시가 실제로 있다

    // 같은 저장소로 **토큰 없이** 부른다 — 방금 접수된 공시까지 보려면 목록을 새로 받아야 한다
    const c = fakeClock();
    const calls: CallLog[] = [];
    const kvGets: string[] = [];
    const deps = deps3({ kv, calls, kvGets, now: c.now, advance: c.advance, perCallMs: 1_000 });

    const r = (await detectUndisclosedTransactions(BASE, deps)) as Record<string, any>;

    // 저장소를 읽지도 않았다
    expect(kvGets.filter((k) => k.startsWith('cont:'))).toEqual([]);
    // 캐시에 있던 회사(에이사·씨사)도 목록을 새로 받았다
    expect(j001Calls(calls).map((x) => x.corpCode).sort()).toEqual(
      [CODE3.에이사, CODE3.씨사, CODE3.비사].sort(),
    );
    expect(r['continuation'].complete).toBe(true);
    expect(r['continuation'].call_index).toBe(1); // 앞 실행의 호출 횟수를 이어받지 않는다
    // 버려진 실행의 키는 남는다 (TTL 로 죽는다) — 완주했다고 남의 토큰을 지우지 않는다
    expect(contKeys(kv).some((k) => k.startsWith(`cont:${token}:`))).toBe(true);
  });

  /* ────────────────────────────── 8 ──────────────────────────────
   * 조회 **횟수** 예산과 이어보기가 만나는 지점.
   *
   * 캐시 히트까지 예산을 먹으면 재호출해도 앞쪽 이름들이 같은 예산을 다시 먹어 뒤쪽 이름은
   * 영원히 대조되지 않는다 — `complete` 가 영영 참이 되지 않으므로 이어보기의 약속("반복하면
   * 끝난다")이 거짓이 된다. 원문 예산을 `isDocCached` 로 푼 것과 같은 문제다.
   *
   * 실물 참고(2026-09-07): jurir 를 비운 DB 1회차 `warming.lookups 24`, 같은 DB 2회차 `0`
   * (전부 캐시) · 판정 차이 0건.
   */

  it('★ 캐시된 법인등록번호 조회는 예산을 쓰지 않는다 — 쓰면 이어보기가 제자리를 돈다', async () => {
    /* 동명 5건짜리 이름 다섯 개 = 대조에 필요한 조회 25회 > 예산 20회.
     * 앞 네 이름이 캐시돼 있으면 **같은 예산으로 다섯 번째 이름까지** 대조돼야 한다. */
    const NAMES = [1, 2, 3, 4, 5].map((i) => `동명0${i}(주)`);
    const portalJurir = (i: number): string => `110111000000${i}`;
    const cand = (i: number, j: number): string => String(30_000_000 + i * 10 + j);

    const CORPS: Record<string, Array<{ corpCode: string; corpName: string }>> = {};
    const JURIR: Record<string, JurirNoFetch> = {};
    NAMES.forEach((raw, idx) => {
      const i = idx + 1;
      // DART 상호 동명 5건 — 이름으로는 고를 수 없고 법인등록번호로만 확정된다
      CORPS[normalizeCompanyName(raw)] = [0, 1, 2, 3, 4].map((j) => ({
        corpCode: cand(i, j),
        corpName: `동명0${i}`,
      }));
      [0, 1, 2, 3, 4].forEach((j) => {
        JURIR[cand(i, j)] = {
          status: 'ok',
          jurirNo: j === 0 ? portalJurir(i) : `9${i}${j}0111000000`,
        };
      });
    });
    const POP: Population = {
      corpCodes: new Map([['19999999', '엘사(주)']]), // 대여회사는 포털에서 바로 조인된다
      group: { representative_company: '엘사(주)' },
      unjoined: [], // 워밍 대상 없음 — 이 테스트가 보는 것은 **동명 판별** 예산이다
      jurirNoByName: new Map(
        NAMES.map((raw, idx) => [normalizeCompanyName(raw), portalJurir(idx + 1)]),
      ),
    };
    const MD = makeMd(
      NAMES.map((raw, idx) => ({
        borrower: raw,
        lender: '엘사(주)',
        amount: 16_000 - idx * 100,
        date: '2025-02-19',
      })),
    );

    // ① 전부 비캐시 — 앞 네 이름이 예산 20회를 다 쓰고 다섯 번째는 대조하지 못한다
    const coldCalls: string[] = [];
    const cold = (await detectUndisclosedTransactions(
      BASE,
      makeDeps({
        markdown: MD,
        corps: CORPS,
        pop: POP,
        jurir: JURIR,
        j001: [],
        jurirCalls: coldCalls,
      }),
    )) as Record<string, any>;

    expect(coldCalls).toHaveLength(20);
    expect(cold['diagnostics'].jurir_disambiguation.lookups).toBe(20);
    expect(cold['diagnostics'].jurir_disambiguation.resolved).toHaveLength(4);
    expect(cold['continuation'].incomplete_reasons).toContain('jurir_disambiguation_skipped');
    expect(cold['continuation'].complete).toBe(false);

    // ② 앞 네 이름의 후보 20개가 캐시된 상태 = 위 호출이 남긴 상태. 같은 예산으로 다섯 번째
    //    이름까지 대조돼 **완주한다** — 이것이 "재호출이 진전을 만든다"의 실체다.
    const cached = new Set<string>();
    [1, 2, 3, 4].forEach((i) => [0, 1, 2, 3, 4].forEach((j) => cached.add(cand(i, j))));
    const warmCalls: string[] = [];
    const warm = (await detectUndisclosedTransactions(
      BASE,
      makeDeps({
        markdown: MD,
        corps: CORPS,
        pop: POP,
        jurir: JURIR,
        j001: [],
        jurirCalls: warmCalls,
        cachedJurir: cached,
      }),
    )) as Record<string, any>;

    // 조회 함수는 25번 불렸지만(캐시 20 + 콜 5) **예산은 5회만** 썼다
    expect(warmCalls).toHaveLength(25);
    expect(warm['diagnostics'].jurir_disambiguation.lookups).toBe(5);
    expect(warm['diagnostics'].jurir_disambiguation.resolved).toHaveLength(5);
    expect(warm['continuation'].incomplete_reasons).not.toContain('jurir_disambiguation_skipped');
    expect(warm['continuation'].complete).toBe(true);
    // 판정도 실제로 늘었다 — 다섯 번째 이름이 조인돼 미판정에서 빠졌다
    expect(warm['summary'].undisclosed_candidates).toBeGreaterThan(
      cold['summary'].undisclosed_candidates,
    );
  });

  it('자동 워밍도 캐시 히트를 조회 횟수로 세지 않는다 — 조인 결과는 같고 예산만 돌아온다', async () => {
    const JURIR_대여 = '1101110022222';
    const MD = makeMd([
      { borrower: '차입회사(주)', lender: '대여증권(주)', amount: 16_000, date: '2025-02-19' },
    ]);
    const POP: Population = {
      corpCodes: new Map([['00222222', '차입회사(주)']]),
      group: { representative_company: '차입회사(주)' },
      unjoined: ['대여증권(주)'],
      jurirNoByName: new Map([['대여증권', JURIR_대여]]),
    };
    const common = {
      markdown: MD,
      pop: POP,
      j001: [],
      // 워밍의 후보 탐색은 **원문 이름 완전일치**부터 본다
      corps: {
        '대여증권(주)': [{ corpCode: '00311030', corpName: '대여증권(주)' }],
        차입회사: [{ corpCode: '00222222', corpName: '차입회사' }],
      },
      jurir: { '00311030': { status: 'ok' as const, jurirNo: JURIR_대여 } },
    };

    const coldWarming = (
      (await detectUndisclosedTransactions(BASE, makeDeps(common))) as Record<string, any>
    )['diagnostics'].population.warming;

    // 30일 억제 기록을 지워 같은 조건으로 다시 돌린다 — 두 실행의 차이는 **캐시 여부뿐**이다
    store.deletePrefix('warm:');

    const warmWarming = (
      (await detectUndisclosedTransactions(
        BASE,
        makeDeps({ ...common, cachedJurir: new Set(['00311030']) }),
      )) as Record<string, any>
    )['diagnostics'].population.warming;

    expect(coldWarming.lookups).toBe(1); // 콜이 나갔으므로 예산을 쓴다
    expect(warmWarming.lookups).toBe(0); // 캐시 히트는 세지 않는다
    // 조인 결과는 완전히 같다 — 예산 계산만 달라졌지 판정이 달라진 것이 아니다
    expect(warmWarming.attempted).toBe(coldWarming.attempted);
    expect(warmWarming.joined).toBe(coldWarming.joined);
    expect(warmWarming.joined).toBe(1);
    expect(warmWarming.over_budget).toBe(false);
  });
});
