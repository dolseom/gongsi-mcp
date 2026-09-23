/**
 * 기업집단포털 조회 캐시 — `get_group_structure` · `resolve_entity` 가 함께 쓴다.
 *
 * 포털은 연 1회(매년 5/1 기준) 갱신이라 집단 목록·소속회사·재무현황을 전부 연월 키로
 * 영구 캐시한다. 종전에는 같은 키·같은 규칙을 두 도구가 따로 구현했고, `resolve_entity` 의
 * 집단 찾기는 집단 목록을 **캐시 없이** 매번 받았다.
 *
 * 캐시 규칙 (되돌리지 말 것):
 *  - **빈 목록은 캐시하지 않는다.** 상류 오류를 연 단위로 박제하면 1년짜리 오진이 된다 (함정 11번).
 *  - **캐시된 빈 목록은 무시하고 다시 받는다.** "빈 목록 미캐시" 규칙 도입 전에 박제된 오염분의
 *    자가 치유 (Codex 7차 중간 5, P0-3).
 *  - 부분 목록은 클라이언트(`EgroupClient.call`)가 `egroup_incomplete_collection` 으로 던지므로
 *    여기까지 오지 않는다 — 캐시에 들어가는 목록은 전부 완주한 목록이다.
 */

import type { Affiliate, AffiliateFinance, EgroupClient, GroupSummary } from '../clients/egroup.js';
import { getStore } from './store.js';
import { ToolError } from './errors.js';

export interface CachedValue<T> {
  value: T;
  /** true 면 캐시 히트 (포털 호출 없음) */
  cached: boolean;
}

/** 캐시 키 — 도구 간 공유된다. 형식을 바꾸면 기존 사용자 캐시가 전부 무효가 된다. */
export const egroupCacheKeys = {
  groups: (yearMonth: string) => `egroup_groups:${yearMonth}`,
  affiliates: (yearMonth: string, groupCode: string) => `egroup_affiliates:${yearMonth}:${groupCode}`,
  finances: (yearMonth: string, groupCode: string) => `egroup_finances:${yearMonth}:${groupCode}`,
} as const;

/** 빈 배열이면 true — 캐시 읽기·쓰기 양쪽에서 같은 판정을 쓴다 */
function isEmptyList(v: unknown): boolean {
  return Array.isArray(v) && v.length === 0;
}

/**
 * 연 단위 JSON 캐시. 캐시에 없거나 캐시값이 빈 목록이면 `fetcher` 를 부른다.
 * 받은 값이 빈 목록이면 캐시하지 않고 그대로 돌려준다 (빈 목록의 처리는 호출부 몫).
 */
export async function cachedPortalJson<T>(
  key: string,
  fetcher: () => Promise<T>,
): Promise<CachedValue<T>> {
  const store = getStore();
  const hit = store.get(key);
  if (hit) {
    const parsed = JSON.parse(hit) as T;
    if (!isEmptyList(parsed)) return { value: parsed, cached: true };
  }
  const value = await fetcher();
  if (!isEmptyList(value)) store.set(key, JSON.stringify(value));
  return { value, cached: false };
}

/** 지정 기업집단 목록 (연 단위 캐시) */
export function cachedGroups(
  egroup: EgroupClient,
  yearMonth: string,
): Promise<CachedValue<GroupSummary[]>> {
  return cachedPortalJson(egroupCacheKeys.groups(yearMonth), () => egroup.groups(yearMonth));
}

/** 소속회사 전수 (연 단위 캐시) */
export function cachedAffiliates(
  egroup: EgroupClient,
  yearMonth: string,
  groupCode: string,
): Promise<CachedValue<Affiliate[]>> {
  return cachedPortalJson(egroupCacheKeys.affiliates(yearMonth, groupCode), () =>
    egroup.affiliates(yearMonth, groupCode),
  );
}

/** 계열사 재무현황 전수 (연 단위 캐시) */
export function cachedFinances(
  egroup: EgroupClient,
  yearMonth: string,
  groupCode: string,
): Promise<CachedValue<AffiliateFinance[]>> {
  return cachedPortalJson(egroupCacheKeys.finances(yearMonth, groupCode), () =>
    egroup.finances(yearMonth, groupCode),
  );
}

/** 기업집단명 비교용 정규화 — 공백·괄호·㈜ 제거 */
export function normalizeGroupName(s: string): string {
  return s.replace(/[\s()㈜]/g, '');
}

/**
 * 기업집단명으로 찾는다. 정규화 완전일치가 있으면 그것만, 없으면 부분일치 후보(최대 5개).
 * 부분일치 후보를 자동 선택할지는 호출부가 정한다 (도구마다 정책이 다르다).
 */
export function matchGroupByName(
  groups: GroupSummary[],
  name: string,
): { exact: GroupSummary | null; candidates: GroupSummary[] } {
  const target = normalizeGroupName(name);
  const exact = groups.find((g) => normalizeGroupName(g.unityGrupNm) === target) ?? null;
  const candidates = exact
    ? []
    : groups.filter((g) => normalizeGroupName(g.unityGrupNm).includes(target)).slice(0, 5);
  return { exact, candidates };
}

/** 집단 요약 응답 필드 (두 도구 공통) */
export function groupSummaryFields(g: GroupSummary, yearMonth: string): Record<string, unknown> {
  return {
    name: g.unityGrupNm,
    code: g.unityGrupCode,
    representative_person: g.smerNm,
    representative_company: g.repreCmpny,
    affiliate_count: Number(g.sumCmpnyCo) || g.sumCmpnyCo,
    mutual_investment_restricted: g.invstmntLmtt,
    year_month: yearMonth,
  };
}

/**
 * 집단 목록이 비었을 때의 오류. 빈 목록은 "그런 집단 없음"·"미소속"의 근거가 아니다 —
 * 미공개 연월이거나 상류 오류다.
 *
 * @param paramName 사용자에게 안내할 입력 이름 (도구마다 `yearMonth`/`year_month` 로 다르다)
 */
export function emptyGroupListError(yearMonth: string, paramName: string): ToolError {
  return new ToolError(
    'group_not_found',
    `${yearMonth} 기준 지정 기업집단 목록이 비어 있습니다. ` +
      `해당 연도 지정이 아직 공개되지 않았을 수 있습니다 — ` +
      `${paramName} 를 전년도 5월(예: ${Number(yearMonth.slice(0, 4)) - 1}05)로 지정해 다시 시도하세요.`,
    { year_month: yearMonth },
  );
}
