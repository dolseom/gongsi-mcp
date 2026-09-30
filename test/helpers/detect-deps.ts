/**
 * detect_undisclosed_transactions 테스트 공용 헬퍼 — 주입 deps·목록/원문 스텁·메모리 저장소.
 *
 * 픽스처(test/fixtures/j004-transactions.md)의 실측 수치:
 *  - 와이케이디벨롭먼트(주): 자본금 50억 / 자본총계 200억 → 기준금액 10억
 *  - 차입 160억(2025-02-19)·120억(2025-06-30) — 둘 다 100억 상한 이상 = 자본 무관 확실
 *  - 상품·용역: 같은 상대방(미래에셋증권)에게 58.9억 + 12.99억 = **상대방별 합산 71.89억**
 *    (≥ 4×10억 → 신호. 행 단위로 보면 12.99억이 미달로 빠진다 — 교차검토 M-4의 재현 구조)
 */

import { beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DetectDeps } from '../../src/tools/detect-undisclosed-transactions.js';
import type { Disclosure } from '../../src/clients/dart.js';
import type { BatchResult } from '../../src/search/batch.js';
import type { DocMeta } from '../../src/tools/read-disclosure.js';
import type { Population, PopulationInput } from '../../src/tools/audit-group-disclosures.js';
import type { JurirNoFetch } from '../../src/resolver/corp-index.js';
import { Store, __setStore } from '../../src/lib/store.js';

const TEST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_MD = readFileSync(join(TEST_DIR, 'fixtures', 'j004-transactions.md'), 'utf-8');

/**
 * 자동 워밍이 30일 억제 기록을 저장소에 쓰므로 **메모리 저장소로 격리**한다 —
 * 그러지 않으면 테스트가 사용자의 실제 캐시 DB(`~/.gongsi-mcp/cache.db`)에 'warm:' 키를 남긴다.
 * 테스트 파일 최상위에서 한 번 부른다. 돌려주는 함수가 현재 테스트의 저장소를 준다.
 */
export function useMemoryStore(): () => Store {
  let store: Store | undefined;
  beforeEach(() => {
    store = new Store(':memory:');
    __setStore(store);
  });
  afterEach(() => {
    store?.close();
    __setStore(null);
  });
  return () => {
    if (!store) throw new Error('useMemoryStore: 테스트 밖에서 저장소를 읽었습니다');
    return store;
  };
}

export function disc(over: Partial<Disclosure>): Disclosure {
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

export function batch(rows: Disclosure[], partial = false): BatchResult {
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

export const META: DocMeta = {
  acode: '80622',
  aregcik: null,
  formulaVersion: null,
  encoding: 'utf-8',
  attachments: [],
  bodyParsable: true,
  boardDate: null,
  pickedEntry: null,
};

export interface CallLog {
  corpCode: string;
  ty: string;
  from: string;
  to: string;
}

export function makeDeps(opts: {
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

export const YKD_CORPS = {
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
export function doc80708(counterparty: string, subject = '출자증권', amount = '1,600'): string {
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
export function doc80718(counterparty: string): string {
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
export function doc80754(...counterparties: string[]): string {
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
