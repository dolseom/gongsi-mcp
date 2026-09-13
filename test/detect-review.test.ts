/**
 * 탐지 MCP 요약 어댑터 회귀.
 *
 * ★ 여기 쓰는 대형 결과는 **합성 fixture** 다 (프로세스 내 Vitest). 엔진을 mock 으로 갈아
 *   어댑터·보관소·읽기 도구·공용 직렬화만 통과시킨다 — 실제 stdio 나 DART 실호출이 아니다.
 *   설치본 stdio 검증은 키 없이 되는 것만 본다(scripts/smoke-tarball.mjs), 실제 대형 왕복은
 *   키가 있는 live 실행으로 따로 기록한다.
 *
 * 지키는 계약:
 *  - 첫 응답의 **최종 직렬화 바이트** ≤ 24,576 (한글·따옴표 escape 포함).
 *  - 그 안에서도 실질 경고(부분 검색·미검토 범위·후보≠확정·0건≠이상없음)는 **항상** 남는다.
 *  - 잘린 것은 `summary_incomplete`·`details_required`·omitted 수로 드러나고 전문 조회 경로가 있다.
 *  - 엔진 오류는 snapshot 을 만들지 않고 종전 오류 계약대로 나간다.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolError, toErrorResponse } from '../src/lib/errors.js';
import { serializeToolResult, TOOL_RESULT_BYTE_BUDGET } from '../src/lib/tool-output.js';

/** 엔진은 mock — 어댑터만 검사한다 (실호출·네트워크 없음) */
const engine = vi.hoisted(() => ({ impl: vi.fn() }));
vi.mock('../src/tools/detect-undisclosed-transactions.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../src/tools/detect-undisclosed-transactions.js')
  >();
  return { ...actual, detectUndisclosedTransactions: engine.impl };
});

const { detectReview } = await import('../src/tools/detect-review.js');
const { clearDetectionResults, detectionResultStats, getDetectionResult } = await import(
  '../src/lib/detection-results.js'
);
const { readDetectionResult } = await import('../src/tools/read-detection-result.js');

function korean(n: number, seed = '계열회사거래상대방기준금액자본총계'): string {
  let out = '';
  while (out.length < n) out += seed;
  return out.slice(0, n);
}

/** 실물 구조를 닮은 합성 탐지 결과 */
function fakeResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  const actions = Array.from({ length: 83 }, (_, i) => ({
    priority: 1,
    status: 'candidate_if_counterparty_qualified',
    perspective: i % 2 ? '거래상대방' : '본인',
    company: `계열회사 ${i}`,
    counterparty: `거래상대방 ${i}`,
    amount_display: '664.90억원',
    threshold_display: '기준금액 60억원',
    source: 'goods_services_matrix_below_threshold',
  }));
  return {
    scope: { source_rcept_no: '20260617000447', judged_at: '20260913', fiscal_year: 2025 },
    continuation: { complete: true, call_index: 1, incomplete_reasons: [], next_step: '온전한 답입니다.' },
    action_items: { total: actions.length, note: '바구니를 가로질러 모은 목록입니다.', items: actions },
    summary: {
      complete: true,
      undisclosed_candidates: 0,
      not_judged: 59,
      goods_services_matrix_below_threshold: 421,
      counterparty_side: { candidate_if_counterparty_qualified: 8, not_judged: 21 },
    },
    undisclosed_candidates: [],
    // 실물 최상위 키 이름에 맞춘다 — 최상위 `not_judged` 배열은 실물에 없다(summary 카운터일 뿐).
    // 판정 불가 상품·용역은 goods_services_signals 안의 status 로, 원리상 판정 불가는 이 배열로 온다.
    goods_services_not_judgeable: Array.from({ length: 59 }, (_, i) => ({
      company: `회사 ${i}`,
      reason: korean(600, `판정 불가 근거 ${i} `),
    })),
    // 실측 규모: 19건 15,514바이트, 최장 1,151자
    scope_caveats: Array.from({ length: 19 }, (_, i) => korean(1_151, `범위 한계 ${i} `)),
    notes: Array.from({ length: 12 }, (_, i) => korean(400, `노트 ${i} `)),
    coverage: {
      transaction_types_checked: ['자금 차입', '상품·용역'],
      undetectable: {
        other_transaction_types: ['담보 제공·수취', '채무보증', '부동산 임대차', '기타자산 거래'],
        non_major_goods_services: true,
        transactions_missing_from_j004: true,
      },
    },
    diagnostics: { parse: { tables: 40 }, budget: { budget_ms: 50_000, expired: false } },
    ...over,
  };
}

