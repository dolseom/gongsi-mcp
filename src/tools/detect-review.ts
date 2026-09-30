/**
 * `detect_undisclosed_transactions` 의 **MCP 응답 어댑터**.
 *
 * 왜 어댑터인가: 탐지 엔진의 완전한 결과는 실물에서 222,709자~1MB다. 그 크기는 MCP 호스트가
 * 전달하지 못해 **판정이 하나도 도달하지 않는다**(실측: "exceeds maximum allowed tokens").
 * → 엔진 출력은 한 글자도 바꾸지 않고 그대로 보관하고(`src/lib/detection-results.ts`),
 *   첫 응답에는 **바이트 예산 안에서** 조치 목록·집계·실질 경고만 싣고 상세 조회 경로를 준다.
 *
 * ★ 엔진 함수(`detectUndisclosedTransactions`)는 그대로 둔다 — 직접 호출하는 테스트와 내부
 *   소비자는 종전 전체 출력을 그대로 받는다. 이 파일은 MCP 등록 지점에만 끼어든다.
 *
 * ★ 첫 응답의 경고 우선순위는 **고정**이다 (구현자가 고르지 않는다):
 *   ① 시간 예산 중단·부분 검색 여부 ② coverage.undetectable 의 실질 미검토 범위
 *   ③ 후보≠확정 / 0건≠이상 없음 ④ 원문 caveat·notes 총수 ⑤ 남는 예산 안에서 앞 200자 preview
 *   잘린 것은 전문 section 조회 경로와 details_required·incomplete 로 남긴다.
 *   예산이 모자라면 **역순으로** 덜어낸다 — preview → scope·continuation 세부 → 집계 → 미검토 범위 원문.
 *   고정 경고(required_warnings)와 이어보기 토큰은 끝까지 남긴다.
 */

import {
  detectUndisclosedTransactions,
  detectUndisclosedTransactionsInput,
  type DetectUndisclosedTransactionsInput,
} from './detect-undisclosed-transactions.js';
import {
  boundedSectionList,
  storeDetectionResult,
  SNAPSHOT_TTL_MS,
  MAX_SNAPSHOTS,
  type StoredSnapshot,
} from '../lib/detection-results.js';
import { ToolError } from '../lib/errors.js';
import { previewText, TOOL_RESULT_BYTE_BUDGET, toolResultBytes } from '../lib/tool-output.js';
import { MAX_READ_CHARS } from './read-detection-result.js';

export { detectUndisclosedTransactionsInput as detectReviewInput };
export type { DetectUndisclosedTransactionsInput as DetectReviewInput };

/** 첫 응답에 실을 조치 항목 수 — 나머지는 수만 밝히고 상세 조회로 보낸다 */
const ACTION_PREVIEW_LIMIT = 5;
/** caveat·note 원문 preview 길이 (UTF-16 단위) */
const CAVEAT_PREVIEW_CHARS = 200;
/** preview 를 잘랐다는 표시 — 이 표시가 붙은 줄은 원문의 일부만 실린 것이다 */
const PREVIEW_CUT_MARK = '…(전문: read_detection_result';
/** 최후 단계에서 scope·continuation 값 하나에 허용하는 길이 (UTF-16 단위) */
const COMPACT_VALUE_CHARS = 200;

/** 크기가 모자랄 때도 남기는 scope 핵심 키 — 어느 문서·어느 시점 판정인지 */
const SCOPE_KEYS = [
  'source_rcept_no',
  'source_viewer_url',
  'source_report_nm',
  'source_acode',
  'group',
  'filing_year',
  'fiscal_year',
  'judged_at',
] as const;
/**
 * 크기가 모자랄 때도 남기는 continuation 핵심 키.
 * ★ `complete`·`token` 은 절대 버리지 않는다 — 토큰을 잃으면 온전한 답에 이를 길이 사라진다.
 */
const CONTINUATION_KEYS = ['complete', 'token', 'call_index', 'expires_at', 'stalled', 'next_step'] as const;

