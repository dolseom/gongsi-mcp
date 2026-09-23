/**
 * 첫 실행 자동 워밍 — 포털 소속회사의 법인등록번호 캐시를 실행 중에 채워 조인한다
 */

import type { Population } from '../audit-group-disclosures.js';
import { normalizeCompanyName } from '../../parsers/md-table.js';
import { getStore } from '../../lib/store.js';
import type { Deadline } from '../../lib/deadline.js';
import { MAX_JURIR_CANDIDATES, MIN_SMALL_CALL_MS } from './budget.js';
import { addDaysYmd } from './dates.js';
import type { DetectDeps } from './types.js';

/**
 * **자동 워밍**의 기업개황 조회 상한 (실행당) — `MAX_JURIR_LOOKUPS` 와 **별도 카운터**다.
 * 두 예산은 서로를 소모하지 않는다: 워밍은 실행 앞머리에서 모집단 전체를 한 번 훑는 준비 단계이고,
 * `MAX_JURIR_LOOKUPS` 는 판정 도중 동명 후보를 좁히는 데 쓰는 예산이라 성격이 다르다.
 *
 * 결과는 `setJurirNo` 로 영속되므로 **다음 실행은 조회 없이 조인된다** — 예산을 넘겨 못 채운
 * 이름도 다음 실행에서 이어서 채운다(30일 억제는 실제로 대조를 시도한 이름에만 걸린다).
 */
export const MAX_WARM_LOOKUPS = 40;
/**
 * 워밍의 부분일치 검색이 받아 올 후보 상한. **결과가 이 수와 같으면** 이름 조각이 너무 흔해
 * 목록이 잘렸다는 뜻이라, 그 안에 **정규화 완전일치가 정확히 1건**일 때만 그 1건을 후보로 삼고
 * 아니면 대조하지 않는다 — 잘못 좁혀 엉뚱한 회사를 확정하느니 미조인이 낫다.
 */
export const WARM_SEARCH_LIMIT = 5;
/**
 * 부분일치 조각을 **뒤에서 줄여 갈 때의 바닥**. 포털 이름이 DART 상호보다 길면
 * (실측 '미래에셋 생명보험(주)' vs DART '미래에셋생명') 포함 방향이 반대라 원본 조각으로는
 * 영영 못 찾는다. 다만 이보다 짧게 줄이면 조각이 너무 흔해져 후보만 늘어난다.
 *
 * ⚠️ **원본 조각에는 적용하지 않는다** — 이 값을 원본에도 걸었더니 '시니안(유)'(조각 3자)가
 * 검색조차 되지 않아 조인되던 회사를 잃었다 (실측 회귀). 짧은 상호는 실재한다.
 */
const WARM_MIN_FRAGMENT = 4;
/**
 * ⚠️ 절단 **횟수 상한은 두지 않는다.** 로컬 `LIKE '%조각%'` 은 인덱스를 못 타 118,581행 전수
 * 스캔(실측 약 10ms)이라 상한을 두고 싶어지지만, 실측에서 상한 10을 걸었더니
 * '삼성에프엔위탁관리부동산투자회사(주)'(조각 16자)가 4자까지 내려가서야 찾히던 것을 놓쳤다.
 * 절단은 **후보를 제안할 뿐** 확정은 법인등록번호가 하므로 깊이 내려가도 오조인 위험이 없고,
 * 비용은 이름당 (조각길이 − 3)회로 이미 유계다 (실측: 67개사 151회 1.4초 / 24개사 53회 0.5초).
 */
