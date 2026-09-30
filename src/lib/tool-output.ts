/**
 * 도구 응답의 **최종 전송 문자열**을 만드는 단일 창구.
 *
 * 왜 함수 하나를 따로 두나: 크기 한도를 지키려면 **호스트에 실제로 나가는 문자열**로 재야 한다.
 * `src/index.ts` 의 wrap 이 `JSON.stringify(v, null, 2)` 로 직렬화하는데, 어댑터가 자기 나름의
 * `JSON.stringify(v)`(들여쓰기 없음)로 재면 같은 객체가 30~40% 작게 측정돼 한도를 넘겨 보낸다.
 * → wrap·요약 어댑터·상세 읽기 도구·테스트가 **전부 이 함수로** 직렬화하고 이 함수로 잰다.
 */

/** 도구 응답 직렬화 — 들여쓰기 2는 wrap 의 기존 동작을 그대로 보존한 값이다 */
export function serializeToolResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * 한 도구 응답의 보수적인 **제품 예산** (UTF-8 바이트).
 *
 * ⚠️ 이 값은 "모든 MCP 호스트의 한도"가 아니다. 실제 호스트 제한은 **토큰**이고, 같은 세션에서
 * 34,929바이트 응답이 정상 전달된 실측이 있다(2026-09-08 m07 의 audit_periodic_disclosures).
 * 반대로 222,709자(282,903바이트) 탐지 결과는 "exceeds maximum allowed tokens" 로 거부됐다.
 * 24,576 은 그 사이에서 **여유 있게 잡은 우리 쪽 상한**이며, 한글이 UTF-8 3바이트라
 * 대략 8,000자 + 메타에 해당한다.
 */
export const TOOL_RESULT_BYTE_BUDGET = 24_576;

/** 직렬화한 최종 문자열의 UTF-8 바이트 수 */
export function toolResultBytes(value: unknown): number {
  return Buffer.byteLength(serializeToolResult(value), 'utf8');
}

/**
 * UTF-16 단위로 자를 때 **surrogate pair 중간을 자르지 않는다.**
 * 이모지·일부 한자는 2 단위라, 중간에서 끊으면 깨진 문자(U+FFFD)가 되고 조각을 이어붙여도
 * 원본이 복원되지 않는다. 경계에 걸리면 **한 단위 앞에서** 끊는다.
 */
export function safeSliceEnd(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return Math.max(0, Math.min(end, text.length));
  const code = text.charCodeAt(end - 1);
  // 0xD800~0xDBFF = high surrogate. 그 뒤가 low surrogate 면 쌍을 쪼개는 것이다.
  if (code >= 0xd800 && code <= 0xdbff) return end - 1;
  return end;
}

/**
 * 앞 `max` UTF-16 단위까지의 preview — surrogate 경계를 지키고, 잘렸으면 말줄임을 붙인다.
 * 잘렸는지를 호출자가 알아야 하므로 `truncated` 를 함께 돌려준다.
 */
export function previewText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const end = safeSliceEnd(text, max);
  return { text: text.slice(0, end), truncated: true };
}
