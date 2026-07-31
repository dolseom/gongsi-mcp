/**
 * `find_precedents` — 타사 선례·문안 참고 (축 1)
 *
 * "다른 회사는 이 항목을 어떻게 썼나"에 답한다. 키워드로 같은 유형의 최근 공시를
 * 찾아 회사당 1건씩 고르고, 원문을 표 구조 보존 마크다운으로 동봉한다.
 *
 * ⚠️ 이 도구만 예외적으로 **최종보고서(Y) 기준**이다 — 문안 참고에는 정정이 반영된
 * 최종 텍스트가 모범 답안이다. 지연 판정용 검색(기본 N)과 목적이 정반대다.
 *
 * 검색은 최신부터 30일 창으로 거슬러 내려가며, 후보가 충분히 모이면 멈춘다 —
 * 전수 수집이 아니므로 range_too_large 없이 항상 60초 안에 끝난다.
 */

import { z } from 'zod';
import { DartClient, viewerUrl, type Disclosure } from '../clients/dart.js';
import { resolveCorp } from '../resolver/corp-index.js';
import { readDisclosure } from './read-disclosure.js';
import { PRESETS, PRESET_NAMES, type PresetSpec } from '../search/presets.js';
import { ToolError } from '../lib/errors.js';
import { getLogger } from '../lib/logger.js';

const log = getLogger('find-precedents');

/** 한 번에 거슬러 내려가는 검색 창 (전체시장 검색 3개월 제한보다 작게) */
const WINDOW_DAYS = 30;

export const findPrecedentsInput = z.object({
  report_name_contains: z
    .string()
    .min(1)
    .describe('찾을 유형 키워드 — 보고서명 부분일치 (예: "자금차입", "담보제공", "수익증권", "부동산임차")'),
  preset: z
    .enum(PRESET_NAMES)
    .optional()
    .describe('검색 범위 프리셋 (기본 internal_transaction=대규모내부거래)'),
  count: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('가져올 선례 수 (기본 3). 건당 원문 다운로드 1회를 소비합니다'),
  lookback_days: z
    .number()
    .int()
    .min(7)
    .max(365)
    .optional()
    .describe('최대 며칠 전까지 거슬러 찾을지 (기본 180일). 후보가 모이면 더 내려가지 않습니다'),
  corp_cls: z
    .enum(['Y', 'K', 'N', 'E'])
    .optional()
    .describe('법인구분 필터 — 자사와 같은 구분(상장/비상장)의 문안만 보려면 지정'),
  exclude_corp: z
    .string()
    .min(1)
    .optional()
    .describe('제외할 회사 (corp_code 8자리 또는 회사명) — 보통 자사'),
  one_per_company: z
    .boolean()
    .optional()
    .describe('회사당 1건만 골라 표현을 다양하게 (기본 true). false 면 최신순 그대로'),
  max_chars_per_doc: z
    .number()
    .int()
    .min(1000)
    .max(30_000)
    .optional()
    .describe('선례당 본문 최대 길이 (기본 8,000자)'),
});

export type FindPrecedentsInput = z.infer<typeof findPrecedentsInput>;

export interface CandidateOptions {
  excludeCorpCode?: string;
  onePerCompany: boolean;
}

/**
 * 후보 선정 — 최신순 정렬 후 제외·회사당 1건 적용.
 * 순수 함수로 분리해 테스트한다.
 */
export function selectCandidates(rows: Disclosure[], opts: CandidateOptions): Disclosure[] {
  const sorted = [...rows].sort((a, b) =>
    a.rcept_dt !== b.rcept_dt ? (a.rcept_dt > b.rcept_dt ? -1 : 1) : a.rcept_no > b.rcept_no ? -1 : 1,
  );
  const seen = new Set<string>();
  const out: Disclosure[] = [];
  for (const r of sorted) {
    if (opts.excludeCorpCode && r.corp_code === opts.excludeCorpCode) continue;
    if (opts.onePerCompany) {
      if (seen.has(r.corp_code)) continue;
      seen.add(r.corp_code);
    }
    out.push(r);
  }
  return out;
}

function kstToday(): string {
  return new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, '');
}