function bytesOf(v: unknown): number {
  return Buffer.byteLength(serializeToolResult(v), 'utf8');
}

function rec(v: unknown): Record<string, any> {
  return v as Record<string, any>;
}

describe('첫 응답은 예산 안의 요약이고, 실질 경고는 항상 남는다', () => {
  beforeEach(() => {
    clearDetectionResults();
    engine.impl.mockReset();
  });

  it('실물 규모 결과: 바이트 예산을 지키고 상세 열쇠를 준다', async () => {
    const full = fakeResult();
    engine.impl.mockResolvedValue(full);

    const out = rec(await detectReview({ rcept_no: '20260617000447' }));
    expect(bytesOf(full)).toBeGreaterThan(100_000); // 원본은 예산의 4배 이상이다
    expect(bytesOf(out)).toBeLessThanOrEqual(TOOL_RESULT_BYTE_BUDGET);

    expect(out['detail_access'].result_id).toMatch(/^[0-9a-f]{32}$/);
    expect(out['detail_access'].available_sections).toContain('scope_caveats');
    expect(out['details_required']).toBe(true);
    // 원본 payload 를 다시 spread 하지 않았다 — 큰 배열은 요약에 없다
    expect(out['goods_services_not_judgeable']).toBeUndefined();
    expect(out['scope_caveats']).toBeUndefined();
    expect(out['diagnostics']).toBeUndefined();
    // 집계와 조치 총수는 남는다
    expect(out['summary'].goods_services_matrix_below_threshold).toBe(421);
    expect(out['action_items_preview'].total).toBe(83);
    expect(out['action_items_preview'].items.length).toBeLessThanOrEqual(5);
    expect(out['action_items_preview'].omitted).toBe(83 - out['action_items_preview'].items.length);
  });

  it('실질 경고 3종이 문자열로 남는다 (후보≠확정 · 0건≠이상없음 · 미검토 범위)', async () => {
    engine.impl.mockResolvedValue(fakeResult());
    const out = rec(await detectReview({ rcept_no: '20260617000447' }));
    const warnings = out['required_warnings'].join('\n');
    expect(warnings).toContain('후보(candidate)는 확정이 아닙니다');
    expect(warnings).toContain('0건은 "이상 없음"이 아닙니다');
    expect(warnings).toContain('상세 열람 완료는 다릅니다');
    // coverage.undetectable 은 전문 그대로(고정 크기)
    expect(out['coverage_undetectable'].other_transaction_types).toContain('채무보증');
    expect(out['coverage_undetectable'].transactions_missing_from_j004).toBe(true);
    // caveat 전문은 싣지 않되 총수와 조회 경로를 남긴다
    expect(out['caveats_and_notes'].scope_caveats_total).toBe(19);
    expect(out['caveats_and_notes'].notes_total).toBe(12);
    expect(out['caveats_and_notes'].full_text_sections).toEqual(['scope_caveats', 'notes']);
    expect(out['summary_incomplete']).toBe(true);
  });

  it('시간 예산으로 잘린 실행과 미완주 검색을 맨 앞 경고로 낸다', async () => {
    engine.impl.mockResolvedValue(
      fakeResult({
        summary: { complete: false, time_budget_truncated: true, not_judged: 400 },
        continuation: { complete: false, token: 'a'.repeat(32), call_index: 1 },
      }),
    );
    const out = rec(await detectReview({ rcept_no: '20260617000447' }));
    expect(out['required_warnings'][0]).toContain('시간 예산');
    expect(out['required_warnings'][1]).toContain('continuation.complete=false');
    expect(bytesOf(out)).toBeLessThanOrEqual(TOOL_RESULT_BYTE_BUDGET);
  });

  it('조치 5,000건이어도 예산을 지키고 omitted 로 밝힌다', async () => {
    const many = Array.from({ length: 5_000 }, (_, i) => ({
      priority: 1,
      status: 'undisclosed_candidate',
      company: `회사 ${i}`,
      counterparty: `상대방 ${i}`,
      amount_display: '1,062.80억원',
      source: 'undisclosed_candidates',
    }));
    engine.impl.mockResolvedValue(fakeResult({ action_items: { total: 5_000, items: many } }));
    const out = rec(await detectReview({ rcept_no: '20260617000447' }));
    expect(bytesOf(out)).toBeLessThanOrEqual(TOOL_RESULT_BYTE_BUDGET);
    expect(out['action_items_preview'].items.length).toBeLessThanOrEqual(5);
    expect(out['action_items_preview'].omitted).toBeGreaterThan(4_990);
    expect(out['summary_incomplete']).toBe(true);
    expect(out['required_warnings'].join('\n')).toContain('반드시 읽으세요');
  });

  it('caveat 1건이 100KB 여도 예산을 지키고 preview + 전문 경로를 남긴다', async () => {
    engine.impl.mockResolvedValue(fakeResult({ scope_caveats: [korean(100_000, '거대한 범위 한계 ')] }));
    const out = rec(await detectReview({ rcept_no: '20260617000447' }));
    expect(bytesOf(out)).toBeLessThanOrEqual(TOOL_RESULT_BYTE_BUDGET);
    const preview: string[] = out['caveats_and_notes'].scope_caveats_preview;
    expect(preview).toHaveLength(1);
    expect(preview[0]!.length).toBeLessThan(300);
    expect(preview[0]).toContain('read_detection_result');
    // 전문은 보관돼 있고 실제로 읽힌다
    const page = readDetectionResult({
      result_id: out['detail_access'].result_id,
      section: 'scope_caveats',
    });
    expect(page.total_chars).toBeGreaterThan(100_000);
  });

  it('단일 조치 항목이 100KB 면 preview 에 넣지 않고 omitted 로 남긴다', async () => {
    engine.impl.mockResolvedValue(
      fakeResult({
        action_items: {
          total: 1,
          items: [{ priority: 1, status: 'undisclosed_candidate', reason: korean(100_000) }],
        },
      }),
    );
    const out = rec(await detectReview({ rcept_no: '20260617000447' }));
    expect(bytesOf(out)).toBeLessThanOrEqual(TOOL_RESULT_BYTE_BUDGET);
    expect(out['action_items_preview'].items).toHaveLength(0);
    expect(out['action_items_preview'].omitted).toBe(1);
    expect(out['summary_incomplete']).toBe(true);
  });

  it('집계마저 거대하면 상세로 넘기고 그 사실을 경고한다 (최후 수단)', async () => {
    engine.impl.mockResolvedValue(fakeResult({ summary: { blob: korean(50_000) } }));
    const out = rec(await detectReview({ rcept_no: '20260617000447' }));
    expect(bytesOf(out)).toBeLessThanOrEqual(TOOL_RESULT_BYTE_BUDGET);
    expect(out['summary'].summary_omitted_due_to_size).toBe(true);
    expect(out['required_warnings'].join('\n')).toContain('집계(summary)조차');
    // 경고는 버리지 않는다
    expect(out['required_warnings'].join('\n')).toContain('후보(candidate)는 확정이 아닙니다');
  });

  it('continuation·scope 가 거대해도 예산을 지키고, 이어보기 토큰과 complete 는 남긴다', async () => {
    const token = 'c'.repeat(32);
    engine.impl.mockResolvedValue(
      fakeResult({
        continuation: {
          complete: false,
          token,
          call_index: 2,
          incomplete_reasons: Array.from({ length: 3_000 }, (_, i) => korean(40, `사유 ${i} `)),
        },
        scope: { source_rcept_no: '20260617000447', blob: korean(60_000) },
      }),
    );
    const out = rec(await detectReview({ rcept_no: '20260617000447' }));
    expect(bytesOf(out)).toBeLessThanOrEqual(TOOL_RESULT_BYTE_BUDGET);
    // 검색을 이어가려면 토큰이 필요하다 — 크기 때문에 토큰을 잃으면 온전한 답에 이를 길이 사라진다
    expect(out['continuation'].complete).toBe(false);
    expect(out['continuation'].token).toBe(token);
    expect(out['required_warnings'].join('\n')).toContain('continuation.complete=false');
    expect(out['summary_incomplete']).toBe(true);
  });

  it('개수는 다 실렸어도 caveat 를 200자로 잘랐으면 미완결이라고 말한다 (실물 m07 형태)', async () => {
    // 실측: 미래에셋 m07 은 조치 4건·caveat 19건·notes 12건이 **개수로는 전부** 들어가지만
    // caveat 원문은 최장 1,151자라 preview 에서 잘린다. 그때 summary_incomplete:false 면 거짓 완결이다.
    engine.impl.mockResolvedValue(
      fakeResult({
        action_items: { total: 1, items: [{ priority: 1, status: 'undisclosed_candidate' }] },
        scope_caveats: [korean(500, '긴 범위 한계 '), '짧은 한계'],
        notes: ['짧은 노트'],
      }),
    );
    const out = rec(await detectReview({ rcept_no: '20260617000447' }));
    expect(out['caveats_and_notes'].scope_caveats_preview).toHaveLength(2);
    expect(out['summary_incomplete']).toBe(true);
    expect(out['required_warnings'].join('\n')).toContain('앞 200자');
  });

  it('아무것도 잘리지 않았으면 summary_incomplete 는 false 다', async () => {
    engine.impl.mockResolvedValue(
      fakeResult({
        action_items: { total: 1, items: [{ priority: 1, status: 'undisclosed_candidate' }] },
        scope_caveats: ['짧은 한계'],
        notes: ['짧은 노트'],
      }),
    );
    const out = rec(await detectReview({ rcept_no: '20260617000447' }));
    expect(out['summary_incomplete']).toBe(false);
    expect(out['details_required']).toBe(true);
  });

  it('최상위 항목이 수천 개여도 첫 응답은 예산 안이다 (section 목록 자체가 커지는 경우)', async () => {
    const extra: Record<string, unknown> = {};
    for (let i = 0; i < 4_000; i += 1) extra[`signal_bucket_${i}`] = [];
    engine.impl.mockResolvedValue(fakeResult(extra));
    const out = rec(await detectReview({ rcept_no: '20260617000447' }));
    expect(bytesOf(out)).toBeLessThanOrEqual(TOOL_RESULT_BYTE_BUDGET);
    expect(out['detail_access'].available_sections_total).toBeGreaterThan(4_000);
  });
});

