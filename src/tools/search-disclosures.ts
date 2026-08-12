/**
 * `search_disclosures` — 공시 검색 (축 1의 나머지 반쪽)
 *
 * 공정위 프리셋이 1급 시민이다. `mode:"page"` 는 한 페이지 조회,
 * `mode:"batch"` 는 적응형 분할 전수 수집 (60초 벽 사전 예측 포함).
 *
 * 응답에는 항상 `diagnostics` 를 동봉한다 — 절단·부분 결과를 조용히 넘기지 않는다.
 */

import { z } from 'zod';
import { DartClient, viewerUrl, type Disclosure, type ListParams } from '../clients/dart.js';
import { resolveCorp } from '../resolver/corp-index.js';
import { collectAdaptive } from '../search/batch.js';
import { PRESETS, PRESET_NAMES, type PresetSpec } from '../search/presets.js';
import { ToolError } from '../lib/errors.js';
import { isValidYMD } from '../rules/business-days.js';

export const searchDisclosuresInput = z.object({
  query: z
    .string()
    .min(1)
    .optional()
    .describe('회사명·종목코드(6자리)·corp_code(8자리)·법인등록번호(13자리). 동명 법인이 여럿이면 ambiguous_corp 에러와 후보 목록을 돌려줍니다'),
  corp_code: z
    .string()
    .regex(/^\d{8}$/, 'corp_code 는 8자리 숫자입니다')
    .optional()
    .describe('DART 법인코드 8자리 — query 대신 직접 지정'),
  date_from: z
    .string()
    .regex(/^\d{8}$/, '날짜는 YYYYMMDD 형식입니다')
    .refine(isValidYMD, '실존하지 않는 날짜입니다')
    .optional()
    .describe('조회 시작일 YYYYMMDD (기본: 30일 전)'),
  date_to: z
    .string()
    .regex(/^\d{8}$/, '날짜는 YYYYMMDD 형식입니다')
    .refine(isValidYMD, '실존하지 않는 날짜입니다')
    .optional()
    .describe('조회 종료일 YYYYMMDD (기본: 오늘)'),
  preset: z
    .enum(PRESET_NAMES)
    .optional()
    .describe('공정위 공시 프리셋. ftc_all=J 전체 / internal_transaction=대규모내부거래 / group_status=기업집단현황 / unlisted_material=비상장사 중요사항 / public_interest_corp=공익법인 / subcontract=하도급 결제조건'),
  pblntf_ty: z
    .string()
    .regex(/^[A-J]$/, '공시유형은 A~J 한 글자입니다')
    .optional()
    .describe('DART 공시유형 원시 코드 (preset 과 동시 지정 불가)'),
  pblntf_detail_ty: z
    .string()
    .regex(/^[A-J]\d{3}$/, '상세유형은 영문자+3자리 숫자입니다 (예: J001)')
    .optional()
    .describe('DART 공시상세유형 원시 코드 (preset 과 동시 지정 불가)'),
  corp_cls: z
    .enum(['Y', 'K', 'N', 'E'])
    .optional()
    .describe('법인구분 Y=유가 K=코스닥 N=코넥스 E=기타(비상장 대부분)'),
  report_name_contains: z
    .string()
    .min(1)
    .optional()
    .describe('보고서명 부분일치 필터 — 서버 필터가 아니라 수집 후 적용됩니다 (예: "자금차입", "기재정정")'),
  last_report_only: z
    .boolean()
    .optional()
    .describe('⚠️ 기본 false. true(최종보고서만)는 정정으로 대체된 원본 접수분을 지워 지연 판정이 불가능해집니다'),
  mode: z
    .enum(['page', 'batch'])
    .optional()
    .describe('page(기본)=한 페이지 조회. batch=적응형 분할 전수 수집 — 규모가 크면 range_too_large 와 분할 안내를 반환'),
  page: z.number().int().min(1).optional().describe('mode:"page" 의 페이지 번호 (기본 1)'),
  page_size: z.number().int().min(1).max(100).optional().describe('페이지당 건수 (기본·최대 100)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .optional()
    .describe('mode:"batch" 응답에 실을 최대 행수 (기본 200). 수집·집계는 전수로 하고 응답만 자릅니다'),
  compact: z
    .boolean()
    .optional()
    .describe('true 면 schema+값 배열 형태로 토큰 30~40% 절감 (행이 많을 때 권장)'),
});

export type SearchDisclosuresInput = z.infer<typeof searchDisclosuresInput>;

const ROW_SCHEMA = [
  'rcept_no',
  'rcept_dt',
  'corp_code',
  'corp_name',
  'corp_cls',
  'report_nm',
  'flr_nm',
  'rm',
] as const;

function kstToday(): string {
  return new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, '');
}

