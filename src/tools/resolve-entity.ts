/**
 * `resolve_entity` — 통합 식별자 해석
 *
 * "삼성전자" / "005930" / "00126380" / 법인등록번호 / "삼성"(기업집단) 을 모두 받아
 * `corp_code`·`stock_code`·`jurir_no`·소속 기업집단으로 풀어준다.
 *
 * 나머지 도구들이 전부 이 해석을 거치므로, **틀린 회사를 조용히 고르지 않는 것**이 가장 중요하다.
 * 동명 법인이 실제로 많다 — 삼성물산 2건(합병 전후), 에스티엠 4건. 임의 선택 대신 후보를 돌려준다.
 */

import { z } from 'zod';
import { DartClient } from '../clients/dart.js';
import { EgroupClient } from '../clients/egroup.js';
import { resolveCorp, detectIdentifier, normalizeName } from '../resolver/corp-index.js';
import { getStore } from '../lib/store.js';
import { getLogger } from '../lib/logger.js';
import { ToolError } from '../lib/errors.js';

const log = getLogger('resolve-entity');

export const resolveEntityInput = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      '해석할 값. 회사명("삼성전자"), 종목코드("005930"), 법인코드 8자리("00126380"), ' +
        '법인등록번호 13자리, 또는 기업집단명("삼성")',
    ),
  type: z
    .enum(['company', 'group', 'auto'])
    .optional()
    .describe('해석 대상. auto(기본)면 회사 → 기업집단 순으로 시도한다'),
  includeGroup: z
    .boolean()
    .optional()
    .describe(
      '회사를 찾은 뒤 소속 기업집단까지 조회할지 (기본 false). ' +
        'true 면 기업집단포털을 호출하며 EGROUP_API_KEY 가 필요하다',
    ),
  fetchJurirNo: z
    .boolean()
    .optional()
    .describe(
      '법인등록번호를 기업개황 API로 채울지 (기본 false, 호출 1회 소비). ' +
        '기업집단포털과 대사하려면 필요하다',
    ),
  yearMonth: z
    .string()
    .regex(/^\d{6}$/)
    .optional()
    .describe('기업집단 기준 공개년월 YYYYMM (미지정 시 최신 지정연도를 추정)'),
});

export type ResolveEntityInput = z.infer<typeof resolveEntityInput>;

/**
 * 기업집단 지정 기준 공개년월을 추정한다.
 * 공정위는 매년 5월 1일 기준으로 지정하고 포털은 연 1회 갱신된다.
 */
export function inferYearMonth(now = new Date()): string {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  // 5월 지정 발표 전이면 전년도 기준이 최신이다
  return m >= 5 ? `${y}05` : `${y - 1}05`;
}