/** MCP 로 나가는 요약의 모양 */
interface DetectSummary {
  /** ★ 상세를 읽을 열쇠 — 30분 뒤 만료되고 서버 프로세스 안에서만 유효하다 */
  detail_access: {
    result_id: string;
    expires_at: string;
    total_chars: number;
    available_sections: string[];
    available_sections_total: number;
    how_to_read: string;
    lifetime_note: string;
  };
  scope: Record<string, unknown>;
  continuation: Record<string, unknown>;
  /** 상태별 바구니를 가로질러 모은 **지금 확인할 것** — 전체는 상세의 action_items 에 있다 */
  action_items_preview: {
    total: number;
    shown: number;
    omitted: number;
    note?: string | undefined;
    read_all?: string | undefined;
    items: unknown[];
  };
  summary: Record<string, unknown>;
  coverage_undetectable: Record<string, unknown>;
  required_warnings: string[];
  /** 원문 caveat·note 는 전문이 아니라 **총수 + preview** 다 (전문은 section 조회) */
  caveats_and_notes: {
    scope_caveats_total: number;
    notes_total: number;
    full_text_sections: string[];
    note: string;
    scope_caveats_preview: string[];
    notes_preview: string[];
  };
  /** 이 응답이 원본의 일부라는 사실 — 모델이 "완결"로 착각하지 않게 구조로 남긴다 */
  details_required: true;
  summary_incomplete: boolean;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function readCall(resultId: string, section: string): string {
  return `read_detection_result{result_id:"${resultId}", section:"${section}"}`;
}

/** 어댑터가 받는 요청 맥락 */
export interface DetectReviewContext {
  /** MCP 요청 취소 신호 (`notifications/cancelled`) */
  signal?: AbortSignal;
}

/**
 * 취소 오류 — 결과를 보관하지 않았고 쓸 수 있는 result_id 가 없다는 사실만 말한다.
 * (SDK 는 취소된 요청의 응답을 전송하지 않지만, 내부 로그·테스트가 사유를 구분할 수 있게 한다.)
 */
function cancelledError(stage: 'before_engine' | 'after_engine'): ToolError {
  return new ToolError(
    'request_cancelled',
    '요청이 취소돼 탐지 결과를 보관하지 않았습니다 (result_id 없음). ' +
      (stage === 'after_engine'
        ? '취소 전에 시작된 DART 조회는 이미 끝났을 수 있습니다 — 탐지 엔진은 중간 취소를 지원하지 않습니다. '
        : '') +
      '결과가 필요하면 다시 탐지하세요.',
    { stage },
  );
}

/** 보관 실패 오류에 동봉할 집계의 상한 — 오류 응답 전체가 응답 예산 안에 들어가게 한다 (Fable M2) */
const ERROR_SUMMARY_BYTE_BUDGET = 8_192;

/**
 * 보관 실패 오류용 집계 — 작으면 그대로, 크면 **원시값 카운터만** 앞에서부터 예산까지 싣고 빠진 수를 밝힌다.
 * (N6: "판정은 됐고 상세만 못 보관했다" 를 구분할 집계는 남기되, 오류 자체가 예산을 넘지 않게)
 */
function boundedErrorSummary(summary: Record<string, unknown>): Record<string, unknown> {
  if (toolResultBytes(summary) <= ERROR_SUMMARY_BYTE_BUDGET) return summary;
  const out: Record<string, unknown> = {};
  let omitted = 0;
  for (const [key, value] of Object.entries(summary)) {
    const primitive =
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null ||
      (typeof value === 'string' && value.length <= COMPACT_VALUE_CHARS);
    if (!primitive || key.length > COMPACT_VALUE_CHARS) {
      omitted += 1;
      continue;
    }
    if (toolResultBytes({ ...out, [key]: value }) > ERROR_SUMMARY_BYTE_BUDGET - 512) {
      omitted += 1;
      continue;
    }
    out[key] = value;
  }
  out['summary_truncated'] = {
    omitted_keys: omitted,
    note: '오류 응답 크기 때문에 집계의 원시값 일부만 실었습니다. 상세는 보관되지 않았으므로 더 좁은 범위로 다시 탐지하세요.',
  };
  return out;
}

/**
 * 최후 단계용 — 지정한 키의 **원시값만** 남긴다(문자열은 앞 200자). 나머지 키는 수와 조회 경로만.
 */
function compactRecord(
  src: Record<string, unknown>,
  keys: readonly string[],
  section: string,
  resultId: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'string') {
      const p = previewText(v, COMPACT_VALUE_CHARS);
      out[k] = p.truncated ? `${p.text}…` : p.text;
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[k] = v;
    }
  }
  const omitted = Object.keys(src).filter((k) => !(k in out));
  if (omitted.length > 0) {
    out['omitted_due_to_size'] = { keys_total: omitted.length, read: readCall(resultId, section) };
  }
  return out;
}