/** 워밍 진단에 이름을 실어 줄 미조인 회사 수 상한 (넘치면 skipped_truncated 로 밝힌다) */
const MAX_WARM_SKIPPED_LISTED = 20;
/** 워밍 재시도 억제 기간 (일). 키는 표기가 흔들리는 이름이 아니라 **법인등록번호**로 잡는다. */
export const WARM_SUPPRESS_DAYS = 30;
/**
 * 억제 키에 박는 **후보 탐색 로직 버전**. `findCandidates` 의 규칙(완전일치 → 점진 절단 →
 * 상한 목록 속 완전일치)을 바꿀 때마다 올린다.
 *
 * ★ 버전을 안 박으면 **개선이 기존 사용자에게 한 달간 도달하지 않는다** — 구버전 로직이
 *   "후보 0건"으로 남긴 억제 기록이 신버전 탐색까지 막기 때문이다 (실측: 점진 절단으로
 *   잡히는 '미래에셋 생명보험(주)' 가 구버전 기록에 막히는 상황). 사용자가 캐시를 손으로
 *   지울 방법도 없다. 버전을 올리면 구버전 키는 자연히 조회되지 않아 마이그레이션이 필요 없다
 *   (남은 옛 키는 kv 행 몇 개일 뿐이다).
 *
 * v2 = 점진 절단(WARM_MIN_FRAGMENT 까지) + 상한 목록 속 정규화 완전일치 1건 채택.
 * v3 = 조각 원본은 길이와 무관하게 검색 (4자 하한은 절단에만 적용 — '시니안' 회귀).
 */
export const WARM_LOGIC_VERSION = 3;
/** 억제 키 — 법인등록번호 + 탐색 로직 버전 */
function warmKey(jurirNo: string): string {
  return `warm:v${WARM_LOGIC_VERSION}:${jurirNo}`;
}

/** 워밍에서 한 이름을 대조하지 못한 사유 */
export type WarmSkipReason =
  | 'no_portal_jurir'
  | 'suppressed'
  | 'no_candidates'
  | 'too_many_candidates'
  | 'over_budget'
  /** 조회 **횟수**가 아니라 **시간** 예산이 모자라 대조하지 않았다 (60초 벽) */
  | 'deadline';

/**
 * 자동 워밍 진단 — 시도했는데 못 채운 것을 **수치와 이름으로** 남긴다.
 * 워밍이 조용히 아무것도 못 하면 "조인 0건"의 원인이 캐시인지 표기인지 알 수 없고,
 * 어느 회사를 손으로 보충해야 하는지도 알 수 없다.
 */
export interface WarmingDiagnostics {
  /** 법인등록번호 대조를 실제로 시도한(기업개황을 부른) 이름 수 */
  attempted: number;
  /** 법인등록번호 1건 일치로 새로 조인된 회사 수 */
  joined: number;
  /** 기업개황 조회 횟수 */
  lookups: number;
  budget: number;
  /** 포털 목록에 법인등록번호가 없어 대조 기준 자체가 없던 이름 수 */
  skipped_no_portal_jurir: number;
  /** 최근 시도 기록이 있어 건너뛴 이름 수 (30일 억제) */
  skipped_suppressed: number;
  /** 후보가 너무 많아(이름 조각이 흔해) 대조하지 않은 이름 수 */
  skipped_too_many_candidates: number;
  /** 어떤 절단 길이에서도 후보가 없던 이름 수 */
  no_candidates: number;
  /** 기업개황 조회가 실패한 횟수 — 불일치와 구분한다 */
  lookup_errors: number;
  over_budget: boolean;
  /** **시간** 예산이 모자라 대조를 시작하지 못한 이름 수 (조회 횟수 예산과 별개다) */
  skipped_deadline: number;
  /** 시간 예산 때문에 워밍을 중간에 멈췄는가 */
  over_deadline: boolean;
  /** 이 실행에서 DART 법인 인덱스를 새로 적재했는가 */
  corp_index_loaded: boolean;
  /** 인덱스 적재를 시도했으나 실패한 사유 (있으면) */
  corp_index_error?: string;
  /** 시간 예산이 모자라 인덱스 적재를 **시작하지 않은** 사유 (실패와 구분한다) */
  corp_index_skipped?: string;
  resolved: Array<{ company: string; corp_code: string; jurir_no: string; candidates: number }>;
  /**
   * 조인하지 못한 회사의 **이름과 사유** — 수치만으로는 어느 회사를 손으로 보충해야 하는지
   * 알 수 없다. 많으면 `MAX_WARM_SKIPPED_LISTED` 건까지만 싣고 `skipped_truncated` 로 밝힌다.
   */
  skipped: Array<{ company: string; reason: WarmSkipReason; candidates?: number }>;
  skipped_total: number;
  skipped_truncated: boolean;
}

