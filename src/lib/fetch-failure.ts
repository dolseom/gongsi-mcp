import { redact } from './logger.js';

/**
 * fetch 가 던진 오류의 **실제 원인**을 사람이 읽을 문구와 코드로 뽑는다.
 *
 * ★ `err.name` 만 남기면 사용자에게는 "TypeError" 넉 자만 간다 — 키 문제인지 방화벽인지
 *   포털 장애인지 구분할 수 없다 (실측 2026-09-06: apis.data.go.kr 연결 불가 상태에서
 *   원인 규명에 시간을 썼다). undici 는 원인을 `err.cause.code` 에 담고
 *   (`UND_ERR_CONNECT_TIMEOUT`·`ENOTFOUND` 등), `AbortSignal.timeout` 은 name 이
 *   `TimeoutError` 로 온다.
 *
 * ⚠️ URL 은 절대 담지 않는다 — 쿼리 문자열에 serviceKey 가 들어 있다. 상류 메시지도
 *   `redact` 를 거친다 (이 프로젝트는 실제 키 유출을 겪었다).
 */
export function describeFetchFailure(err: unknown): { text: string; code?: string } {
  if (!(err instanceof Error)) return { text: '알 수 없는 오류' };
  const cause = (err as { cause?: unknown }).cause;
  let code: string | undefined;
  if (cause !== null && typeof cause === 'object') {
    const c = cause as { code?: unknown; message?: unknown };
    if (typeof c.code === 'string' && c.code) code = c.code;
    else if (typeof c.message === 'string' && c.message) code = redact(c.message).slice(0, 120);
  }
  const base = `${err.name}: ${redact(err.message)}`;
  return { text: code ? `${base} — ${code}` : base, ...(code ? { code } : {}) };
}
