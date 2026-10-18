/**
 * 실행 환경 실패(시간·취소·차단기·한도·통신)를 "이 건만 건너뜀"으로 삼키지 않는다 (2026-10-18)
 *
 * 종전에는 원인이 네트워크·시간인데 결론이 다른 원인을 적었다:
 *   - find_precedents: 원문 수집이 시간 예산으로 끊겨도 "원문을 파싱할 수 있는 건이 없었습니다"
 *   - audit_group_disclosures: 인덱스 갱신이 통신 실패여도 "오타·폐지 코드이거나…"
 *   - DartClient: 재시도 소진 메시지가 "(TypeError)" 넉 자뿐 — IP 차단·DNS·TLS 구분 불가
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { DartClient, __resetDartGate } from '../src/clients/dart.js';
import { isEnvironmentalFailure, RateLimitError, ToolError } from '../src/lib/errors.js';
import { __resetConfig } from '../src/lib/config.js';
import { useMemoryStore } from './helpers/store.js';
import { disclosureBuilder } from './helpers/disclosure.js';

const readDisclosureMock = vi.hoisted(() => vi.fn());
vi.mock('../src/tools/read-disclosure.js', async (orig) => ({
  ...(await orig<typeof import('../src/tools/read-disclosure.js')>()),
  readDisclosure: readDisclosureMock,
}));
const loadCorpIndexMock = vi.hoisted(() => vi.fn());
vi.mock('../src/resolver/corp-index.js', async (orig) => ({
  ...(await orig<typeof import('../src/resolver/corp-index.js')>()),
  loadCorpIndex: loadCorpIndexMock,
}));

const { findPrecedents } = await import('../src/tools/find-precedents.js');
const { resolvePopulation } = await import('../src/tools/audit-group-disclosures.js');

const store = useMemoryStore();
beforeEach(() => {
  vi.stubEnv('DART_API_KEY', 'test-key');
  __resetConfig();
  __resetDartGate();
  readDisclosureMock.mockReset();
  loadCorpIndexMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  __resetConfig();
});

describe('isEnvironmentalFailure', () => {
  it('시간·취소·차단기·한도·키 코드는 환경 실패다', () => {
    for (const code of ['deadline_exceeded', 'request_cancelled', 'upstream_unavailable', 'missing_api_key'] as const) {
      expect(isEnvironmentalFailure(new ToolError(code, 'x'))).toBe(true);
    }
    expect(isEnvironmentalFailure(new RateLimitError(1, 1, 'x'))).toBe(true);
  });
  it('통신 실패·429 로 끝난 dart_api_error 는 환경 실패, 그 밖의 dart_api_error·파싱 오류는 아니다', () => {
    expect(isEnvironmentalFailure(new ToolError('dart_api_error', 'x', { transport_failure: true }))).toBe(true);
    expect(isEnvironmentalFailure(new ToolError('dart_api_error', 'x', { status: 429 }))).toBe(true);
    expect(isEnvironmentalFailure(new ToolError('dart_api_error', 'x', { status: '013' }))).toBe(false);
    expect(isEnvironmentalFailure(new ToolError('body_unparsable', 'x'))).toBe(false);
    expect(isEnvironmentalFailure(new Error('x'))).toBe(false);
  });
});

describe('DartClient 재시도 소진 — 원인 코드 노출', () => {
  it('응답 없이 끊긴 실패는 undici cause.code 를 메시지·details 에 싣는다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      }),
    );
    const p = new DartClient('test-key').listPage({ corpCode: '00111111' }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = (await p) as ToolError;
    expect(err.code).toBe('dart_api_error');
    expect(err.message).toContain('ECONNRESET');
    expect(err.details).toMatchObject({ transport_failure: true, cause: 'ECONNRESET' });
    expect(isEnvironmentalFailure(err)).toBe(true);
  });

  it('마지막 시도가 5xx 로 끝나면 그 상태코드로 적는다 (앞 시도의 통신 원인을 남기지 않는다)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n++;
        if (n === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
        return new Response('busy', { status: 503 });
      }),
    );
    const p = new DartClient('test-key').listPage({ corpCode: '00111111' }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = (await p) as ToolError;
    expect(err.message).toContain('HTTP 503');
    expect(err.message).not.toContain('ECONNRESET');
    expect(err.details).toMatchObject({ status: 503 });
    expect(err.details?.['transport_failure']).toBeUndefined();
  });
});

describe('find_precedents — 원문 수집 중 환경 실패', () => {
  const row = disclosureBuilder({ corp_name: '가나', report_nm: '대규모내부거래(자금대여)', rcept_dt: '20260901' });
  beforeEach(() => {
    vi.spyOn(DartClient.prototype, 'collect').mockResolvedValue({
      rows: [
        row({ rcept_no: '20260901000001', corp_code: 'A0000001' }),
        row({ rcept_no: '20260902000002', corp_code: 'A0000002' }),
      ],
      calls: 1,
      truncated: false,
    } as never);
  });

  it('0건에서 끊기면 body_unparsable 이 아니라 실제 원인 코드로 알린다', async () => {
    readDisclosureMock.mockRejectedValue(new ToolError('deadline_exceeded', '남은 시간 예산이 없습니다'));
    const err = (await findPrecedents({ report_name_contains: '자금대여', count: 2 } as never).catch((e) => e)) as ToolError;
    expect(err.code).toBe('deadline_exceeded');
    expect(err.message).toContain('원문 형식 문제가 아니므로');
    expect(readDisclosureMock).toHaveBeenCalledTimes(1); // 다음 후보로 넘어가 예산을 더 쓰지 않는다
  });

  it('일부 확보 뒤 끊기면 결과를 돌려주되 중단 사실을 notes 에 남긴다', async () => {
    readDisclosureMock
      .mockResolvedValueOnce({ body: '본문', cached: true })
      .mockRejectedValueOnce(new ToolError('upstream_unavailable', '차단기 열림'));
    const out = (await findPrecedents({ report_name_contains: '자금대여', count: 2 } as never)) as {
      precedents: unknown[];
      notes: string[];
    };
    expect(out.precedents).toHaveLength(1);
    expect(out.notes.some((n) => n.includes('upstream_unavailable') && n.includes('중단'))).toBe(true);
  });

  it('원문 자체의 문제(환경 실패 아님)는 종전처럼 건너뛰고 body_unparsable', async () => {
    readDisclosureMock.mockRejectedValue(new ToolError('body_unparsable', 'HWP 첨부만 있음'));
    const err = (await findPrecedents({ report_name_contains: '자금대여', count: 2 } as never).catch((e) => e)) as ToolError;
    expect(err.code).toBe('body_unparsable');
    expect(readDisclosureMock).toHaveBeenCalledTimes(2);
  });
});

describe('audit — 낡은 인덱스 갱신 실패', () => {
  beforeEach(() => {
    store().upsertCorps([{ corpCode: '00126380', corpName: '삼성전자', stockCode: '005930', jurirNo: null, modifyDate: null }]);
  });

  it('갱신이 통신 실패면 "오타·폐지 코드" 가 아니라 확인 못 했다고 알린다', async () => {
    loadCorpIndexMock.mockRejectedValue(new ToolError('upstream_unavailable', '차단기 열림'));
    const err = (await resolvePopulation({ companies: ['99999999'] }).catch((e) => e)) as ToolError;
    expect(err.code).toBe('upstream_unavailable');
    expect(err.message).toContain('신규 등록 법인인지 확인하지 못했습니다');
    expect(err.message).not.toContain('오타·폐지 코드이거나');
    expect(err.details).toMatchObject({ corp_code: '99999999', corp_index_refresh_failed: true });
  });

  it('갱신은 성공했는데 없으면 종전대로 corp_not_found', async () => {
    loadCorpIndexMock.mockResolvedValue(undefined);
    const err = (await resolvePopulation({ companies: ['99999999'] }).catch((e) => e)) as ToolError;
    expect(err.code).toBe('corp_not_found');
  });
});