export async function resolveEntity(input: ResolveEntityInput): Promise<unknown> {
  const type = input.type ?? 'auto';
  const kind = detectIdentifier(input.query);
  const results: Record<string, unknown> = { query: input.query, detectedAs: kind };

  // 숫자 식별자는 회사로만 해석된다 — 기업집단 시도는 의미가 없다
  const tryCompany = type === 'company' || type === 'auto';
  const tryGroup = (type === 'group' || type === 'auto') && kind === 'name';

  let company: Awaited<ReturnType<typeof resolveCorp>> | null = null;
  let companyError: ToolError | null = null;

  if (tryCompany) {
    try {
      const client = new DartClient();
      company = await resolveCorp(input.query, client, {
        allowAmbiguous: true,
        fetchJurirNo: input.fetchJurirNo ?? false,
      });
    } catch (err) {
      if (err instanceof ToolError) companyError = err;
      else throw err;
    }
  }

  if (company && 'ambiguous' in company) {
    return {
      ...results,
      status: 'ambiguous',
      message:
        `'${input.query}' 에 해당하는 법인이 ${company.candidates.length}건입니다. ` +
        `상호가 같아도 별개 법인일 수 있습니다(합병 전후 법인이 대표적). ` +
        `corp_code 로 다시 지정하세요.`,
      // 응답 필드는 전부 snake_case 로 통일한다
      candidates: company.candidates.map((c) => ({
        corp_code: c.corpCode,
        corp_name: c.corpName,
        stock_code: c.stockCode,
        jurir_no: c.jurirNo,
        listed: !!c.stockCode,
      })),
    };
  }

  if (company) {
    results['company'] = {
      corp_code: company.corpCode,
      corp_name: company.corpName,
      stock_code: company.stockCode,
      jurir_no: company.jurirNo,
      listed: !!company.stockCode,
      modify_date: company.modifyDate,
      matched_by: company.matchedBy,
      ...(company.normalizedMatch ? { normalized_match: true } : {}),
    };
    if (!company.jurirNo) {
      results['note_jurir_no'] =
        '법인등록번호가 아직 없습니다. 기업집단포털과 대사하려면 fetchJurirNo=true 로 다시 호출하세요 (DART 호출 1회 소비).';
    }
  }

  // ── 기업집단 해석 ──
  if (tryGroup || input.includeGroup) {
    const yearMonth = input.yearMonth ?? inferYearMonth();
    try {
      const egroup = new EgroupClient();

      if (tryGroup && !company) {
        const { exact, candidates } = await egroup.findGroup(input.query, yearMonth);
        if (exact) {
          results['group'] = {
            name: exact.unityGrupNm,
            code: exact.unityGrupCode,
            representative_person: exact.smerNm,
            representative_company: exact.repreCmpny,
            affiliate_count: Number(exact.sumCmpnyCo) || exact.sumCmpnyCo,
            mutual_investment_restricted: exact.invstmntLmtt,
            year_month: yearMonth,
          };
        } else if (candidates.length) {
          results['group_candidates'] = candidates.map((c) => ({
            name: c.unityGrupNm,
            code: c.unityGrupCode,
          }));
        }
      }

      // 회사를 찾았고 소속집단까지 원하면, 법인등록번호로 조인한다
      if (input.includeGroup && company && !('ambiguous' in company)) {
        const jurirNo = company.jurirNo;
        if (!jurirNo) {
          results['group_lookup'] = {
            status: 'skipped',
            reason:
              '법인등록번호가 없어 기업집단 조인을 건너뛰었습니다. fetchJurirNo=true 로 다시 호출하세요.',
          };
        } else {
          const found = await findGroupByJurirNo(egroup, jurirNo, yearMonth);
          results['group'] = found ?? { status: 'not_found', year_month: yearMonth };
        }
      }
    } catch (err) {
      // 기업집단포털은 선택 기능이다 — 실패해도 회사 해석 결과는 살린다
      if (err instanceof ToolError) {
        results['group_error'] = { error: err.code, message: err.message };
      } else {
        throw err;
      }
    }
  }

  if (!company && !results['group'] && !results['group_candidates']) {
    if (companyError) throw companyError;
    throw new ToolError('corp_not_found', `'${input.query}' 를 회사·기업집단 어느 쪽으로도 찾지 못했습니다.`);
  }

  results['status'] = 'ok';
  return results;
}

/**
 * 법인등록번호로 소속 기업집단을 찾는다.
 *
 * 포털은 집단 단위로만 계열사를 주므로 전 집단을 순회해야 한다(102개, 약 103 호출).
 * 포털은 연 1회 갱신이므로 **집단별 계열사 목록 자체를 캐시**한다 —
 * 최초 1회만 API를 돌고, 이후에는 어떤 회사를 조회해도 캐시로 즉답한다.
 */
async function findGroupByJurirNo(
  egroup: EgroupClient,
  jurirNo: string,
  yearMonth: string,
): Promise<Record<string, unknown> | null> {
  const store = getStore();
  const hitKey = `jurir_group:${yearMonth}:${jurirNo}`;
  const cached = store.get(hitKey);
  if (cached) return JSON.parse(cached) as Record<string, unknown>;
  // "어느 집단에도 없음"도 캐시한다 — 미소속 회사를 반복 조회해도 전 집단을 다시 돌지 않게
  if (store.get(`jurir_group_miss:${yearMonth}:${jurirNo}`)) return null;

  const groups = await egroup.groups(yearMonth);
  log.info('기업집단 역조회 시작', { jurirNo, groups: groups.length, yearMonth });

  for (const g of groups) {
    const affKey = `egroup_affiliates:${yearMonth}:${g.unityGrupCode}`;
    let affiliates: Awaited<ReturnType<EgroupClient['affiliates']>>;
    const affCached = store.get(affKey);
    if (affCached) {
      affiliates = JSON.parse(affCached) as typeof affiliates;
    } else {
      affiliates = await egroup.affiliates(yearMonth, g.unityGrupCode);
      store.set(affKey, JSON.stringify(affiliates));
    }

    const hit = affiliates.find((a) => String(a.jurirno).replace(/-/g, '') === jurirNo);
    if (hit) {
      const result = {
        name: g.unityGrupNm,
        code: g.unityGrupCode,
        representative_person: g.smerNm,
        affiliate_name_in_portal: hit.entrprsNm,
        joined_group_at: hit.grinil,
        founded_at: hit.fondDe,
        biz_no: hit.bizrno,
        year_month: yearMonth,
      };
      store.set(hitKey, JSON.stringify(result));
      return result;
    }
  }
  store.set(`jurir_group_miss:${yearMonth}:${jurirNo}`, '1');
  return null;
}

/** 상호 정규화 결과를 노출한다 (진단·테스트용) */
export { normalizeName };
