/**
 * detect_undisclosed_transactions — 조인·워밍·모집단 — 포털 population · 동명 법인등록번호 확정 · 자동 워밍 · allowEmptyJoin · 실패 사유
 * (공용 헬퍼·픽스처 수치는 test/helpers/detect-deps.ts)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectUndisclosedTransactions } from '../src/tools/detect-undisclosed-transactions.js';
import {
  resolvePopulation,
  type Population,
  type PopulationInput,
} from '../src/tools/audit-group-disclosures.js';
import type { JurirNoFetch } from '../src/resolver/corp-index.js';
import { ToolError } from '../src/lib/errors.js';
import { __resetConfig } from '../src/lib/config.js';
import { makeDeps, YKD_CORPS, useMemoryStore } from './helpers/detect-deps.js';

const memStore = useMemoryStore();

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
    expect(memStore().get(`warm:v3:${JURIR_대여}`)).toBe('20260827');
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
    memStore().set(`warm:v3:${JURIR_대여}`, '20260820'); // 7일 전
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
    memStore().set(`warm:${JURIR_대여}`, '20260826'); // 어제 남긴 구버전 기록
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
    expect(memStore().get(`warm:v3:${JURIR_대여}`)).toBe('20260827');
    expect(memStore().get(`warm:${JURIR_대여}`)).toBe('20260826');
  });

  it('억제 기간(30일)이 지난 기록은 다시 시도한다', async () => {
    memStore().set(`warm:v3:${JURIR_대여}`, '20260701'); // 57일 전
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
    expect(memStore().get('warm:v3:1101110000020')).toBeNull();
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
    memStore().set(`egroup_groups:${YM}`, JSON.stringify([GROUP]));
    memStore().set(`egroup_affiliates:${YM}:K9999999`, JSON.stringify([AFFILIATE]));
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
