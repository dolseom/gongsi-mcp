/**
 * detect_undisclosed_transactions — 시간 예산(60초 벽) · env override · 이어보기(continuation)
 * (공용 헬퍼·픽스처 수치는 test/helpers/detect-deps.ts)
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  detectUndisclosedTransactions,
  detectUndisclosedTransactionsInput,
  type DetectDeps,
} from '../src/tools/detect-undisclosed-transactions.js';
import { normalizeCompanyName } from '../src/parsers/md-table.js';
import type { Disclosure } from '../src/clients/dart.js';
import type { Population } from '../src/tools/audit-group-disclosures.js';
import type { JurirNoFetch } from '../src/resolver/corp-index.js';
import { ToolError } from '../src/lib/errors.js';
import { __resetConfig } from '../src/lib/config.js';
import {
  disc,
  batch,
  type CallLog,
  makeDeps,
  doc80718,
  useMemoryStore,
} from './helpers/detect-deps.js';

const memStore = useMemoryStore();

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
    memStore().deletePrefix('warm:');

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
