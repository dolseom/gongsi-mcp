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

  const tryCompany = type === 'company' || type === 'auto';
  // type=group 을 명시했으면 형식 판정과 무관하게 그룹을 조회한다 (Codex 지적 — 숫자 상호 대비).
  // auto 에서는 숫자 입력을 기업집단으로 볼 이유가 없어 이름일 때만 시도한다.
  const tryGroup = type === 'group' || (type === 'auto' && kind === 'name');

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
        // group 키 부재를 "미소속"으로 읽지 않게 명시한다 — not_found(확인된 미소속)와 다르다 (Opus M-5)
        if (!results['group']) {
          results['group'] = { status: 'unknown', reason: '조회 실패 — group_error 참조. 미소속 확정이 아닙니다.' };
        }
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
export async function findGroupByJurirNo(
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
  if (groups.length === 0) {
    // 빈 집단 목록은 "미소속"의 근거가 아니다 — 미공개 연월이거나 상류 오류다.
    // 이대로 순회 0회 → miss 기록이 되면 "기업집단 미소속 = 공시의무 없음"이 박제된다 (get-group-structure 와 동일 가드).
    throw new ToolError(
      'group_not_found',
      `${yearMonth} 기준 지정 기업집단 목록이 비어 있습니다. 해당 연도 지정이 아직 공개되지 않았을 수 있습니다 — ` +
        `yearMonth 를 전년도 5월(예: ${Number(yearMonth.slice(0, 4)) - 1}05)로 지정해 다시 시도하세요.`,
      { year_month: yearMonth },
    );
  }
  log.info('기업집단 역조회 시작', { jurirNo, groups: groups.length, yearMonth });

  let sawEmptyAffiliates = false;
  let consecutiveEmpty = 0;
  for (const g of groups) {
    const affKey = `egroup_affiliates:${yearMonth}:${g.unityGrupCode}`;
    let affiliates: Awaited<ReturnType<EgroupClient['affiliates']>>;
    const affCached = store.get(affKey);
    const cachedList = affCached ? (JSON.parse(affCached) as typeof affiliates) : null;
    // 캐시된 빈 목록은 과거 오염분일 수 있으므로 무시하고 다시 받는다 (자가 치유)
    if (cachedList && cachedList.length > 0) {
      affiliates = cachedList;
      consecutiveEmpty = 0;
    } else {
      affiliates = await egroup.affiliates(yearMonth, g.unityGrupCode);
      // 빈 목록은 캐시하지 않는다 — 상류 오류를 연단위로 박제하면 1년짜리 오진이 된다
      // (지정 집단은 소속회사가 반드시 있으므로 빈 응답은 정상값이 아니다. get-group-structure 와 동일 방어)
      if (affiliates.length > 0) {
        store.set(affKey, JSON.stringify(affiliates));
        consecutiveEmpty = 0;
      } else {
        sawEmptyAffiliates = true;
        // 연속 3개 집단이 비면 포털 전면 장애로 보고 즉시 중단 — 남은 ~100회 호출 낭비 방지 (Opus M-4)
        if (++consecutiveEmpty >= 3) {
          throw new ToolError(
            'egroup_api_error',
            '연속 3개 기업집단의 계열사 목록이 비어 있습니다 — 포털 장애로 보입니다. ' +
              '시간을 두고 다시 시도하세요 (이 결과는 소속 여부 판정의 근거가 아닙니다).',
            { year_month: yearMonth },
          );
        }
      }
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
  if (sawEmptyAffiliates) {
    // 일부 집단의 계열사 목록을 받지 못했다 — 이 상태의 "못 찾음"은 미소속의 근거가 아니므로
    // miss 캐시도, not_found 단정도 하지 않는다.
    throw new ToolError(
      'egroup_api_error',
      '일부 기업집단의 계열사 목록이 비어 있어 미소속 여부를 단정할 수 없습니다. 잠시 후 다시 시도하세요.',
      { year_month: yearMonth },
    );
  }
  store.set(`jurir_group_miss:${yearMonth}:${jurirNo}`, '1');
  return null;
}

/** 상호 정규화 결과를 노출한다 (진단·테스트용) */
export { normalizeName };
