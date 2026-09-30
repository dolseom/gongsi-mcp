/**
 * 탐지 결과의 **프로세스 범위 임시 보관소**.
 *
 * 왜 필요한가: `detect_undisclosed_transactions` 의 완전한 결과는 실물에서 222,709자~1MB다
 * (미래에셋 계열 13개사가 가장 작은 표본, 케이티는 783KB). MCP 호스트는 그 크기를 전달하지
 * 못해 **응답이 통째로 사라진다** — 모델도 사용자도 판정을 하나도 받지 못한다.
 * → 첫 응답은 요약만 보내고, 원본은 여기 보관해 `read_detection_result` 로 이어서 읽는다.
 *
 * ★ 이것은 **기술 캐시가 아니다**(`src/lib/store.ts` 와 역할이 다르다).
 *   - 회사 프로필·판정 이력을 쌓는 영구 저장이 아니다. 프로세스 메모리에만 있고 30분 뒤 만료된다.
 *   - 파일·DB 에 쓰지 않는다. 서버가 죽으면 함께 사라지고, 그때는 다시 탐지해야 한다.
 *   - `result_id` 는 **이 stdio 서버 프로세스 안의 bearer capability** 다. 다른 프로세스와
 *     공유되지 않으며, 다중 사용자 인증 격리를 제공한다고 주장하지 않는다 (stdio 서버는
 *     사용자 1명의 프로세스다).
 *   - 검색 이어보기 토큰(`continuation_token`)과는 **별개**다. 그쪽은 "안 본 회사를 이어서
 *     검색"하는 것이고, 이쪽은 "이미 낸 판정을 이어서 읽는" 것이다.
 */

import { randomBytes } from 'node:crypto';
import { ToolError } from './errors.js';
import { serializeToolResult } from './tool-output.js';

/** snapshot 수명 — 실무자가 요약을 읽고 상세를 물어보는 왕복에 넉넉하고, 잊힌 결과는 빨리 비운다 */
export const SNAPSHOT_TTL_MS = 30 * 60 * 1000;
/** 동시 보관 수 — 이어보기로 여러 번 부르면 밀려난다(가장 오래된 것부터). N5 안내 문구의 근거다 */
export const MAX_SNAPSHOTS = 4;
/** 단일 snapshot 상한 (직렬화 바이트) */
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
/** 전체 보관 상한 (직렬화 바이트) */
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** 응답에 이름을 나열하는 section 수 상한 — 실물 결과의 최상위 항목은 40여 개다 */
const MAX_LISTED_SECTIONS = 100;
/** 나열할 section 이름 길이 상한 — 입력 스키마의 section 최대 길이와 같다 */
const MAX_SECTION_NAME_CHARS = 200;
/**
 * 나열할 section 이름들의 **직렬화 바이트** 합 상한.
 * 개수(100)만 제한하면 200자 한글 키 100개가 목록만으로 61KB 가 됐다(Fable M1 프로브 A).
 * 실물 최상위 키 24개(ASCII)는 약 600B 라 이 상한에 걸리지 않는다.
 */
const MAX_LISTED_SECTION_BYTES = 4_096;

/**
 * 응답에 싣는 section 목록 — **목록 자체가 응답 크기 예산을 밀어내지 않게** 개수·바이트 상한을 둔다.
 * 실린 이름은 원본 키 그대로이고(자르지 않는다), 빠진 수는 omitted·total 로 드러난다.
 * 목록에서 빠진 section 도 이름을 알면 읽을 수 있고, section 을 생략하면 전체 원본 JSON 에서 보인다.
 */
export function boundedSectionList(sections: readonly string[]): {
  list: string[];
  total: number;
  omitted: number;
  truncated: boolean;
} {
  const list: string[] = [];
  let bytes = 0;
  for (const name of sections) {
    if (list.length >= MAX_LISTED_SECTIONS) break;
    if (name.length > MAX_SECTION_NAME_CHARS) continue;
    // JSON 문자열 escape + 들여쓰기·쉼표·개행 여유
    const cost = Buffer.byteLength(JSON.stringify(name), 'utf8') + 8;
    if (bytes + cost > MAX_LISTED_SECTION_BYTES) break;
    list.push(name);
    bytes += cost;
  }
  const omitted = sections.length - list.length;
  return { list, total: sections.length, omitted, truncated: omitted > 0 };
}

/** 오류 메시지 본문에 section 이름을 직접 나열할 최대 길이 — 넘으면 details 에만 싣는다 (중복 방지) */
const MAX_INLINE_SECTION_CHARS = 600;

/** snapshot 안의 한 section — 원본 JSON 문자열의 **연속 구간**이다 (별도 사본을 두지 않는다) */
interface SectionRange {
  /** `text` 안의 시작 offset (UTF-16 단위) */
  start: number;
  /** 끝 offset (exclusive) */
  end: number;
}

