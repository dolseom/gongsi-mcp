/**
 * `GONGSI_TIME_BUDGET_MS` — detect 시간 예산을 **낮추기만** 하는 검증·운영용 손잡이
 *
 * 상수만 있으면 "예산이 끊겼을 때 부분 결과가 정직하게 나오는가"를 실물에서 재현할 방법이
 * 없다. 그래서 내리는 방향만 열었다 — 올리는 방향은 MCP 클라이언트가 60초에 끊으므로
 * 결과가 통째로 사라질 뿐이고, 5초 미만은 J001 검색을 한 건도 시작하지 못해 부분 결과조차 아니다.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { __resetConfig, getConfig } from '../src/lib/config.js';
import { TIME_BUDGET_MS } from '../src/tools/detect-undisclosed-transactions.js';

/** env 를 세팅하고 config 캐시를 버린다 (getConfig 는 모듈 수준에서 한 번만 계산한다) */
function withEnv(value: string | undefined): number | undefined {
  if (value === undefined) delete process.env['GONGSI_TIME_BUDGET_MS'];
  else process.env['GONGSI_TIME_BUDGET_MS'] = value;
  __resetConfig();
  return getConfig().detectTimeBudgetMs;
}

afterEach(() => {
  delete process.env['GONGSI_TIME_BUDGET_MS'];
  __resetConfig();
});

describe('GONGSI_TIME_BUDGET_MS', () => {
  it('없으면 undefined — 도구가 기본 상수를 쓴다', () => {
    expect(withEnv(undefined)).toBeUndefined();
  });

  it('빈 문자열도 undefined (env 를 지운 것과 같게 다룬다)', () => {
    expect(withEnv('')).toBeUndefined();
  });

  it('숫자가 아니면 undefined — 오타로 예산이 0 이 되지 않는다', () => {
    expect(withEnv('abc')).toBeUndefined();
  });

  it('정상 범위 값은 그대로 쓴다', () => {
    expect(withEnv('8000')).toBe(8_000);
  });

  it('★ 올릴 수는 없다 — 50초를 넘기면 50초로 가둔다 (클라이언트가 60초에 끊는다)', () => {
    expect(withEnv('90000')).toBe(50_000);
  });

  it('★ 5초 미만은 5초로 올린다 — 3초로는 실측상 J001 검색을 한 건도 시작하지 못했다', () => {
    expect(withEnv('1000')).toBe(5_000);
    expect(withEnv('3000')).toBe(5_000);
    expect(withEnv('0')).toBe(5_000);
    expect(withEnv('-5000')).toBe(5_000);
  });

  it('소수는 잘라서 쓴다', () => {
    expect(withEnv('8000.9')).toBe(8_000);
  });

  it('인식하는 GONGSI_* 목록에 들어 있다 — 기동 경고에 걸리지 않아야 한다', async () => {
    process.env['GONGSI_TIME_BUDGET_MS'] = '8000';
    const { unknownEnvVars } = await import('../src/lib/config.js');
    expect(unknownEnvVars()).not.toContain('GONGSI_TIME_BUDGET_MS');
  });

  it('★ 상한은 detect 의 기본 예산과 같은 값이다 (두 곳에 있어 어긋날 수 있다)', () => {
    // config 는 detect 를 import 할 수 없어(순환) 값을 한 벌 더 갖는다. 여기서 드리프트를 잡는다.
    expect(withEnv('999999')).toBe(TIME_BUDGET_MS);
  });
});
