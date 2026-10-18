import { describe, it, expect } from 'vitest';
import { oversizeError, serializeToolResult, TOOL_RESULT_HARD_LIMIT_BYTES } from '../src/lib/tool-output.js';

describe('도구 응답 최종 상한', () => {
  it('상한 이하면 그대로 보낸다', () => {
    expect(oversizeError('read_disclosure', serializeToolResult({ body: '가'.repeat(1000) }))).toBeUndefined();
  });

  it('한글 본문은 바이트로 잰다 — 9만 자(약 27만 바이트)면 상한을 넘는다', () => {
    const e = oversizeError('read_disclosure', serializeToolResult({ body: '가'.repeat(90_000) }));
    expect(e?.error).toBe('response_too_large');
    expect(e?.message).toContain('max_chars');
    expect(e?.details['bytes']).toBeGreaterThan(TOOL_RESULT_HARD_LIMIT_BYTES);
  });

  it('도구별 줄일 인자를 안내하고, 모르는 도구는 범위 축소로 안내한다', () => {
    const big = serializeToolResult({ rows: 'x'.repeat(TOOL_RESULT_HARD_LIMIT_BYTES) });
    expect(oversizeError('search_disclosures', big)?.message).toContain('limit');
    expect(oversizeError('get_financials', big)?.message).toContain('조회 범위를 줄여');
  });

  it('기준선: 거부 실측(282,903B)은 막고 통과 실측(34,929B)은 통과시킨다', () => {
    expect(TOOL_RESULT_HARD_LIMIT_BYTES).toBeLessThan(282_903);
    expect(TOOL_RESULT_HARD_LIMIT_BYTES).toBeGreaterThan(34_929);
  });
});