interface Snapshot {
  id: string;
  /** 원본 결과의 직렬화 전문 — 이것이 "원본"의 정의다 (wrap 이 내보낼 문자열과 같은 함수로 만든다) */
  text: string;
  /** 최상위 key → text 안의 구간. 파일 경로·중첩 표현식은 여기 없다 */
  sections: Map<string, SectionRange>;
  createdAtMs: number;
  expiresAtMs: number;
  bytes: number;
}

/** 저장 결과 — 호출자는 이 id/만료시각을 첫 응답에 싣는다 */
export interface StoredSnapshot {
  result_id: string;
  expires_at: string;
  total_chars: number;
  bytes: number;
  sections: string[];
}

const snapshots = new Map<string, Snapshot>();

/** 테스트에서 시계를 주입한다 (실제 sleep 대신) */
export type Clock = () => number;
const systemClock: Clock = () => Date.now();

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/** 만료된 것을 먼저 걷어낸다 */
function evictExpired(nowMs: number): void {
  for (const [id, s] of snapshots) {
    if (s.expiresAtMs <= nowMs) snapshots.delete(id);
  }
}

function totalBytes(): number {
  let sum = 0;
  for (const s of snapshots.values()) sum += s.bytes;
  return sum;
}

/** 가장 오래된 것부터 회수 — Map 은 삽입 순서를 유지하므로 첫 항목이 가장 오래됐다 */
function evictOldest(): boolean {
  const first = snapshots.keys().next();
  if (first.done) return false;
  snapshots.delete(first.value);
  return true;
}

/**
 * 최상위 key별 구간을 계산하면서 직렬화한다.
 *
 * ★ 왜 직접 조립하나: section 을 **원본 문자열의 연속 구간**으로 두면 데이터 사본이 하나뿐이고
 *   (16MiB 짜리를 두 번 들고 있지 않다), "조각을 이어붙이면 원본과 같다" 는 성질이 section
 *   읽기에도 그대로 성립한다. 조립 결과가 `JSON.stringify(v, null, 2)` 와 한 글자라도 다르면
 *   **조립본을 버리고** 표준 직렬화를 쓰고 section 색인만 포기한다 (전체 읽기는 항상 된다).
 */
function serializeWithSections(value: unknown): {
  text: string;
  sections: Map<string, SectionRange>;
} {
  const canonical = serializeToolResult(value);
  const sections = new Map<string, SectionRange>();
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !canonical.startsWith('{')
  ) {
    return { text: canonical, sections };
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined && typeof v !== 'function',
  );
  if (entries.length === 0) return { text: canonical, sections };

  let built = '{\n';
  entries.forEach(([key, v], i) => {
    built += `  ${JSON.stringify(key)}: `;
    const start = built.length;
    // 중첩 값은 한 단계(2칸) 더 들여쓴다 — JSON.stringify(_, null, 2) 가 하는 것과 같다
    built += serializeToolResult(v).split('\n').join('\n  ');
    sections.set(key, { start, end: built.length });
    built += i < entries.length - 1 ? ',\n' : '\n';
  });
  built += '}';

  if (built !== canonical) {
    // 조립 규칙이 표준 직렬화와 어긋났다 — 조용히 다른 문자열을 "원본"이라고 부르지 않는다.
    return { text: canonical, sections: new Map() };
  }
  return { text: built, sections };
}

/**
 * 결과를 보관한다.
 *
 * 한도를 넘으면 **usable token 없이** 구조화 오류를 던진다 — "보관은 실패했는데 id 는 줬다" 가
 * 가장 나쁜 결과다(사용자는 읽을 수 있다고 믿고 읽으면 없다).
 */
export function storeDetectionResult(
  value: unknown,
  opts: { clock?: Clock } = {},
): StoredSnapshot {
  const now = (opts.clock ?? systemClock)();
  evictExpired(now);

  const { text, sections } = serializeWithSections(value);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw new ToolError(
      'resource_limit',
      `탐지 결과가 상세 보관 한도를 넘었습니다 (${bytes.toLocaleString()}바이트 > ` +
        `${MAX_SNAPSHOT_BYTES.toLocaleString()}바이트). **탐지 자체는 수행됐지만** 상세를 ` +
        '보관하지 못해 read_detection_result 로 읽을 수 없습니다. 더 좁은 범위(개별 회사·' +
        'rcept_no 지정)로 다시 실행하세요.',
      { bytes, limit_bytes: MAX_SNAPSHOT_BYTES },
    );
  }

  // 총량·개수 상한 — 새로 넣을 자리를 만들기 위해 오래된 것부터 회수한다
  while (snapshots.size >= MAX_SNAPSHOTS) {
    if (!evictOldest()) break;
  }
  while (totalBytes() + bytes > MAX_TOTAL_BYTES) {
    if (!evictOldest()) break;
  }
  if (totalBytes() + bytes > MAX_TOTAL_BYTES) {
    throw new ToolError(
      'resource_limit',
      `상세 보관 총량 한도(${MAX_TOTAL_BYTES.toLocaleString()}바이트)를 넘어 이 결과를 ` +
        '보관하지 못했습니다. **탐지 자체는 수행됐습니다.**',
      { bytes, total_limit_bytes: MAX_TOTAL_BYTES },
    );
  }

  const id = randomBytes(16).toString('hex');
  const snap: Snapshot = {
    id,
    text,
    sections,
    createdAtMs: now,
    expiresAtMs: now + SNAPSHOT_TTL_MS,
    bytes,
  };
  snapshots.set(id, snap);

  return {
    result_id: id,
    expires_at: isoOf(snap.expiresAtMs),
    total_chars: text.length,
    bytes,
    sections: [...sections.keys()],
  };
}