function addDays(ymd: string, n: number): string {
  const ms = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
  return new Date(ms + n * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
}

export async function findPrecedents(input: FindPrecedentsInput): Promise<unknown> {
  const client = new DartClient();
  const preset: PresetSpec = PRESETS[input.preset ?? 'internal_transaction'];
  const count = input.count ?? 3;
  const lookbackDays = input.lookback_days ?? 180;
  const onePerCompany = input.one_per_company ?? true;
  const keyword = input.report_name_contains;

  // 제외 회사 특정 (이름이면 corp_code 로 풀어준다)
  let excludeCorpCode: string | undefined;
  if (input.exclude_corp) {
    const r = await resolveCorp(input.exclude_corp, client);
    if ('ambiguous' in r) {
      throw new ToolError('ambiguous_corp', `'${input.exclude_corp}' 후보가 여럿입니다.`);
    }
    excludeCorpCode = r.corpCode;
  }

  // 최신부터 30일 창으로 거슬러 검색 — 후보가 넉넉해지면 중단
  const today = kstToday();
  const oldest = addDays(today, -(lookbackDays - 1));
  const wantBuffer = count * 3; // 파싱 불가·중복 대비 여유
  const matched: Disclosure[] = [];
  let windowsScanned = 0;
  let searchCalls = 0;
  let truncatedAny = false;

  let winTo = today;
  let scannedFrom = today;
  while (winTo >= oldest) {
    const winFrom = addDays(winTo, -(WINDOW_DAYS - 1)) < oldest ? oldest : addDays(winTo, -(WINDOW_DAYS - 1));
    scannedFrom = winFrom;
    const r = await client.collect({
      pblntfTy: preset.pblntfTy,
      pblntfDetailTy: preset.pblntfDetailTy,
      corpCls: input.corp_cls,
      bgnDe: winFrom,
      endDe: winTo,
      // 문안 참고는 정정 반영된 최종본이 정답이다 (지연 판정과 정반대 — 파일 상단 주석)
      lastReportOnly: true,
    });
    windowsScanned++;
    searchCalls += r.calls;
    if (r.truncated) truncatedAny = true;
    matched.push(...r.rows.filter((row) => row.report_nm.includes(keyword)));

    const candidatesSoFar = selectCandidates(matched, { excludeCorpCode, onePerCompany });
    if (candidatesSoFar.length >= wantBuffer) break;
    winTo = addDays(winFrom, -1);
  }

  const candidates = selectCandidates(matched, { excludeCorpCode, onePerCompany });
  if (candidates.length === 0) {
    throw new ToolError(
      'document_not_found',
      `최근 ${lookbackDays}일(${oldest}~${today}) ${preset.label} 공시에서 ` +
        `보고서명에 '${keyword}' 가 들어간 건을 찾지 못했습니다. ` +
        `키워드를 짧게 하거나 lookback_days 를 늘려보세요.`,
      { keyword, preset: preset.label, searched_from: oldest, searched_to: today },
    );
  }

  // 원문 수집 — HWP 첨부만 있는 건은 건너뛰고 다음 후보로
  const precedents: Array<Record<string, unknown>> = [];
  const skipped: Array<{ rcept_no: string; corp_name: string; reason: string }> = [];
  let bodyCalls = 0;
  for (const c of candidates) {
    if (precedents.length >= count) break;
    try {
      const doc = (await readDisclosure({
        rcept_no: c.rcept_no,
        max_chars: input.max_chars_per_doc ?? 8_000,
      })) as Record<string, unknown>;
      if (!doc['cached']) bodyCalls++;
      precedents.push({
        rcept_no: c.rcept_no,
        rcept_dt: c.rcept_dt,
        corp_code: c.corp_code,
        corp_name: c.corp_name,
        corp_cls: c.corp_cls,
        report_nm: c.report_nm,
        viewer_url: viewerUrl(c.rcept_no),
        board_date: doc['board_date'],
        acode: doc['acode'],
        body_truncated: doc['truncated'],
        body: doc['body'],
      });
    } catch (err) {
      const reason = err instanceof ToolError ? err.code : 'unknown';
      skipped.push({ rcept_no: c.rcept_no, corp_name: c.corp_name, reason });
      log.warn('선례 원문 수집 실패, 다음 후보로', { rcept_no: c.rcept_no, reason });
    }
  }

  if (precedents.length === 0) {
    throw new ToolError(
      'body_unparsable',
      `'${keyword}' 선례 ${candidates.length}건을 찾았으나 원문을 파싱할 수 있는 건이 없었습니다. ` +
        `viewer_url 로 직접 확인하세요.`,
      { candidates: candidates.slice(0, 5).map((c) => ({ rcept_no: c.rcept_no, corp_name: c.corp_name, viewer_url: viewerUrl(c.rcept_no) })) },
    );
  }

  return {
    keyword,
    preset: preset.label,
    searched_from: scannedFrom,
    searched_to: today,
    total_matched: candidates.length,
    returned: precedents.length,
    ...(precedents.length < count
      ? { note: `요청 ${count}건 중 ${precedents.length}건만 확보했습니다. lookback_days 를 늘리거나 키워드를 넓혀보세요.` }
      : {}),
    precedents,
    ...(skipped.length ? { skipped_unparsable: skipped } : {}),
    diagnostics: {
      // 문안 참고 목적이라 최종본(Y) 기준 — 원본 접수분 필요 시 search_disclosures 사용
      last_reprt_at: 'Y',
      windows_scanned: windowsScanned,
      search_calls: searchCalls,
      body_downloads: bodyCalls,
      truncated: truncatedAny,
    },
  };
}
