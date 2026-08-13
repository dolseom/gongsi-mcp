/**
 * `get_group_structure` — 기업집단 구조 조회 (축 2 기반)
 *
 * 공정위 기업집단포털 API를 결합해 집단 개요 + 소속회사 전수(+재무현황)를 돌려준다.
 * 소속회사 목록이 곧 **공시의무 모집단**이다 — 감사 도구의 전제 조건.
 *
 * - 포털은 연 1회(5/1) 갱신이므로 집단·계열사·재무 전부 연단위 캐시한다
 *   (계열사 캐시 키는 resolve_entity 의 역조회와 공유 — 같은 데이터를 두 번 받지 않는다)
 * - DART corp_code 조인은 법인등록번호(jurirno ↔ jurir_no) 기준이다.
 *   이름 매칭은 원리적으로 불가능하다 (포털=한글 음차, DART=영문 약어).
 * - 재무현황의 자본총액(caplTotamt)·자본금(caplAmount)은 check_disclosure_duty 의
 *   기준금액 입력으로 그대로 쓸 수 있다 (단위: 원).
 */

import { z } from 'zod';
import {
  EgroupClient,
  type Affiliate,
  type AffiliateFinance,
  type GroupSummary,
} from '../clients/egroup.js';
import { inferYearMonth } from './resolve-entity.js';
import { getStore } from '../lib/store.js';
import { getLogger } from '../lib/logger.js';
import { ToolError } from '../lib/errors.js';

const log = getLogger('group-structure');

export const getGroupStructureInput = z.object({
  group: z
    .string()
    .min(1)
    .describe('기업집단명("삼성", "에스케이") 또는 기업집단코드("K1000032")'),
  include_financials: z
    .boolean()
    .optional()
    .describe(
      '계열사 재무현황 포함 (기본 false, 포털 호출 1회 추가). ' +
        '자산총액·자본총액·자본금·부채·매출·당기순이익 (단위: 원). ' +
        '자본총액·자본금은 check_disclosure_duty 의 totalEquity/paidInCapital 입력으로 쓸 수 있습니다',
    ),
  join_dart: z
    .boolean()
    .optional()
    .describe(
      'DART corp_code 조인 시도 (기본 true). 법인등록번호가 캐시에 채워진 회사만 조인됩니다 — ' +
        'joined 수가 적으면 resolve_entity(fetchJurirNo=true) 로 회사를 조회해 채우세요',
    ),
  year_month: z
    .string()
    .regex(/^\d{6}$/, '공개년월은 YYYYMM 형식입니다 (예: 202605)')
    .optional()
    .describe('기준 공개년월 (미지정 시 최신 지정연도 추정 — 매년 5월 갱신)'),
  compact: z
    .boolean()
    .optional()
    .describe('true 면 계열사를 schema+값 배열로 (150개사 집단에서 토큰 절감)'),
});

export type GetGroupStructureInput = z.infer<typeof getGroupStructureInput>;

/** 집단코드 형식인지 (예: K1000032) */
export function isGroupCode(q: string): boolean {
  return /^K\d{7}$/.test(q.trim());
}

/** 포털 금액 문자열 → 숫자(원). 파싱 불가면 원문 유지 */
export function toWon(s: string | undefined): number | string | null {
  if (s === undefined || s === '') return null;
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : s;
}

async function cachedJson<T>(key: string, fetcher: () => Promise<T>): Promise<{ value: T; cached: boolean }> {
  const store = getStore();
  const hit = store.get(key);
  if (hit) return { value: JSON.parse(hit) as T, cached: true };
  const value = await fetcher();
  // 빈 목록은 캐시하지 않는다 — 상류 오류를 연단위로 박제하면 1년짜리 오진이 된다
  if (!(Array.isArray(value) && value.length === 0)) {
    store.set(key, JSON.stringify(value));
  }
  return { value, cached: false };
}

