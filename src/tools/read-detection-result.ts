/**
 * `read_detection_result` — 탐지 결과의 상세를 **크기 제한 안에서** 이어 읽는다.
 *
 * 왜 필요한가: `detect_undisclosed_transactions` 의 완전한 결과(실물 222,709자~1MB)는 MCP
 * 호스트가 전달하지 못한다. 그래서 첫 응답은 요약이고, 근거·caveat 전문은 이 도구로 읽는다.
 *
 * 계약:
 *  - 같은 snapshot 의 조각을 `offset` 순서대로 이어붙이면 **원본 JSON 문자열과 정확히 같다.**
 *  - `offset`·`total_chars` 의 단위는 **UTF-16 코드 단위**(JavaScript 문자열 길이)다. 바이트가
 *    아니다 — 한글 1자는 1 단위이고 UTF-8 3바이트다.
 *  - surrogate pair(이모지 등) 중간에서 자르지 않는다 — 경계에 걸리면 한 단위 앞에서 끊는다.
 *  - **중간 조각은 그 자체로 유효한 JSON 이 아니다.** 이어붙인 뒤에 파싱하라.
 */

import { z } from 'zod';
import {
  boundedSectionList,
  getDetectionResult,
  getDetectionSection,
  type Clock,
} from '../lib/detection-results.js';
import { ToolError } from '../lib/errors.js';
import {
  TOOL_RESULT_BYTE_BUDGET,
  safeSliceEnd,
  serializeToolResult,
} from '../lib/tool-output.js';

/**
 * 한 번에 요청할 수 있는 최대 문자 수.
 *
 * 한글은 UTF-8 3바이트라 8,000자 × 3 = 24,000바이트 + 메타 < 24,576이다. 이 값은 **상한**이고,
 * 서버는 남은 바이트 예산에 맞춰 **더 짧게** 돌려줄 수 있다 (그때도 `next_offset` 이 진전한다).
 */
export const MAX_READ_CHARS = 8_000;

export const readDetectionResultInput = z.object({
  result_id: z
    .string()
    .regex(/^[0-9a-f]{32}$/, 'result_id 는 32자리 16진수입니다')
    .describe(
      'detect_undisclosed_transactions 요약 응답이 준 result_id. ' +
        '수명은 30분이고 서버 프로세스 안에서만 유효합니다',
    ),
  section: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      '읽을 최상위 항목 이름 (요약의 available_sections 목록 중 하나). 예: goods_services_signals · ' +
        'coverage · scope_caveats · notes. 생략하면 결과 전체를 읽습니다. ' +
        '파일 경로나 a.b 형태의 중첩 표현은 받지 않습니다',
    ),
  offset: z
    .number()
    .int()
    .nonnegative('offset 은 0 이상의 정수입니다')
    .optional()
    .describe(
      '이어 읽을 시작 위치 (UTF-16 코드 단위, 기본 0). 앞 호출이 준 next_offset 을 그대로 넣으세요',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_READ_CHARS, `limit 은 ${MAX_READ_CHARS} 이하입니다`)
    .optional()
    .describe(
      `한 번에 읽을 최대 문자 수 (UTF-16 코드 단위, 기본·최대 ${MAX_READ_CHARS}). ` +
        '응답 크기 예산에 맞춰 더 짧게 돌아올 수 있습니다',
    ),
});

export type ReadDetectionResultInput = z.infer<typeof readDetectionResultInput>;

interface ReadDetectionResultOutput {
  result_id: string;
  /** 읽은 항목 — 전체를 읽었으면 null */
  section: string | null;
  /** 이 snapshot 에서 읽을 수 있는 항목 목록 (응답 크기 때문에 앞 일부만일 수 있다) */
  available_sections: string[];
  /** 읽을 수 있는 항목의 실제 총수 — 목록 길이와 다르면 목록이 잘린 것이다 */
  available_sections_total: number;
  offset: number;
  /** 다음 호출에 넣을 offset — null 이면 끝이다 */
  next_offset: number | null;
  /** 이 section(또는 전체)의 총 길이 (UTF-16 코드 단위) */
  total_chars: number;
  /** 이 조각으로 끝까지 읽었는가 */
  complete: boolean;
  expires_at: string;
  /** 원본 JSON 문자열의 연속 조각 */
  text: string;
  notes: string[];
}