/** 만료·회수·오타를 **한 가지 어휘로** 알린다 — 서버는 회수된 id 와 없던 id 를 구분할 수 없다 */
function unavailable(resultId: string): ToolError {
  return new ToolError(
    'result_unavailable',
    `result_id(${resultId}) 로 보관된 탐지 결과가 없습니다. 수명(30분)이 지났거나, 그 뒤 새 탐지가 ` +
      `${MAX_SNAPSHOTS}건을 넘어 회수됐거나, 서버가 다시 시작됐을 수 있습니다. ` +
      'detect_undisclosed_transactions 를 다시 실행해 새 result_id 를 받으세요 ' +
      '(상세는 서버 프로세스 메모리에만 있어 재시작 후에는 남지 않습니다).',
    { result_id: resultId },
  );
}

export interface SnapshotView {
  id: string;
  text: string;
  expires_at: string;
  sections: string[];
}

/** 보관된 결과를 가져온다 — 만료·부재는 명시 오류다 (다른 snapshot 으로 대체하지 않는다) */
export function getDetectionResult(
  resultId: string,
  opts: { clock?: Clock } = {},
): SnapshotView {
  const now = (opts.clock ?? systemClock)();
  evictExpired(now);
  const snap = snapshots.get(resultId);
  if (!snap) throw unavailable(resultId);
  return {
    id: snap.id,
    text: snap.text,
    expires_at: isoOf(snap.expiresAtMs),
    sections: [...snap.sections.keys()],
  };
}

/**
 * section 하나의 **연속 구간**을 돌려준다.
 * section 이름은 snapshot 자기 소유의 최상위 key 만 허용한다 — 파일 경로·`a.b` 중첩 표현식·
 * 프로토타입 키(`__proto__` 등)는 전부 거절한다.
 */
export function getDetectionSection(
  resultId: string,
  section: string,
  opts: { clock?: Clock } = {},
): { text: string; expires_at: string; sections: string[] } {
  const now = (opts.clock ?? systemClock)();
  evictExpired(now);
  const snap = snapshots.get(resultId);
  if (!snap) throw unavailable(resultId);
  const range = snap.sections.get(section);
  if (!range) {
    const listed = boundedSectionList([...snap.sections.keys()]);
    const inline = listed.list.join(', ');
    // 이름 목록은 details 에 한 번만 싣는다. 짧을 때만 메시지에도 적는다(길면 같은 목록을 두 번 싣게 된다 — Fable M2).
    throw new ToolError(
      'invalid_argument',
      `section '${section}' 은(는) 이 결과에 없습니다. 사용 가능한 section ${listed.total}개 중 ` +
        (inline.length <= MAX_INLINE_SECTION_CHARS
          ? `${listed.list.length}개: ${inline}`
          : `${listed.list.length}개를 details.available_sections 에 실었습니다`) +
        (listed.truncated ? ` (나머지 ${listed.omitted}개는 section 을 생략하고 전체를 읽으면 보입니다)` : '') +
        '.',
      {
        available_sections: listed.list,
        available_sections_total: listed.total,
        available_sections_omitted: listed.omitted,
      },
    );
  }
  return {
    text: snap.text.slice(range.start, range.end),
    expires_at: isoOf(snap.expiresAtMs),
    sections: [...snap.sections.keys()],
  };
}

/** 테스트·진단용 — 보관 상태 */
export function detectionResultStats(): {
  count: number;
  bytes: number;
  ids: string[];
} {
  return { count: snapshots.size, bytes: totalBytes(), ids: [...snapshots.keys()] };
}

/** 테스트 격리용 — 프로세스 보관소를 비운다 (제품 코드 경로에서는 쓰지 않는다) */
export function clearDetectionResults(): void {
  snapshots.clear();
}