/**
 * 첫 실행 **자동 워밍** — 포털 소속회사의 법인등록번호 캐시를 실행 중에 채워 조인한다.
 *
 * 이 프로젝트의 조인 설계는 법인등록번호 직접 조인인데(포털 한글 음차 vs DART 영문 약어라
 * 이름으로는 못 잇는다), 그 번호는 DART 기업개황을 회사별로 불러야만 얻어진다. 종전에는 그 캐시를
 * 사용자가 `resolve_entity(fetchJurirNo=true)` 로 손수 채워야 했고, 안 채우면 판정이 통째로
 * "확인 못 함"으로 떨어졌다 (실측: 콜드 캐시에서 joined 0·unjoined 24, 유가증권 판정불가 8건 →
 * 캐시를 채운 뒤 1건).
 *
 * ★ **확정 근거는 법인등록번호 정확히 1건 일치뿐이다.** 후보 탐색에 이름을 쓰지만 그것은 어디까지나
 *   *후보*를 좁히는 용도이고, 이름 유사도로 조인을 확정하지 않는다 — 실측(미래에셋증권)에서
 *   이름으로 골랐다면 절반의 확률로 2016년 합병으로 사라진 옛 법인을 잡았고, 폐지 법인의 공시를
 *   "공시 존재" 근거로 삼는 것은 전형적인 거짓 안심이다.
 *
 * 2단계로 나눈다: ① 후보 탐색(로컬 인덱스만 — API 콜 0) ② **후보 수 오름차순**으로 예산 소진.
 * 순서가 중요하다 — 후보 1건짜리(싸고 확실한 조인)를 먼저 소진해야 예산이 모자라도 확실한
 * 조인부터 확보된다.
 */