const OFFSET_NOTE =
  'offset·total_chars 의 단위는 UTF-16 코드 단위(JavaScript 문자열 길이)입니다 — 바이트가 아닙니다. ' +
  '한글 1자는 1 단위이고 UTF-8 3바이트입니다.';
const PARTIAL_NOTE =
  '이 text 는 원본 JSON 문자열의 **연속 조각**입니다. 중간 조각은 그 자체로 유효한 JSON 이 아닐 수 ' +
  '있으니, 조각을 offset 순서대로 모두 이어붙인 뒤에 해석하세요.';

/**
 * 섹션 이름이 snapshot 자기 소유 최상위 key 인지 미리 걸러낸다.
 * 경로·중첩 표현·프로토타입 오염 시도는 조회 전에 거절한다 — 저장소가 Map 이라 위험하지는
 * 않지만, 그런 입력을 "없는 section" 으로 뭉개면 사용자가 왜 실패했는지 모른다.
 */
function assertPlainSectionName(section: string): void {
  if (/[./\\[\]"'`\s]/.test(section)) {
    throw new ToolError(
      'invalid_argument',
      `section '${section}' 은(는) 항목 이름 하나여야 합니다 — 파일 경로나 a.b 형태의 중첩 표현, ` +
        '공백·따옴표를 포함할 수 없습니다. 요약 응답의 sections 목록에서 그대로 골라 넣으세요.',
      { section },
    );
  }
}

export function readDetectionResult(
  input: ReadDetectionResultInput,
  opts: { clock?: Clock } = {},
): ReadDetectionResultOutput {
  const clockOpts = opts.clock ? { clock: opts.clock } : {};
  let text: string;
  let expiresAt: string;
  let sections: string[];

  if (input.section === undefined) {
    const snap = getDetectionResult(input.result_id, clockOpts);
    text = snap.text;
    expiresAt = snap.expires_at;
    sections = snap.sections;
  } else {
    assertPlainSectionName(input.section);
    const sec = getDetectionSection(input.result_id, input.section, clockOpts);
    text = sec.text;
    expiresAt = sec.expires_at;
    sections = sec.sections;
  }

  const total = text.length;
  const offset = input.offset ?? 0;
  if (offset > total) {
    throw new ToolError(
      'invalid_argument',
      `offset(${offset}) 이 총 길이(${total})를 넘습니다. 앞 호출이 준 next_offset 을 쓰거나 0 부터 읽으세요.`,
      { total_chars: total },
    );
  }

  const wanted = Math.min(input.limit ?? MAX_READ_CHARS, MAX_READ_CHARS);
  // section 목록이 예산을 밀어내면 조각을 아무리 줄여도 수렴하지 않는다 — 목록에 상한을 둔다
  const listed = boundedSectionList(sections);
  const meta = {
    result_id: input.result_id,
    section: input.section ?? null,
    available_sections: listed.list,
    available_sections_total: listed.total,
    offset,
    total_chars: total,
    expires_at: expiresAt,
  };

  // ── 바이트 예산에 맞춘 조각 길이 결정 ──
  // 한글·따옴표·역슬래시는 JSON escape 로 부풀기 때문에 **직렬화한 최종 문자열**로 재야 한다.
  // 길이를 줄여 가며 맞춘다 (문자 수 → 바이트는 단조 증가라 이 축소는 항상 수렴한다).
  let end = chunkEnd(text, offset, offset + wanted);
  let chunk = text.slice(offset, end);
  let out = buildOutput(meta, chunk, end, total);
  while (
    Buffer.byteLength(serializeToolResult(out), 'utf8') > TOOL_RESULT_BYTE_BUDGET &&
    end > offset + 2
  ) {
    // 초과분을 바이트→문자로 어림잡아 한 번에 줄인다 (최악 3바이트/자 가정 + 여유 8자)
    const over = Buffer.byteLength(serializeToolResult(out), 'utf8') - TOOL_RESULT_BYTE_BUDGET;
    const shrink = Math.max(8, Math.ceil(over / 3) + 8);
    end = chunkEnd(text, offset, end - shrink);
    chunk = text.slice(offset, end);
    out = buildOutput(meta, chunk, end, total);
  }

  // 최소 조각에서도 넘친다 = 메타가 비정상적으로 크다. 이름 목록을 비우고(총수는 남긴다) 다시 잰다.
  // 목록 상한이 있어 정상 경로에서는 오지 않지만, **예산을 넘는 응답을 절대 내보내지 않는다.**
  if (Buffer.byteLength(serializeToolResult(out), 'utf8') > TOOL_RESULT_BYTE_BUDGET) {
    out = buildOutput({ ...meta, available_sections: [] }, chunk, end, total);
  }
  if (Buffer.byteLength(serializeToolResult(out), 'utf8') > TOOL_RESULT_BYTE_BUDGET) {
    throw new ToolError(
      'resource_limit',
      `응답 크기 예산(${TOOL_RESULT_BYTE_BUDGET}바이트) 안에 이 조각을 담을 수 없습니다. limit 을 줄여 다시 호출하세요.`,
      { offset, budget_bytes: TOOL_RESULT_BYTE_BUDGET },
    );
  }

  return out;
}

/**
 * 조각의 끝 offset — surrogate 경계를 지키면서 **반드시 전진한다.**
 *
 * ⚠️ 경계 보정만 하면 `offset` 바로 뒤가 surrogate pair 의 앞짝일 때 길이 0 짜리 조각이 나오고
 * `next_offset === offset` 이 되어 **무한 반복**이 된다. 남은 텍스트가 있으면 최소 한 쌍(2 단위)은
 * 준다 — 그러면 next_offset 이 단조 증가한다.
 */
function chunkEnd(text: string, offset: number, target: number): number {
  const total = text.length;
  if (offset >= total) return total;
  const safe = safeSliceEnd(text, Math.min(Math.max(target, offset + 1), total));
  if (safe <= offset) return Math.min(offset + 2, total);
  return safe;
}

function buildOutput(
  meta: {
    result_id: string;
    section: string | null;
    available_sections: string[];
    available_sections_total: number;
    offset: number;
    total_chars: number;
    expires_at: string;
  },
  chunk: string,
  end: number,
  total: number,
): ReadDetectionResultOutput {
  const complete = end >= total;
  const notes = [OFFSET_NOTE];
  if (meta.available_sections.length < meta.available_sections_total) {
    notes.push(
      `available_sections 는 응답 크기 때문에 ${meta.available_sections.length}/${meta.available_sections_total}개만 ` +
        '나열했습니다. 나머지 항목은 section 을 생략하고 전체를 읽으면 보입니다.',
    );
  }
  if (!complete) {
    notes.push(PARTIAL_NOTE);
    notes.push(
      `아직 ${total - end}자가 남았습니다 — 같은 result_id 와 next_offset(${end}) 으로 다시 호출하세요. ` +
        '남은 부분을 읽지 않은 채 "확인했다"고 말하지 마세요.',
    );
  } else if (meta.offset > 0) {
    notes.push(PARTIAL_NOTE);
  }
  return {
    result_id: meta.result_id,
    section: meta.section,
    available_sections: meta.available_sections,
    available_sections_total: meta.available_sections_total,
    offset: meta.offset,
    next_offset: complete ? null : end,
    total_chars: total,
    complete,
    expires_at: meta.expires_at,
    text: chunk,
    notes,
  };
}