/**
 * preview 개수와 **일치하는** 미완결 경고를 붙인다.
 * 덜어낸 뒤에 다시 계산해야 경고 속 "조치 5/83" 같은 숫자가 실제 응답과 어긋나지 않는다.
 */
function finalize(
  o: DetectSummary,
  totals: { actions: number; scopeCaveats: number; notes: number },
): DetectSummary {
  const shown = o.action_items_preview.items.length;
  const preview = {
    ...o.action_items_preview,
    shown,
    omitted: Math.max(0, totals.actions - shown),
  };
  // ★ 개수가 다 실렸어도 원문을 앞 200자로 잘랐으면 **완결이 아니다** (실물 m07: 19건 전부 잘림).
  const cutPreviews = [
    ...o.caveats_and_notes.scope_caveats_preview,
    ...o.caveats_and_notes.notes_preview,
  ].filter((line) => line.includes(PREVIEW_CUT_MARK)).length;
  const incomplete =
    shown < totals.actions ||
    o.caveats_and_notes.scope_caveats_preview.length < totals.scopeCaveats ||
    o.caveats_and_notes.notes_preview.length < totals.notes ||
    cutPreviews > 0;
  if (!incomplete) return { ...o, action_items_preview: preview };
  return {
    ...o,
    action_items_preview: preview,
    summary_incomplete: true,
    required_warnings: [
      ...o.required_warnings,
      '⚠️ 이 요약은 응답 크기 예산 때문에 **일부만** 실었습니다 ' +
        `(조치 ${shown}/${totals.actions} · ` +
        `scope_caveats ${o.caveats_and_notes.scope_caveats_preview.length}/${totals.scopeCaveats} · ` +
        `notes ${o.caveats_and_notes.notes_preview.length}/${totals.notes}` +
        (cutPreviews > 0 ? ` · 앞 ${CAVEAT_PREVIEW_CHARS}자로 자른 caveat·note ${cutPreviews}건` : '') +
        '). ' +
        '빠진 것은 read_detection_result 로 반드시 읽으세요.',
    ],
  };
}

/**
 * MCP 로 나가는 탐지 응답.
 *
 * 실패 계약은 그대로다 — 입력 오류·API 오류는 엔진이 던지는 그대로 밖으로 나가고 snapshot 을
 * 만들지 않는다(보관할 결과가 없다).
 */
