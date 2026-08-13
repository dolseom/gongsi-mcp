/**
 * ZIP 읽기 — 의존성 없이 `node:zlib` 만 사용
 *
 * DART 는 공시 원문·법인코드·XBRL 을 전부 ZIP 으로 준다.
 * 참고 MCP 의 안전검사(zip bomb·경로 탈출)를 여기 한곳에 모은다. (docs §1-4)
 *
 * 상한:
 *   파일 수 500 / 해제 총량 100MB / 압축률 1000:1(1MB 초과 멤버) / 개별 XML 10MB
 */

import { inflateRawSync } from 'node:zlib';

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
}

const MAX_FILES = 500;
const MAX_TOTAL_UNCOMPRESSED = 100 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 1000;

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** ZIP 매직(`PK`) 검사 — DART 는 오류도 HTTP 200 으로 주므로 항상 먼저 본다 */
export function looksLikeZip(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x50 && data[1] === 0x4b;
}

function u16(v: DataView, off: number): number {
  return v.getUint16(off, true);
}
function u32(v: DataView, off: number): number {
  return v.getUint32(off, true);
}

/** 중앙 디렉터리를 읽어 엔트리 목록을 만든다 */
export function listEntries(data: Uint8Array): ZipEntry[] {
  if (!looksLikeZip(data)) throw new ZipError('ZIP 형식이 아닙니다.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // EOCD 는 파일 끝에 있다. 주석 때문에 최대 65535+22 바이트를 역방향 탐색한다.
  // 시그니처만 믿지 않는다 — 주석 안에 가짜 EOCD 를 심어 빈 ZIP 으로 오독시키는
  // 공격이 가능하므로(Codex 지적), 중앙 디렉터리 오프셋이 자기 앞에 있는 후보만 채택한다.
  let eocd = -1;
  const scanFrom = Math.max(0, data.length - (0xffff + 22));
  for (let i = data.length - 22; i >= scanFrom; i--) {
    if (u32(view, i) === SIG_EOCD && u32(view, i + 16) <= i && u16(view, i + 8) === u16(view, i + 10)) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('ZIP 중앙 디렉터리를 찾지 못했습니다 (손상된 파일).');

  const count = u16(view, eocd + 10);
  // ZIP64 sentinel — 지원하지 않음을 명시적으로 알린다 (오진 방지)
  if (count === 0xffff || u32(view, eocd + 16) === 0xffffffff) {
    throw new ZipError('ZIP64 형식은 지원하지 않습니다.');
  }
  if (count > MAX_FILES) {
    throw new ZipError(`ZIP 파일 수가 상한을 초과합니다 (${count} > ${MAX_FILES}).`);
  }
  let offset = u32(view, eocd + 16);

  const entries: ZipEntry[] = [];
  let totalUncompressed = 0;

  for (let i = 0; i < count; i++) {
    if (offset + 46 > data.length || u32(view, offset) !== SIG_CENTRAL) {
      throw new ZipError('ZIP 중앙 디렉터리 항목이 손상되었습니다.');
    }
    const compressionMethod = u16(view, offset + 10);
    const compressedSize = u32(view, offset + 20);
    const uncompressedSize = u32(view, offset + 24);
    const nameLen = u16(view, offset + 28);
    const extraLen = u16(view, offset + 30);
    const commentLen = u16(view, offset + 32);
    const localHeaderOffset = u32(view, offset + 42);

    if (offset + 46 + nameLen + extraLen + commentLen > data.length) {
      throw new ZipError('ZIP 중앙 디렉터리 항목이 파일 범위를 벗어납니다.');
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new ZipError('ZIP64 형식은 지원하지 않습니다.');
    }
    const name = new TextDecoder('utf-8').decode(
      data.subarray(offset + 46, offset + 46 + nameLen),
    );
    validateEntryName(name);

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
      throw new ZipError('ZIP 해제 총량이 100MB 상한을 초과합니다.');
    }
    if (uncompressedSize > 1024 * 1024 && compressedSize > 0) {
      const ratio = uncompressedSize / compressedSize;
      if (ratio > MAX_COMPRESSION_RATIO) {
        throw new ZipError(
          `비정상 압축률의 ZIP 항목을 거부합니다: ${name} (${ratio.toFixed(0)}:1)`,
        );
      }
    }

    // 디렉터리 항목은 건너뛴다
    if (!name.endsWith('/')) {
      entries.push({ name, compressedSize, uncompressedSize, compressionMethod, localHeaderOffset });
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 경로 탈출 방어 — 절대경로·드라이브·`..`·NUL 거부 */
function validateEntryName(name: string): void {
  if (
    !name ||
    name.includes('\0') ||
    name.startsWith('/') ||
    name.startsWith('\\') ||
    /^[A-Za-z]:/.test(name) ||
    name.split(/[/\\]/).includes('..')
  ) {
    throw new ZipError(`안전하지 않은 ZIP 항목 경로입니다: ${JSON.stringify(name)}`);
  }
}

/** 한 항목의 내용을 꺼낸다 */
export function readEntry(data: Uint8Array, entry: ZipEntry): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const off = entry.localHeaderOffset;
  if (off + 30 > data.length || u32(view, off) !== SIG_LOCAL) {
    throw new ZipError(`ZIP 로컬 헤더가 손상되었습니다: ${entry.name}`);
  }
  const nameLen = u16(view, off + 26);
  const extraLen = u16(view, off + 28);
  const start = off + 30 + nameLen + extraLen;
  // 압축 데이터가 파일 밖으로 나가면 subarray 가 조용히 잘린다 — 명시적으로 거부한다
  if (start + entry.compressedSize > data.length) {
    throw new ZipError(`ZIP 항목 데이터가 파일 범위를 벗어납니다: ${entry.name}`);
  }
  const raw = data.subarray(start, start + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    if (raw.length !== entry.uncompressedSize) {
      throw new ZipError(`ZIP 항목 크기가 신고값과 다릅니다: ${entry.name}`);
    }
    return raw;
  }
  if (entry.compressionMethod === 8) {
    let out: Uint8Array;
    try {
      // ⚠️ 신고 크기(중앙 디렉터리)는 위조될 수 있다. 크기를 1로 신고하고 실제로는
      // 수백 MB 로 팽창하는 zip bomb 이 사전 검사를 전부 통과하므로(Codex 지적),
      // inflate 자체에 출력 상한을 건다. 신고값과 다르면 위조로 보고 거부한다.
      out = new Uint8Array(
        inflateRawSync(raw, {
          maxOutputLength: Math.min(entry.uncompressedSize, MAX_TOTAL_UNCOMPRESSED) + 1,
        }),
      );
    } catch (err) {
      throw new ZipError(
        `ZIP 항목 압축 해제에 실패했습니다: ${entry.name} (${err instanceof Error ? err.name : '오류'})`,
      );
    }
    if (out.length !== entry.uncompressedSize) {
      throw new ZipError(
        `ZIP 항목 해제 크기가 신고값과 다릅니다 (위조 의심): ${entry.name} ` +
          `(신고 ${entry.uncompressedSize} / 실제 ${out.length})`,
      );
    }
    return out;
  }
  throw new ZipError(`지원하지 않는 ZIP 압축 방식입니다: ${entry.compressionMethod} (${entry.name})`);
}

/** 이름이 조건에 맞는 첫 항목을 꺼낸다 */
export function readFirstEntry(
  data: Uint8Array,
  predicate: (name: string) => boolean,
): { name: string; content: Uint8Array } | null {
  for (const entry of listEntries(data)) {
    if (predicate(entry.name)) {
      return { name: entry.name, content: readEntry(data, entry) };
    }
  }
  return null;
}

/**
 * 텍스트 항목 중 **가장 큰 것**을 본문으로 고른다.
 * DART 공시 ZIP 은 본문 XML 과 첨부가 함께 들어 있는데, 본문이 항상 가장 크다.
 */
export function pickLargestText(
  data: Uint8Array,
  exts = ['.xml', '.html', '.htm', '.xhtml'],
):
  | { name: string; content: Uint8Array; attachments: string[]; otherTexts: string[] }
  | { name: null; content: null; attachments: string[]; otherTexts: string[] } {
  const entries = listEntries(data);
  const texts = entries.filter((e) => exts.some((x) => e.name.toLowerCase().endsWith(x)));
  const attachments = entries
    .filter((e) => !texts.includes(e))
    .map((e) => {
      const dot = e.name.lastIndexOf('.');
      return dot >= 0 ? e.name.slice(dot + 1).toLowerCase() : '';
    })
    .filter(Boolean);

  if (!texts.length)
    return { name: null, content: null, attachments: [...new Set(attachments)].sort(), otherTexts: [] };

  texts.sort((a, b) => b.uncompressedSize - a.uncompressedSize);
  const picked = texts[0]!;
  return {
    name: picked.name,
    content: readEntry(data, picked),
    attachments: [...new Set(attachments)].sort(),
    // 채택 안 된 텍스트 항목 — 본문에도 attachments 에도 안 실리면 존재 자체가 사라져
    // "본문 1개 = 이게 전문"으로 읽힌다 (P2-나 8). 이름을 남겨 호출부가 고지할 수 있게 한다.
    otherTexts: texts.slice(1).map((e) => e.name),
  };
}
