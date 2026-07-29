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
  extractBoardDate,
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

interface DocMeta {
  acode: string | null;
  aregcik: string | null;
  formulaVersion: string | null;
  encoding: string;
  attachments: string[];
  bodyParsable: boolean;
  boardDate: string | null;
  pickedEntry: string | null;
}

export async function readDisclosure(input: ReadDisclosureInput): Promise<unknown> {
  const store = getStore();
  const metaKey = `docmeta:${input.rcept_no}`;

  if (input.force_refresh) {
    store.invalidateBody(input.rcept_no);
    store.set(metaKey, '');
  }

  let markdown: string | null = null;
  let meta: DocMeta | null = null;
  let cached = false;

  const cachedBody = store.getBody(input.rcept_no);
  const cachedMeta = store.get(metaKey);
  if (cachedBody && cachedMeta) {
    markdown = cachedBody.content;
    meta = JSON.parse(cachedMeta) as DocMeta;
    cached = true;
  }

  if (markdown === null || meta === null) {
    const client = new DartClient();
    const zip = await client.downloadDocument(input.rcept_no);
    const picked = pickLargestText(zip);

    if (!picked.content) {
      // 파싱 불가도 캐시한다 — 같은 공시를 반복 다운로드하지 않게
      const emptyMeta: DocMeta = {
        acode: null,
        aregcik: null,
        formulaVersion: null,
        encoding: 'utf-8',
        attachments: picked.attachments,
        bodyParsable: false,
        boardDate: null,
        pickedEntry: null,
      };
      store.storeBody(input.rcept_no, '');
      store.set(metaKey, JSON.stringify(emptyMeta));
      throw new ToolError(
        'body_unparsable',
        `접수번호 ${input.rcept_no} 원문에 파싱 가능한 텍스트가 없습니다 ` +
          `(첨부: ${picked.attachments.join(', ') || '없음'}). DART 뷰어에서 직접 확인하세요.`,
        { rcept_no: input.rcept_no, attachments: picked.attachments, viewer_url: viewerUrl(input.rcept_no) },
      );
    }

    const { text: xml, encoding } = decodeDocument(picked.content);
    const parsed = parseDocument(xml);
    meta = {
      acode: parsed.acode,
      aregcik: parsed.aregcik,
      formulaVersion: parsed.formulaVersion,
      encoding,
      attachments: picked.attachments,
      bodyParsable: true,
      boardDate: extractBoardDate(xml),
      pickedEntry: picked.name,
    };
    markdown = parsed.markdown;
    store.storeBody(input.rcept_no, markdown);
    store.set(metaKey, JSON.stringify(meta));
    log.info('원문 파싱 완료', {
      rcept_no: input.rcept_no,
      acode: meta.acode,
      chars: markdown.length,
      encoding,
    });
  }

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

  return {
    rcept_no: input.rcept_no,
    viewer_url: viewerUrl(input.rcept_no),
    acode: meta.acode,
    // 이사회 의결일 — check_disclosure_duty 의 boardDate 입력으로 그대로 쓸 수 있다
    board_date: meta.boardDate,
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