function shapeRows(rows: Disclosure[], compact: boolean): Record<string, unknown> {
  if (compact) {
    return {
      schema: ROW_SCHEMA,
      rows: rows.map((r) => ROW_SCHEMA.map((k) => r[k])),
    };
  }
  return {
    rows: rows.map((r) => ({
      rcept_no: r.rcept_no,
      rcept_dt: r.rcept_dt,
      corp_code: r.corp_code,
      corp_name: r.corp_name,
      corp_cls: r.corp_cls,
      report_nm: r.report_nm,
      flr_nm: r.flr_nm,
      rm: r.rm,
      viewer_url: viewerUrl(r.rcept_no),
    })),
  };
}

export async function searchDisclosures(input: SearchDisclosuresInput): Promise<unknown> {
  if (input.preset && (input.pblntf_ty || input.pblntf_detail_ty)) {
    throw new ToolError(
      'invalid_argument',
      'preset 과 원시 코드(pblntf_ty/pblntf_detail_ty)는 함께 지정할 수 없습니다. 하나만 쓰세요.',
    );
  }
  if (input.query && input.corp_code) {
    throw new ToolError('invalid_argument', 'query 와 corp_code 는 함께 지정할 수 없습니다.');
  }

  const client = new DartClient();

  // 회사 특정 — 동명 법인이면 resolveCorp 가 후보 목록과 함께 던진다
  let corpCode = input.corp_code;
  let corpResolved: { corp_code: string; corp_name: string } | undefined;
  if (input.query) {
    const r = await resolveCorp(input.query, client);
    if ('ambiguous' in r) {
      // allowAmbiguous 를 쓰지 않으므로 도달하지 않지만, 타입 좁히기용
      throw new ToolError('ambiguous_corp', `'${input.query}' 후보가 여럿입니다.`);
    }
    corpCode = r.corpCode;
    corpResolved = { corp_code: r.corpCode, corp_name: r.corpName };
  }

  const dateTo = input.date_to ?? kstToday();
  const dateFrom =
    input.date_from ??
    ((): string => {
      const ms = Date.UTC(
        Number(dateTo.slice(0, 4)),
        Number(dateTo.slice(4, 6)) - 1,
        Number(dateTo.slice(6, 8)),
      );
      return new Date(ms - 29 * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
    })();
  if (dateFrom > dateTo) {
    throw new ToolError('invalid_argument', `date_from(${dateFrom})이 date_to(${dateTo})보다 늦습니다.`);
  }
  // 날짜 미지정의 기본 30일은 조용히 적용하면 "그 공시는 없다"로 오독된다 (P2-가 5번)
  const dateDefaulted = !input.date_from;
  const dateDefaultNote = dateDefaulted
    ? `date_from 미지정 — 최근 30일(${dateFrom}~${dateTo})만 조회했습니다. 이전 공시까지 보려면 날짜를 명시하세요.`
    : null;

  const preset: PresetSpec | undefined = input.preset ? PRESETS[input.preset] : undefined;
  const base: ListParams = {
    corpCode,
    pblntfTy: preset?.pblntfTy ?? input.pblntf_ty,
    pblntfDetailTy: preset?.pblntfDetailTy ?? input.pblntf_detail_ty,
    corpCls: input.corp_cls,
    lastReportOnly: input.last_report_only ?? false,
  };

  const nameFilter = input.report_name_contains;
  const applyNameFilter = (rows: Disclosure[]): { kept: Disclosure[]; dropped: number } => {
    if (!nameFilter) return { kept: rows, dropped: 0 };
    const kept = rows.filter((r) => r.report_nm.includes(nameFilter));
    return { kept, dropped: rows.length - kept.length };
  };

  const commonDiag = {
    preset_resolved: preset
      ? { preset: input.preset, label: preset.label, pblntf_ty: preset.pblntfTy ?? null, pblntf_detail_ty: preset.pblntfDetailTy ?? null }
      : null,
    // ⚠️ Y 는 정정으로 대체된 원본을 지운다 — 무엇으로 조회했는지 항상 노출
    last_reprt_at: (input.last_report_only ?? false) ? 'Y' : 'N',
  };

  if ((input.mode ?? 'page') === 'page') {
    const page = await client.listPage({
      ...base,
      bgnDe: dateFrom,
      endDe: dateTo,
      pageNo: input.page ?? 1,
      pageCount: input.page_size ?? 100,
    });
    const { kept, dropped } = applyNameFilter(page.list);
    return {
      mode: 'page',
      ...(corpResolved ? { corp: corpResolved } : {}),
      date_from: dateFrom,
      date_to: dateTo,
      ...(dateDefaultNote ? { date_range_note: dateDefaultNote } : {}),
      total_count: page.totalCount,
      total_page: page.totalPage,
      page_no: page.pageNo,
      has_more: page.pageNo < page.totalPage,
      returned: kept.length,
      ...shapeRows(kept, input.compact ?? false),
      diagnostics: {
        ...commonDiag,
        calls_consumed: 1,
        report_name_filtered: dropped,
        ...(nameFilter
          ? { note: 'report_name_contains 는 이 페이지 안에서만 거릅니다. 전 기간을 거르려면 mode:"batch" 를 쓰세요.' }
          : {}),
      },
    };
  }

  // mode: "batch" — 적응형 분할 전수 수집
  const batch = await collectAdaptive(client, base, dateFrom, dateTo);
  const { kept, dropped } = applyNameFilter(batch.rows);
  const limit = input.limit ?? 200;
  const responseTruncated = kept.length > limit;

  // 수집 불완전은 diagnostics 안에만 두면 "정상 완료 0건"과 구분되지 않는다 (P2-가 1번)
  const collectionComplete =
    !batch.diagnostics.partial_results &&
    !batch.diagnostics.truncated &&
    batch.diagnostics.chunks_failed === 0;
  const warnings: string[] = [];
  if (dateDefaultNote) warnings.push(dateDefaultNote);
  if (!collectionComplete) {
    warnings.push(
      '⚠️ 수집이 불완전합니다 (diagnostics 의 partial_results/truncated/chunks_failed 참조) — ' +
        '이 결과만으로 "해당 공시 없음"이나 "누락 없음"을 결론내지 마세요.',
    );
  }
  if (nameFilter && kept.length === 0 && batch.rows.length > 0) {
    // 필터 전량 탈락 — page 모드에는 안내가 있는데 batch 에는 없던 비대칭 (P2-가 4번)
    warnings.push(
      `report_name_contains("${nameFilter}") 가 수집된 ${batch.rows.length.toLocaleString()}건을 전부 걸렀습니다. ` +
        '이 필터는 정규화 없는 부분일치입니다 — DART 보고서명의 공백·괄호 표기가 다르면 탈락하니 더 짧은 키워드로 시도하세요.',
    );
  }

  return {
    mode: 'batch',
    ...(corpResolved ? { corp: corpResolved } : {}),
    date_from: dateFrom,
    date_to: dateTo,
    collection_complete: collectionComplete,
    ...(warnings.length ? { warnings } : {}),
    total_collected: batch.rows.length,
    matched: kept.length,
    returned: Math.min(kept.length, limit),
    response_truncated: responseTruncated,
    ...(responseTruncated
      ? { note: `일치 ${kept.length.toLocaleString()}건 중 ${limit}건만 실었습니다. limit 을 늘리거나 기간·필터를 좁히세요.` }
      : {}),
    ...shapeRows(kept.slice(0, limit), input.compact ?? false),
    diagnostics: {
      ...commonDiag,
      calls_consumed: batch.diagnostics.measure_calls + batch.diagnostics.collect_calls,
      report_name_filtered: dropped,
      ...batch.diagnostics,
    },
  };
}