describe('보관·재조회 계약', () => {
  beforeEach(() => {
    clearDetectionResults();
    engine.impl.mockReset();
  });

  it('보관된 전문은 원본과 한 글자도 다르지 않다', async () => {
    const full = fakeResult();
    engine.impl.mockResolvedValue(full);
    const out = rec(await detectReview({ rcept_no: '20260617000447' }));
    expect(getDetectionResult(out['detail_access'].result_id).text).toBe(serializeToolResult(full));
  });

  it('재조회는 탐지 엔진을 다시 부르지 않는다', async () => {
    engine.impl.mockResolvedValue(fakeResult());
    const out = rec(await detectReview({ rcept_no: '20260617000447' }));
    expect(engine.impl).toHaveBeenCalledTimes(1);

    let offset = 0;
    for (let i = 0; i < 5; i += 1) {
      const page = readDetectionResult({
        result_id: out['detail_access'].result_id,
        section: 'goods_services_not_judgeable',
        offset,
      });
      if (page.complete) break;
      offset = page.next_offset!;
    }
    expect(engine.impl).toHaveBeenCalledTimes(1);
  });

  it('호출마다 새 snapshot 이다 — 앞 호출 내용은 바뀌지 않는다 (검색 이어보기와 별개)', async () => {
    engine.impl.mockResolvedValueOnce(fakeResult({ summary: { complete: false, call: 1 } }));
    const first = rec(await detectReview({ rcept_no: '20260617000447' }));
    engine.impl.mockResolvedValueOnce(fakeResult({ summary: { complete: true, call: 2 } }));
    const second = rec(
      await detectReview({ rcept_no: '20260617000447', continuation_token: 'b'.repeat(32) }),
    );

    expect(second['detail_access'].result_id).not.toBe(first['detail_access'].result_id);
    expect(
      JSON.parse(
        readDetectionResult({ result_id: first['detail_access'].result_id, section: 'summary' }).text,
      ).call,
    ).toBe(1);
    expect(
      JSON.parse(
        readDetectionResult({ result_id: second['detail_access'].result_id, section: 'summary' }).text,
      ).call,
    ).toBe(2);
  });

  it('앞 result_id 가 회수될 수 있다는 안내를 첫 응답에 담는다', async () => {
    engine.impl.mockResolvedValue(fakeResult());
    const out = rec(await detectReview({ rcept_no: '20260617000447' }));
    expect(out['detail_access'].lifetime_note).toContain('회수될 수 있습니다');
    expect(out['detail_access'].lifetime_note).toContain('complete:true');
  });

  it('엔진 오류는 snapshot 을 만들지 않고 그대로 나간다', async () => {
    engine.impl.mockRejectedValue(new ToolError('invalid_argument', 'rcept_no 또는 group 중 하나는 필수입니다.'));
    await expect(detectReview({} as never)).rejects.toThrowError(/필수입니다/);
    expect(detectionResultStats().count).toBe(0);
  });

  it('보관 실패는 usable token 없이 구조화 오류 + summary 동봉이다', async () => {
    // 16MiB 초과 → 보관 불가. 탐지 자체는 성공한 것이므로 그 둘을 구분해야 한다.
    engine.impl.mockResolvedValue(fakeResult({ blob: korean(6_000_000) }));
    let thrown: unknown;
    try {
      await detectReview({ rcept_no: '20260617000447' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToolError);
    const e = thrown as ToolError;
    expect(e.code).toBe('resource_limit');
    expect(e.details?.['detection_completed']).toBe(true);
    expect(rec(e.details?.['summary']).goods_services_matrix_below_threshold).toBe(421);
    expect(detectionResultStats().count).toBe(0);
  });
});

describe('취소된 탐지는 보관소를 건드리지 않는다 (2026-09-13 live: 취소된 요청이 snapshot 을 저장해 앞 id 를 회수시켰다)', () => {
  beforeEach(() => {
    clearDetectionResults();
    engine.impl.mockReset();
  });

  it('시작 전에 이미 취소됐으면 엔진을 부르지 않고 snapshot 도 만들지 않는다', async () => {
    engine.impl.mockResolvedValue(fakeResult());
    const ctrl = new AbortController();
    ctrl.abort('client cancelled');
    let thrown: unknown;
    try {
      await detectReview({ rcept_no: '20260617000447' }, { signal: ctrl.signal });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToolError);
    expect((thrown as ToolError).code).toBe('request_cancelled');
    expect(engine.impl).not.toHaveBeenCalled();
    expect(detectionResultStats().count).toBe(0);
  });

  it('엔진 대기 중 취소되면 보관·회수 없이 거절하고, 앞 결과는 읽히며 이후 요청은 정상이다', async () => {
    // 보관소를 가득 채운다 — 취소된 요청이 저장하면 가장 오래된 것이 회수된다
    engine.impl.mockResolvedValue(fakeResult());
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push(rec(await detectReview({ rcept_no: '20260617000447' }))['detail_access'].result_id);
    }
    const ctrl = new AbortController();
    engine.impl.mockImplementationOnce(async () => {
      // 엔진이 도는 동안 클라이언트가 notifications/cancelled 를 보낸 상황
      ctrl.abort('client cancelled');
      return fakeResult();
    });
    let thrown: unknown;
    try {
      await detectReview({ rcept_no: '20260617000447' }, { signal: ctrl.signal });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToolError);
    expect((thrown as ToolError).code).toBe('request_cancelled');
    // 쓸 수 있는 id 를 주지 않는다
    expect(serializeToolResult(toErrorResponse(thrown))).not.toMatch(/[0-9a-f]{32}/);
    // 보관소가 그대로다 — 새로 저장되지도, 앞 결과가 회수되지도 않았다
    expect(detectionResultStats().ids).toEqual(ids);
    expect(readDetectionResult({ result_id: ids[0]!, section: 'summary' }).complete).toBe(true);

    const later = rec(await detectReview({ rcept_no: '20260617000447' }));
    expect(
      readDetectionResult({ result_id: later['detail_access'].result_id, section: 'summary' }).complete,
    ).toBe(true);
  });
});

describe('새 응답 메타·오류도 바이트 예산 안이다 (Fable M1·M2)', () => {
  beforeEach(() => {
    clearDetectionResults();
    engine.impl.mockReset();
  });

  it('최상위 키 100개가 200자 한글이어도 첫 응답은 예산 안이고, 실린 이름은 원본 그대로다', async () => {
    const extra: Record<string, unknown> = {};
    for (let i = 0; i < 100; i += 1) extra[('키' + String(i).padStart(3, '0')).padEnd(200, '한')] = [i];
    const full = fakeResult(extra);
    engine.impl.mockResolvedValue(full);
    const out = rec(await detectReview({ rcept_no: '20260617000447' }));
    expect(bytesOf(out)).toBeLessThanOrEqual(TOOL_RESULT_BYTE_BUDGET);
    const listed: string[] = out['detail_access'].available_sections;
    expect(out['detail_access'].available_sections_total).toBe(Object.keys(full).length);
    expect(listed.length).toBeLessThan(out['detail_access'].available_sections_total);
    for (const name of listed) expect(Object.keys(full)).toContain(name);
  });

  it('보관 실패 오류는 summary 가 거대해도 최종 오류 문자열이 예산 안이고 usable id 가 없다', async () => {
    const hugeSummary: Record<string, unknown> = { complete: true, undisclosed_candidates: 2 };
    for (let i = 0; i < 3_000; i += 1) hugeSummary[`bucket_${i}`] = korean(50, `카운터 ${i} `);
    engine.impl.mockResolvedValue(fakeResult({ blob: korean(6_000_000), summary: hugeSummary }));
    let thrown: unknown;
    try {
      await detectReview({ rcept_no: '20260617000447' });
    } catch (err) {
      thrown = err;
    }
    const e = thrown as ToolError;
    expect(e.code).toBe('resource_limit');
    expect(e.details?.['detection_completed']).toBe(true);
    const wire = serializeToolResult(toErrorResponse(e));
    expect(Buffer.byteLength(wire, 'utf8')).toBeLessThanOrEqual(TOOL_RESULT_BYTE_BUDGET);
    expect(wire).not.toContain('"result_id"');
    expect(rec(e.details?.['summary']).undisclosed_candidates).toBe(2);
    expect(detectionResultStats().count).toBe(0);
  });
});