export async function warmJurirJoins(
  deps: DetectDeps,
  population: Population,
  today: string,
  /** 전체 시간 예산 (60초 벽) */
  budget: Deadline,
  /** 준비 단계 자체 상한 — 워밍이 판정 구간의 시간을 먹지 않게 한다 */
  prepBudget: Deadline,
): Promise<WarmingDiagnostics> {
  const warming: WarmingDiagnostics = {
    attempted: 0,
    joined: 0,
    lookups: 0,
    budget: MAX_WARM_LOOKUPS,
    skipped_no_portal_jurir: 0,
    skipped_suppressed: 0,
    skipped_too_many_candidates: 0,
    no_candidates: 0,
    lookup_errors: 0,
    over_budget: false,
    skipped_deadline: 0,
    over_deadline: false,
    corp_index_loaded: false,
    resolved: [],
    skipped: [],
    skipped_total: 0,
    skipped_truncated: false,
  };
  /** 워밍은 전체 예산과 준비 예산 **둘 다** 통과해야 계속한다 */
  const canWarm = (): boolean =>
    budget.canAfford(MIN_SMALL_CALL_MS) && prepBudget.canAfford(MIN_SMALL_CALL_MS);
  const store = getStore();
  const suppressAfter = addDaysYmd(today, -WARM_SUPPRESS_DAYS);

  function noteSkip(company: string, reason: WarmSkipReason, candidates?: number): void {
    warming.skipped_total++;
    if (warming.skipped.length < MAX_WARM_SKIPPED_LISTED) {
      warming.skipped.push({ company, reason, ...(candidates !== undefined ? { candidates } : {}) });
    } else {
      warming.skipped_truncated = true;
    }
  }

  const stripLegal = (n: string): string =>
    n.replace(/\(주\)|\(유\)|㈜|주식회사|유한회사|유한책임회사|합자회사|합명회사/g, '').trim();

  /**
   * 이름 하나의 후보를 찾는다 — **전부 로컬 인덱스 조회라 API 콜이 0이다.**
   *
   * ★ 포털 이름이 DART 상호보다 **길 때** 부분일치는 무력하다 (실측: 포털 '미래에셋 생명보험(주)'
   *   → 조각 '미래에셋생명보험' 으로는 DART 상호 '미래에셋생명' 을 못 찾는다 — 포함 방향이 반대다).
   *   그래서 조각을 **뒤에서 한 글자씩 줄여가며** 다시 찾는다. 실측으로 두 글자만 줄이면 잡혔다.
   *   `WARM_MIN_FRAGMENT` 자 미만으로는 줄이지 않는다 — 그 아래는 너무 흔해 엉뚱한 회사만 나온다.
   * ★ 결과가 상한에 걸려도 **그 안에 정규화 완전일치가 정확히 1건**이면 그것만 후보로 삼는다
   *   (실측: '미래에셋증권' 부분일치는 사모투자 회사들에 밀려 상한 5건이 되는데 정답이 그 안에
   *   있었다). 후보를 **좁히는** 것이지 넓히는 것이 아니며, 확정은 여전히 법인등록번호 1건 일치다.
   */
  function findCandidates(
    rawName: string,
    nameKey: string,
  ): { candidates: Array<{ corpCode: string; corpName: string }> } | { skip: WarmSkipReason; found?: number } {
    const base = rawName.trim();
    const exact = deps.findCorps(base);
    if (exact.length > 0) {
      return exact.length > MAX_JURIR_CANDIDATES
        ? { skip: 'too_many_candidates', found: exact.length }
        : { candidates: exact };
    }
    const fragment = stripLegal(base).replace(/[\s ]+/g, '');
    if (!fragment) return { skip: 'no_candidates' }; // 법인격만 남은 이름 — 빈 조각으로 검색하지 않는다
    // ★ **조각 원본은 길이와 무관하게 반드시 1회 검색한다.** 4자 하한은 *절단해 내려갈 때의*
    //   바닥이지 원본에 거는 조건이 아니다 — 짧은 상호는 실재하고(실측 '시니안(유)' ↔ DART
    //   '시니안', 주석의 '한샘' 사례) 그걸 건너뛰면 멀쩡히 조인되던 회사가 통째로 미조인이 된다.
    //   짧은 조각이 후보를 많이 물어와도 상한 5건 규칙이 막고, 확정은 법인등록번호가 지킨다.
    const floor = Math.min(fragment.length, WARM_MIN_FRAGMENT);
    for (let len = fragment.length; len >= floor; len--) {
      const hits = deps.searchCorps(fragment.slice(0, len));
      if (hits.length === 0) continue; // 더 줄여 본다
      if (hits.length < WARM_SEARCH_LIMIT) return { candidates: hits };
      // 상한에 걸렸다 = 목록이 잘렸을 수 있다. 더 줄이면 더 흔해지기만 하므로 여기서 결론낸다.
      const named = hits.filter((h) => normalizeCompanyName(h.corpName) === nameKey);
      if (named.length === 1) return { candidates: named };
      return { skip: 'too_many_candidates', found: hits.length };
    }
    return { skip: 'no_candidates' };
  }

  // ── ① 후보 탐색 (API 콜 0) ──
  const planned: Array<{
    company: string;
    jurir: string;
    candidates: Array<{ corpCode: string; corpName: string }>;
  }> = [];
  for (const rawName of population.unjoined) {
    // 후보 탐색은 API 콜이 없지만 공짜도 아니다 — 로컬 LIKE 스캔은 인덱스를 못 타고
    // 이름당 (조각길이 − 3)회 돈다 (실측 67개사 151회 1.4초). 예산이 끊기면 여기서도 멈춘다.
    if (!canWarm()) {
      warming.over_deadline = true;
      warming.skipped_deadline++;
      budget.markStopped('warming');
      noteSkip(rawName, 'deadline');
      continue;
    }
    const nameKey = normalizeCompanyName(rawName);
    const portalJurir = population.jurirNoByName?.get(nameKey);
    if (!portalJurir) {
      // 대조 기준이 없으면 무엇을 찾아내도 확정할 수 없다 — 후보 탐색조차 하지 않는다
      warming.skipped_no_portal_jurir++;
      noteSkip(rawName, 'no_portal_jurir');
      continue;
    }
    const lastTry = store.get(warmKey(portalJurir));
    if (lastTry && lastTry >= suppressAfter) {
      warming.skipped_suppressed++;
      noteSkip(rawName, 'suppressed');
      continue;
    }
    const found = findCandidates(rawName, nameKey);
    if ('skip' in found) {
      if (found.skip === 'no_candidates') warming.no_candidates++;
      else warming.skipped_too_many_candidates++;
      noteSkip(rawName, found.skip, found.found);
      continue;
    }
    planned.push({ company: rawName, jurir: portalJurir, candidates: found.candidates });
  }

  // ── ② 후보 수 오름차순으로 예산 소진 (동수는 포털 목록 순서 유지) ──
  planned.sort((a, b) => a.candidates.length - b.candidates.length);
  for (const p of planned) {
    // 시간 예산도 이름 단위로 끊는다 (아래 조회 횟수 예산과 같은 이유) — 시도하지 않았으므로
    // 억제 기록도 남기지 않아 다음 실행이 이어서 채운다.
    if (!canWarm()) {
      warming.over_deadline = true;
      warming.skipped_deadline++;
      budget.markStopped('warming');
      noteSkip(p.company, 'deadline', p.candidates.length);
      continue;
    }
    // 예산은 **콜이 실제로 나가는 후보**만 센다 (동명 판별과 같은 규칙 — 캐시 히트까지 세면
    // 재실행이 같은 예산을 다시 먹어 뒤쪽 이름에 예산이 돌아가지 않는다).
    const uncachedCandidates = deps.isJurirCached
      ? p.candidates.filter((c) => !deps.isJurirCached!(c.corpCode))
      : p.candidates;
    if (warming.lookups + uncachedCandidates.length > MAX_WARM_LOOKUPS) {
      // 예산을 반쯤 쓴 채 이름을 끊으면 어느 후보를 봤는지가 흐려진다 — 이름 단위로 끊는다.
      // 시도하지 않았으므로 억제 기록도 남기지 않는다 → 다음 실행이 이어서 채운다.
      warming.over_budget = true;
      noteSkip(p.company, 'over_budget', p.candidates.length);
      continue;
    }

    warming.attempted++;
    const matched: Array<{ corpCode: string; corpName: string }> = [];
    for (const c of p.candidates) {
      const r = await deps.fetchJurirNo(c.corpCode);
      // 캐시에서 나온 건은 콜이 없었으므로 예산을 쓰지 않는다
      if (!(r.status === 'ok' && r.cached)) warming.lookups++;
      if (r.status === 'ok') {
        if (r.jurirNo === p.jurir) matched.push(c);
      } else if (r.status === 'error') {
        // 조회 실패는 "다른 회사"가 아니다 — 불일치로 뭉개지 않고 따로 센다
        warming.lookup_errors++;
      }
      // 'absent' = 확인된 부재 — 이 후보는 그 계열사가 아니다
    }
    // 시도했으면 성공·실패 무관하게 기록한다 (같은 이름으로 매 실행 조회를 반복하지 않도록)
    store.set(warmKey(p.jurir), today);
    if (matched.length === 1) {
      warming.joined++;
      warming.resolved.push({
        company: p.company,
        corp_code: matched[0]!.corpCode,
        jurir_no: p.jurir,
        candidates: p.candidates.length,
      });
    }
    // 0건 = 후보 중에 그 계열사가 없다 / 2건 이상 = 같은 번호에 corp_code 가 여럿 —
    // 어느 쪽도 고르지 않는다 (추측 금지)
  }
  return warming;
}