export async function getGroupStructure(input: GetGroupStructureInput): Promise<unknown> {
  const egroup = new EgroupClient();
  const store = getStore();
  const yearMonth = input.year_month ?? inferYearMonth();
  const joinDart = input.join_dart ?? true;
  let apiCalls = 0;
  let cacheHits = 0;

  // ① 지정 집단 목록 (연단위 캐시)
  const groupsRes = await cachedJson<GroupSummary[]>(`egroup_groups:${yearMonth}`, async () => {
    const g = await egroup.groups(yearMonth);
    apiCalls++;
    return g;
  });
  if (groupsRes.cached) cacheHits++;
  const allGroups = groupsRes.value;
  if (allGroups.length === 0) {
    throw new ToolError(
      'group_not_found',
      `${yearMonth} 기준 지정 기업집단 목록이 비어 있습니다. ` +
        `해당 연도 지정이 아직 공개되지 않았을 수 있습니다 — year_month 를 전년도 5월(예: ${Number(yearMonth.slice(0, 4)) - 1}05)로 지정해 보세요.`,
      { year_month: yearMonth },
    );
  }

  // ② 집단 특정 — 코드 직접 지정 또는 이름 매칭
  const q = input.group.trim();
  let group: GroupSummary | undefined;
  let matchKind: 'code' | 'exact' | 'partial' = 'exact';
  if (isGroupCode(q)) {
    group = allGroups.find((g) => g.unityGrupCode === q);
    matchKind = 'code';
  } else {
    const norm = (s: string) => s.replace(/[\s()㈜]/g, '');
    const target = norm(q);
    group = allGroups.find((g) => norm(g.unityGrupNm) === target);
    if (!group) {
      const candidates = allGroups
        .filter((g) => norm(g.unityGrupNm).includes(target))
        .slice(0, 5);
      if (candidates.length === 1) {
        // 부분일치 단독 후보 자동 선택 — 정확일치와 구분되는 플래그를 응답에 남긴다 (P2-마 23)
        group = candidates[0];
        matchKind = 'partial';
      } else if (candidates.length > 1) {
        throw new ToolError(
          'group_not_found',
          `'${q}' 에 해당하는 기업집단이 여럿입니다. 이름을 정확히 쓰거나 코드로 지정하세요.`,
          { candidates: candidates.map((c) => ({ name: c.unityGrupNm, code: c.unityGrupCode })) },
        );
      }
    }
  }
  if (!group) {
    throw new ToolError(
      'group_not_found',
      `'${q}' 와 일치하는 기업집단이 없습니다 (${yearMonth} 기준 ${allGroups.length}개 집단). ` +
        `공정위 지정 집단명은 법인명과 다를 수 있습니다 (예: "SK"가 아니라 "에스케이").`,
      { year_month: yearMonth },
    );
  }
  const grp = group; // 클로저 안에서 undefined 좁히기가 풀리지 않도록 고정

  // ③ 소속회사 전수 — resolve_entity 역조회와 같은 캐시 키
  const affKey = `egroup_affiliates:${yearMonth}:${grp.unityGrupCode}`;
  const affRes = await cachedJson<Affiliate[]>(affKey, async () => {
    const a = await egroup.affiliates(yearMonth, grp.unityGrupCode);
    apiCalls++;
    return a;
  });
  if (affRes.cached) cacheHits++;
  const affiliates = affRes.value;

  // ④ 재무현황 (옵션, 연단위 캐시)
  let financeByJurir = new Map<string, AffiliateFinance>();
  if (input.include_financials) {
    const finKey = `egroup_finances:${yearMonth}:${grp.unityGrupCode}`;
    const finRes = await cachedJson<AffiliateFinance[]>(finKey, async () => {
      const f = await egroup.finances(yearMonth, grp.unityGrupCode);
      apiCalls++;
      return f;
    });
    if (finRes.cached) cacheHits++;
    financeByJurir = new Map(
      finRes.value.map((f) => [String(f.jurirno).replace(/-/g, ''), f]),
    );
  }

  // ⑤ DART corp_code 조인 — 로컬 인덱스만 본다 (API 호출 없음)
  let joined = 0;
  let ambiguousJoins = 0;
  const rows = affiliates.map((a) => {
    const jurirNo = String(a.jurirno).replace(/-/g, '');
    const row: Record<string, unknown> = {
      name: a.entrprsNm,
      jurir_no: jurirNo,
      biz_no: a.bizrno,
      representative: a.rprsntvNm,
      founded_at: a.fondDe,
      joined_group_at: a.grinil,
    };
    if (joinDart) {
      const matches = store.findCorpsByJurirNo(jurirNo);
      if (matches.length === 1 && matches[0]) {
        joined++;
        row['corp_code'] = matches[0].corpCode;
        row['corp_name_dart'] = matches[0].corpName;
        row['listed'] = !!matches[0].stockCode;
      } else if (matches.length > 1) {
        // 같은 법인등록번호에 corp_code 가 2건 이상 — "캐시에 없어서"가 아니라 중복이라 미조인이다 (P2-마 22).
        // 이 구분이 없으면 안내(fetchJurirNo)를 따라도 영원히 조인되지 않는다.
        ambiguousJoins++;
        row['corp_code_ambiguous'] = matches.map((m) => ({
          corp_code: m.corpCode,
          corp_name: m.corpName,
        }));
      }
    }
    const fin = financeByJurir.get(jurirNo);
    if (fin) {
      row['financials'] = {
        assets_total: toWon(fin.assetsTotamt),
        equity_total: toWon(fin.caplTotamt),
        paid_in_capital: toWon(fin.caplAmount),
        debt_total: toWon(fin.debtTotamt),
        revenue: toWon(fin.selngAmount),
        net_income: toWon(fin.thstrmNtpfAmount),
        fiscal_year_end: fin.stacntDudt,
        unit: '원',
      };
    }
    return row;
  });
  rows.sort((a, b) => String(a['name']).localeCompare(String(b['name']), 'ko'));

  log.info('기업집단 구조 조회', {
    group: group.unityGrupNm,
    affiliates: affiliates.length,
    joined,
    apiCalls,
  });

  const affiliatesOut = input.compact
    ? (() => {
        const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
        return { affiliate_schema: keys, affiliates: rows.map((r) => keys.map((k) => r[k] ?? null)) };
      })()
    : { affiliates: rows };

  return {
    group: {
      name: group.unityGrupNm,
      code: group.unityGrupCode,
      representative_person: group.smerNm,
      representative_company: group.repreCmpny,
      affiliate_count: Number(group.sumCmpnyCo) || group.sumCmpnyCo,
      mutual_investment_restricted: group.invstmntLmtt,
      year_month: yearMonth,
      // 어떻게 매칭됐는지 — 부분일치 자동 선택이 정확일치처럼 보이지 않게 (P2-마 23)
      matched_by: matchKind,
      ...(matchKind === 'partial'
        ? { match_note: `'${q}' 부분일치 단독 후보를 자동 선택했습니다 — 의도한 집단인지 이름을 확인하세요.` }
        : {}),
    },
    affiliate_returned: rows.length,
    ...affiliatesOut,
    diagnostics: {
      api_calls: apiCalls,
      cache_hits: cacheHits,
      // 포털 신고 수와 실제 목록 수가 다르면 여기서 드러난다
      count_mismatch: Number(group.sumCmpnyCo) !== rows.length ? true : false,
      dart_join: joinDart
        ? {
            joined,
            unjoined: rows.length - joined,
            // 미조인 원인은 두 가지다 — "캐시에 없음"만 말하면 중복(ambiguous) 건은
            // 안내대로 fetchJurirNo 를 해도 영원히 조인되지 않는다 (P2-마 22)
            ...(ambiguousJoins > 0 ? { ambiguous: ambiguousJoins } : {}),
            note:
              joined < rows.length
                ? 'corp_code 미조인 회사는 대부분 법인등록번호가 DART 캐시에 없는 경우입니다 — ' +
                  'resolve_entity(fetchJurirNo=true) 로 채워지며, 공시 역수집(J공시 → 기업개황)으로도 채워집니다.' +
                  (ambiguousJoins > 0
                    ? ` 단 ${ambiguousJoins}개사는 같은 법인등록번호에 corp_code 가 2건 이상이라(합병 전후 법인 등) ` +
                      '자동 조인하지 않았습니다 — 해당 행의 corp_code_ambiguous 후보 중에서 직접 고르세요.'
                    : '')
                : undefined,
          }
        : { skipped: true },
      data_freshness: `포털은 연 1회(매년 5/1 기준) 갱신 — ${yearMonth} 기준`,
    },
  };
}