export async function detectReview(
  input: DetectUndisclosedTransactionsInput,
  ctx: DetectReviewContext = {},
): Promise<unknown> {
  // ★ 취소는 두 번 본다. 엔진 시작 전, 그리고 엔진이 끝난 뒤 **보관 전**.
  //   두 번째 검사와 storeDetectionResult 사이에는 await 가 없어 그 사이에 취소가 끼어들 수 없다.
  //   취소된 요청이 snapshot 을 저장하면 받을 수 없는 결과가 한 칸을 차지해 앞 result_id 를 회수시킨다
  //   (2026-09-13 live 실측). 엔진 자체는 중간 취소를 지원하지 않아 이미 시작된 DART 조회는 끝까지 돈다.
  if (ctx.signal?.aborted) throw cancelledError('before_engine');
  const full = await detectUndisclosedTransactions(input);
  if (ctx.signal?.aborted) throw cancelledError('after_engine');
  const payload = asRecord(full);

  const summary = asRecord(payload['summary']);
  const scope = asRecord(payload['scope']);
  const continuation = asRecord(payload['continuation']);
  const coverage = asRecord(payload['coverage']);
  const actionItems = asRecord(payload['action_items']);
  const scopeCaveats = asStringArray(payload['scope_caveats']);
  const notes = asStringArray(payload['notes']);

  // ── 보관 ──
  // 보관에 실패하면 **usable token 을 주지 않는다.** 다만 탐지 자체는 성공한 것이므로
  // summary 를 오류에 동봉해 "판정은 됐고 상세만 못 보관했다" 를 구분할 수 있게 한다 (N6).
  let stored: StoredSnapshot;
  try {
    stored = storeDetectionResult(full);
  } catch (err) {
    if (err instanceof ToolError) {
      throw new ToolError(err.code, err.message, {
        ...(err.details ?? {}),
        detection_completed: true,
        summary: boundedErrorSummary(summary),
        note:
          '이 오류는 **상세 보관 실패**이고 탐지 실패가 아닙니다. 위 summary 의 집계는 실제 판정 ' +
          '결과이지만, 근거·caveat 전문은 이번 호출에서 읽을 수 없습니다.',
      });
    }
    throw err;
  }
  const resultId = stored.result_id;

  const allItems = Array.isArray(actionItems['items']) ? actionItems['items'] : [];
  const actionTotal = typeof actionItems['total'] === 'number' ? actionItems['total'] : allItems.length;
  const totals = { actions: actionTotal, scopeCaveats: scopeCaveats.length, notes: notes.length };

  const requiredWarnings: string[] = [];
  const truncated = summary['time_budget_truncated'] === true;
  const searchComplete = continuation['complete'] === true;

  // ① 시간 예산 중단·부분 검색
  if (truncated) {
    requiredWarnings.push(
      '⚠️ 시간 예산으로 **범위가 잘린 부분 결과**입니다 — 보지 못한 범위는 "후보 없음"이 아니라 ' +
        '확인하지 못한 것입니다 (coverage.not_examined_due_to_time_budget · diagnostics.budget).',
    );
  }
  if (!searchComplete) {
    requiredWarnings.push(
      '⚠️ 검색이 완결되지 않았습니다 (continuation.complete=false) — continuation_token 으로 ' +
        'complete:true 가 나올 때까지 다시 호출해야 온전한 답입니다. 이 결과를 최종으로 제시하지 마세요.',
    );
  }

  // ② coverage.undetectable — 실질 미검토 범위 (고정 크기)
  const undetectable = asRecord(coverage['undetectable']);

  // ③ 후보≠확정 / 0건≠이상 없음 (언제나 나간다)
  requiredWarnings.push(
    '후보(candidate)는 확정이 아닙니다. 그리고 **0건은 "이상 없음"이 아닙니다** — 이 도구의 원천은 ' +
      'J004 한 문서이고, 거기 기재되지 않은 거래·"주요" 기준 미달 거래·담보/채무보증/임대차/기타자산은 ' +
      '애초에 보이지 않습니다 (coverage.undetectable).',
  );
  requiredWarnings.push(
    '검색 완결(continuation.complete)과 **상세 열람 완료는 다릅니다** — 아래 근거·caveat 전문을 ' +
      'read_detection_result 로 읽지 않은 상태에서 "확인했다"고 말하지 마세요.',
  );

  // section 목록 자체가 예산을 밀어내지 않게 상한을 둔다 (실물은 40여 개)
  const sectionList = boundedSectionList(stored.sections);

  let out: DetectSummary = {
    detail_access: {
      result_id: resultId,
      expires_at: stored.expires_at,
      total_chars: stored.total_chars,
      available_sections: sectionList.list,
      available_sections_total: sectionList.total,
      how_to_read:
        `read_detection_result{result_id:"${resultId}", section:"<위 목록 중 하나>"} 로 ` +
        `상세를 읽습니다. 한 번에 최대 ${MAX_READ_CHARS}자이고, next_offset 을 넣어 이어 읽으면 ` +
        '원본과 정확히 같아집니다. section 을 생략하면 결과 전체를 처음부터 읽습니다.',
      lifetime_note:
        `수명 ${SNAPSHOT_TTL_MS / 60000}분 · 동시 보관 ${MAX_SNAPSHOTS}건. ` +
        '이어보기로 여러 번 호출하면 **앞 호출의 result_id 는 회수될 수 있습니다** — ' +
        'continuation.complete:true 를 낸 마지막 호출의 result_id 를 쓰세요. ' +
        '서버가 다시 시작되면 상세는 남지 않고 다시 탐지해야 합니다.',
    },
    scope,
    continuation,
    action_items_preview: {
      total: actionTotal,
      shown: 0,
      omitted: actionTotal,
      note: typeof actionItems['note'] === 'string' ? actionItems['note'] : undefined,
      read_all: actionTotal > 0 ? 'read_detection_result section:"action_items"' : undefined,
      items: [],
    },
    summary,
    coverage_undetectable: undetectable,
    required_warnings: requiredWarnings,
    caveats_and_notes: {
      scope_caveats_total: scopeCaveats.length,
      notes_total: notes.length,
      full_text_sections: ['scope_caveats', 'notes'].filter((s) => stored.sections.includes(s)),
      note:
        'scope_caveats·notes 전문은 응답 크기 때문에 여기 싣지 않았습니다 — 위 section 으로 ' +
        '읽으세요. **읽지 않은 caveat 를 없는 것으로 취급하지 마세요.**',
      scope_caveats_preview: [],
      notes_preview: [],
    },
    details_required: true,
    summary_incomplete: false,
  };
  const fits = (o: DetectSummary): boolean =>
    toolResultBytes(finalize(o, totals)) <= TOOL_RESULT_BYTE_BUDGET;

  // ── 바이트 예산 안에서 채운다 (우선순위: 조치 preview → caveat preview) ──
  for (const item of allItems.slice(0, ACTION_PREVIEW_LIMIT)) {
    const trial: DetectSummary = {
      ...out,
      action_items_preview: { ...out.action_items_preview, items: [...out.action_items_preview.items, item] },
    };
    if (!fits(trial)) break;
    out = trial;
  }

  for (const [key, list, section] of [
    ['scope_caveats_preview', scopeCaveats, 'scope_caveats'],
    ['notes_preview', notes, 'notes'],
  ] as const) {
    for (const raw of list) {
      const p = previewText(raw, CAVEAT_PREVIEW_CHARS);
      const line = p.truncated ? `${p.text}${PREVIEW_CUT_MARK} section="${section}")` : p.text;
      const trial: DetectSummary = {
        ...out,
        caveats_and_notes: { ...out.caveats_and_notes, [key]: [...out.caveats_and_notes[key], line] },
      };
      if (!fits(trial)) break;
      out = trial;
    }
  }

  // 채운 뒤에도 넘치면(예: 거대한 scope·continuation) preview 를 뒤에서부터 덜어낸다.
  // 경고 속 개수는 finalize 가 덜어낸 **뒤** 다시 센다.
  while (!fits(out)) {
    const c = out.caveats_and_notes;
    if (c.notes_preview.length > 0) {
      out = { ...out, caveats_and_notes: { ...c, notes_preview: c.notes_preview.slice(0, -1) } };
    } else if (c.scope_caveats_preview.length > 0) {
      out = { ...out, caveats_and_notes: { ...c, scope_caveats_preview: c.scope_caveats_preview.slice(0, -1) } };
    } else if (out.action_items_preview.items.length > 0) {
      out = {
        ...out,
        action_items_preview: { ...out.action_items_preview, items: out.action_items_preview.items.slice(0, -1) },
      };
    } else {
      break;
    }
  }

  const done = finalize(out, totals);
  if (toolResultBytes(done) <= TOOL_RESULT_BYTE_BUDGET) return done;

  // ── 최후 수단 — preview 를 다 덜어내도 예산을 넘을 때 (엔진 출력이 비정상적으로 클 때) ──
  // **경고는 그대로 남긴다** — 크기를 맞추려고 실질 경고를 지우지 않는다.
  // 1) scope·continuation 을 핵심 값만 (complete·token 유지)
  let fallback: DetectSummary = {
    ...done,
    scope: compactRecord(scope, SCOPE_KEYS, 'scope', resultId),
    continuation: compactRecord(continuation, CONTINUATION_KEYS, 'continuation', resultId),
    summary_incomplete: true,
    required_warnings: [
      ...done.required_warnings,
      '⚠️ scope·continuation 은 응답 크기 예산 때문에 핵심 값(complete·token 등)만 실었습니다 — ' +
        '나머지는 해당 section 으로 읽으세요.',
    ],
  };
  if (toolResultBytes(fallback) <= TOOL_RESULT_BYTE_BUDGET) return fallback;

  // 2) 집계를 상세로
  fallback = {
    ...fallback,
    summary: { summary_omitted_due_to_size: true, read: readCall(resultId, 'summary') },
    required_warnings: [
      ...fallback.required_warnings,
      '⚠️ 집계(summary)조차 응답 크기 예산을 넘어 상세로 넘겼습니다 — 위 section 으로 읽으세요. ' +
        '집계를 읽지 않은 상태에서 결론을 말하지 마세요.',
    ],
  };
  if (toolResultBytes(fallback) <= TOOL_RESULT_BYTE_BUDGET) return fallback;

  // 3) 미검토 범위 원문을 상세로 — 고정 경고 ③ 이 "보이지 않는 범위"의 요지를 이미 말한다
  return {
    ...fallback,
    coverage_undetectable: { omitted_due_to_size: true, read: readCall(resultId, 'coverage') },
    required_warnings: [
      ...fallback.required_warnings,
      '⚠️ 미검토 범위(coverage.undetectable) 원문도 크기 때문에 상세로 넘겼습니다 — 읽기 전에는 ' +
        '탐지 범위를 좁혀 말하지 마세요.',
    ],
  };
}
