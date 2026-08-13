/**
 * `read_disclosure` — 공시 원문 읽기 (축 1)
 *
 * 원문 ZIP 을 내려받아 **표 구조를 보존한 마크다운**으로 돌려준다.
 * "다른 회사는 이 항목을 어떻게 썼나"에 답하는 기반이다.
 *
 * - 원문은 영구 캐시한다 (접수된 공시는 불변이고, 정정은 새 접수번호로 온다)
 * - 파싱 실패(HWP 첨부만 등)도 캐시해 재다운로드를 막는다
 * - 이사회 의결일은 정밀 추출해 함께 준다 (판정 도구와의 연결 고리)
 */

import { z } from 'zod';
import { DartClient, viewerUrl } from '../clients/dart.js';
import { getStore } from '../lib/store.js';
import { getLogger } from '../lib/logger.js';
import { pickLargestText } from '../lib/zip.js';
import { ToolError } from '../lib/errors.js';
import {
  parseDocument,
  decodeDocument,
  extractBoardDateDetail,
  type BoardDateStatus,
} from '../parsers/document.js';

const log = getLogger('read-disclosure');

export const readDisclosureInput = z.object({
  rcept_no: z
    .string()
    .regex(/^\d{14}$/, '접수번호는 14자리 숫자여야 합니다 (예: 20260728000484)')
    .describe('DART 접수번호 14자리'),
  format: z
    .enum(['markdown', 'text'])
    .optional()
    .describe('markdown(기본) = 표 구조 보존. text = 공백 정규화된 평문'),
  force_refresh: z
    .boolean()
    .optional()
    .describe('캐시를 무시하고 재다운로드 (기본 false). 접수된 공시는 불변이므로 보통 불필요'),
  max_chars: z
    .number()
    .int()
    .min(1000)
    .max(200_000)
    .optional()
    .describe('본문 최대 길이 (기본 60,000자). 초과 시 truncated=true 로 잘라서 준다'),
});

export type ReadDisclosureInput = z.infer<typeof readDisclosureInput>;

export interface DocMeta {
  acode: string | null;
  aregcik: string | null;
  formulaVersion: string | null;
  encoding: string;
  attachments: string[];
  bodyParsable: boolean;
  boardDate: string | null;
  /** boardDate 가 null 인 이유 (P2-나 7). 구 캐시 메타에는 없다 — force_refresh 로 재생성된다 */
  boardDateStatus?: BoardDateStatus;
  pickedEntry: string | null;
  /** 본문으로 채택되지 않은 나머지 텍스트 항목들 (P2-나 8). 구 캐시 메타에는 없다 */
  otherTextEntries?: string[];
}

/**
 * 원문 다운로드 + 파싱 + 영구 캐시 — read_disclosure 와 audit 도구가 공유하는 코어.
 * 파싱 불가 문서도 예외를 던지지 않고 `bodyParsable: false` 로 돌려준다 (감사는 계속 가야 한다).
 * 호출부가 사용자 대면 도구라면 bodyParsable 을 보고 직접 에러를 만들 것.
 */
export async function loadDocument(
  rceptNo: string,
  client?: DartClient,
): Promise<{ markdown: string; meta: DocMeta; cached: boolean }> {
  const store = getStore();
  const metaKey = `docmeta:${rceptNo}`;

  const cachedBody = store.getBody(rceptNo);
  const cachedMeta = store.get(metaKey);
  if (cachedBody && cachedMeta) {
    const meta = JSON.parse(cachedMeta) as DocMeta;
    // 오염된 구 캐시 자가 치유: 빈 본문이 '정상(parsable)'로 저장돼 있으면 캐시를 버리고 재다운로드
    // (이 결함 수정 전 버전이 만든 캐시일 수 있다 — P0-3 빈 계열사 캐시와 같은 패턴)
    if (!(meta.bodyParsable && !cachedBody.content.trim())) {
      return { markdown: cachedBody.content, meta, cached: true };
    }
  }

  const dart = client ?? new DartClient();
  const zip = await dart.downloadDocument(rceptNo);
  const picked = pickLargestText(zip);

  // 파싱 불가도 캐시한다 — 같은 공시를 반복 다운로드하지 않게.
  // 단 반드시 bodyParsable:false 로 캐시해야 한다: 빈 본문을 '정상'으로 캐시하면
  // 이후 영구히 "본문 0자 = 이게 전문"으로 읽히는 거짓 안심이 된다 (P2-나 6번).
  const storeUnparsable = (encoding: string) => {
    const emptyMeta: DocMeta = {
      acode: null,
      aregcik: null,
      formulaVersion: null,
      encoding,
      attachments: picked.attachments,
      bodyParsable: false,
      boardDate: null,
      pickedEntry: null,
    };
    store.storeBody(rceptNo, '');
    store.set(metaKey, JSON.stringify(emptyMeta));
    return { markdown: '', meta: emptyMeta, cached: false };
  };

  // 길이 0 Uint8Array 는 truthy 다 — null 검사만으로는 빈 항목이 '정상 파싱'으로 통과한다
  if (!picked.content || picked.content.length === 0) {
    return storeUnparsable('utf-8');
  }

  const { text: xml, encoding } = decodeDocument(picked.content);
  const parsed = parseDocument(xml);
  // 바이트는 있었는데 변환 결과가 빈 문서 — '정상 파싱된 빈 공시'는 없다
  if (!parsed.markdown.trim()) {
    return storeUnparsable(encoding);
  }
  const boardDate = extractBoardDateDetail(xml);
  const meta: DocMeta = {
    acode: parsed.acode,
    aregcik: parsed.aregcik,
    formulaVersion: parsed.formulaVersion,
    encoding,
    attachments: picked.attachments,
    bodyParsable: true,
    boardDate: boardDate.date,
    boardDateStatus: boardDate.status,
    pickedEntry: picked.name,
    otherTextEntries: picked.otherTexts,
  };
  store.storeBody(rceptNo, parsed.markdown);
  store.set(metaKey, JSON.stringify(meta));
  log.info('원문 파싱 완료', {
    rcept_no: rceptNo,
    acode: meta.acode,
    chars: parsed.markdown.length,
    encoding,
  });
  return { markdown: parsed.markdown, meta, cached: false };
}

/** 캐시에 이미 있는 원문인지 (다운로드 예상 비용 계산용) */
export function isDocumentCached(rceptNo: string): boolean {
  const store = getStore();
  return store.hasBody(rceptNo) && !!store.get(`docmeta:${rceptNo}`);
}

export async function readDisclosure(input: ReadDisclosureInput): Promise<unknown> {
  const store = getStore();
  const metaKey = `docmeta:${input.rcept_no}`;

  if (input.force_refresh) {
    store.invalidateBody(input.rcept_no);
    store.set(metaKey, '');
  }

  const { markdown, meta, cached } = await loadDocument(input.rcept_no);

  if (!meta.bodyParsable) {
    throw new ToolError(
      'body_unparsable',
      `접수번호 ${input.rcept_no} 원문에 파싱 가능한 텍스트가 없습니다 ` +
        `(첨부: ${meta.attachments.join(', ') || '없음'}). DART 뷰어에서 직접 확인하세요.`,
      { rcept_no: input.rcept_no, attachments: meta.attachments, viewer_url: viewerUrl(input.rcept_no) },
    );
  }

  const body =
    input.format === 'text' ? markdown.replace(/\|/g, ' ').replace(/[ \t]+/g, ' ') : markdown;
  const limit = input.max_chars ?? 60_000;
  const truncated = body.length > limit;

  // board_date null 의 원인별 안내 (P2-나 7) — 특히 invalid_date 는 원문 거짓기재 신호라 침묵하면 안 된다
  const BOARD_DATE_NOTES: Record<BoardDateStatus, string | null> = {
    found: null,
    label_missing:
      '이 서식에는 이사회 의결일 항목이 없습니다 (약관에 의한 금융거래 트랙 B 서식 등) — 파싱 실패가 아닙니다.',
    value_empty:
      '원문의 이사회 의결일 값이 "-" 입니다 (기공시 재약정·변경공시 등 정당한 무기재일 수 있습니다).',
    invalid_date:
      '⚠️ 원문에 실존하지 않는 날짜가 이사회 의결일로 기재되어 있습니다 (예: "2026.2.31") — ' +
      '원문 오기 또는 거짓기재 신호입니다. viewer_url 에서 원문을 직접 확인하세요.',
    unparsed:
      '이사회 의결일 항목은 있으나 날짜를 추출하지 못했습니다 (표기 변형 가능) — viewer_url 에서 확인하세요.',
  };
  const boardDateNote =
    meta.boardDate === null && meta.boardDateStatus ? BOARD_DATE_NOTES[meta.boardDateStatus] : null;

  return {
    rcept_no: input.rcept_no,
    viewer_url: viewerUrl(input.rcept_no),
    acode: meta.acode,
    // 이사회 의결일 — check_disclosure_duty 의 boardDate 입력으로 그대로 쓸 수 있다
    board_date: meta.boardDate,
    ...(meta.boardDate === null && meta.boardDateStatus
      ? { board_date_status: meta.boardDateStatus }
      : {}),
    ...(boardDateNote ? { board_date_note: boardDateNote } : {}),
    // 어떤 항목을 본문으로 골랐고 무엇이 남았는지 — "본문 1개 = 전문" 오독 방지 (P2-나 8)
    picked_entry: meta.pickedEntry,
    ...(meta.otherTextEntries?.length
      ? {
          other_text_entries: meta.otherTextEntries,
          other_text_note:
            `본문으로 채택되지 않은 텍스트 항목이 ${meta.otherTextEntries.length}건 더 있습니다 — ` +
            '이 응답의 body 가 공시 전체가 아닐 수 있습니다. 전체는 viewer_url 에서 확인하세요.',
        }
      : {}),
    submitter_corp_code: meta.aregcik,
    encoding: meta.encoding,
    attachments: meta.attachments,
    cached,
    total_chars: body.length,
    truncated,
    ...(truncated
      ? { note: `본문이 ${limit.toLocaleString()}자를 넘어 잘랐습니다. max_chars 를 늘려 다시 호출하세요.` }
      : {}),
    body: truncated ? body.slice(0, limit) : body,
  };
}
