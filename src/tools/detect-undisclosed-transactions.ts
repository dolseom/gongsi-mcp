/**
 * `detect_undisclosed_transactions` — J004 거래내역 ↔ J001 공시 교차탐지 (미공시 후보)
 *
 * audit_group_disclosures(J001) 는 DART 접수분만 보므로 **아예 공시하지 않은 거래(미공시)를
 * 원리상 탐지하지 못한다.** 그런데 J004(기업집단현황공시) 대표회사 연1회 서식에는 계열회사 간
 * 실제 거래가 상대방·금액 단위로 실려 있고, 같은 문서의 재무현황 표에 계열사별 자본금·자본총계가
 * 있어 기준금액까지 한 문서로 계산된다. 이 둘을 대조하면 "실제로 거래했는데 J001 공시가 없는 건"을
 * **후보**로 뽑을 수 있다 — 이 프로젝트에서 미공시 신호를 얻는 유일한 경로다.
 *
 * 파이프라인:
 *  ① 원천 문서 확정 — rcept_no 직접 지정 또는 group+year 로 대표회사 연1회 J004 를 찾는다
 *     (정정 반영 **최신 접수분**을 읽는다 — 내용을 읽는 도구라 최종본이 옳다. 지연 판정과 반대)
 *  ② 파싱 — 자금 차입(차입일 있음 = 높은 신뢰도) / 주요 상품·용역(연간 합계 = 제한적 신호) /
 *     유가증권 총괄 매트릭스(상대방별 연간 총액 — 고시 §4③상 개별 거래로 분해되지 않아 가장
 *     약한 신호. 총액이 기준 미만일 때 "개별도 미만"만 확실하다) / 자본
 *  ③ 회사별 기준금액 계산 — min(100억, max(5억, max(자본총계, 자본금)×5%))
 *     ⚠️ J004 자본은 "당해 사업연도말" 스냅샷이라 고시 §2③의 정확한 기준(주총 승인 최근
 *     사업연도말 자본총계 + 의결일 직전일 자본금)과 **시점이 다르다** — 근사치로만 쓴다.
 *     거래금액이 100억(령 §33①1호 상한) 이상이면 자본과 무관하게 확실하다.
 *  ④ 기준 초과 거래의 차입회사를 corp_code 로 조인 → 그 회사의 J001 목록을
 *     [거래일·사업연도초 −400일 ~ 오늘] 창으로 수집 → 해당 유형 공시가 하나도 없으면 **미공시 후보**,
 *     있으면 **건별 차입일 근접도**(−90~+30일)로 filing_near_date / filing_in_window_only 를 가른다
 *     — 창 전체에 공시 1건만 있어도 그 회사의 모든 차입이 "공시됨"으로 둔갑하는 것(부분 공시
 *     은폐 = 최악 방향의 거짓 안심)을 막기 위해서다 (교차검토 C-1).
 *
 * ★ 이 도구의 출력은 전부 "후보"다. 확정하면 안 되는 이유가 구조적으로 여럿 있다:
 *  - 이사회 의결은 **한도**로 미리 해 둘 수 있다 — 연초 한도 의결 공시 1건이 연중 여러 차입을
 *    커버한다. 검색창을 거래일 이전 400일까지 열지만 그 밖일 수 있다.
 *  - 상대방이 계열 금융회사면 약관특례(고시 §9, 트랙 B)로 분기 일괄공시에 실릴 수 있다.
 *  - 상품·용역 기준은 분기 합계액(§4③)인데 J004 는 연간 합계뿐이다 — (판매회사, 상대방) 연간
 *    합산이 ≥ 4×기준금액일 때만(비둘기집: 어느 분기 하나는 반드시 기준금액 이상) 신호로 쓴다.
 */

import { z } from 'zod';
import { DartClient, viewerUrl, type Disclosure } from '../clients/dart.js';
import { collectAdaptive, type BatchResult } from '../search/batch.js';
import { loadDocument, isDocumentCached, type DocMeta } from './read-disclosure.js';
import {
  resolvePopulation,
  type Population,
  type PopulationInput,
} from './audit-group-disclosures.js';
import { classifyReportName, isCorrection } from './audit-periodic-disclosures.js';
import {
  extractCapitals,
  extractFundBorrowings,
  extractGroupName,
  extractMajorGoodsServices,
  diagnose,
  type FundBorrowing,
  type GoodsServiceRow,
} from '../parsers/j004-transactions.js';
import { extractGoodsServicesMatrix, extractSecuritiesMatrix } from '../parsers/j004-matrix.js';

/**
 * 이 매트릭스 열이 **국외 계열회사** 묶음인가 — 원문 그룹 헤더로만 판별한다.
 *
 * ★ 국외 계열회사와의 거래에는 대규모내부거래 공시의무가 **없다** (원문 3중 확인, 2026-09-04):
 *  - 법 §26① : "…에 속하는 국내 회사는 특수관계인(**국외 계열회사는 제외한다.** 이하 이 조에서
 *    같다)을 상대방으로 하거나 특수관계인을 위하여 …"
 *  - 고시 §2③2호 : "…특수관계인(**국외 계열회사는 제외한다.** 이하 이 호에서 같다)을 상대방으로
 *    하거나 …"
 *  - 공정위 공시 업무 매뉴얼(2026-04-27) : "공시대상회사와 공익법인이 해당 공시대상기업집단에
 *    속하는 국외 계열회사와 대규모내부거래 등을 하는 경우 이에 대한 **이사회 의결 및 공시의무
 *    없음**" (lit26-020)
 *
 * ⚠️ 회사명 모양(영문 상호 등)으로 추측하지 않는다 — 국내 법인도 영문 상호를 쓴다.
 * J004 (5) 총괄표가 열 묶음을 '국내계열사'/'해외계열사' 그룹 헤더로 스스로 구분하므로 그것만 쓴다.
 */
export function isForeignAffiliateColumn(colGroup: string): boolean {
  return /(해외|국외)계열/.test(colGroup.replace(/[\s ]+/g, ''));
}

/** 국외 계열회사 열로 분류한 신호에 붙이는 근거·한계 문구 (사용자에게 그대로 전달된다) */
function foreignAffiliateReason(colGroup: string): string {
  return (
    'not_applicable_foreign_affiliate — 원문 표가 이 열을 **국외(해외) 계열회사** 묶음으로 ' +
    `분류합니다(그룹 헤더: "${colGroup.replace(/\|+$/, '').replace(/\|/g, ' › ')}"). ` +
    '법 §26①은 "특수관계인(**국외 계열회사는 제외한다**. 이하 이 조에서 같다)"이라고 명시하고 ' +
    '고시 §2③2호도 같은 문언이며, 공정위 공시 업무 매뉴얼(2026-04-27)도 "국외 계열회사와 ' +
    '대규모내부거래 등을 하는 경우 이사회 의결 및 공시의무 없음"이라고 답합니다 — 따라서 ' +
    '미공시 후보가 아닙니다. ' +
    '⚠️ 다만 같은 매뉴얼은 "특수관계인이 발행한 주식 등을 **국외 계열회사를 통하여 간접적으로** ' +
    '매입하는 등 특수관계인을 **위한** 거래"에는 의무가 있다고 합니다 — 이 표는 상대방만 보여 ' +
    '그런 간접거래인지 구분하지 못하므로, 금액이 크면 거래 성격을 직접 확인하세요. ' +
    '또한 열 그룹은 병합 헤더를 왼쪽부터 이어받아 읽은 것이라 분류가 틀릴 수 있습니다'
  );
}
import { randomBytes } from 'node:crypto';
import { normalizeCompanyName } from '../parsers/md-table.js';
import { ensureCorpIndex, fetchJurirNo, type JurirNoFetch } from '../resolver/corp-index.js';
import { calcThreshold, CAP_100, 억 } from '../rules/thresholds.js';
import { getStore } from '../lib/store.js';
import { getLogger } from '../lib/logger.js';
import { Deadline } from '../lib/deadline.js';
import { getConfig } from '../lib/config.js';
import { ToolError } from '../lib/errors.js';
import { isValidYMD, toYMD } from '../rules/business-days.js';

const log = getLogger('detect-undisclosed');

const YMD = z
  .string()
  .regex(/^\d{8}$/, 'YYYYMMDD 형식이어야 합니다')
  .refine(isValidYMD, '실존하지 않는 날짜입니다');
const RCEPT = z.string().regex(/^\d{14}$/, '접수번호는 14자리 숫자입니다');

export const detectUndisclosedTransactionsInput = z.object({
  group: z
    .string()
    .min(1)
    .optional()
    .describe('기업집단명 — 대표회사 연1회 J004 를 자동으로 찾는다 (rcept_no 와 동시 사용 불가)'),
  year: z
    .number()
    .int()
    .min(2021)
    .max(2100)
    .optional()
    .describe(
      '연1회 J004 가 **제출된** 연도 (기본: 올해). 거래내역은 통상 그 전년도(직전 사업연도) 것이다',
    ),
  rcept_no: RCEPT.optional().describe(
    '점검할 J004 접수번호 직접 지정 (group 없이 단독 사용). 거래현황 표가 있는 ' +
      '**대표회사 연1회 서식**이어야 한다 — 분기 개별 서식에는 거래내역이 없다',
  ),
  today: YMD.optional().describe('오늘 날짜 (기본: 시스템 날짜). J001 검색창 상한'),
  continuation_token: z
    .string()
    .regex(/^[0-9a-f]{32}$/, '이어보기 토큰은 32자리 16진수입니다')
    .optional()
    .describe(
      '이전 호출이 continuation.complete:false 와 함께 돌려준 토큰. **같은 인자**(rcept_no 또는 ' +
        'group)와 함께 주면 안 본 회사부터 이어서 본다 — 앞 호출이 이미 받아 둔 J001 목록은 ' +
        '다시 받지 않는다. complete:true 가 나올 때까지 반복하면 그 마지막 결과가 온전한 답이다',
    ),
});

export type DetectUndisclosedTransactionsInput = z.infer<
  typeof detectUndisclosedTransactionsInput
>;

/* ────────────────────────────────────────────────────────────────────────────
 * 시간 예산 (60초 벽 — 함정 7)
 *
 * ★ **건수 예산(아래 MAX_*)은 시간 예산이 아니다.** 건수 상한을 곱한 최악 소요를 실측 단가로
 *   계산하면 이미 60초를 넘는다. 단가는 전부 이 저장소에 기록된 실측이다:
 *
 *   | 항목                          | 단가   | 출처                                              |
 *   |------------------------------|--------|---------------------------------------------------|
 *   | 목록 수집 1콜                 | 1.7초  | search/batch.ts SECONDS_PER_CALL (16페이지 27.34초)|
 *   | 목록 측정 1콜(page_count=1)   | 0.4초  | search/batch.ts SECONDS_PER_MEASURE               |
 *   | J001 원문 콜드 1건            | 0.3초  | MAX_FILING_DOC_FETCHES 주석 실측                   |
 *   | 기업개황(법인등록번호) 1콜    | 0.4초  | 직접 실측 없음 — 같은 크기의 측정 호출로 대신 잡음  |
 *   | 법인 인덱스 적재(3.4MB ZIP)   | 3.8~7.8초 | 2026-09-07 실측 (MIN_CORP_INDEX_MS 주석)        |
 *
 *   구간별 최악 = 상한 × 단가:
 *     자동 워밍 40회 × 0.4 = 16.0초 · 동명 판별 20회 × 0.4 = 8.0초
 *     J001 검색 20개사 × (0.4 + 1.7) = 42.0초 (회사당 1페이지 가정 — 페이지가 늘면 더)
 *     원문 열기 40건 × 0.3 = 12.0초 · 원천 J004(목록 1 + 원문 1) ≈ 2.0초
 *     ─────────────────────────────────────────────── 합계 80.0초 > 60초 벽
 *
 *   게다가 단일 HTTP 요청 하나가 타임아웃 100초 × 재시도 3회 + 백오프 7초 = 최악 307초다
 *   (dart.ts). 그래서 **시간**을 따로 재고, 끊길 것 같으면 다음 일을 시작하지 않는다.
 *
 * ★ 캐시가 실행 간에 남는 범위(재실행하면 빨라지는 것): J001 **원문**(store.storeBody) ·
 *   법인등록번호(store.setJurirNo) · 법인 인덱스(corps 표) · 포털 소속회사 목록(연단위).
 *   ⚠️ **J001 공시 목록은 캐시하지 않는다**(설계 불변식 "공시 목록 미캐시") — 검색을 못 마친
 *   회사는 재실행해도 처음부터 조회한다. 안내 문구에서 이 둘을 뭉뚱그리지 말 것.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 도구 한 번의 **전체** 시간 예산.
 *
 * 60초 벽에서 10초를 뺀 값이다. 10초 여유의 근거: ① 마지막으로 시작한 상류 호출이 끝나는 시간
 * (요청 타임아웃을 남은 예산으로 좁히므로 상한이 곧 남은 예산이다) ② 결과 JSON 직렬화·전송
 * ③ 클라이언트 왕복. 이 예산을 넘기면 **결과가 통째로 사라지므로** 넉넉하게 잡는 쪽이 옳다.
 */
export const TIME_BUDGET_MS = 50_000;
/**
 * **준비 단계**(법인 인덱스 적재 + 자동 워밍)에 쓸 수 있는 시간 상한 — 전체 예산의 40%.
 * 준비는 조인 품질을 올릴 뿐 그 자체로 판정을 만들지 않는다. 워밍 최악이 16초(40회 × 0.4)라
 * 여기에 인덱스 적재까지 더하면 준비만으로 예산 절반을 넘길 수 있어, 판정 구간(검색 42초 ·
 * 원문 12초 최악)에 최소 30초를 남긴다.
 */
export const PREP_BUDGET_MS = 20_000;
/**
 * 목록 수집(J001/J004)을 **새로 시작할** 최소 잔여 시간.
 * 근거: 회사 1개사 = 측정 0.4초 + 수집 1.7초 ≈ 2.1초. 여유를 붙여 3초.
 */
const MIN_LIST_CALL_MS = 3_000;
/**
 * 단건 소형 호출(원문 1건 0.3초 · 기업개황 1콜 0.4초)을 새로 시작할 최소 잔여 시간.
 * 목록보다 훨씬 싸므로 임계도 낮다 — 같은 임계를 쓰면 남은 2초로 열 수 있는 원문 대여섯 건을
 * 통째로 버린다.
 */
const MIN_SMALL_CALL_MS = 1_500;
/**
 * 법인 인덱스(3.4MB ZIP → 28MB XML)를 적재할 최소 잔여 시간.
 * 적재 도중 예산이 끊기면 워밍도 판정도 못 하므로, 확보하지 못하면 아예 시작하지 않는다.
 *
 * 실측 2026-09-07 (118,868건 ZIP 적재, 같은 날 2회): corp_index 7,755ms / 3,818ms.
 * 15초는 느린 쪽의 약 2배 — 네트워크 편차(같은 날 2배 차이)를 감안한 여유.
 * 같은 실행의 다른 구간: warming 2,699ms(27콜) · j001_search 3,182ms · judge 1,027ms,
 * 전체 14,877ms / DART HTTP 53콜 (rcept_no 경로) · group 경로 7,430ms / 55콜.
 */
const MIN_CORP_INDEX_MS = 15_000;

/**
 * 동명 1건을 확정하려고 기업개황을 조회할 **후보 수 상한**.
 * 후보가 이보다 많으면 대조하지 않고 ambiguous 로 남긴다 (한 이름이 콜을 독점하지 않게).
 */
const MAX_JURIR_CANDIDATES = 5;
/**
 * 이 도구 한 번의 실행에서 기업개황(법인등록번호) 조회 **총 상한** — 60초 벽 대비.
 * 결과는 캐시에 남으므로 다음 실행은 상한을 쓰지 않고도 조인된다.
 */
const MAX_JURIR_LOOKUPS = 20;
/**
 * **자동 워밍**의 기업개황 조회 상한 (실행당) — `MAX_JURIR_LOOKUPS` 와 **별도 카운터**다.
 * 두 예산은 서로를 소모하지 않는다: 워밍은 실행 앞머리에서 모집단 전체를 한 번 훑는 준비 단계이고,
 * `MAX_JURIR_LOOKUPS` 는 판정 도중 동명 후보를 좁히는 데 쓰는 예산이라 성격이 다르다.
 *
 * 결과는 `setJurirNo` 로 영속되므로 **다음 실행은 조회 없이 조인된다** — 예산을 넘겨 못 채운
 * 이름도 다음 실행에서 이어서 채운다(30일 억제는 실제로 대조를 시도한 이름에만 걸린다).
 */
const MAX_WARM_LOOKUPS = 40;
/**
 * 워밍의 부분일치 검색이 받아 올 후보 상한. **결과가 이 수와 같으면** 이름 조각이 너무 흔해
 * 목록이 잘렸다는 뜻이라, 그 안에 **정규화 완전일치가 정확히 1건**일 때만 그 1건을 후보로 삼고
 * 아니면 대조하지 않는다 — 잘못 좁혀 엉뚱한 회사를 확정하느니 미조인이 낫다.
 */
const WARM_SEARCH_LIMIT = 5;
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
const WARM_SUPPRESS_DAYS = 30;
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
const WARM_LOGIC_VERSION = 3;
/** 억제 키 — 법인등록번호 + 탐색 로직 버전 */
/**
 * 예산 ms 를 안내 문구용 "초" 표기로. 기본값 50,000ms 는 종전과 같은 `50` 이 되고,
 * env override 로 들어온 8,500ms 같은 값은 `8.5` 가 된다 — 문구가 **실제 적용값**을 말해야
 * 사용자가 부분 결과의 이유를 재현할 수 있다.
 */
function budgetSeconds(ms: number): string {
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
}

function warmKey(jurirNo: string): string {
  return `warm:v${WARM_LOGIC_VERSION}:${jurirNo}`;
}

/**
 * **한 번의 호출**에서 J001 검색을 새로 수행할 회사 수 상한 — 회사당 측정 1 + 수집 1 콜이라
 * 60초 벽 대비.
 *
 * ★ 이 상한은 이제 "이 도구가 볼 수 있는 회사 수"가 아니라 **"한 호출에서 새로 볼 회사 수"**다.
 *   넘치는 회사는 이어보기 토큰(`continuation_token`)으로 다음 호출이 이어서 본다 — 앞 호출이
 *   받아 둔 목록은 토큰 캐시에서 나오므로 콜도 상한도 쓰지 않는다. 대형 집단(151개사)도 몇 번
 *   부르면 온전한 답에 이른다.
 */
export const MAX_COMPANIES_TO_SEARCH = 20;
/**
 * 이어보기 캐시의 수명 (6시간).
 *
 * 짧으면 실무자가 잠깐 다른 일을 하고 돌아왔을 때 처음부터 다시 시작해야 하고, 길면 그 사이에
 * 접수된 새 공시가 앞 호출의 옛 목록에 가려 보이지 않는다 ("공시 목록 미캐시" 불변식이 지키는
 * 것이 바로 그 신선도다). 한 번의 점검을 마치기에 충분하고 하루를 넘기지 않는 값으로 6시간을 둔다.
 */
const CONTINUATION_TTL_MS = 6 * 60 * 60 * 1000;
/** 이어보기 kv 키 접두사 — 이 토큰에 딸린 모든 키가 이 접두사를 공유한다 (완주 시 통째로 삭제) */
function contPrefix(token: string): string {
  return `cont:${token}:`;
}
/**
 * J001 원문을 **새로 내려받는** 건수 상한(실행당, 접수번호 기준 중복 제거) — 60초 벽 대비
 * 콜드 1건 ≈ 0.3초.
 *
 * ★ **캐시에 이미 있는 원문은 이 예산을 쓰지 않는다**(`deps.isDocCached`). 그래서 같은 문서로
 *   다시 실행하면 지난 실행이 받아 둔 만큼은 공짜로 대조되고, 예산은 **아직 못 본 원문**에만
 *   쓰인다 — 실행을 거듭할수록 대조 범위가 넓어진다.
 * ★ 유형 미상 공시(`isTypeAmbiguousReport`)와 **보고서명으로 유형이 확정된 공시**가 이 예산을
 *   함께 쓴다. 후자도 상대방을 대조해야 "공시 존재"라 할 수 있기 때문이다 (Codex P0: 종전에는
 *   회사 + 유형 + 검색창만 보고 exists 를 냈다 — 같은 유형의 **다른 상대방** 공시가 이 거래를
 *   확인해 준 것처럼 보였다).
 * ★ 실측(미래에셋 20260819000341): 유가증권 유형은 한 회사에 76·95건씩 매칭돼 **필요 원문이
 *   305건**이었다. 그래서 판정마다 확인되는 즉시 멈추고(조기 종료), 남은 건은 '읽지 않음'으로
 *   둔다 — 전부 여는 설계는 어떤 예산으로도 성립하지 않는다.
 */
const MAX_FILING_DOC_FETCHES = 40;
/**
 * 캐시 히트까지 포함한 **총 원문 파싱** 상한 — 콜은 없지만 파싱은 CPU를 쓴다.
 * 조기 종료가 걸려 있어 실제로는 여기까지 가지 않는 것이 정상이고, 이 상한은 병리적 입력
 * (한 회사에 수백 건 매칭 × 판정 수십 개)에서 도구가 멈추지 않게 하는 마지막 방어선이다.
 */
const MAX_FILING_DOC_READS_TOTAL = 400;
/** 거래일 이전으로 여는 검색창 (달력일) — 한도성 이사회 의결이 거래보다 훨씬 앞설 수 있다 */
const LOOKBACK_DAYS = 400;
/**
 * 건별 근접 대조 창 (달력일) — 공시(의결)는 통상 거래보다 앞서므로 앞을 넓게, 지연 공시를
 * 감안해 뒤를 좁게 연다. 실측: 160억 차입(2/19)의 공시는 2/14 접수 (−5일).
 */
const NEAR_BEFORE_DAYS = 90;
const NEAR_AFTER_DAYS = 30;
/** J004 계열 서식코드 (실측: 80621 분기 개별 / 80622 연1회 대표 / 80623 연1회 개별) */
const J004_ACODES = new Set(['80620', '80621', '80622', '80623', '80624', '80625']);

/** 테스트 주입점 — 실제 API 없이 판정 로직을 검증한다 */
export interface DetectDeps {
  loadDoc: (rceptNo: string) => Promise<{ markdown: string; meta: DocMeta }>;
  collectList: (
    corpCode: string,
    detailTy: 'J001' | 'J004',
    from: string,
    to: string,
  ) => Promise<BatchResult>;
  resolvePop: (input: PopulationInput) => Promise<Population>;
  findCorps: (name: string) => Array<{ corpCode: string; corpName: string }>;
  /**
   * 상호 **부분일치** 검색 (상한 `WARM_SEARCH_LIMIT`건). 자동 워밍에서 완전일치가 0건인
   * 이름의 후보를 찾는 데만 쓴다 — 로컬 인덱스 조회라 API 콜이 아니다.
   *
   * ★ 여기서 찾은 후보는 **후보일 뿐이다.** 조인 확정은 언제나 법인등록번호 1건 일치로만 한다
   *   (이름 유사도로 고르면 합병 전 옛 법인을 잡는다 — `disambiguateByJurirNo` 주석 참조).
   */
  searchCorps: (fragment: string) => Array<{ corpCode: string; corpName: string }>;
  /**
   * DART 기업개황으로 한 회사의 **법인등록번호**를 얻는다 (조회 1회 = API 콜 1회, 결과는 캐시).
   * 동명 2건 이상이라 이름으로 못 고르는 회사를 포털 `jurirno` 와 대조해 확정하는 데 쓴다.
   */
  fetchJurirNo: (corpCode: string) => Promise<JurirNoFetch>;
  /**
   * 이 접수번호의 원문이 **이미 캐시에 있는가** — 원문 열기 예산을 콜이 실제로 나가는 건에만
   * 쓰기 위한 사전 확인이다 (캐시 히트는 60초 벽과 무관하다).
   */
  isDocCached: (rceptNo: string) => boolean;
  /**
   * 이 법인의 법인등록번호가 **이미 저장소에 있는가** — 조회 **횟수** 예산(`MAX_JURIR_LOOKUPS`·
   * `MAX_WARM_LOOKUPS`)을 콜이 실제로 나가는 건에만 쓰기 위한 사전 확인이다.
   *
   * ★ 없으면 "전부 비캐시"로 본다(종전 동작). 주입 테스트는 이 값을 주지 않으므로 카운터
   *   기대값이 그대로 유지된다.
   * ⚠️ 이 확인이 없으면 **이어보기가 제자리를 돈다**: 캐시 히트가 예산을 먹으므로 다시
   *   호출해도 같은 이름들이 같은 예산을 다시 먹고, 뒤쪽 이름은 영원히 대조되지 않는다.
   */
  isJurirCached?: (corpCode: string) => boolean;
  /**
   * 시계 주입점 — **시간 예산 테스트를 실제 sleep 없이** 돌리기 위한 것이다 (기본 Date.now).
   * 판정에는 쓰지 않는다 (판정 기준일은 `input.today`).
   */
  now?: () => number;
  /**
   * ── 이어보기(continuation) 저장소 3종 ──
   *
   * ★ **이 저장소는 토큰이 있는 호출에서만 읽는다.** "공시 목록은 캐시하지 않는다"는 설계
   *   불변식은 신규 호출에 그대로 성립한다 — 토큰 없이 부르면 목록은 언제나 새로 받는다.
   *   이어보기 캐시는 **한 논리적 실행 안에서만** 쓰는 예외다: 같은 실행의 이어보기에서
   *   앞 호출이 이미 받은 목록을 또 받으면 예산만 쓰고 진전이 없다 (이어보기 자체가 성립하지
   *   않는다). 수명은 `CONTINUATION_TTL_MS`(6시간)로 끊는다.
   */
  kvGet: (key: string) => string | null;
  kvSet: (key: string, value: string) => void;
  /** 접두사가 같은 키를 통째로 지운다 (완주·만료한 토큰의 뒷정리) */
  kvDeletePrefix: (prefix: string) => void;
}

function realDeps(client: DartClient, budget: Deadline): DetectDeps {
  return {
    loadDoc: (rceptNo) => loadDocument(rceptNo, client),
    collectList: (corpCode, pblntfDetailTy, from, to) =>
      collectAdaptive(
        client,
        {
          pblntfDetailTy,
          corpCode,
          // 전수(N) 고정. J004 최신본 선택은 코드에서 접수일 최대값으로 고르고,
          // J001 존재 확인은 원본·정정 어느 쪽이 남아 있어도 "공시가 존재한다"이므로
          // 전수 조회가 어느 쪽 판정도 왜곡하지 않는다.
          lastReportOnly: false,
        },
        from,
        to,
        {
          // 청크 타임아웃을 남은 예산 안으로 좁힌다. ⚠️ 이 타임아웃은 `Promise.race` 라
          // **진행 중인 수집을 취소하지 못하지만**(Codex ③), 그 요청 자체는 DartClient 가
          // 같은 예산으로 abort 하므로 뒤에서 계속 도는 일은 없다.
          perChunkTimeoutMs: Math.max(
            MIN_LIST_CALL_MS,
            Math.min(budget.budgetMs, budget.remainingMs()),
          ),
          // 60초 벽 사전 예측도 **남은 예산** 기준으로 한다 — 45초짜리 수집을 시작하면
          // 한 회사가 예산을 통째로 먹어 나머지 회사가 전부 미판정이 된다.
          maxToolSeconds: Math.max(1, Math.floor(budget.remainingMs() / 1000)),
        },
      ),
    resolvePop: (input) => resolvePopulation(input),
    findCorps: (name) =>
      getStore()
        .findCorpsByName(name)
        .map((c) => ({ corpCode: c.corpCode, corpName: c.corpName })),
    searchCorps: (fragment) =>
      getStore()
        .searchCorpsByName(fragment, WARM_SEARCH_LIMIT)
        .map((c) => ({ corpCode: c.corpCode, corpName: c.corpName })),
    fetchJurirNo: (corpCode) => fetchJurirNo(corpCode, client),
    isDocCached: (rceptNo) => isDocumentCached(rceptNo),
    isJurirCached: (corpCode) => Boolean(getStore().getCorpByCode(corpCode)?.jurirNo),
    kvGet: (key) => getStore().get(key),
    kvSet: (key, value) => getStore().set(key, value),
    kvDeletePrefix: (prefix) => void getStore().deletePrefix(prefix),
  };
}

function addDaysYmd(ymd: string, days: number): string {
  const t =
    Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) + days * 86_400_000;
  const d = new Date(t);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** a − b 를 달력일 수로 (a 가 뒤면 양수) */
function daysBetween(a: string, b: string): number {
  const t = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.round((t(a) - t(b)) / 86_400_000);
}

function fmtWon(n: number): string {
  if (n >= 억) {
    const v = n / 억;
    return `${Number.isInteger(v) ? v : v.toFixed(1)}억원`;
  }
  return `${n.toLocaleString('ko-KR')}원`;
}

/** 보고서명 정규화 — 공백·가운뎃점·괄호 표기 차이를 무시하고 유형 키워드를 찾는다 */
function normalizeReportNm(nm: string): string {
  return nm.replace(/[\s·ㆍ・()[\],]/g, '');
}

/** 자금 차입 거래를 커버할 수 있는 J001 보고서명인가 */
export function isBorrowingReport(reportNm: string): boolean {
  return normalizeReportNm(reportNm).includes('자금차입');
}

/**
 * 자금 **대여** 거래를 커버할 수 있는 J001 보고서명인가 (대여회사 관점).
 *
 * 대규모내부거래 공시의무는 거래를 하는 계열회사 **각자에게** 있다 — 차입회사가
 * "특수관계인으로부터의 자금차입" 을 공시하는 것과 별개로, 자금을 대준 계열회사에는
 * "특수관계인에 대한 자금대여" 공시의무가 있다 (J001 ACODE 80719, 실측 보고서명
 * '특수관계인에대한자금대여'). 차입회사 쪽만 보면 대여회사의 미공시가 통째로 시야 밖이다.
 */
export function isLendingReport(reportNm: string): boolean {
  return normalizeReportNm(reportNm).includes('자금대여');
}

/**
 * 거래상대방 이름이 법인이 아니라 **자연인(동일인·친족)** 으로 보이는가 — 어디까지나
 * 이름 모양에 근거한 **추정**이다.
 *
 * 왜 필요한가: J004 §거래현황은 "계열회사와 **특수관계인**간 거래현황" 이라 자연인인
 * 동일인·친족이 거래상대방으로 실릴 수 있다. 자연인은 회사가 아니므로 J001 공시의무자가
 * 아니고, 그 이름으로 "대여회사 미공시 후보" 를 만들면 오경보다.
 *
 * 안전 방향: 이 추정이 틀려(짧은 상호의 실제 법인) 자연인으로 분류되더라도, 그 건은
 * 어차피 조인에 실패해 판정되지 않는 자리다 — 두 경우 모두 "판정하지 않음" 이므로
 * 오분류가 거짓 안심을 만들지 않는다. 그래서 호출부는 **조인·소속 확인이 모두 실패한
 * 뒤에만** 이 함수를 쓴다.
 */
export function looksLikeNaturalPerson(name: string): boolean {
  const n = name.replace(/[\s ]+/g, '');
  // 한글 2~4자만 (한국 성명 형태). 괄호·숫자·영문·법인격 표기가 섞이면 회사로 본다.
  if (!/^[가-힣]{2,4}$/.test(n)) return false;
  // 짧아도 조직임이 드러나는 어미는 제외한다
  return !/(회사|법인|재단|조합|은행|증권|보험|생명|화재|투자|공사|상사|산업|물산|건설|개발|기금|공단|협회|센터)$/.test(
    n,
  );
}

/** 상품·용역 거래를 커버할 수 있는 J001 보고서명인가 (변경 공시 포함) */
export function isGoodsServicesReport(reportNm: string): boolean {
  const n = normalizeReportNm(reportNm);
  return n.includes('상품') && n.includes('용역');
}

/**
 * 유가증권 거래를 커버할 수 있는 J001 보고서명인가.
 *
 * 넓게 잡는다 — 유가증권 거래는 서식이 여러 갈래이고(출자·유상증자참여·수익증권·채권·
 * 기타유가증권), 그중 상당수가 약관특례(고시 §9, 트랙 B)의 분기 일괄공시로 나간다.
 * 필터가 좁으면 정상 공시를 못 알아보고 **없는 미공시를 만들어낸다** — 이 신호는
 * 연간 총액 기반이라 애초에 약한 신호이므로, 오경보 억제 쪽으로 기울이고
 * 실제로 무엇에 걸렸는지는 `matching_filings` 로 그대로 보여준다.
 */
export function isSecuritiesReport(reportNm: string): boolean {
  const n = normalizeReportNm(reportNm);
  return [
    '유가증권',
    '수익증권',
    '출자',
    '유상증자',
    '채권',
    '사모사채',
    '단기금융상품',
    '주식',
  ].some((k) => n.includes(k));
}

/**
 * '[공시취소]' 접수분인가 — 취소 접수는 공시를 없앤 기록이지 공시가 존재한다는 근거가
 * 아니다 (교차검토 S-5). 취소된 원본 접수분은 목록에 별도 행으로 남으므로, 취소 행만
 * 근거에서 빼면 "원본은 있고 취소만 있는" 경우를 잘못 후보로 만들지 않는다.
 */
/**
 * ⚠️ **실측: J001 에 '공시취소' 보고서명은 존재하지 않는다.**
 * 전체시장 2024-01-01~2026-09-04 J001 **22,794건 / 서로 다른 보고서명 94종**을 전수 수집해
 * `취소·철회·무효·해제` 를 찾았더니 **0건**이었다 (픽스처 `j001-report-names-2024-2026.json`).
 * 고시 §8①단서의 "거래 취소"는 별도 서식이 아니라 **정정([기재정정], 1,496건)·변경 공시**로
 * 표현된다. 이 함수는 그래도 남겨 둔다 — 서식이 생기면 그 즉시 판정을 보류시키는 방어선이고,
 * 비용이 0 이다. 다만 **이 경로에 의존하는 판정은 없다**고 알고 읽어야 한다.
 */
function isCancellationReport(reportNm: string): boolean {
  return normalizeReportNm(reportNm).includes('공시취소');
}

/**
 * 보고서명만으로 **거래유형을 알 수 없는** J001 서식인가 — 유형 필터를 빠져나가는 실측 사례다.
 *
 * ★ 왜 필요한가 (실측 2026-09-05, 전체시장 2.7년 22,794건):
 *  - `특수관계인과의내부거래` **740건** — 유형이 이름에 없다. 실물 20260903000201(플랜에이치
 *    벤처스)은 **벤처투자조합 출자**(유가증권 유형)를 이 이름으로 공시했다.
 *  - `약관에의한금융거래시계열금융회사의거래상대방의공시` **433건** — 고시 §9② 약관특례의
 *    거래상대방 쪽 공시다. 실물 20260902000068(농협양곡)은 **차입금 415.2억**을 이 이름으로
 *    공시했다 — 우리 '자금차입' 필터에 걸리지 않는다.
 *
 * 이 이름들이 창 안에 있는데 유형 필터에는 안 걸리면, "공시 없음 → 미공시 후보"가 **오탐**일
 * 수 있다. 그렇다고 "공시 존재"로 삼으면 거짓 안심이므로, 후보를 만들지 않고 **판정을 보류**한다.
 */
export function isTypeAmbiguousReport(reportNm: string): boolean {
  const n = normalizeReportNm(reportNm);
  return (
    n.includes('특수관계인과의내부거래') ||
    n.includes('약관에의한금융거래시계열금융회사의거래상대방')
  );
}

/** J001 원문에서 읽어 낸 사실 — 상대방 대조에 쓴다 (금액은 단위가 섞여 **문자열 그대로**) */
export interface FilingDocFacts {
  /**
   * 현재 유효한 거래상대방. 세로형(80708·80718·80719·80706·80732)은 라벨 행의 **마지막** 비어
   * 있지 않은 셀(정정본은 `정정사유 | 정정전 | 정정후` 순이라 정정후) 1건, 가로형(80757·80702·
   * 80754 계열)은 표의 상대방 열 전부(중복 제거).
   */
  counterparties: string[];
  /** 정정본에서 밀려난 정정전 상대방 — 대조에는 쓰지 않고 표시만 한다 (Codex ②) */
  superseded_counterparties?: string[];
  /** '다. 거래대상' 또는 표의 거래목적물·채권종류(종목명) 열 — 유형 판단 참고용 */
  subjects: string[];
  /** '라. 거래금액' 원문 텍스트 — 80708 은 '217 억원'·'12,226'(백만원) 이 섞여 있어 숫자화하지 않는다 */
  amount_text?: string;
}

/** @deprecated 유형 미상 전용이던 시절의 이름 — 호환용 별칭이다 */
export type AmbiguousDocFacts = FilingDocFacts;

/**
 * 세로형 서식에서 '거래상대방' 자리를 가리키는 라벨인가.
 *
 * ★ **정확 일치만 본다.** `4. 거래상대방과의 차입총계`(80718)·`다. 거래상대방 총잔액`(80719)·
 *   `라. 출자상대방 총출자액`(80732)은 전부 **금액 라벨**이라 상대방 이름이 오지 않는다.
 *   부분 일치로 잡으면 금액을 상대방으로 읽어 대조가 통째로 틀어진다.
 */
function isVerticalCounterpartyLabel(cell: string): boolean {
  const c = cell.trim();
  return (
    /^(?:\d+\.\s*)?거래상대방$/.test(c) ||
    /차입처$/.test(c) ||
    /대여처$/.test(c) ||
    /출자상대방$/.test(c) ||
    /^상대방$/.test(c)
  );
}

/**
 * 세로형 라벨 행으로 인정할지 — 라벨 문자열만 보면 **가로형 표의 열 이름**을 값 행으로 오독한다.
 *
 * 실측 반례 2종: 80757 헤더 `| 거래상대방 | 거래예정기간 | 거래대상 | … |` (첫 칸이 라벨과 같다) /
 * 80754 1단 헤더 `| 발행자 |  | 거래일자 | 거래상대방 |  | 거래금액 | … |` (넷째 칸이 라벨과 같다).
 * 둘 다 그대로 읽으면 '거래목적'·'거래금액' 같은 **열 이름이 상대방으로** 올라간다.
 *
 * → 실측 세로형 6종(80708·80718·80719·80706·80732 + 정정본)은 예외 없이
 *   ① 같은 행에 `회사와의 관계` 칸이 있거나 ② 라벨에 항목번호(`1.`·`나.`)가 붙는다.
 *   둘 중 하나도 없으면 **읽지 않는다** — 미확인 서식은 no_counterparty_field 로 남기지
 *   "공시 존재"로 올리지 않는 쪽이 이 도구의 기본 방향이다.
 */
function isVerticalLabelRow(cells: string[], labelIdx: number): boolean {
  const hasRelation = cells.some((c) => /회사와의\s*관계/.test(c));
  const numbered = /^(?:\d+|[가-힣])\.\s*\S/.test(cells[labelIdx] ?? '');
  return hasRelation || numbered;
}

/** doc_subjects 로 실어 나르는 상한 — 80754 트랙 B 는 종목명이 수십 줄이라 표시가 터진다 */
const MAX_DOC_SUBJECTS = 20;

function mdCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/**
 * J001 원문(markdown)에서 **거래상대방·거래대상·거래금액**을 읽는다.
 *
 * 실측 서식 (2026-09-05, 미래에셋·농협양곡 실물 7건):
 *  - **세로형** — 라벨 행의 오른쪽에 상대방 이름이 온다. 라벨은 서식마다 다르다:
 *    `1. 거래상대방`(80708 내부거래 / 80719 자금대여 / 80706 수익증권 / 80732 출자) ·
 *    `나. 차입처`(80718 자금차입). 정정본은 `| 1. 거래상대방 | 정정사유 | 정정전 | 정정후 |
 *    회사와의 관계 … |` 형태라 라벨 뒤 ~ '회사와의 관계' 앞의 비어 있지 않은 셀 중
 *    **마지막**(= 정정후)만 현재 상대방으로 삼는다.
 *  - **가로형 A** — 상대방이 표의 **첫 칸**. 헤더가 `거래상대방`(80757 약관 상대방 공시) 또는
 *    `거래상대방(동일인 등 출자계열회사)`(80702 상품·용역 분기공시)이고, 후자는 다음 항목번호
 *    행(`5. 상품ㆍ용역 거래내역`)에서 끝난다.
 *  - **가로형 B** — 2단 헤더의 `상대방명` **열 번호**로 읽는다 (80754·80751·80752·80701 트랙 B
 *    분기 일괄). 같은 표의 `발행자명` 열은 상대방이 아니다. 소계·총계 행은 그 칸이 비어 있어
 *    자연히 빠진다.
 *
 * 어느 형식도 못 읽으면 counterparties 가 빈 배열 — 호출 쪽은 이를 **대조 불가**로 다뤄야 한다
 * (일치 없음과 다르다). 미확인 서식(담보 80734·80735, 유상증자참여 80733 등)이 여기 해당하고,
 * 그 건은 "공시 존재"로 올리지 않는다.
 */
export function parseFilingCounterparties(markdown: string): FilingDocFacts {
  const lines = markdown.split('\n');
  const counterparties: string[] = [];
  const superseded: string[] = [];
  const subjects: string[] = [];
  let amountText: string | undefined;
  const isSep = (c: string) => /^-+$/.test(c);
  const pushUnique = (arr: string[], v: string) => {
    if (v && v !== '-' && !arr.includes(v)) arr.push(v);
  };
  const pushSubject = (v: string) => {
    if (subjects.length < MAX_DOC_SUBJECTS) pushUnique(subjects, v);
  };

  // ── 세로형 ──
  for (const line of lines) {
    if (!line.trim().startsWith('|')) continue;
    const cells = mdCells(line);
    if (cells.length === 0 || cells.every(isSep)) continue;
    const label = cells.join(' ');
    const labelIdx = cells.findIndex(isVerticalCounterpartyLabel);
    if (labelIdx >= 0 && isVerticalLabelRow(cells, labelIdx)) {
      const rest = cells.slice(labelIdx + 1);
      const stop = rest.findIndex((c) => c.includes('회사와의 관계') || c.includes('회사와의관계'));
      const cand = (stop >= 0 ? rest.slice(0, stop) : rest).filter((c) => c !== '');
      // ★ 정정본은 `정정사유 | 정정전 | 정정후` — 정정전 상대방으로 "일치"를 만들면 안 된다.
      //   마지막 셀만 현재 상대방으로 삼고 나머지는 superseded 로 분리한다.
      if (cand.length > 0) {
        pushUnique(counterparties, cand[cand.length - 1]!);
        // 3칸 이상이면 첫 칸은 정정사유 — 상대방이 아니다
        for (const c of cand.length >= 3 ? cand.slice(1, -1) : cand.slice(0, -1)) {
          pushUnique(superseded, c);
        }
      }
      continue;
    }
    if (/다\.\s*거래대상/.test(label)) {
      const idx = cells.findIndex((c) => /거래대상/.test(c));
      const cand = cells.slice(idx + 1).filter((c) => c !== '');
      if (cand.length > 0) pushSubject(cand[cand.length - 1]!);
      continue;
    }
    if (/라\.\s*거래금액/.test(label) && amountText === undefined) {
      const idx = cells.findIndex((c) => /거래금액/.test(c));
      const cand = cells.slice(idx + 1).filter((c) => c !== '');
      if (cand.length > 0) amountText = cand[cand.length - 1];
    }
  }
  if (counterparties.length > 0) {
    return {
      counterparties,
      ...(superseded.length ? { superseded_counterparties: superseded } : {}),
      subjects,
      amount_text: amountText,
    };
  }

  // ── 가로형 A(첫 칸) / B(상대방명 열) ──
  // 헤더를 만나면 모드가 바뀌고, 표가 끝나거나 다음 항목번호 행을 만나면 모드가 풀린다.
  type HMode =
    | { kind: 'first_cell'; subjectCol: number }
    | { kind: 'named_column'; cpCol: number; subjectCol: number }
    | null;
  let mode: HMode = null;
  for (const line of lines) {
    if (!line.trim().startsWith('|')) {
      mode = null;
      continue;
    }
    const cells = mdCells(line);
    if (cells.every(isSep)) continue;
    // 헤더 B — 2단 헤더의 '상대방명' 열. '발행자명' 열보다 이 열이 상대방이다.
    const cpCol = cells.findIndex((c) => c === '상대방명');
    if (cpCol >= 0) {
      mode = {
        kind: 'named_column',
        cpCol,
        subjectCol: cells.findIndex((c) => /종목명|채권종류/.test(c)),
      };
      continue;
    }
    // 헤더 A — 첫 칸이 '거래상대방'(80757) 이거나 어느 칸이 '거래상대방(' 로 시작(80702)
    if (cells[0] === '거래상대방' || cells.some((c) => c.startsWith('거래상대방('))) {
      mode = {
        kind: 'first_cell',
        subjectCol: cells.findIndex((c) => c === '거래목적물' || c === '거래대상'),
      };
      continue;
    }
    if (!mode) continue;
    const first = cells[0] ?? '';
    // 다음 항목번호(`5. 상품ㆍ용역 거래내역`) 행 = 상대방 표의 끝 (80702)
    if (/^\d+\.\s*\S/.test(first)) {
      mode = null;
      continue;
    }
    if (/^(총\s*계|소\s*계|합\s*계|이사회\s*의결일)/.test(first)) continue;
    if (mode.kind === 'first_cell') {
      pushUnique(counterparties, first);
      if (mode.subjectCol >= 0) pushSubject(cells[mode.subjectCol] ?? '');
    } else {
      pushUnique(counterparties, cells[mode.cpCol] ?? '');
      if (mode.subjectCol >= 0) pushSubject(cells[mode.subjectCol] ?? '');
    }
  }
  return { counterparties, subjects, amount_text: amountText };
}

/** @deprecated 유형 미상 전용이던 시절의 이름 — 호환용 별칭이다 */
export const parseAmbiguousFilingDoc = parseFilingCounterparties;

/** 유형 미상 원문의 거래대상을 우리 판정 유형으로 거칠게 분류한 값 */
export type AmbiguousSubjectClass = 'funds' | 'securities' | 'goods' | 'unknown';

const SUBJECT_KEYWORDS: Record<Exclude<AmbiguousSubjectClass, 'unknown'>, RegExp> = {
  funds: /차입|대여|대여금|차입금|자금/,
  securities: /지분|주식|출자|증권|수익증권|채권|사채|펀드|조합|CP|기업어음/,
  goods: /용역|서비스|상품|사용료|브랜드|상표|임대|임차|판매|수수료|광고|공사|매입|매출|위탁|운영|관리|보험/,
};

/**
 * 거래대상 텍스트 → 판정 유형. **정확히 한 유형의 키워드만** 걸릴 때 그 유형, 아니면 unknown.
 *
 * ★ 왜 필요한가 (Codex 검토 ①, 2026-09-05): 상대방 이름만으로 "공시 존재"를 올리면 같은 회사 쌍의
 *   **다른 유형** 공시(예: 자산운용과의 브랜드 사용료 공시)가 그 쌍의 유가증권 거래를 확인 대상에서
 *   빼 버린다. 같은 집단 안에서 한 쌍이 여러 유형을 거래하는 것은 흔하다.
 * ★ 왜 키워드 하나로 단정하지 않는가: '출자증권 매입 용역' 같은 복합 표현은 두 유형에 걸린다 —
 *   그때는 unknown 으로 두고 사람이 보게 한다 (버리지 않고 보류).
 */
export function classifyAmbiguousSubject(subjects: string[]): AmbiguousSubjectClass {
  const text = subjects.join(' ');
  if (!text.trim()) return 'unknown';
  const hits = (Object.keys(SUBJECT_KEYWORDS) as Array<keyof typeof SUBJECT_KEYWORDS>).filter((k) =>
    SUBJECT_KEYWORDS[k].test(text),
  );
  return hits.length === 1 ? hits[0]! : 'unknown';
}

/** checkCompany 의 typeLabel → 원문 거래대상에서 기대하는 분류 */
function expectedSubjectClass(typeLabel: string): Exclude<AmbiguousSubjectClass, 'unknown'> {
  if (typeLabel === '유가증권') return 'securities';
  if (typeLabel === '상품·용역') return 'goods';
  return 'funds'; // 자금차입 · 자금대여
}

/** 원문 대조 결과 — FilingRef 에 실어 사용자에게도 그대로 보여 준다 */
type FilingDocRead =
  | { read: 'ok'; facts: FilingDocFacts; acode: string | null }
  | { read: 'error'; error: string }
  | { read: 'budget_exceeded' }
  /** **건수**가 아니라 **시간** 예산(60초 벽)이 모자라 열지 않았다 — 둘은 대응이 다르다 */
  | { read: 'deadline_exceeded' };

/** 회사별 기준금액 (J004 재무현황 기반 근사치) */
export interface ApproxThreshold {
  value: number;
  formula: string;
  /** 재무현황 표에서 매칭된 원문 회사명 */
  source_row: string;
}

/**
 * 재무현황 자본으로 회사별 기준금액을 계산한다.
 * 자본총계·자본금이 둘 다 없는 회사는 넣지 않는다 (추정 금지).
 * 정규화 동명이 **서로 다른 기준금액**으로 두 번 나오면 어느 쪽이 맞는지 알 수 없다 —
 * 둘 다 버리고 conflicts 로 보고한다 (첫 행 유지는 다른 회사의 자본을 쓰는 사고가 된다.
 * 교차검토 S-3).
 */
export function buildThresholdMap(capitals: ReturnType<typeof extractCapitals>): {
  map: Map<string, ApproxThreshold>;
  conflicts: string[];
} {
  const map = new Map<string, ApproxThreshold>();
  const conflicted = new Set<string>();
  for (const c of capitals) {
    if (c.totalEquity === null && c.paidInCapital === null) continue;
    const r = calcThreshold({
      ...(c.totalEquity !== null ? { totalEquity: c.totalEquity } : {}),
      ...(c.paidInCapital !== null ? { paidInCapital: c.paidInCapital } : {}),
    });
    if (!r) continue;
    const key = normalizeCompanyName(c.company);
    if (conflicted.has(key)) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { value: r.threshold, formula: r.formula, source_row: c.company });
      continue;
    }
    // 같은 이름·같은 값이면 중복 행일 뿐이다 (표가 금융/비금융으로 갈릴 때) — 유지
    if (prev.value !== r.threshold) {
      map.delete(key);
      conflicted.add(key);
    }
  }
  return { map, conflicts: [...conflicted] };
}

type Certainty = 'certain_by_cap' | 'approx_from_j004';

/** 거래 1건의 기준금액 판정 */
export function judgeOverThreshold(
  amount: number,
  threshold: ApproxThreshold | undefined,
): { over: boolean | null; certainty?: Certainty } {
  // 령 §33①1호 상한: 기준금액은 어떤 자본에서도 100억을 넘지 못한다 —
  // 거래금액이 100억 이상이면 자본을 몰라도 기준 이상이 확실하다
  if (amount >= CAP_100) return { over: true, certainty: 'certain_by_cap' };
  if (!threshold) return { over: null };
  return amount >= threshold.value
    ? { over: true, certainty: 'approx_from_j004' }
    : { over: false };
}

interface FilingRef {
  rcept_no: string;
  rcept_dt: string;
  report_nm: string;
  viewer_url: string;
  /** 이 공시의 원문을 열었는가 (유형 미상 공시 + 보고서명으로 유형이 확정된 매칭 공시 공통) */
  doc_read?: 'ok' | 'error' | 'budget_exceeded' | 'deadline_exceeded' | 'no_counterparty_field';
  /** 원문 '거래상대방' (정정본은 정정전·정정후가 함께) — 이 거래의 상대방과 대조한 값 */
  doc_counterparties?: string[];
  /** 원문 '거래대상'/'거래목적물' — 유형 참고 */
  doc_subjects?: string[];
  /** 원문 '거래금액' 텍스트 그대로 (단위 혼재: '217 억원' / '12,226'[백만원]) */
  doc_amount_text?: string;
  doc_acode?: string | null;
  doc_error?: string;
  /** 이 공시의 원문 상대방이 이 거래의 상대방과 정규화 일치했다 */
  covers_this_counterparty?: boolean;
  /** 정정본의 정정전 상대방 (대조에 쓰지 않음) */
  doc_superseded_counterparties?: string[];
  /** 원문 거래대상을 판정 유형으로 분류한 값 — 상대방 일치 + 이 분류 일치일 때만 "공시 존재" */
  doc_subject_class?: AmbiguousSubjectClass;
  /**
   * 이 공시가 이 거래를 커버한다고 볼 근거가 됐다.
   * 유형 미상 경로는 **상대방 + 거래대상 분류**가 모두 맞을 때, 보고서명 경로는 유형이 이미
   * 이름으로 확정돼 있어 **상대방**만 맞으면 true 다.
   */
  covers_this_transaction?: boolean;
}

function toFilingRef(d: Disclosure): FilingRef {
  return {
    rcept_no: d.rcept_no,
    rcept_dt: d.rcept_dt,
    report_nm: d.report_nm,
    viewer_url: viewerUrl(d.rcept_no),
  };
}

type TxStatus =
  | 'undisclosed_candidate'
  /**
   * 상품·용역 전용 — J001 이 없어 후보이나, 공시의무의 전제(상대방이 동일인·친족 20%↑ 출자
   * 계열회사 또는 그 자회사 — 법 §26①4호·령 §33②·고시 §4①4호)를 확인할 데이터가 없다.
   * 요건 미충족 상대방과의 거래는 애초에 공시대상이 아니므로 "미공시 후보"로 단정하면
   * 오경보다 (Codex 4차 C1). 동일인이 법인인 집단은 이 유형의 의무 자체가 없다.
   */
  | 'candidate_if_counterparty_qualified'
  /** 차입일 근방(−90~+30일)에 같은 유형 공시가 있다 — 내용 대조는 아니다 */
  | 'j001_filing_near_date'
  /** 창 안 어딘가에만 있다 — 한도 의결 커버일 수도, 부분 공시 누락일 수도 있다 */
  | 'j001_filing_in_window_only'
  /** 날짜 개념이 없는 신호(상품·용역)의 존재 확인 */
  | 'j001_filing_exists'
  | 'below_threshold'
  /** 계열편입일 이전 거래 — 편입 전에는 공시의무가 없다 (포털 소속회사 목록을 불러온 경우) */
  | 'no_duty_before_joining'
  | 'not_judged';

/**
 * 대여회사(자금을 대준 계열회사) 관점의 판정 어휘.
 * 차입회사 쪽 어휘(TxStatus)를 그대로 쓰되, 상대방을 회사로 특정하지 못하는 두 경우를 더한다.
 */
type LenderStatus =
  | 'undisclosed_candidate'
  | 'j001_filing_near_date'
  | 'j001_filing_in_window_only'
  | 'below_threshold'
  | 'no_duty_before_joining'
  | 'not_judged'
  /** 상대방 이름을 DART corp_code 로 잇지 못했다 — 조회 자체가 불가능 */
  | 'counterparty_not_joined'
  /** 상대방이 자연인(동일인·친족)으로 **추정**된다 — 회사가 아니면 J001 의무자가 아니다 */
  | 'counterparty_not_company';

/**
 * 한 차입 건의 **대여회사 쪽** 공시의무 대조 결과.
 * 기준금액은 대여회사 자신의 자본으로 계산한다 (같은 J004 재무현황 표).
 */
interface LenderSide {
  /** 대여회사 = 이 차입 건의 거래상대방 */
  company: string;
  corp_code?: string;
  status: LenderStatus;
  reason?: string;
  threshold?: {
    value: number;
    value_display: string;
    formula: string;
    source_row: string;
  };
  certainty?: Certainty;
  joined_group_at?: string;
  j001_search?: { from: string; to: string; type_filter: string };
  matching_filings?: FilingRef[];
  matching_filings_total?: number;
  nearest_filing_gap_days?: number;
  same_counterparty_annual_total?: number;
  same_counterparty_annual_total_display?: string;
  cancellations_of_type_in_window?: number;
  search_partial?: boolean;
  other_j001_in_window?: number;
  /**
   * 같은 유형·같은 창의 공시이지만 **원문 거래상대방이 이 거래 상대방과 달랐던** 건 (최대 5).
   * "공시 없음"이 아니라 "이 거래의 공시로 확인되지 않은 공시"다 — doc_counterparties 를 직접
   * 대조하라는 뜻으로 함께 낸다.
   */
  matching_filings_unconfirmed?: FilingRef[];
  /** matching_filings 의 **원문 거래상대방**까지 이 거래 상대방과 일치함을 확인했다 */
  counterparty_confirmed_by_document?: true;
  /**
   * 상대방이 확인돼 판정이 끝났거나(또는 원문 예산이 소진돼) **열어 보지 않은** 매칭 공시 수.
   * ⚠️ "상대방이 다른 공시"가 아니라 **보지 않은 공시**다 — 확인된 건이 있으면 더 볼 필요가
   * 없어서, 없으면 예산이 없어서다(후자는 reason 에 명시된다).
   */
  matching_filings_not_examined_total?: number;
  /** 이름만으로 유형을 알 수 없어 판정을 보류시킨 공시 — "공시 있음" 확인이 아니다 */
  type_ambiguous_filings?: FilingRef[];
  /** 유형 미상 공시의 **원문 거래상대방**이 이 거래 상대방과 일치해 "공시 존재"로 확정했다 */
  type_ambiguous_resolved_by_document?: true;
}

/**
 * 거래 **상대방 쪽** 공시의무 대조 결과 — 상품·용역의 매입회사, 유가증권의 매도회사.
 *
 * ★ 근거 (공정위 공시 업무 매뉴얼 2026-04-27 lit26-001): "거래규모가 거래당사자 **모두에게**
 * 대규모내부거래에 해당되는 경우 이사회 의결 및 공시의무는 **거래당사자 모두에게** 있음.
 * 만일 거래규모가 일방당사자에게만 해당되는 경우에는 해당되는 거래당사자에게만 있음."
 * → 기준금액을 **각자의 자본**으로 계산해 따로 판정한다 (차입의 lender_side 와 같은 원리).
 *
 * ⚠️ 상품·용역은 여기에 더해 **상대방 요건**이 걸린다 — 각 당사자의 의무는 *그 상대방*이
 * 동일인·친족 20%↑ 출자 계열회사인지에 달렸다(고시 §4①4호, 매뉴얼 lit26-065·066 실례).
 * 지분을 확인할 수 없으므로 양쪽 모두 candidate_if_counterparty_qualified 에 머문다.
 *
 * 날짜 개념이 없는 표(연간 총액)라 건별 근접 대조는 하지 않는다 — 존재 확인까지만 한다.
 */
interface CounterpartySide {
  /** 이 관점의 공시의무자 = 원래 신호의 거래상대방 (매입회사 또는 매도회사) */
  company: string;
  corp_code?: string;
  status:
    | 'candidate_if_counterparty_qualified'
    | 'candidate_aggregate_only'
    | 'j001_filing_exists'
    | 'below_threshold'
    | 'not_judged'
    /** 상대방을 DART corp_code 로 잇지 못했다 — 조회 자체가 불가능 */
    | 'counterparty_not_joined'
    /** 상대방이 자연인(동일인·친족)으로 **추정**된다 — 회사가 아니면 J001 의무자가 아니다 */
    | 'counterparty_not_company';
  reason?: string;
  threshold?: { value: number; value_display: string; formula: string; source_row: string };
  certainty?: Certainty;
  /** 상품·용역 전용 — 연간 총액이 이 회사 기준금액의 4배 이상이면 비둘기집이 선다 */
  quarterly_logic?: GoodsMatrixSignal['quarterly_logic'];
  /** 상품·용역 전용 — 상대방(= 원래 신호의 판매회사) 지분 요건을 확인하지 못했다 */
  counterparty_qualification?: 'not_verified';
  j001_search?: { from: string; to: string; type_filter: string };
  matching_filings?: FilingRef[];
  matching_filings_total?: number;
  cancellations_of_type_in_window?: number;
  search_partial?: boolean;
  other_j001_in_window?: number;
  /**
   * 같은 유형·같은 창의 공시이지만 **원문 거래상대방이 이 거래 상대방과 달랐던** 건 (최대 5).
   * "공시 없음"이 아니라 "이 거래의 공시로 확인되지 않은 공시"다 — doc_counterparties 를 직접
   * 대조하라는 뜻으로 함께 낸다.
   */
  matching_filings_unconfirmed?: FilingRef[];
  /** matching_filings 의 **원문 거래상대방**까지 이 거래 상대방과 일치함을 확인했다 */
  counterparty_confirmed_by_document?: true;
  /**
   * 상대방이 확인돼 판정이 끝났거나(또는 원문 예산이 소진돼) **열어 보지 않은** 매칭 공시 수.
   * ⚠️ "상대방이 다른 공시"가 아니라 **보지 않은 공시**다 — 확인된 건이 있으면 더 볼 필요가
   * 없어서, 없으면 예산이 없어서다(후자는 reason 에 명시된다).
   */
  matching_filings_not_examined_total?: number;
  /** 이름만으로 유형을 알 수 없어 판정을 보류시킨 공시 — "공시 있음" 확인이 아니다 */
  type_ambiguous_filings?: FilingRef[];
  /** 유형 미상 공시의 **원문 거래상대방**이 이 거래 상대방과 일치해 "공시 존재"로 확정했다 */
  type_ambiguous_resolved_by_document?: true;
}

interface JudgedBorrowing {
  company: string;
  corp_code?: string;
  counterparty: string;
  amount: number;
  amount_display: string;
  date: string | null;
  raw_date?: string;
  table_label: string;
  threshold?: {
    value: number;
    value_display: string;
    formula: string;
    source_row: string;
  };
  certainty?: Certainty;
  status: TxStatus;
  reason?: string;
  joined_group_at?: string;
  j001_search?: { from: string; to: string; type_filter: string };
  matching_filings?: FilingRef[];
  /** matching_filings 가 10건에서 잘렸을 때의 전체 건수 */
  matching_filings_total?: number;
  /** 가장 가까운 같은 유형 공시와의 일수 차 (공시 접수일 − 차입일. 음수 = 공시가 앞) */
  nearest_filing_gap_days?: number;
  /**
   * 같은 상대방과의 연간 차입 합산 (원). 개별 건이 기준 미달이어도 §4③(동일 거래상대방·
   * 동일 거래대상 기준 판단)에 따라 합산 기준으로 공시대상일 수 있다 (Codex 4차 C2).
   */
  same_counterparty_annual_total?: number;
  same_counterparty_annual_total_display?: string;
  /** 창 안의 같은 유형 '[공시취소]' 접수분 수 — 매칭 공시가 취소된 원공시일 수 있다 */
  cancellations_of_type_in_window?: number;
  search_partial?: boolean;
  other_j001_in_window?: number;
  /**
   * 같은 유형·같은 창의 공시이지만 **원문 거래상대방이 이 거래 상대방과 달랐던** 건 (최대 5).
   * "공시 없음"이 아니라 "이 거래의 공시로 확인되지 않은 공시"다 — doc_counterparties 를 직접
   * 대조하라는 뜻으로 함께 낸다.
   */
  matching_filings_unconfirmed?: FilingRef[];
  /** matching_filings 의 **원문 거래상대방**까지 이 거래 상대방과 일치함을 확인했다 */
  counterparty_confirmed_by_document?: true;
  /**
   * 상대방이 확인돼 판정이 끝났거나(또는 원문 예산이 소진돼) **열어 보지 않은** 매칭 공시 수.
   * ⚠️ "상대방이 다른 공시"가 아니라 **보지 않은 공시**다 — 확인된 건이 있으면 더 볼 필요가
   * 없어서, 없으면 예산이 없어서다(후자는 reason 에 명시된다).
   */
  matching_filings_not_examined_total?: number;
  /** 이름만으로 유형을 알 수 없어 판정을 보류시킨 공시 — "공시 있음" 확인이 아니다 */
  type_ambiguous_filings?: FilingRef[];
  /** 유형 미상 공시의 **원문 거래상대방**이 이 거래 상대방과 일치해 "공시 존재"로 확정했다 */
  type_ambiguous_resolved_by_document?: true;
  other_j001_sample?: FilingRef[];
  /** 자금을 대준 계열회사 쪽의 "자금대여" 공시의무 대조 (거래 한 건에 의무자가 둘이다) */
  lender_side?: LenderSide;
}

interface GoodsItem {
  item: string;
  annual_amount: number;
  annual_amount_display: string;
  label: string;
}

/**
 * (판매회사, 거래상대방) 연간 합산 단위의 상품·용역 신호.
 * §4③2호의 판정 단위는 상대방별 분기 합계이지 품목별이 아니다 — 품목 행 단위로 판정하면
 * 같은 상대방에게 품목 A 30억 + B 15억(합계 45억, 4×기준 40억)인 케이스가 각각 미달로
 * 빠져 탐지 가능한 신호가 유실된다 (교차검토 M-4).
 */
interface GoodsSignal {
  company: string;
  corp_code?: string;
  counterparty: string;
  /** 어느 표에서 왔는가 — (6) 주요 내역은 품목·금액이 명시된 강한 원천이다 */
  source: '(6)주요내역';
  annual_amount_total: number;
  annual_amount_total_display: string;
  items: GoodsItem[];
  /**
   * 같은 쌍을 **(5) 총괄표**가 더 크게 적었을 때 그 값 — 판정은 이 값으로 한다.
   *
   * ★ 왜 필요한가 (실물 40문서 측정, 2026-09-08): (6)은 서식상 "거래한 금액이 **일정 규모
   * 이상**인 경우"의 내역만 싣고 그 규모 기준은 우리가 계산하는 기준금액(령 §33①)과 다르다.
   * 그래서 같은 쌍이라도 (5) 총괄표의 연간 총액이 (6) 합산보다 클 수 있다 — 겹친 149쌍 중
   * **30쌍**이 그랬고, 최대는 ㈜케이티 → ㈜케이티에스테이트의 (5) 664.90억 vs (6) 4.04억
   * (164배)다. 종전에는 (6)에 쌍이 있으면 (5) 값을 **비교 없이 버려서**, 그 664.90억이
   * 4.04억으로 판정돼 후보가 통째로 사라졌다.
   */
  matrix_annual_total?: number;
  matrix_annual_total_display?: string;
  /** (5) 총괄 − (6) 합산. (6)이 담지 못한 부분의 크기다 */
  matrix_excess_display?: string;
  /** 판정에 쓴 금액의 출처 — `(5)총괄` 이면 위 승격이 일어났다는 뜻이다 */
  judged_on?: '(6)합산' | '(5)총괄';
  /** (5) 값을 판정에 쓸 때 함께 지는 한계 (품목 부재 등) */
  matrix_caveat?: string;
  /**
   * 같은 쌍이 (6)의 '가.(분기)' 표와 '나.(연1회)' 표에 **모두** 실렸다 — 한쪽이 다른 쪽의
   * 부분기간이라 **더하면 이중 계상**이다. 합산하지 않고 큰 쪽만 썼다.
   * (실물: ㈜케이뱅크 → 비씨카드㈜ 분기 89.39억 + 연1회 244.69억 = 334.08억으로 계상되던
   * 것이, (5) 총괄표의 244.69억과 대조하면 연1회 값만이 연간 총액임이 확인된다.)
   */
  label_overlap?: {
    quarterly_display: string;
    annual_display: string;
    note: string;
  };
  threshold?: { value: number; value_display: string; formula: string; source_row: string };
  certainty?: Certainty;
  /** 연간 합산 ≥ 4×기준금액 ⇒ 어느 분기 하나는 반드시 기준금액 이상 (비둘기집 논증) */
  quarterly_logic:
    | 'annual_geq_4x_threshold'
    | 'annual_below_4x_threshold'
    | 'threshold_unknown';
  status?: TxStatus;
  reason?: string;
  /**
   * 상품·용역 공시의무는 상대방이 동일인(자연인)·친족 합계 20%↑ 출자 계열회사(또는 그
   * 상법 §342의2 자회사)일 때만 성립한다(법 §26①4호·령 §33②·고시 §4①4호·§2④) —
   * 이 도구는 지분 데이터가 없어 그 요건을 확인하지 못한다.
   */
  counterparty_qualification?: 'not_verified';
  j001_search?: { from: string; to: string; type_filter: string };
  matching_filings?: FilingRef[];
  matching_filings_total?: number;
  cancellations_of_type_in_window?: number;
  search_partial?: boolean;
  other_j001_in_window?: number;
  /**
   * 같은 유형·같은 창의 공시이지만 **원문 거래상대방이 이 거래 상대방과 달랐던** 건 (최대 5).
   * "공시 없음"이 아니라 "이 거래의 공시로 확인되지 않은 공시"다 — doc_counterparties 를 직접
   * 대조하라는 뜻으로 함께 낸다.
   */
  matching_filings_unconfirmed?: FilingRef[];
  /** matching_filings 의 **원문 거래상대방**까지 이 거래 상대방과 일치함을 확인했다 */
  counterparty_confirmed_by_document?: true;
  /**
   * 상대방이 확인돼 판정이 끝났거나(또는 원문 예산이 소진돼) **열어 보지 않은** 매칭 공시 수.
   * ⚠️ "상대방이 다른 공시"가 아니라 **보지 않은 공시**다 — 확인된 건이 있으면 더 볼 필요가
   * 없어서, 없으면 예산이 없어서다(후자는 reason 에 명시된다).
   */
  matching_filings_not_examined_total?: number;
  /** 이름만으로 유형을 알 수 없어 판정을 보류시킨 공시 — "공시 있음" 확인이 아니다 */
  type_ambiguous_filings?: FilingRef[];
  /** 유형 미상 공시의 **원문 거래상대방**이 이 거래 상대방과 일치해 "공시 존재"로 확정했다 */
  type_ambiguous_resolved_by_document?: true;
  /** 매입(구매)회사 쪽 의무 — 거래 한 건에 의무자가 둘이다 (매뉴얼 lit26-001) */
  buyer_side?: CounterpartySide;
}

/**
 * 계열회사 간 유가증권 거래 신호 — J004 총괄 **매트릭스**의 (매입회사, 매도회사) 한 칸.
 *
 * ⚠️ 이 신호의 한계를 status 이름에 박아 둔다: 값이 **직전 사업연도 1년 총액**이고
 * 개별 거래 건으로 분해되지 않는다. 고시 §4③은 유가증권 거래의 해당 여부를
 * "동일 거래상대방과의 **동일 거래대상**에 대한 거래행위" 기준으로 판단하므로,
 * 연간 총액이 기준금액 이상이어도 거래대상별로 쪼개면 전부 기준 미만일 수 있다 —
 * 상품·용역의 비둘기집 논증(연간 ≥ 4×기준 ⇒ 어느 분기 하나는 반드시 초과)이
 * **여기서는 성립하지 않는다.** 반대 방향은 확실하다: 연간 총액이 기준 미만이면
 * 그 상대방과의 어떤 개별 거래도 기준 미만이다.
 */
interface SecuritySignal {
  /** 매입회사 (매트릭스 행) — 이 회사의 J001 을 대조한다 */
  company: string;
  corp_code?: string;
  /** 매도회사 (매트릭스 열) */
  counterparty: string;
  /** 직전 사업연도 1년 합계 (원) */
  annual_amount: number;
  annual_amount_display: string;
  threshold?: { value: number; value_display: string; formula: string; source_row: string };
  certainty?: Certainty;
  /**
   * 거래상대방 이름이 이 문서의 회사 목록(재무현황·포털 소속회사·매트릭스 행)에서
   * 확인되지 않았다. 같은 회사의 표기 흔들림일 수도, 국외 계열사일 수도 있다 —
   * 판정에서 빼지는 않되 상대방 확인이 필요함을 알린다.
   */
  counterparty_in_known_list?: false;
  /** 원문이 이 열을 국외(해외) 계열회사로 분류했는가 — 판정 근거를 사용자가 보게 남긴다 */
  column_group?: string;
  status?:
    | 'below_threshold'
    | 'candidate_aggregate_only'
    | 'j001_filing_exists'
    /** 국외 계열회사 상대 거래 — 법 §26①·고시 §2③2호가 특수관계인에서 제외한다 */
    | 'not_applicable_foreign_affiliate'
    | 'not_judged';
  reason?: string;
  j001_search?: { from: string; to: string; type_filter: string };
  matching_filings?: FilingRef[];
  matching_filings_total?: number;
  cancellations_of_type_in_window?: number;
  search_partial?: boolean;
  other_j001_in_window?: number;
  /**
   * 같은 유형·같은 창의 공시이지만 **원문 거래상대방이 이 거래 상대방과 달랐던** 건 (최대 5).
   * "공시 없음"이 아니라 "이 거래의 공시로 확인되지 않은 공시"다 — doc_counterparties 를 직접
   * 대조하라는 뜻으로 함께 낸다.
   */
  matching_filings_unconfirmed?: FilingRef[];
  /** matching_filings 의 **원문 거래상대방**까지 이 거래 상대방과 일치함을 확인했다 */
  counterparty_confirmed_by_document?: true;
  /**
   * 상대방이 확인돼 판정이 끝났거나(또는 원문 예산이 소진돼) **열어 보지 않은** 매칭 공시 수.
   * ⚠️ "상대방이 다른 공시"가 아니라 **보지 않은 공시**다 — 확인된 건이 있으면 더 볼 필요가
   * 없어서, 없으면 예산이 없어서다(후자는 reason 에 명시된다).
   */
  matching_filings_not_examined_total?: number;
  /** 이름만으로 유형을 알 수 없어 판정을 보류시킨 공시 — "공시 있음" 확인이 아니다 */
  type_ambiguous_filings?: FilingRef[];
  /** 유형 미상 공시의 **원문 거래상대방**이 이 거래 상대방과 일치해 "공시 존재"로 확정했다 */
  type_ambiguous_resolved_by_document?: true;
  /** 매도회사 쪽 의무 — 유가증권은 상대방 지분 요건이 없어 각자의 기준금액만 본다 */
  seller_side?: CounterpartySide;
}

/**
 * 상품·용역 **총괄표 (5)** 의 (매출회사, 매입회사) 한 칸 — (6) 주요 내역에 없는 쌍의 보완 신호.
 *
 * 왜 필요한가: 판정의 주 원천인 (6) '주요 상품ㆍ용역거래 **내역**' 은 서식 설명 그대로
 * "거래한 금액이 **일정 규모 이상**인 경우"만 싣는다. 그 규모 기준은 우리가 계산하는
 * 기준금액(령 §33①)과 다르므로, **(6)에 없는데 공시대상인 쌍**이 존재할 수 있다.
 * (5) 총괄표는 같은 문서 안에서 **전 쌍**을 담으므로 그 구멍을 메운다.
 *
 * ⚠️ 다만 (5)는 상대방별 **연간 총액**뿐이다. 상품·용역의 기준금액 판단 단위는 §4③2호상
 * **분기 합계액**이라, 연간 총액이 기준 이상이라고 해서 어느 분기가 기준을 넘었다고 단정할 수
 * 없다. 비둘기집 논증(연간 ≥ 4×기준 ⇒ 네 분기가 전부 미만일 수는 없다)이 성립할 때만
 * (6) 경로와 같은 강도의 후보로 올리고, 그 미만은 `candidate_aggregate_only`(확인 대상)다.
 * 반대 방향(연간 총액 < 기준 ⇒ 어느 분기도 미달)은 확실하므로 below_threshold 로 확정한다.
 *
 * ⚠️ (5)에는 (6)과 달리 **품목이 없다.** 실측(미래에셋 20260819000341)상 (5)에는 배당금수익이
 * 실리지 않지만, 품목을 볼 수 없으므로 item_caveat(배당·이자·임대차 분리)을 적용하지 못한다.
 */
interface GoodsMatrixSignal {
  /** 매출회사 (매트릭스 행) — 이 회사의 J001 을 대조한다 */
  company: string;
  corp_code?: string;
  /** 매입회사 (매트릭스 열) */
  counterparty: string;
  source: '(5)총괄';
  /** 직전 사업연도 1년 합계 (원) */
  annual_amount: number;
  annual_amount_display: string;
  threshold?: { value: number; value_display: string; formula: string; source_row: string };
  certainty?: Certainty;
  /**
   * 연간 총액과 기준금액의 관계. `annual_geq_4x_threshold` 만 비둘기집 논증이 성립한다.
   * `annual_geq_threshold` 는 "연간 총액은 넘었으나 분기 하한을 알 수 없음" 이다.
   */
  quarterly_logic:
    | 'annual_geq_4x_threshold'
    | 'annual_geq_threshold'
    | 'annual_below_threshold'
    | 'threshold_unknown';
  /** 거래상대방 이름이 이 문서·포털의 회사 목록에서 확인되지 않았다 (표기 흔들림·국외 계열사 등) */
  counterparty_in_known_list?: false;
  /**
   * (6) 주요 내역에 **같은 매출회사·같은 금액**의 행이 다른 상대방 이름으로 있다 —
   * 두 표가 같은 회사를 다르게 적은 같은 거래일 가능성이 높다는 표시다 (실물에서 확인:
   * (6) '미래에셋생명(주)' vs (5) '미래에셋 생명보험(주)'). 버리지 않고 표시만 한다.
   */
  possible_duplicate_of_major_detail?: {
    major_detail_counterparty: string;
    amount_display: string;
    note: string;
  };
  /** (6) 주요 내역과 같은 상대방 요건 미확인 한계가 그대로 적용된다 */
  counterparty_qualification?: 'not_verified';
  /** (5)만의 한계를 사용자에게 그대로 전달한다 */
  caveat: string;
  /** 원문이 이 열을 국외(해외) 계열회사로 분류했는가 — 판정 근거를 사용자가 보게 남긴다 */
  column_group?: string;
  status?:
    | 'candidate_if_counterparty_qualified'
    | 'candidate_aggregate_only'
    | 'j001_filing_exists'
    | 'below_threshold'
    /** 국외 계열회사 상대 거래 — 법 §26①·고시 §2③2호가 특수관계인에서 제외한다 */
    | 'not_applicable_foreign_affiliate'
    | 'not_judged';
  reason?: string;
  j001_search?: { from: string; to: string; type_filter: string };
  matching_filings?: FilingRef[];
  matching_filings_total?: number;
  cancellations_of_type_in_window?: number;
  search_partial?: boolean;
  other_j001_in_window?: number;
  /**
   * 같은 유형·같은 창의 공시이지만 **원문 거래상대방이 이 거래 상대방과 달랐던** 건 (최대 5).
   * "공시 없음"이 아니라 "이 거래의 공시로 확인되지 않은 공시"다 — doc_counterparties 를 직접
   * 대조하라는 뜻으로 함께 낸다.
   */
  matching_filings_unconfirmed?: FilingRef[];
  /** matching_filings 의 **원문 거래상대방**까지 이 거래 상대방과 일치함을 확인했다 */
  counterparty_confirmed_by_document?: true;
  /**
   * 상대방이 확인돼 판정이 끝났거나(또는 원문 예산이 소진돼) **열어 보지 않은** 매칭 공시 수.
   * ⚠️ "상대방이 다른 공시"가 아니라 **보지 않은 공시**다 — 확인된 건이 있으면 더 볼 필요가
   * 없어서, 없으면 예산이 없어서다(후자는 reason 에 명시된다).
   */
  matching_filings_not_examined_total?: number;
  /** 이름만으로 유형을 알 수 없어 판정을 보류시킨 공시 — "공시 있음" 확인이 아니다 */
  type_ambiguous_filings?: FilingRef[];
  /** 유형 미상 공시의 **원문 거래상대방**이 이 거래 상대방과 일치해 "공시 존재"로 확정했다 */
  type_ambiguous_resolved_by_document?: true;
  /** 매입(구매)회사 쪽 의무 — 거래 한 건에 의무자가 둘이다 (매뉴얼 lit26-001) */
  buyer_side?: CounterpartySide;
}

/** 품목 성격상 미공시 후보 경로에서 제외한 행 — 합산에도 넣지 않는다 (배당이 합계를 부풀린다) */
interface GoodsCaveatRow {
  company: string;
  counterparty: string;
  item: string;
  annual_amount: number;
  annual_amount_display: string;
  item_caveat: string;
  threshold?: { value: number; value_display: string; formula: string; source_row: string };
  certainty?: Certainty;
  quarterly_logic: GoodsSignal['quarterly_logic'];
  /** 회사가 다른 신호로 이미 검색된 경우에 한해, 참고용 J001 존재 정보를 동봉 (교차검토 S-9) */
  related_j001?: { goods_type_filings_in_window: number; from: string; to: string };
}

/**
 * 상품·용역 연간 총액 → 분기 판정 강도. (6) 합산과 (5) 총괄 두 금액을 **같은 규칙**으로
 * 재기 위해 함수로 뺐다 — 승격 여부를 "판정이 실제로 달라지는가"로 정하려면 둘을
 * 같은 자로 재야 한다.
 *
 * 비둘기집: 연간 합산 ≥ 4×기준금액이면 네 분기 전부가 기준금액 미만일 수 없다.
 * 그 미만이면 분기 집중 여부를 알 수 없어 **원리상 판정 불가**다.
 */
function goodsQuarterlyLogic(
  amount: number,
  th: ApproxThreshold | undefined,
): GoodsSignal['quarterly_logic'] {
  if (amount >= 4 * CAP_100) return 'annual_geq_4x_threshold';
  if (!th) return 'threshold_unknown';
  return amount >= 4 * th.value ? 'annual_geq_4x_threshold' : 'annual_below_4x_threshold';
}

/**
 * (6) 주요 상품ㆍ용역거래 내역의 이 표가 **분기** 표인가 ('가. 상장회사 … (분기)').
 *
 * ★ 왜 표 라벨을 봐야 하는가 (실물, 케이티 20260617000447): 같은 쌍이 '가.(분기)' 와
 * '나.(연1회)' 표에 모두 실리는 문서가 있다. 두 표의 값을 더하면 이중 계상이다 —
 * ㈜케이뱅크 → 비씨카드㈜ 는 분기 89.39억 + 연1회 244.69억 = 334.08억으로 계상됐는데,
 * 같은 문서 (5) 총괄표의 그 쌍은 **244.69억**이라 연1회 값만이 연간 총액임이 확인된다.
 * 라벨을 못 읽는 표(빈 라벨)는 분기가 아닌 쪽으로 담는다 — 종전 동작과 같다.
 */
function isQuarterlyGoodsTable(label: string): boolean {
  return label.includes('분기');
}

/**
 * 상품·용역 거래의 대가가 아닐 가능성이 높은 품목 (교차검토 S-6 확장).
 * 실측(미래에셋 실물): J004 상품·용역 표에 "배당금수익" 이 실려 있다 — 배당은 주주 지위에 따른
 * 이익 분배이지 법 §26①의 거래유형(자금·유가증권·자산·상품용역) 어디에도 해당하지 않으므로,
 * 이를 미공시 후보로 올리면 오경보다. 단정하지 않고 별도 바구니로 분리한다.
 */
export function itemLikelyNotGoodsService(item: string): string | null {
  // 키워드가 품목의 **어미(성격 서술부)**일 때만 분리한다 — '배당전산시스템 구축용역' 같은
  // 진짜 용역을 부분문자열 일치로 빼면 합산이 줄어 후보 판정이 통째로 빠진다 (Codex 4차 M6).
  const n = item.replace(/[\s ]+/g, '');
  if (/배당(금)?(수익|수입)?$/.test(n)) {
    return (
      '품목이 "배당" 성격입니다 — 배당금은 주주 지위에 따른 이익 분배로, 대규모내부거래의 ' +
      '상품·용역 거래에 해당하지 않을 가능성이 높습니다. 공시 대상 여부를 별도로 판단하세요'
    );
  }
  if (/이자(수익|수입|비용)?$/.test(n)) {
    return (
      '품목이 "이자" 성격입니다 — 이자는 자금거래의 과실(대가)로, 상품·용역 거래가 아닐 ' +
      '가능성이 높습니다. 원본 자금 차입·대여의 공시 여부를 자금거래 쪽에서 별도로 확인하세요'
    );
  }
  if (/(임대|임차)(료)?$/.test(n)) {
    return (
      '품목이 임대차 성격일 수 있습니다 — 부동산 임대차는 상품·용역이 아니라 자산 거래 유형' +
      '(고시 §4①3호)으로 공시되므로, 이 도구의 상품·용역 보고서명 필터로는 그 공시를 ' +
      '찾지 못합니다. 공시가 실제로 있는지는 J001 부동산·자산 유형 공시에서 별도로 확인하세요'
    );
  }
  return null;
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
async function warmJurirJoins(
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

/** 회사 하나의 J001 검색 결과 (회사당 1회만 수집한다) */
interface CompanySearch {
  corp_code: string;
  from: string;
  to: string;
  rows: Disclosure[];
  partial: boolean;
  error?: string;
}

/**
 * 이어보기 토큰의 메타 — `cont:<token>:meta` 에 JSON 으로 저장한다.
 *
 * ★ **토큰에는 판정 결과를 싣지 않는다.** 토큰은 불투명한 실행 ID 하나이고, 결과는 서버
 *   저장소에만 있다. 클라이언트가 토큰을 손으로 고쳐도 남의 실행을 들여다볼 수 없고
 *   (32바이트 난수), 인자가 어긋나면 아래 검증이 거절한다.
 */
interface ContinuationMeta {
  /** 이 실행이 읽은 **원천 J004 접수번호** — 다른 문서의 캐시를 섞어 쓰지 않게 하는 열쇠다 */
  rcept_no: string;
  /**
   * 앞 호출의 판정 기준일. 이어보기 호출이 `today` 를 생략하면 **이 값을 쓴다** —
   * 검색창 상한이 호출마다 밀리면 앞 호출과 창이 달라져 한 실행의 결과가 아니게 된다.
   */
  today: string;
  fiscal_year: number;
  /** ISO — TTL 검사 기준 */
  created_at: string;
  /** 이 토큰으로 몇 번 불렸는지 (1부터) */
  calls: number;
}

/** 이 실행에서 재호출로 풀리는 미완주 사유 — 하나라도 있으면 `complete:false` */
type IncompleteReason =
  | 'companies_over_count_budget'
  | 'companies_over_time_budget'
  | 'company_search_failed_retryable'
  | 'filing_docs_over_fetch_budget'
  | 'filing_docs_over_time_budget'
  | 'warming_over_budget'
  | 'corp_index_not_loaded'
  | 'jurir_disambiguation_skipped';

function continuationInvalid(why: string): ToolError {
  return new ToolError(
    'continuation_invalid',
    `이어보기 토큰을 쓸 수 없습니다 — ${why}. ` +
      'continuation_token 없이 처음부터 다시 실행하세요 (앞 호출의 부분 결과는 버려집니다). ' +
      '이어보기는 앞 호출과 **같은 인자**(rcept_no 또는 group, today)로만 성립하고 ' +
      `수명은 ${CONTINUATION_TTL_MS / 3_600_000}시간입니다.`,
  );
}

export async function detectUndisclosedTransactions(
  input: DetectUndisclosedTransactionsInput,
  depsOverride?: DetectDeps,
): Promise<unknown> {
  if (!input.rcept_no && !input.group) {
    throw new ToolError('invalid_argument', 'rcept_no 또는 group 중 하나는 필수입니다.');
  }
  if (input.rcept_no && input.group) {
    throw new ToolError('invalid_argument', 'rcept_no 와 group 은 동시에 쓸 수 없습니다.');
  }
  if (input.rcept_no && input.year !== undefined) {
    throw new ToolError(
      'invalid_argument',
      'year 는 group 경로에서만 씁니다 — rcept_no 를 지정하면 그 문서를 그대로 읽습니다.',
    );
  }

  /**
   * ── 이어보기 토큰 검증 ──
   * 저장소 접근은 `deps` 를 거쳐야 하는데 `deps` 는 시계(`now`)까지 들고 있어 예산보다 먼저
   * 만들어야 한다. 그래서 검증은 예산을 세운 **직후**에 하고, 여기서는 시계만 먼저 꺼낸다.
   */
  const nowFn = depsOverride?.now ?? Date.now;
  /**
   * ── 시간 예산 (60초 벽) ──
   * `budget` 은 실행 전체, `prepBudget` 은 준비 단계(인덱스 적재 + 워밍)의 자체 상한이다.
   * 둘 다 같은 시계로 같은 시점에 출발하므로 준비 구간은 두 조건을 모두 만족해야 진행된다.
   *
   * ★ 입력으로 열지 않았다: 60초 벽은 **MCP 클라이언트의 성질**이지 질문의 성질이 아니다.
   *   올려도 클라이언트가 60초에 끊고, 내리면 결과만 더 부분적이 된다 — 올바른 값이 하나뿐인
   *   손잡이는 만들지 않는다. 테스트는 `deps.now` 로 시계를 주입해 조정한다.
   *
   * ★ 다만 환경변수 `GONGSI_TIME_BUDGET_MS` 로 **낮추는 것만** 허용한다 (config.ts). 상수만
   *   있으면 "예산이 끊겼을 때 부분 결과가 정직하게 나오는가"를 실물에서 재현할 방법이 없다.
   *   올릴 수는 없다 — 클라이언트가 어차피 60초에 끊는다.
   */
  const budgetOverrideMs = getConfig().detectTimeBudgetMs;
  const budgetMs = budgetOverrideMs ?? TIME_BUDGET_MS;
  const budgetSource: 'default' | 'env' = budgetOverrideMs === undefined ? 'default' : 'env';
  /** 준비 단계 상한은 전체의 40% — 예산을 낮춰도 판정 구간에 60% 가 남도록 비율을 유지한다 */
  const prepBudgetMs = Math.min(PREP_BUDGET_MS, Math.floor(budgetMs * 0.4));
  const budget = new Deadline(budgetMs, nowFn);
  const prepBudget = new Deadline(prepBudgetMs, nowFn);
  budget.enter('source_document');
  // 워밍이 법인 인덱스를 적재할 때 같은 클라이언트를 쓴다 (테스트 주입 경로에는 클라이언트가 없다)
  const client = depsOverride ? null : new DartClient(undefined, { deadline: budget });
  const deps = depsOverride ?? realDeps(client!, budget);

  /* ── 이어보기 토큰 검증 ──────────────────────────────────────────────────────
   * ★ **토큰이 없으면 이 블록이 통째로 건너뛰어진다** — 저장소를 읽지도, 쓰지도 않는다.
   *   토큰 없는 호출이 종전과 완전히 같아야 하는 이유는 "공시 목록 미캐시" 불변식이다:
   *   신규 점검은 언제나 방금 접수된 공시까지 본다.
   * ⚠️ 어긋난 토큰을 **관대하게 무시하고 새로 시작하지 않는다.** 그러면 사용자는 이어보고
   *   있다고 믿는데 실제로는 매번 1번 회사부터 도는 상태가 되어 영원히 끝나지 않는다.
   */
  const contToken = input.continuation_token ?? null;
  let contMeta: ContinuationMeta | null = null;
  if (contToken) {
    const raw = deps.kvGet(`${contPrefix(contToken)}meta`);
    if (!raw) {
      throw continuationInvalid(
        '그런 토큰이 없습니다 (수명이 지나 지워졌거나, 앞 호출이 완주해 이미 정리됐습니다)',
      );
    }
    let parsed: ContinuationMeta | null = null;
    try {
      parsed = JSON.parse(raw) as ContinuationMeta;
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed.rcept_no !== 'string' || typeof parsed.today !== 'string') {
      deps.kvDeletePrefix(contPrefix(contToken));
      throw continuationInvalid('토큰 기록이 손상됐습니다');
    }
    const age = nowFn() - Date.parse(parsed.created_at);
    if (!Number.isFinite(age) || age >= CONTINUATION_TTL_MS) {
      // 만료 토큰은 만난 김에 거둔다 — 버려진 실행의 키는 남지만(아래 주석) 이건 확실히 죽었다
      deps.kvDeletePrefix(contPrefix(contToken));
      throw continuationInvalid(
        `수명 ${CONTINUATION_TTL_MS / 3_600_000}시간이 지났습니다 (발급 ${parsed.created_at})`,
      );
    }
    if (input.rcept_no && parsed.rcept_no !== input.rcept_no) {
      throw continuationInvalid(
        `앞 호출은 다른 문서(${parsed.rcept_no})를 보고 있었습니다 — rcept_no 가 ${input.rcept_no} 로 바뀌었습니다`,
      );
    }
    if (input.today && parsed.today !== input.today) {
      throw continuationInvalid(
        `앞 호출의 기준일은 ${parsed.today} 인데 today 가 ${input.today} 로 들어왔습니다 — ` +
          '검색창 상한이 밀리면 앞 호출과 같은 실행이 아닙니다 (today 를 생략하면 앞 값을 그대로 씁니다)',
      );
    }
    contMeta = parsed;
  }

  /**
   * 판정 기준일 = J001 검색창의 상한.
   * 이어보기 호출이 `today` 를 생략하면 **앞 호출의 값**을 이어받는다 — 호출마다 시스템 날짜로
   * 다시 잡으면 자정을 넘긴 이어보기가 앞 호출과 다른 창을 보게 된다.
   */
  const today = input.today ?? contMeta?.today ?? toYMD(new Date());

  /** 이 실행이 실제로 쓴 DART HTTP 콜 수 — `list_calls` 는 회사당 1 카운터라 콜 수가 아니다 */
  const dartCallsBefore = client?.todayCalls() ?? null;
  const notes: string[] = [];
  let listCalls = 0;
  let partialLists = false;
  /** 시간 예산으로 J001 검색을 **시작조차 못 한** 회사 (정규화 이름) */
  const deadlineSkippedKeys = new Set<string>();
  /** 시간 예산으로 법인등록번호 동명 대조를 건너뛴 이름 수 */
  let jurirDeadlineSkips = 0;

  // ── ① 원천 문서 확정 ──
  let sourceRceptNo: string;
  let sourceReportNm: string | null = null;
  let sourceIsCorrection = false;
  let population: Population | null = null;
  /** 포털 소속회사 목록을 실제로 불러왔는가 (rcept_no 경로는 문서의 기업집단명으로 시도한다) */
  let populationSource: 'portal' | 'none' = 'none';
  let populationGroup: string | null = null;
  let populationYearMonth: string | null = null;
  let populationReason: string | null = null;
  let warming: WarmingDiagnostics | null = null;
  let filingYear: number;

  /**
   * 모집단을 받은 직후 **조인을 쓰는 모든 코드보다 먼저** 부르는 준비 단계 —
   * 법인등록번호 캐시를 자동으로 채우고, 새로 조인된 회사가 있으면 모집단을 다시 받는다.
   *
   * ★ group 경로의 대표회사 탐색보다 반드시 앞에 와야 한다. 조인 0건이면 대표회사도 못 찾아
   *   거기서 예외가 나고, 그러면 워밍이 실행될 기회 자체가 사라진다.
   */
  async function prepareJoins(
    pop: Population,
    popInput: PopulationInput,
  ): Promise<{ population: Population; warming: WarmingDiagnostics | null }> {
    // 워밍은 포털이 법인등록번호를 준 미조인 이름에만 걸린다 — 대상이 없으면 저장소도 건드리지 않는다
    const hasTarget = pop.unjoined.some((n) =>
      pop.jurirNoByName?.has(normalizeCompanyName(n)),
    );
    if (!hasTarget) return { population: pop, warming: null };

    let indexLoaded = false;
    let indexError: string | undefined;
    let indexSkipped: string | undefined;
    // 인덱스가 비어 있으면 findCorps·searchCorps 가 항상 0건이라 워밍이 무의미하다.
    // 테스트 주입 경로(depsOverride)는 실제 HTTP 가 나가면 안 되므로 건너뛴다.
    if (client && getStore().corpCount() === 0) {
      if (!budget.canAfford(MIN_CORP_INDEX_MS) || !prepBudget.canAfford(MIN_CORP_INDEX_MS)) {
        // 적재하다 예산이 끊기면 워밍도 판정도 못 한다 — 확보 못 하면 시작하지 않는다
        indexSkipped =
          `시간 예산 부족 — 남은 ${budget.remainingMs()}ms(준비 예산 ${prepBudget.remainingMs()}ms)로는 ` +
          `법인 인덱스(3.4MB)를 적재하지 않았습니다. 인덱스는 한 번 적재하면 영구 보관되므로 ` +
          `resolve_entity 를 한 번 호출하거나 이 도구를 다시 실행하면 채워집니다`;
        budget.markStopped('corp_index');
      } else {
        try {
          await budget.during('corp_index', () => ensureCorpIndex(client));
          indexLoaded = true;
        } catch (err) {
          // 폴백 — 워밍은 그대로 진행하고(캐시가 부분적으로 있을 수 있다) 사유만 남긴다
          indexError = err instanceof Error ? err.message.split('\n')[0] : String(err);
          log.warn('법인 인덱스 자동 적재 실패 — 워밍은 기존 인덱스로 진행', { error: indexError });
        }
      }
    }

    let w: WarmingDiagnostics;
    try {
      w = await budget.during('warming', () =>
        warmJurirJoins(deps, pop, today, budget, prepBudget),
      );
    } catch (err) {
      // 워밍은 조인 **품질**을 올리는 준비 단계다 — 여기서 던지면 rcept_no 경로의 상위 catch 가
      // 이를 "포털 목록을 못 불러왔다"로 오해해 **모집단 전체를 버린다**(종전보다 나빠진다).
      notes.push(
        '⚠️ 법인등록번호 자동 워밍이 실패해 워밍 없이 진행했습니다 ' +
          `(${err instanceof Error ? err.message.split('\n')[0] : String(err)}) — ` +
          '조인은 기존 캐시로만 이뤄져 미조인이 많을 수 있습니다.',
      );
      return { population: pop, warming: null };
    }
    w.corp_index_loaded = indexLoaded;
    if (indexError) w.corp_index_error = indexError;
    if (indexSkipped) w.corp_index_skipped = indexSkipped;

    let result = pop;
    if (w.joined > 0) {
      // 포털 응답은 캐시 히트라 추가 API 콜이 없다. 재호출은 1회뿐이다.
      try {
        result = await deps.resolvePop(popInput);
      } catch (err) {
        notes.push(
          `⚠️ 자동 워밍으로 ${w.joined}개사의 법인등록번호를 채웠으나 소속회사 목록 재조회에 ` +
            `실패해 워밍 전 조인 상태로 판정했습니다 (${
              err instanceof Error ? err.message.split('\n')[0] : String(err)
            }) — 다시 실행하면 채워진 캐시로 조인됩니다.`,
        );
      }
    }
    if (w.joined > 0 || w.lookups > 0) {
      notes.push(
        `ℹ️ 자동 워밍: 미조인 계열사 ${w.attempted}개사의 법인등록번호를 DART 기업개황으로 ` +
          `대조해(${w.lookups}회 조회) ${w.joined}개사를 조인했습니다 — 포털 법인등록번호와 ` +
          '**정확히 1건 일치**한 회사만 확정합니다(이름 유사도로 고르지 않습니다). ' +
          '결과는 캐시에 남으므로 다음 실행부터는 조회 없이 조인됩니다.' +
          (w.over_budget
            ? ` 조회 예산(${MAX_WARM_LOOKUPS}회)을 넘어 남은 회사는 대조하지 못했습니다 — ` +
              '다시 실행하면 이어서 채웁니다.'
            : ''),
      );
    }
    if (w.over_deadline) {
      notes.push(
        `⚠️ 시간 예산(준비 단계 ${budgetSeconds(prepBudgetMs)}초 / 전체 ${budgetSeconds(budgetMs)}초)이 ` +
          `모자라 미조인 계열사 ${w.skipped_deadline}개사는 법인등록번호를 대조하지 못했습니다 ` +
          '(warming.skipped 의 reason:"deadline") — 그 회사가 상대방인 거래는 ' +
          'counterparty_not_joined 로 남습니다. 채워 둔 법인등록번호는 캐시에 영구 남으므로 ' +
          '다시 실행하면 이어서 채웁니다.',
      );
    }
    if (w.corp_index_skipped) {
      notes.push(`⚠️ DART 법인 인덱스를 적재하지 않았습니다 — ${w.corp_index_skipped}.`);
    }
    return { population: result, warming: w };
  }

  if (input.group) {
    const year = input.year ?? Number(today.slice(0, 4));
    filingYear = year;
    // 포털 스냅샷은 매년 5/1 기준 — 점검 연도의 5월로 맞춘다 (audit_periodic 과 같은 이유)
    populationYearMonth = `${year}05`;
    // allowEmptyJoin — 조인 0건이어도 포털 명단·법인등록번호를 버리지 않는다. 그게 있어야
    // 아래 워밍이 조인을 채울 수 있다 (audit 두 도구는 이 옵션을 쓰지 않는다: 빈 모집단으로
    // 감사하면 "지연 0건"이 거짓 안심이 된다).
    const popInput: PopulationInput = {
      group: input.group,
      year_month: populationYearMonth,
      allowEmptyJoin: true,
    };
    budget.enter('population');
    const prepared = await prepareJoins(await deps.resolvePop(popInput), popInput);
    population = prepared.population;
    warming = prepared.warming;
    populationSource = 'portal';
    populationGroup = input.group;
    budget.enter('source_document');

    // 대표회사 corp_code — 포털 대표회사명을 소속회사 목록과 정규화 이름으로 조인
    const repName = String(
      (population.group as Record<string, unknown>)?.['representative_company'] ?? '',
    );
    const repKey = normalizeCompanyName(repName);
    let repCode: string | undefined;
    for (const [code, name] of population.corpCodes) {
      if (normalizeCompanyName(name) === repKey) {
        repCode = code;
        break;
      }
    }
    if (!repName || !repCode) {
      throw new ToolError(
        'corp_not_found',
        `'${input.group}' 대표회사(${repName || '이름 미상'})의 DART corp_code 를 찾지 못했습니다 — ` +
          (warming
            ? `자동 워밍이 ${warming.attempted}개사를 대조해 ${warming.joined}개사를 조인했으나 ` +
              '대표회사는 포함되지 않았습니다(diagnostics 는 예외에 실리지 않으니 ' +
              'get_group_structure 로 조인 상태를 확인하세요). '
            : '') +
          'resolve_entity(fetchJurirNo=true) 로 대표회사를 조회해 조인 캐시를 채우거나, ' +
          '대표회사 연1회 J004 의 rcept_no 를 직접 지정하세요.',
        {
          representative_company: repName,
          ...(warming
            ? {
                warming: {
                  attempted: warming.attempted,
                  joined: warming.joined,
                  lookups: warming.lookups,
                  over_budget: warming.over_budget,
                },
              }
            : {}),
        },
      );
    }

    // 연1회 대표회사 서식 탐색 — 4/1 부터 이듬해 3/31 까지 (해 넘긴 지연 제출 포함)
    const from = `${year}0401`;
    const to = today < `${year + 1}0331` ? today : `${year + 1}0331`;
    if (from > to) {
      throw new ToolError(
        'invalid_argument',
        `${year}년 연1회 공시 창(${from}~)이 아직 열리지 않았습니다 — year 를 확인하세요.`,
      );
    }
    const r = await deps.collectList(repCode, 'J004', from, to);
    listCalls++;
    if (r.diagnostics.partial_results || r.diagnostics.truncated) partialLists = true;
    const candidates = r.rows.filter((row) => {
      const c = classifyReportName(row.report_nm);
      return c.kind === 'annual_q1' && c.representative;
    });
    if (candidates.length === 0) {
      throw new ToolError(
        'document_not_found',
        `${year}년 창(${from}~${to})에서 대표회사(${repName})의 연1회 J004 를 찾지 못했습니다 — ` +
          '아직 제출 전(기한 5/31)이거나 대표회사가 바뀌었을 수 있습니다. ' +
          'search_disclosures(preset:"group_status") 로 직접 찾아 rcept_no 로 지정하세요.',
        { representative_company: repName, corp_code: repCode, window: { from, to } },
      );
    }
    // 정정 반영 **최신 접수분** — 내용을 읽는 도구라 최종본이 옳다 (J004 정정률 91% 실측).
    // 지연 판정 도구들이 원본을 고집하는 것과 반대 방향이고, 그 반대가 여기선 정답이다.
    // 같은 날 원본+정정이 함께 접수되면 접수일이 같다 — 접수번호(일련 증가)로 뒤를 고른다.
    const latest = candidates.reduce((a, b) =>
      a.rcept_dt !== b.rcept_dt
        ? a.rcept_dt > b.rcept_dt
          ? a
          : b
        : a.rcept_no > b.rcept_no
          ? a
          : b,
    );
    sourceRceptNo = latest.rcept_no;
    sourceReportNm = latest.report_nm;
    sourceIsCorrection = isCorrection(latest.report_nm);
  } else {
    sourceRceptNo = input.rcept_no!;
    const y = Number(sourceRceptNo.slice(0, 4));
    const m = Number(sourceRceptNo.slice(4, 6));
    // 1~3월 접수는 전년도 의무분의 해 넘긴 제출일 가능성이 높다 — 직전 사업연도를 한 해 더 당긴다
    filingYear = m >= 4 ? y : y - 1;
  }
  // 이어보기 토큰이 가리키는 실행과 **같은 문서**인지 확인한다. rcept_no 경로는 위에서 이미
  // 걸렀지만 group 경로는 원천 문서를 찾아봐야 알 수 있다 (집단·연도가 바뀌면 문서가 달라진다).
  if (contMeta && contMeta.rcept_no !== sourceRceptNo) {
    throw continuationInvalid(
      `앞 호출은 다른 문서(${contMeta.rcept_no})를 보고 있었습니다 — 이번 인자는 ${sourceRceptNo} 를 가리킵니다`,
    );
  }
  /** 거래가 속한 직전 사업연도 (12월 결산 가정 — 변칙 회계연도는 어긋날 수 있다) */
  const fiscalYear = filingYear - 1;

  // today 가 원천 문서 접수일보다 앞서면 창이 통째로 어긋난다 — 오타를 잡는다 (교차검토 S-1)
  const sourceFiledYmd = sourceRceptNo.slice(0, 8);
  if (today < sourceFiledYmd) {
    throw new ToolError(
      'invalid_argument',
      `today(${today})가 원천 J004 접수일(${sourceFiledYmd})보다 앞섭니다 — ` +
        'today 오타이거나 rcept_no 가 잘못 지정됐습니다.',
    );
  }

  const { markdown, meta } = await deps.loadDoc(sourceRceptNo);
  if (!markdown) {
    throw new ToolError(
      'body_unparsable',
      '원문 본문을 파싱할 수 없습니다 (HWP 첨부만 있는 공시일 수 있습니다).',
      { rcept_no: sourceRceptNo, viewer_url: viewerUrl(sourceRceptNo) },
    );
  }
  if (meta.acode && !J004_ACODES.has(meta.acode)) {
    notes.push(
      `⚠️ 서식코드 ${meta.acode}는 기업집단현황공시 계열(8062x)이 아닐 수 있습니다 — ` +
        '거래현황 표가 없으면 아래 추출이 전부 0건이 됩니다.',
    );
  }

  // ── ①-b rcept_no 경로: 문서가 밝힌 기업집단명으로 포털 소속회사 목록을 불러온다 ──
  //
  // 종전에는 rcept_no 경로에 모집단 자체가 없어 조인이 "DART 상호 완전일치" 한 갈래뿐이었다.
  // 그 결과 ① 동명 비계열 회사로 오조인될 위험을 걸러내지 못하고 ② 계열편입일(편입 전 거래는
  // 의무 없음) 대조를 못 하며 ③ 유가증권 매트릭스의 거래상대방이 계열사인지 확인할 목록이
  // 재무현황 표뿐이었다. 문서 표지의 '기업집단명' 행 하나면 group 경로와 같은 모집단을 쓸 수 있다.
  //
  // ★ 실패는 전부 폴백이다 — EGROUP 키가 없어도(README 약속: DART 키 하나면 동작) 집단명을
  //   못 읽어도 포털이 죽어도, 종전 동작(DART 상호 매칭)으로 조용히 되돌아가고 사유만 남긴다.
  if (!input.group) {
    budget.enter('population');
    const docGroup = extractGroupName(markdown);
    if (!docGroup) {
      populationReason =
        'group_name_not_found — 문서에서 "기업집단명" 행을 찾지 못했습니다 (서식 변형 가능)';
    } else {
      // group 경로와 같은 규칙: 포털 스냅샷은 매년 5/1 기준이고 연1회 J004 기한은 5/31이라,
      // **그 문서가 제출된 해의 5월** 스냅샷이 문서 시점의 소속 상태에 가장 가깝다.
      populationYearMonth = `${filingYear}05`;
      const popInput: PopulationInput = {
        group: docGroup,
        year_month: populationYearMonth,
        allowEmptyJoin: true,
      };
      try {
        const prepared = await prepareJoins(await deps.resolvePop(popInput), popInput);
        population = prepared.population;
        warming = prepared.warming;
        populationSource = 'portal';
        populationGroup = docGroup;
      } catch (err) {
        population = null;
        populationYearMonth = null;
        const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
        // ★ 사유 코드와 실제 원인을 맞춘다. 종전에는 **조인 0건**(포털은 정상 응답, 캐시 히트인
        //   경우까지)도 'portal_unavailable' 로 적혀 "포털을 못 불러왔다"는 오해를 낳았다.
        //   allowEmptyJoin 을 켠 지금 이 갈래는 나오지 않아야 하지만, 다른 호출 경로나 회귀로
        //   되살아날 수 있어 방어선으로 남긴다.
        populationReason =
          err instanceof ToolError && err.code === 'corp_not_found'
            ? `join_empty — 포털 소속회사 목록은 응답했으나 DART corp_code 조인이 0건이라 ` +
              `모집단을 쓰지 못했습니다 (${detail})`
            : `portal_unavailable — 문서의 기업집단명 '${docGroup}' 으로 포털 소속회사 목록을 ` +
              `불러오지 못했습니다 (${detail})`;
      }
    }
    if (populationSource === 'portal') {
      notes.push(
        `ℹ️ 문서의 기업집단명('${populationGroup}')으로 포털 소속회사 목록(${populationYearMonth} 기준, ` +
          `조인 ${population!.corpCodes.size}개사·미조인 ${population!.unjoined.length}개사)을 불러와 ` +
          '회사명 조인과 계열사 확인에 사용했습니다.',
      );
    } else {
      notes.push(
        `ℹ️ 포털 소속회사 목록 없이 DART 상호 완전일치만으로 조인했습니다 (${populationReason}) — ` +
          '동명 비계열 회사 오조인·계열편입일 대조 불가 등 조인 품질이 낮습니다. ' +
          'group 경로로 호출하면 같은 문서를 포털 목록과 함께 점검합니다.',
      );
    }
  }

  // ── ② 파싱 ──
  budget.enter('parse');
  const parseDiag = diagnose(markdown);
  const capitals = extractCapitals(markdown);
  const borrowings = extractFundBorrowings(markdown);
  const goods = extractMajorGoodsServices(markdown);
  // 유가증권 총괄 매트릭스. 집계 열('소계'·'계'·'국내 매출액' 등)이 거래상대방으로 새면
  // **없는 거래**가 후보로 오르므로, 이름 블랙리스트에 더해 회사명 화이트리스트를 2차 방어선으로
  // 준다. 화이트리스트는 ① 재무현황 표의 계열사 ② (group 경로면) 포털 소속회사
  // ③ 매트릭스 자신의 **행** 회사 — 행은 집계 행이 이미 제거돼 있어 회사만 남는다.
  const securitiesSeed = extractSecuritiesMatrix(markdown);
  // 상품·용역 **총괄** 매트릭스 (5). (6) '주요 내역' 은 일정 규모 이상만 실리므로 그것만 보면
  // 규모 미달로 빠진 공시대상 쌍을 못 본다 — (5)는 전 쌍을 담아 그 구멍을 메운다.
  // 화이트리스트는 유가증권과 같은 이유로 **필터가 아니다** (표기 흔들림으로 진짜 거래가
  // 사라지는 쪽이 더 위험하다). 집계 열 방어는 파서의 isAggregateLabel 이 맡는다.
  const goodsMatrixSeed = extractGoodsServicesMatrix(markdown);

  if (parseDiag.sections_missing.length > 0) {
    notes.push(
      `⚠️ 원문에서 절을 찾지 못했습니다: ${parseDiag.sections_missing.join(', ')} — ` +
        '해당 유형의 점검은 **수행되지 않은 것**이지 "거래 없음"이 아닙니다. ' +
        '대표회사 연1회 서식(예: ACODE 80622)이 맞는지 확인하세요.',
    );
  }
  if (parseDiag.tables_without_unit > 0) {
    notes.push(
      `⚠️ 단위 캡션을 읽지 못해 통째로 건너뛴 표가 ${parseDiag.tables_without_unit}개 있습니다 — ` +
        '금액을 추측하지 않으므로 그 표의 거래는 점검되지 않았습니다.',
    );
  }
  if (parseDiag.rows_amount_unparsable > 0) {
    notes.push(
      `⚠️ 거래상대방은 있는데 금액을 읽지 못한 행이 ${parseDiag.rows_amount_unparsable}건 있습니다 ` +
        "(각주 '16,000 (주1)'·무액 '-' 표기 등 — 실물에서 '-' 기재 실측됨) — 금액을 추측하지 " +
        '않으므로 그 거래는 **점검되지 않았습니다**. 원문(source_viewer_url)에서 해당 행을 직접 확인하세요.',
    );
  }
  if (parseDiag.tables_with_ragged_rows > 0) {
    notes.push(
      `ℹ️ 헤더 폭과 열 수가 다른 데이터 행이 ${parseDiag.ragged_rows}건 ` +
        `(${parseDiag.tables_with_ragged_rows}개 표에) 있습니다 — 병합 헤더 전개가 밀렸거나 ` +
        '서식이 실측과 다를 수 있습니다. 값 열은 열 번호가 아니라 **"데이터가 전부 숫자인 열"** ' +
        '규칙으로 잡으므로 밀림 자체가 곧 오판은 아니지만, 후보가 나온 표는 원문과 대조하세요.',
    );
  }
  if (parseDiag.rows_company_equals_counterparty > 0) {
    notes.push(
      `⚠️ 회사와 거래상대방이 같은 이름으로 읽힌 행이 ${parseDiag.rows_company_equals_counterparty}건 ` +
        '있습니다 — 표 열 배치가 실측 서식과 달라 열을 오인했을 수 있어 그 행은 쓰지 않았습니다. ' +
        '원문 확인이 필요합니다.',
    );
  }

  // ── ③ 회사별 기준금액 (근사) ──
  // 여기부터 조인·1차 판정 구간이다 — 순수 계산이지만 동명 판별이 기업개황을 부를 수 있다
  budget.enter('threshold_join');
  const { map: thresholds, conflicts: thresholdConflicts } = buildThresholdMap(capitals);
  if (thresholdConflicts.length > 0) {
    notes.push(
      `⚠️ 재무현황 표에 정규화 동명인데 자본이 다른 이름이 ${thresholdConflicts.length}건 있어 ` +
        `기준금액 계산에서 제외했습니다 (${thresholdConflicts.join(', ')}) — 해당 회사의 100억 미만 ` +
        '거래는 threshold_unknown 으로 남습니다.',
    );
  }

  // group 경로 조인 맵 — 같은 정규화 이름이 서로 다른 corp_code 로 두 번 나오면 조인하지 않는다
  const popByName = new Map<string, string>();
  const popNameConflicts = new Set<string>();
  if (population) {
    for (const [code, name] of population.corpCodes) {
      const key = normalizeCompanyName(name);
      const prev = popByName.get(key);
      if (prev !== undefined && prev !== code) {
        popByName.delete(key);
        popNameConflicts.add(key);
        continue;
      }
      if (!popNameConflicts.has(key)) popByName.set(key, code);
    }
  }

  // ── ③-b 회사명 → corp_code 조인 ──
  // ① 집단 소속회사(포털 이름) 정규화 매칭 ② DART 법인 인덱스 상호 완전일치.
  // ★ ② 폴백으로 찾은 corp_code 가 집단 목록 어디에도 없으면 **비계열 동명 회사일 수 있다** —
  // 그 회사의 J001 로 filing_exists 를 만들면 오조인이 거짓 안심으로 직결되므로 조인 실패로
  // 처리한다 (Codex 4차 M7). 포털 목록을 못 불러온 경우(population === null)에는 이 검증이
  // 불가능하다 — scope_caveats 로 밝힌다.
  //
  // 판정 순서상 **차입 판정보다 앞에** 둔다: 대여회사 쪽 의무를 판정하려면 검색 예산을 짜기
  // 전에 상대방이 조인되는 계열회사인지 알아야 한다.
  const joinFailures: Array<{ company: string; reason: string }> = [];
  /** 기업개황(법인등록번호) 조회 횟수 — 예산 상한 대비 */
  let jurirLookups = 0;
  /** 조회 **횟수** 예산(`MAX_JURIR_LOOKUPS`)을 넘겨 동명 대조를 못 한 이름 수 — 재호출로 풀린다 */
  let jurirBudgetSkips = 0;
  /** 동명 2건 이상을 법인등록번호로 확정한 건 — 근거를 진단에 남긴다 */
  const jurirResolved: Array<{
    company: string;
    corp_code: string;
    jurir_no: string;
    candidates: number;
  }> = [];
  // 포털이 소속을 보증하는 이름들 — jurir 미조인이라 corp_code 는 없지만 계열사임은 확실하다
  const popUnjoinedKeys = new Set(
    (population?.unjoined ?? []).map((n) => normalizeCompanyName(n)),
  );
  /** 포털이 소속을 보증하는 이름인가 (조인분·미조인분 모두) */
  function isKnownAffiliateName(rawName: string): boolean {
    if (population === null) return false;
    const key = normalizeCompanyName(rawName);
    return popByName.has(key) || popNameConflicts.has(key) || popUnjoinedKeys.has(key);
  }
  /** 이 문서 재무현황 표(계열회사별 자본)에 실린 이름 — 자본을 못 읽은 행도 포함한다 */
  const capitalNameKeys = new Set(capitals.map((c) => normalizeCompanyName(c.company)));
  /**
   * 이름의 주인이 **회사임이 문서·포털로 확인되는가.**
   * corp_code 조인과는 독립이다 — 조인은 DART 인덱스 캐시 사정으로도 실패하지만,
   * 재무현황 표(계열회사별 자본)나 포털 소속회사 목록에 실린 이름은 그 자체로 계열 '회사'다.
   */
  function isConfirmedCompanyName(rawName: string): boolean {
    return isKnownAffiliateName(rawName) || capitalNameKeys.has(normalizeCompanyName(rawName));
  }
  function verifyMembership(code: string, rawName: string): { code?: string; reason?: string } {
    if (population === null) return { code };
    if (population.corpCodes.has(code)) return { code };
    // 미조인 계열사: 포털 소속 목록에 같은 이름이 있고 DART 완전일치가 유일하면 그 회사다
    // (동명 법인이 실존하면 findCorps 가 2건 이상을 돌려줘 여기 오기 전에 거부된다)
    if (popUnjoinedKeys.has(normalizeCompanyName(rawName))) return { code };
    return {
      reason:
        'dart_join_unverified — DART 에 상호가 일치하는 회사는 있으나 집단 소속회사 목록 ' +
        '어디에도 없습니다. 비계열 동명 회사일 수 있어 그 회사의 공시로 판정하지 않습니다 ' +
        '(실제 계열사라면 resolve_entity(fetchJurirNo=true) 로 조인 캐시를 채우세요)',
    };
  }
  /** 포털이 계열사로 확인해 준 이름인데 DART 쪽에서 못 이은 경우의 안내를 덧붙인다 */
  function withAffiliateHint(rawName: string, reason: string): string {
    if (!isKnownAffiliateName(rawName)) return reason;
    return (
      `${reason}. 다만 이 이름은 포털 소속회사 목록에 있는 **계열회사**입니다 — ` +
      'resolve_entity(fetchJurirNo=true) 로 법인등록번호 조인 캐시를 채우면 대조할 수 있습니다'
    );
  }
  /**
   * DART 상호 동명 2건 이상을 **법인등록번호로** 확정한다 (이름으로는 못 고른다).
   *
   * 이 프로젝트의 원래 조인 설계가 법인등록번호 직접 조인이다 — 포털은 한글 음차,
   * DART 는 영문 약어라 이름 매칭이 성립하지 않기 때문이다. 포털 소속회사 목록에 그 회사의
   * `jurirno` 가 있으므로, 후보들의 기업개황 `jurir_no` 를 받아 대조하면 **추측 없이** 하나로
   * 좁혀진다 (실측: 미래에셋증권은 DART 상호 동명 2건이라 이 경로가 없으면 영원히 미조인).
   *
   * ★ 정확히 1건 일치일 때만 확정한다. 0건이면 후보 중에 그 계열사가 없다는 뜻이고,
   *   2건 이상이면 같은 법인등록번호에 corp_code 가 여럿이라는 뜻이라 어느 쪽도 고르지 않는다.
   * ★ 조회 실패(error)를 "불일치"로 뭉개지 않는다 — 실패 건수를 사유에 남긴다.
   */
  async function disambiguateByJurirNo(
    rawName: string,
    hits: Array<{ corpCode: string; corpName: string }>,
  ): Promise<{ code?: string; reason?: string }> {
    const key = normalizeCompanyName(rawName);
    const list = hits.map((h) => `${h.corpName}(${h.corpCode})`).join(', ');
    const ambiguous = (extra: string): { reason: string } => ({
      reason: withAffiliateHint(rawName, `동명 법인 ${hits.length}건 [${list}] — ${extra}`),
    });

    const portalJurir = population?.jurirNoByName?.get(key);
    if (!portalJurir) {
      return ambiguous(
        population === null
          ? '자동 선택하지 않습니다 (포털 소속회사 목록이 없어 법인등록번호로 확정할 수 없습니다 — ' +
              'group 경로로 호출하면 대조합니다)'
          : '자동 선택하지 않습니다 (포털 소속회사 목록에서 이 이름의 법인등록번호를 찾지 못했습니다 — ' +
              '표기가 다르거나 포털에도 동명이 있습니다)',
      );
    }
    if (hits.length > MAX_JURIR_CANDIDATES) {
      return ambiguous(
        `후보가 상한 ${MAX_JURIR_CANDIDATES}개를 넘어 법인등록번호를 대조하지 않았습니다`,
      );
    }
    // ★ 예산이 세는 것은 **콜이 실제로 나가는 후보**뿐이다. 캐시 히트까지 세면 다시 호출해도
    //   같은 이름들이 같은 예산을 다시 먹어 뒤쪽 이름이 영원히 대조되지 않는다(이어보기 제자리걸음).
    const uncachedHits = deps.isJurirCached
      ? hits.filter((h) => !deps.isJurirCached!(h.corpCode))
      : hits;
    if (jurirLookups + uncachedHits.length > MAX_JURIR_LOOKUPS) {
      // 조회 **횟수** 예산이 모자란 것 — 재호출로 풀린다(결과가 캐시에 영구 남고, 남은 건은
      // 다음 호출에서 캐시라 예산을 쓰지 않으므로 예산이 아직 못 본 이름에 돌아간다).
      jurirBudgetSkips++;
      return ambiguous(
        `법인등록번호 조회 예산(${MAX_JURIR_LOOKUPS}회)을 넘어 대조하지 않았습니다 — ` +
          'resolve_entity(fetchJurirNo=true) 로 미리 캐시를 채우면 대조합니다',
      );
    }
    // 시간 예산(60초 벽) — 조회 횟수와 별개다. 이름 단위로 끊어 어느 후보를 봤는지 흐리지 않는다.
    // 후보가 전부 캐시면 콜이 없으므로 시간 예산과 무관하다 (여기서 미루면 역시 제자리를 돈다).
    if (uncachedHits.length > 0 && !budget.canAfford(MIN_SMALL_CALL_MS)) {
      jurirDeadlineSkips++;
      budget.markStopped();
      return ambiguous(
        `시간 예산(${budgetSeconds(budgetMs)}초)이 남지 않아 법인등록번호를 대조하지 않았습니다 — ` +
          '조회 결과는 캐시에 영구 남으므로 다시 실행하면 대조합니다',
      );
    }

    const matched: Array<{ corpCode: string; corpName: string }> = [];
    let failures = 0;
    for (const h of hits) {
      const r = await deps.fetchJurirNo(h.corpCode);
      // 캐시에서 나온 건은 콜이 없었으므로 예산을 쓰지 않는다 (원문 예산과 같은 규칙)
      if (!(r.status === 'ok' && r.cached)) jurirLookups++;
      if (r.status === 'ok') {
        if (r.jurirNo === portalJurir) matched.push(h);
      } else if (r.status === 'error') {
        failures++;
      }
      // 'absent' = 확인된 부재 — 이 후보는 그 계열사가 아니다
    }
    if (matched.length === 1) {
      jurirResolved.push({
        company: rawName,
        corp_code: matched[0]!.corpCode,
        jurir_no: portalJurir,
        candidates: hits.length,
      });
      // 법인등록번호 일치는 소속 검증(verifyMembership)보다 강한 근거다 — 포털이 그 번호를
      // 이 집단 소속회사로 싣고 있으므로 비계열 동명 회사일 수 없다.
      return { code: matched[0]!.corpCode };
    }
    return ambiguous(
      `법인등록번호(${portalJurir}) 일치 ${matched.length}건` +
        (failures > 0 ? `·조회 실패 ${failures}건` : '') +
        ' — 정확히 1건일 때만 확정합니다',
    );
  }

  async function joinCorpCodeUncached(
    rawName: string,
  ): Promise<{ code?: string; reason?: string }> {
    const key = normalizeCompanyName(rawName);
    if (popNameConflicts.has(key)) {
      // 포털 목록 안에서조차 동명이라 어느 쪽인지 알 수 없다 — DART 완전일치로만 재시도
      const exactOnly = deps.findCorps(rawName.trim());
      if (exactOnly.length === 1) return verifyMembership(exactOnly[0]!.corpCode, rawName);
      return { reason: '집단 소속회사 목록에 정규화 동명 2건 이상 — 자동 선택하지 않습니다' };
    }
    const fromPop = popByName.get(key);
    if (fromPop) return { code: fromPop };
    // 이름 변형을 순서대로 시도한다.
    // ★ 매트릭스 표의 회사명에는 열 폭 때문에 줄바꿈에서 온 **공백이 섞인다**
    //   ('미래에셋 자산운용(주)'). 공백을 그대로 두면 DART 상호 완전일치가 전부 실패해
    //   신호가 통째로 join_failed 로 빠진다 (실측: 유가증권 신호 11건 전원 조인 실패).
    const base = rawName.trim();
    const stripLegal = (n: string): string =>
      n.replace(/\(주\)|\(유\)|㈜|주식회사|유한회사|유한책임회사|합자회사|합명회사/g, '').trim();
    const noSpace = base.replace(/[\s ]+/g, '');
    const tried = new Set<string>();
    for (const variant of [base, noSpace, stripLegal(base), stripLegal(noSpace)]) {
      if (!variant || tried.has(variant)) continue;
      tried.add(variant);
      const hits = deps.findCorps(variant);
      if (hits.length === 1) return verifyMembership(hits[0]!.corpCode, rawName);
      if (hits.length > 1) return disambiguateByJurirNo(rawName, hits);
    }
    return {
      reason: withAffiliateHint(
        rawName,
        population === null
          ? 'DART 법인 인덱스에서 상호 일치 없음'
          : '집단 소속회사 목록·DART 법인 인덱스 어디에서도 조인 실패',
      ),
    };
  }
  // 같은 회사가 차입회사·대여회사·매트릭스 행으로 여러 번 나온다 — 인덱스 조회도 기업개황
  // 호출도 이름당 한 번만 한다 (호출은 전부 순차라 경합이 없다)
  const joinCache = new Map<string, { code?: string; reason?: string }>();
  async function joinCorpCode(rawName: string): Promise<{ code?: string; reason?: string }> {
    const key = normalizeCompanyName(rawName);
    const hit = joinCache.get(key);
    if (hit) return hit;
    const r = await joinCorpCodeUncached(rawName);
    joinCache.set(key, r);
    return r;
  }

  // ── ④ 거래 판정 1차 — 기준 초과 여부 ──
  const judgedBorrowings: JudgedBorrowing[] = borrowings.map((b: FundBorrowing) => {
    const th = thresholds.get(normalizeCompanyName(b.company));
    const j = judgeOverThreshold(b.amount, th);
    const base: JudgedBorrowing = {
      company: b.company,
      counterparty: b.counterparty,
      amount: b.amount,
      amount_display: fmtWon(b.amount),
      date: b.date,
      ...(b.rawDate && !b.date ? { raw_date: b.rawDate } : {}),
      table_label: b.label,
      ...(th
        ? {
            threshold: {
              value: th.value,
              value_display: fmtWon(th.value),
              formula: th.formula,
              source_row: th.source_row,
            },
          }
        : {}),
      ...(j.certainty ? { certainty: j.certainty } : {}),
      status: 'not_judged',
    };
    // 차입일이 오늘 이후면 원문 기재 오류이거나 예정 거래다 — J001 부재가 당연하므로
    // 후보로 만들면 오경보다 (Codex 4차 S2)
    if (b.date && b.date > today) {
      return {
        ...base,
        status: 'not_judged',
        reason:
          `future_transaction_date — 차입일(${b.date})이 오늘(${today}) 이후입니다. ` +
          '원문 기재 오류이거나 예정 거래일 수 있어 판정하지 않습니다',
      };
    }
    if (j.over === false) return { ...base, status: 'below_threshold' };
    if (j.over === null) {
      return {
        ...base,
        status: 'not_judged',
        reason:
          'threshold_unknown — 재무현황 표에서 이 회사의 자본을 찾지 못했고 거래금액이 100억원 미만이라 ' +
          '기준금액 초과 여부를 판정할 수 없습니다',
      };
    }
    return base; // over — 상태는 J001 대조 후 확정
  });

  // ④-0. 같은 상대방과의 연간 합산 재점검 — §4③은 자금거래의 대규모내부거래 해당 여부를
  // "동일 거래상대방과의 동일 거래대상에 대한 거래행위" 기준으로 판단한다. 개별 인출이
  // 기준 미달이어도 같은 약정(동일 거래대상)의 분할 인출 합산이 기준 이상이면 공시대상일 수
  // 있는데, J004 로는 동일 거래대상 여부를 알 수 없다 — below_threshold 로 안심시키지 않고
  // not_judged 로 내린다 (Codex 4차 C2. 분할 차입 4억×4회가 전부 "기준 미달"로 빠지는
  // 거짓 안심 경로).
  {
    const pairTotals = new Map<string, number>();
    for (const b of judgedBorrowings) {
      const k = `${normalizeCompanyName(b.company)} ${normalizeCompanyName(b.counterparty)}`;
      pairTotals.set(k, (pairTotals.get(k) ?? 0) + b.amount);
    }
    for (const b of judgedBorrowings) {
      if (b.status !== 'below_threshold') continue;
      const total = pairTotals.get(
        `${normalizeCompanyName(b.company)} ${normalizeCompanyName(b.counterparty)}`,
      )!;
      const overByCap = total >= CAP_100;
      const overByThreshold = b.threshold !== undefined && total >= b.threshold.value;
      if (!overByCap && !overByThreshold) continue;
      b.status = 'not_judged';
      b.same_counterparty_annual_total = total;
      b.same_counterparty_annual_total_display = fmtWon(total);
      b.reason =
        `aggregation_unknown — 이 건(${b.amount_display})은 기준 미달이지만 같은 상대방과의 ` +
        `연간 차입 합산이 ${fmtWon(total)}로 기준 이상입니다. 고시 §4③은 자금거래를 ` +
        '동일 거래상대방과의 **동일 거래대상** 기준으로 판단하므로, 같은 약정의 분할 인출이면 ' +
        '합산 기준으로 공시대상일 수 있습니다 — J004 로는 동일 거래대상 여부를 알 수 없어 ' +
        '"기준 미달"로 단정하지 않습니다. 약정 단위를 원문으로 확인하세요';
    }
  }

  // ④-1. 계열편입일 이전 거래 분리 — 편입 전에는 공시의무 자체가 없다.
  // audit_periodic 이 같은 오탐(신규 편입사의 과거 기한이 통째로 "미제출")을 겪고 도입한
  // joinedGroupAt(포털 grinil)을 여기서도 쓴다 (교차검토 M-6).
  if (population?.joinedGroupAt) {
    for (const b of judgedBorrowings) {
      if (b.status !== 'not_judged' || b.reason) continue; // 기준 초과 건만
      const code = popByName.get(normalizeCompanyName(b.company));
      const joinedAt = code ? population.joinedGroupAt.get(code) : undefined;
      if (b.date && joinedAt && b.date < joinedAt) {
        b.status = 'no_duty_before_joining';
        b.corp_code = code!;
        b.joined_group_at = joinedAt;
        b.reason =
          `차입일(${b.date})이 계열편입일(${joinedAt}, 포털 grinil)보다 앞섭니다 — 편입 전 거래에는 ` +
          '대규모내부거래 공시의무가 없습니다. 단 편입일 데이터의 정확성·재편입 여부는 확인하지 않았습니다';
      }
    }
  } else if (population) {
    notes.push(
      'ℹ️ 포털에서 계열편입일(grinil)을 얻지 못해 "편입 전 거래 = 의무 없음" 분리를 하지 않았습니다 — ' +
        '신규 편입 회사의 편입 전 거래가 후보로 나올 수 있습니다.',
    );
  }

  // ── ④-2. 대여회사(자금을 대준 계열회사) 관점 1차 판정 ──
  //
  // 대규모내부거래 공시의무는 거래를 하는 계열회사 **각자에게** 있다. 차입 한 건에 의무자가
  // 둘이고(차입회사 = 자금차입 / 대여회사 = 특수관계인에 대한 자금대여), 기준금액은 **각자의
  // 자본**으로 계산한다. 종전에는 차입회사 쪽만 봐서, 자본이 작은 대여회사의 미공시가 통째로
  // 시야 밖이었다 (반대로 차입회사가 기준 미달이라 below_threshold 로 빠진 건이라도 대여회사
  // 기준으로는 초과일 수 있다 — 그래서 차입회사 판정과 **독립적으로** 계산한다).
  //
  // 여기서는 조인·기준금액까지만 확정하고(순수 계산), J001 조회가 필요한 대여회사는 아래
  // 검색 예산(⑤)에 함께 올린다. 상태는 ⑦에서 차입회사와 같은 함수·창·근접 규칙으로 확정한다.
  /** 대여회사 정규화 이름 → 원문 이름 (검색 단계에서 조인에 쓴다) */
  const lenderRawNames = new Map<string, string>();
  /** J001 조회가 필요한 대여회사 키 → 이 대여회사가 관련된 차입일 목록 */
  const lenderNeedsSearch = new Map<string, string[]>();
  {
    // (대여회사, 차입회사) 연간 합산 — §4③ 판단 단위는 차입회사 쪽과 같은 쌍이다
    const pairTotals = new Map<string, number>();
    for (const b of judgedBorrowings) {
      const k = `${normalizeCompanyName(b.counterparty)} ${normalizeCompanyName(b.company)}`;
      pairTotals.set(k, (pairTotals.get(k) ?? 0) + b.amount);
    }
    for (const b of judgedBorrowings) {
      const lender = b.counterparty;
      const key = normalizeCompanyName(lender);
      const side: LenderSide = { company: lender, status: 'not_judged' };
      b.lender_side = side;

      // 차입회사 쪽과 같은 이유로 미래 일자는 판정하지 않는다
      if (b.date && b.date > today) {
        side.reason =
          `future_transaction_date — 차입일(${b.date})이 오늘(${today}) 이후입니다 — ` +
          '대여회사 쪽도 판정하지 않습니다';
        continue;
      }

      const joined = await joinCorpCode(lender);
      if (!joined.code) {
        // 자연인 추정은 **조인 실패 + 소속 확인 실패**가 모두 성립한 뒤에만 쓴다.
        // ★ 조인 실패만으로 자연인 추정을 돌리면 안 된다: 한글 2~4자 상호가 실재하고
        //   (예: '한샘'), 조인은 DART 인덱스 캐시 사정만으로도 실패한다. 재무현황 표나
        //   포털 소속회사 목록이 회사임을 보증하는 이름을 자연인으로 분류하면 그 계열사의
        //   자금대여 미공시가 counterparty_not_company 로 조용히 사라진다 — 거짓 안심이다.
        if (!isConfirmedCompanyName(lender) && looksLikeNaturalPerson(lender)) {
          side.status = 'counterparty_not_company';
          side.reason =
            'counterparty_looks_like_natural_person — 거래상대방 이름이 자연인(동일인·친족) 형태로 ' +
            '보입니다. 자연인은 회사가 아니어서 J001 공시의무자가 아니므로 대조하지 않았습니다 — ' +
            '**이름 모양에 근거한 추정**이니 실제로 법인이라면 그 회사의 자금대여 공시를 직접 확인하세요';
        } else {
          side.status = 'counterparty_not_joined';
          side.reason =
            `counterparty_not_joined — 대여회사 이름을 DART corp_code 로 잇지 못해 자금대여 공시를 ` +
            `조회할 수 없었습니다 (${joined.reason ?? '조인 실패'}) — "공시 없음"이 아니라 확인하지 못한 것입니다` +
            (capitalNameKeys.has(key)
              ? '. 이 이름은 같은 문서의 재무현황 표에 있는 **계열회사**입니다 — ' +
                'resolve_entity 로 corp_code 를 확인해 직접 대조하세요'
              : '');
        }
        continue;
      }
      side.corp_code = joined.code;
      lenderRawNames.set(key, lender);

      // 대여회사도 편입 전에는 의무가 없다 (차입회사와 같은 근거·같은 한계)
      const joinedAt = population?.joinedGroupAt?.get(joined.code);
      if (b.date && joinedAt && b.date < joinedAt) {
        side.status = 'no_duty_before_joining';
        side.joined_group_at = joinedAt;
        side.reason =
          `차입일(${b.date})이 대여회사의 계열편입일(${joinedAt}, 포털 grinil)보다 앞섭니다 — ` +
          '편입 전 거래에는 공시의무가 없습니다';
        continue;
      }

      // 기준금액은 **대여회사 자신의 자본**으로 (같은 J004 재무현황 표)
      const th = thresholds.get(key);
      if (th) {
        side.threshold = {
          value: th.value,
          value_display: fmtWon(th.value),
          formula: th.formula,
          source_row: th.source_row,
        };
      }
      const j = judgeOverThreshold(b.amount, th);
      if (j.certainty) side.certainty = j.certainty;
      if (j.over === null) {
        side.reason =
          'threshold_unknown — 재무현황 표에서 대여회사의 자본을 찾지 못했고 거래금액이 100억원 ' +
          '미만이라 기준금액 초과 여부를 판정할 수 없습니다';
        continue;
      }
      if (j.over === false) {
        const total = pairTotals.get(`${key} ${normalizeCompanyName(b.company)}`)!;
        if (total >= CAP_100 || total >= th!.value) {
          // 차입회사 쪽 aggregation_unknown 과 같은 근거 (고시 §4③ 동일 거래대상)
          side.same_counterparty_annual_total = total;
          side.same_counterparty_annual_total_display = fmtWon(total);
          side.reason =
            `aggregation_unknown — 이 건(${b.amount_display})은 대여회사 기준금액 미달이지만 같은 ` +
            `상대방과의 연간 대여 합산이 ${fmtWon(total)}로 기준 이상입니다 — 같은 약정의 분할 ` +
            '실행이면 합산 기준으로 공시대상일 수 있어 "기준 미달"로 단정하지 않습니다';
          continue;
        }
        side.status = 'below_threshold';
        continue;
      }
      // 기준 초과 — J001 자금대여 공시를 대조해야 한다
      const dates = lenderNeedsSearch.get(key) ?? [];
      if (b.date) dates.push(b.date);
      lenderNeedsSearch.set(key, dates);
    }
  }

  // 상품·용역 — 품목 성격상 제외할 행을 먼저 갈라내고, 나머지를 (회사, 상대방) 단위로 합산한다.
  const caveatRows: GoodsCaveatRow[] = [];
  const aggregates = new Map<
    string,
    {
      company: string;
      counterparty: string;
      /** '가.(분기)' 표에서 온 합 */
      quarterly: number;
      /** 그 밖의 표('나.(연1회)' 등)에서 온 합 */
      annual: number;
      items: GoodsItem[];
    }
  >();
  for (const g of goods as GoodsServiceRow[]) {
    const itemCaveat = itemLikelyNotGoodsService(g.item);
    if (itemCaveat) {
      const th = thresholds.get(normalizeCompanyName(g.company));
      const jl: GoodsSignal['quarterly_logic'] =
        g.annualAmount >= 4 * CAP_100
          ? 'annual_geq_4x_threshold'
          : th
            ? g.annualAmount >= 4 * th.value
              ? 'annual_geq_4x_threshold'
              : 'annual_below_4x_threshold'
            : 'threshold_unknown';
      caveatRows.push({
        company: g.company,
        counterparty: g.counterparty,
        item: g.item,
        annual_amount: g.annualAmount,
        annual_amount_display: fmtWon(g.annualAmount),
        item_caveat: itemCaveat,
        ...(th
          ? {
              threshold: {
                value: th.value,
                value_display: fmtWon(th.value),
                formula: th.formula,
                source_row: th.source_row,
              },
            }
          : {}),
        ...(jl === 'annual_geq_4x_threshold'
          ? {
              certainty: (g.annualAmount >= 4 * CAP_100
                ? 'certain_by_cap'
                : 'approx_from_j004') as Certainty,
            }
          : {}),
        quarterly_logic: jl,
      });
      continue;
    }
    const key = `${normalizeCompanyName(g.company)} ${normalizeCompanyName(g.counterparty)}`;
    const agg = aggregates.get(key) ?? {
      company: g.company,
      counterparty: g.counterparty,
      quarterly: 0,
      annual: 0,
      items: [],
    };
    // ★ 표 라벨을 갈라 담는다 — 같은 쌍이 '가.(분기)' 와 '나.(연1회)' 에 모두 실리면
    //   한쪽이 다른 쪽의 부분기간이라 **더하면 이중 계상**이다 (GoodsSignal.label_overlap 주석).
    if (isQuarterlyGoodsTable(g.label)) agg.quarterly += g.annualAmount;
    else agg.annual += g.annualAmount;
    agg.items.push({
      item: g.item,
      annual_amount: g.annualAmount,
      annual_amount_display: fmtWon(g.annualAmount),
      label: g.label,
    });
    aggregates.set(key, agg);
  }

  // (5) 총괄표의 쌍별 연간 총액 — (6) 판정을 보강하는 데 쓴다 (GoodsSignal.matrix_annual_total).
  // 파서가 같은 쌍을 두 번 만나면 첫 값을 쓰므로(MatrixResult.duplicatePairs) 여기서도 첫 값이다.
  const matrixTotals = new Map<string, { amount: number; colGroup: string }>();
  for (const c of goodsMatrixSeed.cells) {
    const key = `${normalizeCompanyName(c.rowCompany)} ${normalizeCompanyName(c.colCompany)}`;
    if (!matrixTotals.has(key)) matrixTotals.set(key, { amount: c.amount, colGroup: c.colGroup });
  }
  /** (5) 총괄 값이 더 커서 판정 금액을 올린 쌍 (진단용) */
  const goodsPromotedFromMatrix: { pair: string; from: number; to: number }[] = [];
  /** (6) 두 표에 걸쳐 실려 합산하지 않은 쌍 수 (진단용) */
  let goodsLabelOverlaps = 0;

  const judgedGoods: GoodsSignal[] = [...aggregates.values()].map((a) => {
    const th = thresholds.get(normalizeCompanyName(a.company));
    const key = `${normalizeCompanyName(a.company)} ${normalizeCompanyName(a.counterparty)}`;
    // 두 표에 걸친 쌍은 **더하지 않는다** — 한쪽이 다른 쪽의 부분기간이다 (isQuarterlyGoodsTable).
    const overlapped = a.quarterly > 0 && a.annual > 0;
    if (overlapped) goodsLabelOverlaps++;
    const detailTotal = overlapped ? Math.max(a.quarterly, a.annual) : a.quarterly + a.annual;

    // (5) 총괄이 같은 쌍을 더 크게 적었으면 **그 값으로 판정한다**. (6)은 "일정 규모 이상"만
    // 싣는 표라 상대방별 연간 총액을 다 담지 못한다 — 실물 30/149 쌍에서 실제로 더 컸다.
    // 국외 계열회사 열은 공시대상이 아니므로(법 §26①·고시 §2③2호) 승격 근거로 쓰지 않는다.
    //
    // ★ 두 표를 옮겨 적는 과정의 미세한 오차(반올림·전기 오류)까지 승격으로 표시하면
    //   caveat 만 늘고 사람이 볼 것은 늘지 않는다 — 실측(케이티)에서 16건 중 3건이
    //   1.000~1.017배(차액 100만~8,600만원)였고 그 셋은 판정을 전혀 바꾸지 않았다.
    //   그래서 **판정(quarterly_logic)이 실제로 달라지거나 차액이 5%를 넘을 때만** 승격한다.
    //   승격하지 않으면 판정도 (6) 합산 그대로다 — 근거와 판정 금액이 어긋나지 않게.
    const mt = matrixTotals.get(key);
    const usable =
      mt !== undefined && !isForeignAffiliateColumn(mt.colGroup) && mt.amount > detailTotal;
    const promote =
      usable &&
      (goodsQuarterlyLogic(mt.amount, th) !== goodsQuarterlyLogic(detailTotal, th) ||
        mt.amount - detailTotal > detailTotal * 0.05);
    const judgeAmount = promote ? mt.amount : detailTotal;
    if (promote) {
      goodsPromotedFromMatrix.push({
        pair: `${a.company} → ${a.counterparty}`,
        from: detailTotal,
        to: mt.amount,
      });
    }

    const base: GoodsSignal = {
      company: a.company,
      counterparty: a.counterparty,
      source: '(6)주요내역',
      annual_amount_total: detailTotal,
      annual_amount_total_display: fmtWon(detailTotal),
      items: a.items,
      ...(overlapped
        ? {
            label_overlap: {
              quarterly_display: fmtWon(a.quarterly),
              annual_display: fmtWon(a.annual),
              note:
                `이 쌍이 (6)의 '가.(분기)' 표(${fmtWon(a.quarterly)})와 '나.(연1회)' ` +
                `표(${fmtWon(a.annual)})에 **모두** 실려 있습니다 — 한쪽이 다른 쪽의 부분기간이면 ` +
                '더하는 것이 이중 계상이라 합산하지 않고 큰 쪽만 판정에 썼습니다. 원문 두 표를 ' +
                '직접 대조해 별개 거래인지 확인하세요 (별개라면 실제 총액은 더 큽니다)',
            },
          }
        : {}),
      ...(promote
        ? {
            matrix_annual_total: mt.amount,
            matrix_annual_total_display: fmtWon(mt.amount),
            matrix_excess_display: fmtWon(mt.amount - detailTotal),
            judged_on: '(5)총괄' as const,
            matrix_caveat:
              `(5) 계열회사간 상품ㆍ용역거래 **총괄표**가 같은 쌍에 ${fmtWon(mt.amount)}를 적어 ` +
              `(6) 주요 내역 합산(${fmtWon(detailTotal)})보다 ${fmtWon(mt.amount - detailTotal)} ` +
              '큽니다 — (6)은 "거래한 금액이 **일정 규모 이상**인 경우"의 내역만 싣는 표라 상대방별 ' +
              '연간 총액을 다 담지 못하므로, 판정은 더 큰 (5) 총액으로 했습니다. ⚠️ 다만 (5)에는 ' +
              '**품목이 없어** 배당·이자·임대차처럼 상품·용역이 아닌 항목이 그 차액에 섞여 있어도 ' +
              '가려내지 못합니다. 차액의 성격은 원문 (5)·(6) 두 표를 대조해 확인하세요',
          }
        : { judged_on: '(6)합산' as const }),
      ...(th
        ? {
            threshold: {
              value: th.value,
              value_display: fmtWon(th.value),
              formula: th.formula,
              source_row: th.source_row,
            },
          }
        : {}),
      quarterly_logic: 'threshold_unknown',
    };
    // 판정 강도는 goodsQuarterlyLogic 한 곳에서만 정한다 (승격 판단과 같은 자로 재기 위해).
    const logic = goodsQuarterlyLogic(judgeAmount, th);
    if (logic === 'annual_geq_4x_threshold') {
      return {
        ...base,
        quarterly_logic: logic,
        certainty: judgeAmount >= 4 * CAP_100 ? 'certain_by_cap' : 'approx_from_j004',
      };
    }
    if (logic === 'threshold_unknown') return base;
    return { ...base, quarterly_logic: 'annual_below_4x_threshold' };
  });

  // ④-3. 유가증권 총괄 매트릭스 판정 (Codex 4차 M1 — 종전에는 이 표를 파싱하지 못해
  // "유가증권 형태 자금조달 미검토"를 coverage 에 적어두는 것이 전부였다).
  const knownCompanyNames = new Set<string>([
    ...capitals.map((c) => c.company),
    // 포털 소속회사는 **조인분(corpCodes)과 미조인분(unjoined)을 모두** 넣는다 —
    // jurir 캐시가 비어 미조인일 뿐 소속은 포털이 보증한다. 조인분만 넣으면 캐시 상태에 따라
    // 같은 계열사가 "목록 밖 상대방"으로 표시돼 확인 우선순위가 흔들린다.
    ...(population ? [...population.corpCodes.values(), ...population.unjoined] : []),
    ...securitiesSeed.cells.map((c) => c.rowCompany),
    ...goodsMatrixSeed.cells.map((c) => c.rowCompany),
  ]);
  // ★ 화이트리스트를 **필터로 쓰지 않는다.** 같은 회사가 표마다 다르게 적히기 때문이다
  //   (실측: 열 '미래에셋 파트너스 제9호…' vs 행 '미래에셋 파트너스 제구호…').
  //   목록 밖이라고 버리면 진짜 거래가 조용히 사라져 거짓 안심이 된다 — 대신 상대방이
  //   확인된 계열사인지 신호마다 표시하고, 판정은 그대로 진행한다.
  const securitiesMatrix = securitiesSeed;
  const knownKeys = new Set([...knownCompanyNames].map((n) => normalizeCompanyName(n)));
  const judgedSecurities: SecuritySignal[] = securitiesMatrix.cells.map((c) => {
    const th = thresholds.get(normalizeCompanyName(c.rowCompany));
    const j = judgeOverThreshold(c.amount, th);
    const base: SecuritySignal = {
      company: c.rowCompany,
      counterparty: c.colCompany,
      annual_amount: c.amount,
      annual_amount_display: fmtWon(c.amount),
      ...(th
        ? {
            threshold: {
              value: th.value,
              value_display: fmtWon(th.value),
              formula: th.formula,
              source_row: th.source_row,
            },
          }
        : {}),
      ...(j.certainty ? { certainty: j.certainty } : {}),
      ...(knownKeys.has(normalizeCompanyName(c.colCompany))
        ? {}
        : { counterparty_in_known_list: false }),
      status: 'not_judged',
    };
    // 국외 계열회사는 법 §26①·고시 §2③2호가 특수관계인에서 제외한다 — 후보가 될 수 없다.
    // 버리지 않고 근거와 함께 남긴다 (그룹 헤더 판독이 틀렸을 수 있다).
    if (isForeignAffiliateColumn(c.colGroup)) {
      return {
        ...base,
        column_group: c.colGroup,
        status: 'not_applicable_foreign_affiliate' as const,
        reason: foreignAffiliateReason(c.colGroup),
      };
    }
    if (j.over === false) {
      // ★ 이 방향만 확실하다 — 상대방별 **연간 총액**이 기준 미만이면 그 상대방과의
      //   어떤 개별 거래도 기준 미만이다 (부분은 합계를 넘지 못한다).
      return {
        ...base,
        status: 'below_threshold' as const,
        reason:
          'annual_total_below_threshold — 이 상대방과의 연간 총액이 기준금액 미만이므로 개별 ' +
          '거래도 전부 기준 미만입니다. 다만 기준금액은 J004 자본 스냅샷 기반 근사치입니다',
      };
    }
    if (j.over === null) {
      return {
        ...base,
        status: 'not_judged' as const,
        reason:
          'threshold_unknown — 재무현황 표에서 이 회사의 자본을 찾지 못했고 연간 총액이 100억원 ' +
          '미만이라 기준금액 초과 여부를 판정할 수 없습니다',
      };
    }
    return base; // over — 상태는 J001 대조 후 확정
  });

  // ④-4. 상품·용역 **총괄표 (5)** 로 (6) 주요 내역의 구멍을 메운다.
  //
  // ★ 중복을 만들지 않는 것이 제1 요건이다 — 같은 거래가 두 바구니에 서로 다른 강도로 실리면
  //   사용자가 같은 건을 두 번 확인하게 되고, 무엇이 진짜 신호인지 흐려진다. 쌍 키는
  //   (6) 합산과 **완전히 같은 형식**(정규화된 매출회사·매입회사)이라 표기 차이를 흡수한다
  //   (실측: (5)의 '와이케이 디벨롭먼트(주)'·'미래에셋 증권(주)' ↔ (6)의 '와이케이디벨롭먼트(주)'·
  //   '미래에셋증권' — 공백·법인격 표기가 다르지만 같은 쌍이다).
  //
  // ⚠️ 품목 성격상 (6)에서 분리한 행(배당·이자·임대차)만 있는 쌍은 `aggregates` 에 없다.
  //   그 쌍은 (5)에서 보완 신호로 낸다 — 실측상 (5)에는 배당금수익이 실리지 않으므로
  //   (5)의 값은 그 caveat 행과 다른 거래일 개연성이 크고, 조용히 버리면 누락이 된다.
  const goodsPairKeys = new Set(aggregates.keys());
  // ★ 실물에서 **쌍 키 정규화가 못 잡는 표기 차이**가 확인됐다 (미래에셋 20260819000341):
  //   같은 205,454백만 보험판매 거래를 (6)은 '미래에셋생명(주)', (5)는 '미래에셋 생명보험(주)'
  //   로 적는다. 공백·법인격을 지워도 '미래에셋생명' ≠ '미래에셋생명보험' 이라 중복 제거를
  //   비껴가 같은 거래가 양쪽에 후보로 올랐다. 이름만으로 같은 회사인지 알 방법이 없다
  //   (DART↔포털 표기 체계가 다르다는 이 프로젝트의 오래된 전제와 같은 문제다).
  // ★ 그렇다고 "같은 매출회사 + 같은 금액"으로 **버리면** 우연히 금액이 같은 별개 거래가
  //   조용히 사라진다 — 이 프로젝트가 반복해서 금지한 거짓 안심 방향이다. 그래서 버리지 않고
  //   **표시만 한다** (화이트리스트를 필터가 아니라 표시로 쓰는 것과 같은 규칙).
  const majorByCompanyAmount = new Map<string, string>();
  for (const a of aggregates.values()) {
    // 라벨별 소계와 그 합을 **모두** 힌트 키로 넣는다 — 표기 차이를 찾는 것이 목적이라
    // 어느 쪽 값이 (5)와 같아도 같은 거래 의심으로 표시해야 한다.
    // 금액 0 은 우연 일치가 흔해 힌트로 쓰지 않는다.
    for (const v of [a.quarterly, a.annual, a.quarterly + a.annual]) {
      if (v > 0) majorByCompanyAmount.set(`${normalizeCompanyName(a.company)} ${v}`, a.counterparty);
    }
  }
  const GOODS5_CAVEAT =
    '(5) 계열회사간 상품ㆍ용역거래 **총괄표**에서 온 값입니다 — ① 상대방별 **연간 총액**이라 ' +
    '기준금액 판단 단위인 **분기 합계액**(고시 §4③2호)으로 분해되지 않습니다 ② 총괄표에는 ' +
    '**품목이 없어** 배당·이자·임대차처럼 상품·용역이 아닌 항목을 가려내지 못합니다 ' +
    '(실측상 총괄표에 배당금수익은 실리지 않았습니다) ③ (6) 주요 내역과 **회사명이 정규화 ' +
    '일치하는 쌍**은 제외했습니다. 다만 두 표가 같은 회사를 다르게 적으면(실측: (6) ' +
    "'미래에셋생명(주)' vs (5) '미래에셋 생명보험(주)') 같은 거래가 양쪽에 남습니다 — " +
    '그 가능성이 보이면 possible_duplicate_of_major_detail 로 표시하니 확인 전에 먼저 보세요.';
  let goodsMatrixPairsAlsoInDetail = 0;
  let goodsMatrixPossibleDuplicates = 0;
  const judgedGoodsMatrix: GoodsMatrixSignal[] = [];
  for (const c of goodsMatrixSeed.cells) {
    const key = `${normalizeCompanyName(c.rowCompany)} ${normalizeCompanyName(c.colCompany)}`;
    if (goodsPairKeys.has(key)) {
      goodsMatrixPairsAlsoInDetail++;
      continue;
    }
    // 같은 매출회사가 (6)에서 **원 단위까지 같은 금액**을 다른 이름의 상대방에게 적었다면
    // 같은 거래일 가능성이 높다 — 판정은 그대로 두고 표시만 한다
    const dupCounterparty = majorByCompanyAmount.get(
      `${normalizeCompanyName(c.rowCompany)} ${c.amount}`,
    );
    if (dupCounterparty !== undefined) goodsMatrixPossibleDuplicates++;
    const th = thresholds.get(normalizeCompanyName(c.rowCompany));
    const j = judgeOverThreshold(c.amount, th);
    const base: GoodsMatrixSignal = {
      company: c.rowCompany,
      counterparty: c.colCompany,
      source: '(5)총괄',
      annual_amount: c.amount,
      annual_amount_display: fmtWon(c.amount),
      ...(th
        ? {
            threshold: {
              value: th.value,
              value_display: fmtWon(th.value),
              formula: th.formula,
              source_row: th.source_row,
            },
          }
        : {}),
      ...(j.certainty ? { certainty: j.certainty } : {}),
      ...(knownKeys.has(normalizeCompanyName(c.colCompany))
        ? {}
        : { counterparty_in_known_list: false }),
      ...(dupCounterparty !== undefined
        ? {
            possible_duplicate_of_major_detail: {
              major_detail_counterparty: dupCounterparty,
              amount_display: fmtWon(c.amount),
              note:
                `(6) 주요 내역에도 같은 매출회사가 **같은 금액**(${fmtWon(c.amount)})을 ` +
                `'${dupCounterparty}' 에게 적은 행이 있습니다 — 두 표가 같은 회사를 다르게 ` +
                '적은 **같은 거래**일 가능성이 높습니다. 그 경우 (6) 쪽 신호와 이 신호는 하나로 ' +
                '세어야 합니다. 우연히 금액이 같은 별개 거래일 수도 있어 버리지 않고 표시만 합니다',
            },
          }
        : {}),
      quarterly_logic: 'threshold_unknown',
      caveat: GOODS5_CAVEAT,
      status: 'not_judged',
    };
    // 국외 계열회사 열은 후보가 될 수 없다 (법 §26①·고시 §2③2호). 버리지 않고 근거와 함께 남긴다.
    if (isForeignAffiliateColumn(c.colGroup)) {
      judgedGoodsMatrix.push({
        ...base,
        column_group: c.colGroup,
        status: 'not_applicable_foreign_affiliate',
        reason: foreignAffiliateReason(c.colGroup),
      });
      continue;
    }
    if (j.over === false) {
      // ★ 이 방향만 확실하다 — 분기 합계는 연간 총액을 넘지 못하므로, 연간 총액이 기준 미만이면
      //   네 분기 전부 기준 미만이다. (기준금액 자체는 J004 자본 스냅샷 기반 근사치다.)
      judgedGoodsMatrix.push({
        ...base,
        quarterly_logic: 'annual_below_threshold',
        status: 'below_threshold',
        reason:
          'annual_total_below_threshold — 이 상대방과의 연간 총액이 기준금액 미만이므로 어느 ' +
          '분기 합계도 기준 미만입니다. 다만 기준금액은 J004 자본 스냅샷 기반 근사치입니다',
      });
      continue;
    }
    if (j.over === null) {
      judgedGoodsMatrix.push({
        ...base,
        status: 'not_judged',
        reason:
          'threshold_unknown — 재무현황 표에서 이 회사의 자본을 찾지 못했고 연간 총액이 100억원 ' +
          '미만이라 기준금액 초과 여부를 판정할 수 없습니다',
      });
      continue;
    }
    // 기준 초과 — 비둘기집이 서는지로 신호 강도를 가른다. 상태는 J001 대조 후 확정한다.
    const fourX = c.amount >= 4 * CAP_100 || (th !== undefined && c.amount >= 4 * th.value);
    judgedGoodsMatrix.push({
      ...base,
      quarterly_logic: fourX ? 'annual_geq_4x_threshold' : 'annual_geq_threshold',
    });
  }

  // ── ④-5. 거래 **상대방 쪽** 관점 (상품·용역 매입회사 / 유가증권 매도회사) ──
  //
  // ★ 근거: 매뉴얼 lit26-001 "거래규모가 거래당사자 **모두에게** 대규모내부거래에 해당되는
  //   경우 이사회 의결 및 공시의무는 거래당사자 모두에게 있음" — 차입의 lender_side 와 같은
  //   원리이고, 기준금액은 **각자의 자본**으로 계산한다.
  // ★ 어휘·검색 예산·유형 필터를 전부 재사용한다. 실측 J001 보고서명이 방향 중립이라
  //   (`특수관계인과의수익증권거래`·`계열금융회사의약관에의한금융거래-[유가증권-채권]`·
  //   `상품ㆍ용역거래`) 매도/매입 어느 쪽이든 같은 필터로 찾는다.
  /** 상대방 관점 판정 대상 — 상태는 ⑦에서 차입·판매 쪽과 같은 함수로 확정한다 */
  const counterSides: Array<{
    side: CounterpartySide;
    kind: 'goods' | 'securities';
    /** 검색 예산 우선순위용 거래금액 (연간 총액) */
    amount: number;
    /** 원래 신호의 회사 = 이 관점에서의 거래상대방 (유형 미상 공시 원문 상대방과 대조) */
    origin: string;
  }> = [];
  /** 상대방 관점 때문에 새로 검색이 필요해진 회사 (정규화 이름 → 원문 이름) */
  const counterRawNames = new Map<string, string>();

  /**
   * 상대방 쪽 1차 판정 — 조인·기준금액까지만 확정하고 J001 조회는 ⑤ 예산에 올린다.
   * 판정 강도 규칙은 원래 신호와 **완전히 같다** (상품·용역 비둘기집 / 유가증권 총액 한계).
   */
  async function judgeCounterSide(
    counterparty: string,
    amount: number,
    kind: 'goods' | 'securities',
    origin: string,
  ): Promise<CounterpartySide> {
    const key = normalizeCompanyName(counterparty);
    const side: CounterpartySide = { company: counterparty, status: 'not_judged' };
    counterSides.push({ side, kind, amount, origin });
    if (kind === 'goods') side.counterparty_qualification = 'not_verified';

    const joined = await joinCorpCode(counterparty);
    if (!joined.code) {
      // 차입 쪽과 같은 순서 — 조인 실패 + 소속 확인 실패 뒤에만 자연인 추정을 쓴다
      if (!isConfirmedCompanyName(counterparty) && looksLikeNaturalPerson(counterparty)) {
        side.status = 'counterparty_not_company';
        side.reason =
          'counterparty_looks_like_natural_person — 이름이 자연인(동일인·친족) 형태로 보입니다. ' +
          '자연인은 J001 공시의무자가 아니므로 대조하지 않았습니다 — **이름 모양에 근거한 ' +
          '추정**이니 실제로 법인이라면 그 회사의 공시를 직접 확인하세요';
      } else {
        side.status = 'counterparty_not_joined';
        side.reason =
          `counterparty_not_joined — 이 회사를 DART corp_code 로 잇지 못해 공시를 조회할 수 ` +
          `없었습니다 (${joined.reason ?? '조인 실패'}) — "공시 없음"이 아니라 확인하지 못한 것입니다`;
      }
      return side;
    }
    side.corp_code = joined.code;
    counterRawNames.set(key, counterparty);

    const th = thresholds.get(key);
    if (th) {
      side.threshold = {
        value: th.value,
        value_display: fmtWon(th.value),
        formula: th.formula,
        source_row: th.source_row,
      };
    }
    const j = judgeOverThreshold(amount, th);
    if (j.certainty) side.certainty = j.certainty;
    if (j.over === null) {
      if (kind === 'goods') side.quarterly_logic = 'threshold_unknown';
      side.reason =
        'threshold_unknown — 재무현황 표에서 이 회사의 자본을 찾지 못했고 연간 총액이 100억원 ' +
        '미만이라 기준금액 초과 여부를 판정할 수 없습니다';
      return side;
    }
    if (j.over === false) {
      // 분기 합계·개별 거래는 연간 총액을 넘지 못한다 — 이 방향만 확실하다
      if (kind === 'goods') side.quarterly_logic = 'annual_below_threshold';
      side.status = 'below_threshold';
      side.reason =
        'annual_total_below_threshold — 이 회사 기준으로도 연간 총액이 기준금액 미만이므로 ' +
        '분기 합계·개별 거래도 전부 기준 미만입니다 (기준금액은 J004 자본 스냅샷 기반 근사치)';
      return side;
    }
    if (kind === 'goods') {
      side.quarterly_logic =
        amount >= 4 * CAP_100 || (th !== undefined && amount >= 4 * th.value)
          ? 'annual_geq_4x_threshold'
          : 'annual_geq_threshold';
    }
    return side; // 기준 초과 — ⑤ 예산에 올려 ⑦에서 확정한다
  }

  for (const g of judgedGoods) {
    // 매입회사 쪽 판정도 **판정에 쓴 금액**으로 한다 — (5) 총괄이 더 컸다면 그쪽이다.
    // 한쪽만 (6) 합산으로 재면 같은 거래를 두 회사에 다른 크기로 재는 셈이 된다.
    g.buyer_side = await judgeCounterSide(
      g.counterparty,
      g.matrix_annual_total ?? g.annual_amount_total,
      'goods',
      g.company,
    );
  }
  for (const sec of judgedSecurities) {
    // 국외 계열회사는 양쪽 다 의무가 없다 (법 §26① 상대방 제외 + 국내 회사가 아니다)
    if (sec.status === 'not_applicable_foreign_affiliate') continue;
    sec.seller_side = await judgeCounterSide(sec.counterparty, sec.annual_amount, 'securities', sec.company);
  }
  for (const m of judgedGoodsMatrix) {
    if (m.status === 'not_applicable_foreign_affiliate') continue;
    m.buyer_side = await judgeCounterSide(m.counterparty, m.annual_amount, 'goods', m.company);
  }

  // ── ⑤ J001 대조 대상 회사 확정 (조인 + 예산) ──
  const needsSearch = new Map<string, { maxAmount: number; dates: string[] }>();
  const overBorrowings = judgedBorrowings.filter(
    (b) => b.status === 'not_judged' && !b.reason,
  );
  for (const b of overBorrowings) {
    const k = normalizeCompanyName(b.company);
    const e = needsSearch.get(k) ?? { maxAmount: 0, dates: [] };
    e.maxAmount = Math.max(e.maxAmount, b.amount);
    if (b.date) e.dates.push(b.date);
    needsSearch.set(k, e);
  }
  const signalGoods = judgedGoods.filter((g) => g.quarterly_logic === 'annual_geq_4x_threshold');
  for (const g of signalGoods) {
    const k = normalizeCompanyName(g.company);
    const e = needsSearch.get(k) ?? { maxAmount: 0, dates: [] };
    e.maxAmount = Math.max(e.maxAmount, g.annual_amount_total);
    needsSearch.set(k, e);
  }

  // (5) 총괄 보완 신호 — 기준 초과분(비둘기집 성립 여부와 무관)만 J001 을 대조한다
  const signalGoodsMatrix = judgedGoodsMatrix.filter(
    (m) =>
      m.quarterly_logic === 'annual_geq_4x_threshold' ||
      m.quarterly_logic === 'annual_geq_threshold',
  );
  for (const m of signalGoodsMatrix) {
    const k = normalizeCompanyName(m.company);
    const e = needsSearch.get(k) ?? { maxAmount: 0, dates: [] };
    e.maxAmount = Math.max(e.maxAmount, m.annual_amount);
    needsSearch.set(k, e);
  }

  const signalSecurities = judgedSecurities.filter(
    (sec) => sec.status === 'not_judged' && !sec.reason,
  );
  for (const sec of signalSecurities) {
    const k = normalizeCompanyName(sec.company);
    const e = needsSearch.get(k) ?? { maxAmount: 0, dates: [] };
    e.maxAmount = Math.max(e.maxAmount, sec.annual_amount);
    needsSearch.set(k, e);
  }

  // 상대방 관점(매입회사·매도회사)도 같은 예산·같은 캐시를 쓴다 — 판매회사와 같은 회사면
  // J001 조회는 1회뿐이다 (유형 필터가 방향 중립이라 한 번의 수집을 양쪽이 나눠 쓴다).
  for (const { side, amount } of counterSides) {
    if (side.status !== 'not_judged' || side.reason || !side.corp_code) continue;
    const k = normalizeCompanyName(side.company);
    const e = needsSearch.get(k) ?? { maxAmount: 0, dates: [] };
    e.maxAmount = Math.max(e.maxAmount, amount);
    needsSearch.set(k, e);
  }

  // 대여회사도 같은 예산·같은 캐시를 쓴다 — 차입회사와 같은 회사면 J001 조회는 1회뿐이다
  // (유형 필터만 '자금대여'로 달리 적용한다).
  for (const [key, dates] of lenderNeedsSearch) {
    const maxAmount = judgedBorrowings
      .filter((b) => normalizeCompanyName(b.counterparty) === key)
      .reduce((m, b) => Math.max(m, b.amount), 0);
    const e = needsSearch.get(key) ?? { maxAmount: 0, dates: [] };
    e.maxAmount = Math.max(e.maxAmount, maxAmount);
    e.dates.push(...dates);
    needsSearch.set(key, e);
  }

  // 예산: 금액 큰 회사부터. 넘치는 회사의 거래는 판정하지 않고 그렇다고 말한다.
  // ★ 순서는 **매 호출 같다** — 이어보기가 성립하려면 앞 호출이 본 회사가 이번에도 같은
  //   자리에 있어야 한다 (같은 문서를 읽으므로 needsSearch 도 같다).
  const ranked = [...needsSearch.entries()].sort((a, b) => b[1].maxAmount - a[1].maxAmount);
  /** 이 호출의 **건수** 예산(`MAX_COMPANIES_TO_SEARCH`)을 넘겨 이번에 보지 못한 회사 */
  const overBudgetKeys = new Set<string>();

  // ── ⑥ 회사당 1회 J001 수집 ──
  // 창 상한은 **오늘**이다. 종전의 "사업연도말 +90일" 상한은 J004 작성 중 누락을 발견해
  // 5~6월에 지연 공시(자진시정)한 건을 못 봐 "시정했는데 후보"를 만들었다 (교차검토 M-5).
  // corp_code 지정 검색은 장기 구간이 허용되므로(함정 10) 콜 수는 동일하다.
  const fyStart = `${fiscalYear}0101`;
  budget.enter('j001_search');
  const searches = new Map<string, CompanySearch>(); // 정규화 이름 → 검색 결과
  /** 이 호출에서 **새로** 검색을 시도한 회사 수 — 건수 예산은 이 수를 센다 */
  let newSearchSlots = 0;
  /** 이 호출에서 실제로 J001 목록을 받아 온 회사 수 (조인 실패는 세지 않는다 — 진전의 척도다) */
  let newSearchesPerformed = 0;
  /** 이어보기 캐시에서 그대로 가져온 회사 수 (HTTP 0) */
  let contReused = 0;
  /**
   * 이 호출에서 새로 받은 성공 목록 — 미완주로 끝나면 토큰 캐시에 쓴다.
   * ★ 토큰은 **미완주가 확정된 뒤에야** 만들어지므로(완주한 첫 호출은 저장소를 건드리지
   *   않는다) 루프 도중에는 쓸 곳이 없다. 그래서 메모리에 모았다가 끝에서 한 번에 쓴다.
   */
  const contToPersist = new Map<string, CompanySearch>();
  /** 재호출로 다시 시도할 값어치가 있는 실패(시간 예산 계열)를 낸 회사 */
  const retryableErrorKeys = new Set<string>();
  for (const [key, info] of ranked) {
    // ── ① 이어보기 캐시 — 앞 호출이 같은 실행에서 이미 받아 둔 목록 ──
    // 콜도 건수 예산도 시간 임계도 쓰지 않는다. corp_code 가 캐시에 있으므로 조인도 다시
    // 하지 않는다 (조인은 기업개황 호출을 부를 수 있어 공짜가 아니다).
    if (contToken) {
      const cachedRaw = deps.kvGet(`${contPrefix(contToken)}s:${key}`);
      if (cachedRaw) {
        try {
          searches.set(key, JSON.parse(cachedRaw) as CompanySearch);
          contReused++;
          continue;
        } catch {
          // 손상된 항목은 없는 셈 치고 다시 검색한다 (조용히 빈 결과로 흘리지 않는다)
        }
      }
    }
    // ── ② 건수 예산 — **이 호출에서 새로 검색한 회사 수** 기준 ──
    // 넘긴 회사는 버려지는 것이 아니라 다음 호출이 이어서 본다.
    if (newSearchSlots >= MAX_COMPANIES_TO_SEARCH) {
      overBudgetKeys.add(key);
      continue;
    }
    newSearchSlots++;
    // ★ 시간 예산 — **진행 중인 것을 죽이지 않고 다음 것을 시작하지 않는다.** 금액 상위부터
    //   돌고 있으므로 여기서 끊기면 남는 것은 금액이 작은 회사들이다.
    //   이 회사들은 **이어보기 토큰으로 다음 호출이 이어서** 검색한다 (J001 목록은 캐시하지
    //   않지만, 이어보기 캐시가 한 실행 안에서만 그 자리를 대신한다).
    if (!budget.canAfford(MIN_LIST_CALL_MS)) {
      deadlineSkippedKeys.add(key);
      budget.markStopped('j001_search');
      continue;
    }
    // 대표 원문 이름 하나를 찾는다 (조인 시도용)
    const rawName =
      overBorrowings.find((b) => normalizeCompanyName(b.company) === key)?.company ??
      signalGoods.find((g) => normalizeCompanyName(g.company) === key)?.company ??
      signalSecurities.find((sec) => normalizeCompanyName(sec.company) === key)?.company ??
      signalGoodsMatrix.find((m) => normalizeCompanyName(m.company) === key)?.company ??
      lenderRawNames.get(key) ??
      counterRawNames.get(key) ??
      key;
    const joined = await joinCorpCode(rawName);
    if (!joined.code) {
      joinFailures.push({ company: rawName, reason: joined.reason ?? '조인 실패' });
      continue;
    }
    const earliest = [fyStart, ...info.dates].reduce((a, b) => (a <= b ? a : b));
    const from = addDaysYmd(earliest, -LOOKBACK_DAYS);
    const to = today;
    if (from > to) {
      // S-1 방어선 — today 검증을 통과했다면 도달할 수 없지만, 창 역전을 조용히 빈 결과로
      // 흘리면 후보 오경보가 된다
      searches.set(key, {
        corp_code: joined.code,
        from,
        to,
        rows: [],
        partial: false,
        error: `검색창 역전 (from ${from} > to ${to})`,
      });
      continue;
    }
    try {
      const r = await deps.collectList(joined.code, 'J001', from, to);
      listCalls++;
      // ★ **성공했을 때만** 센다 — 이 값이 `stalled`(제자리걸음) 판정의 근거이기 때문이다.
      //   시도 횟수를 세면, 매번 같은 회사가 같은 이유로 실패하는 실행이 "진전 중"으로 보여
      //   `complete:false` 인 채 `stalled:false` 가 영원히 계속된다 — 도구는 "다시 호출하세요"만
      //   반복하고 사용자는 끝나지 않는 루프에 갇힌다 (작업 5 검토에서 실측으로 잡았다:
      //   2·3회차의 카운터가 완전히 같았는데 stalled 이 false 였다).
      newSearchesPerformed++;
      if (r.diagnostics.partial_results || r.diagnostics.truncated) partialLists = true;
      const result: CompanySearch = {
        corp_code: joined.code,
        from,
        to,
        rows: r.rows,
        partial: r.diagnostics.partial_results || r.diagnostics.truncated,
      };
      searches.set(key, result);
      // 이어보기 캐시에는 **온전한 목록만** 넣는다 — 부분 수집을 이어보기로 굳히면 다음
      // 호출이 그 누락을 물려받고 재시도할 기회가 영영 사라진다.
      if (!result.partial) contToPersist.set(key, result);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // 수집 전 예상 시간이 **남은 예산**을 넘어 거절된 경우다 (realDeps 가 maxToolSeconds 를
      // 남은 예산으로 준다) — 기간이 커서가 아니라 시간이 없어서라는 점을 밝힌다.
      const isDeadline =
        err instanceof ToolError &&
        (err.code === 'deadline_exceeded' || err.code === 'range_too_large');
      // 시간이 모자라 거절된 수집은 **재호출로 풀린다** — 이어보기 미완주 사유로 센다.
      // 그 밖의 실패(상류 오류 등)는 다시 부른다고 달라진다는 보장이 없어 세지 않는다.
      if (isDeadline) retryableErrorKeys.add(key);
      searches.set(key, {
        corp_code: joined.code,
        from,
        to,
        rows: [],
        partial: false,
        error: isDeadline
          ? `${raw} (이 도구의 남은 시간 예산 ${budget.remainingMs()}ms 기준으로 판단했습니다 — ` +
            '이 회사만 따로 search_disclosures 로 조회하면 예산 전부를 쓸 수 있습니다)'
          : raw,
      });
    }
  }
  const joinFailedKeys = new Set(joinFailures.map((f) => normalizeCompanyName(f.company)));

  // ── ⑥-b J001 원문 열기 — 상대방 대조용 (판정이 필요로 할 때만 연다) ──
  // 보고서명만으로 유형을 알 수 없는 공시(isTypeAmbiguousReport)는 종전에 판정을 통째로
  // 보류시켰다. 실물 확인(미래에셋 20260819000341, 보류 5건·유일 접수번호 11건) 결과 서식
  // 80708·80757 은 '거래상대방'이 구조화돼 있어 **원문 상대방 = 이 거래 상대방**이면 "공시
  // 존재"로 올릴 수 있다 (5건 중 3건이 그렇게 풀렸다). 반대로 상대방이 다르거나 못 읽으면
  // **보류를 유지**한다 — 이름 불일치가 표기 차이일 수 있어서다(실측: 원문 '미래에셋파트너스제9호'
  // vs J004 '미래에셋 파트너스 제구호'). 불일치를 "공시 없음 → 후보"로 내리면 오탐이 된다.
  // ★ 사전에 전부 열지 않는다 — 검색된 회사 전체의 유형 미상 공시(실측 20건)가 아니라 유형 필터에
  //   빠진 판정이 실제로 걸린 공시(실측 11건)만 열어야 예산(15건) 안에서 필요한 건이 잘리지 않는다.
  const filingDocReads = new Map<string, FilingDocRead>();
  /** 새로 내려받은 건수 (예산 대상) */
  let filingDocFetches = 0;
  /** 캐시에 이미 있어 콜 없이 읽은 건수 */
  let filingDocCachedReads = 0;
  let filingDocBudgetHits = 0;
  /** 시간 예산으로 열지 못한 원문 수 (건수 예산 초과와 구분한다 — 대응이 다르다) */
  let filingDocDeadlineHits = 0;
  async function readFilingDoc(rceptNo: string): Promise<FilingDocRead> {
    const cached = filingDocReads.get(rceptNo);
    if (cached) return cached;
    let result: FilingDocRead;
    // ★ 캐시 여부를 **읽기 전에** 확인한다 — 읽고 나면 전부 캐시가 되어 구분이 사라진다.
    const inCache = deps.isDocCached(rceptNo);
    if (filingDocFetches + filingDocCachedReads >= MAX_FILING_DOC_READS_TOTAL) {
      filingDocBudgetHits++;
      result = { read: 'budget_exceeded' };
    } else if (!inCache && filingDocFetches >= MAX_FILING_DOC_FETCHES) {
      filingDocBudgetHits++;
      result = { read: 'budget_exceeded' };
    } else if (budget.isExpired() || (!inCache && !budget.canAfford(MIN_SMALL_CALL_MS))) {
      // 시간 예산 — 캐시 히트도 파싱 CPU 를 쓰므로 **완전히 소진되면** 캐시 건도 멈춘다.
      // 아직 남아 있으면 캐시 건은 통과시킨다 (콜이 없어 60초 벽과 사실상 무관하다).
      filingDocDeadlineHits++;
      budget.markStopped('judge');
      result = { read: 'deadline_exceeded' };
    } else {
      if (inCache) filingDocCachedReads++;
      else filingDocFetches++;
      try {
        const doc = await deps.loadDoc(rceptNo);
        result = {
          read: 'ok',
          facts: parseFilingCounterparties(doc.markdown),
          acode: doc.meta.acode,
        };
      } catch (err) {
        result = { read: 'error', error: err instanceof Error ? err.message : String(err) };
      }
    }
    filingDocReads.set(rceptNo, result);
    return result;
  }
  let ambiguousResolvedToExists = 0;
  /** 보고서명 경로의 상대방 대조 결과 — 판정 단위 (한 공시가 여러 판정에 걸릴 수 있다) */
  let typedConfirmed = 0;
  let typedUnconfirmed = 0;
  let typedUnread = 0;

  /** 원문을 읽은 접수번호의 상대방이 이 거래 상대방과 정규화 일치하는가 (못 읽었으면 false) */
  function docCoversCounterparty(rceptNo: string, counterpartyKey: string): boolean {
    const rd = filingDocReads.get(rceptNo);
    return (
      rd?.read === 'ok' && rd.facts.counterparties.some((c) => normalizeCompanyName(c) === counterpartyKey)
    );
  }

  /** 원문을 읽어 상대방을 실제로 대조했는가 (읽기 실패·예산 초과·상대방 필드 없음 = false) */
  function docComparable(rceptNo: string): boolean {
    const rd = filingDocReads.get(rceptNo);
    return rd?.read === 'ok' && rd.facts.counterparties.length > 0;
  }

  /** 대조 못 한 사유를 FilingRef.doc_read 와 **같은 어휘**로 (사유가 어휘로 갈리는 것이 핵심이다) */
  function docReadLabel(rceptNo: string): FilingRef['doc_read'] {
    const rd = filingDocReads.get(rceptNo);
    if (!rd) return 'budget_exceeded';
    if (rd.read === 'ok') return rd.facts.counterparties.length > 0 ? 'ok' : 'no_counterparty_field';
    return rd.read;
  }

  /**
   * 공시 한 건을 FilingRef 로 — 원문 대조 결과를 함께 싣는다.
   *
   * `mode: 'ambiguous'` 는 보고서명으로 유형을 모르는 공시라 **상대방 + 거래대상 분류**가 모두
   * 맞아야 covers_this_transaction 이 되고, `mode: 'typed'` 는 유형이 이미 보고서명으로 확정돼
   * 있어 **상대방**만 본다 (거래대상 분류는 참고 표시로만 싣는다).
   */
  function toFilingRefWithDoc(
    d: Disclosure,
    counterpartyKey: string,
    expectedClass: Exclude<AmbiguousSubjectClass, 'unknown'>,
    mode: 'ambiguous' | 'typed',
  ): FilingRef {
    const ref = toFilingRef(d);
    const rd = filingDocReads.get(d.rcept_no);
    if (!rd) return ref;
    if (rd.read === 'ok') {
      const cps = rd.facts.counterparties;
      ref.doc_read = cps.length > 0 ? 'ok' : 'no_counterparty_field';
      ref.doc_counterparties = cps;
      ref.doc_subjects = rd.facts.subjects;
      if (rd.facts.amount_text !== undefined) ref.doc_amount_text = rd.facts.amount_text;
      ref.doc_acode = rd.acode;
      if (rd.facts.superseded_counterparties?.length) {
        ref.doc_superseded_counterparties = rd.facts.superseded_counterparties;
      }
      ref.covers_this_counterparty = cps.some((c) => normalizeCompanyName(c) === counterpartyKey);
      ref.doc_subject_class = classifyAmbiguousSubject(rd.facts.subjects);
      ref.covers_this_transaction =
        mode === 'typed'
          ? ref.covers_this_counterparty
          : ref.covers_this_counterparty && ref.doc_subject_class === expectedClass;
    } else if (rd.read === 'error') {
      ref.doc_read = 'error';
      ref.doc_error = rd.error;
    } else {
      ref.doc_read = rd.read; // budget_exceeded | deadline_exceeded
    }
    return ref;
  }

  // ── ⑦ 상태 확정 ──
  // 같은 회사를 거래 여러 건이 공유하므로 접수번호로 중복 없이 센다
  const cancelledMatchingSeen = new Set<string>();
  interface CompanyCheck {
    outcome: 'exists' | 'none' | 'not_judged';
    reason?: string;
    corp_code?: string;
    j001_search?: { from: string; to: string; type_filter: string };
    matching?: Disclosure[];
    others?: Disclosure[];
    search_partial?: boolean;
    cancelled_of_type?: number;
    /** 이름만으로 유형을 알 수 없어 판정을 보류시킨 공시 (isTypeAmbiguousReport) */
    type_ambiguous?: Disclosure[];
    /** 유형 미상 공시의 원문 상대방이 이 거래 상대방과 일치해 exists 로 올렸다 */
    resolved_by_document?: true;
    /** matching 의 원문 거래상대방까지 이 거래 상대방과 일치함을 확인했다 */
    counterparty_confirmed?: true;
    /** 창 안의 같은 유형 매칭 공시 **총수** (matching 은 근거로 삼은 것만 담는다) */
    matching_total?: number;
    /** 확인이 먼저 끝나(또는 예산이 소진돼) **열지 않은** 매칭 공시 수 — 불일치가 아니다 */
    matching_not_examined?: number;
    /** 같은 유형·같은 창이지만 원문 상대방이 달랐던 공시 */
    matching_unconfirmed?: Disclosure[];
    /** 같은 유형·같은 창인데 원문을 읽지 못해(오류·예산·상대방 필드 없음) 대조 못 한 공시 */
    matching_unread?: Disclosure[];
  }
  async function checkCompany(
    key: string,
    typeFilter: (nm: string) => boolean,
    typeLabel: string,
    /** 이 거래의 상대방 원문 이름 — 공시 원문의 거래상대방과 대조한다 */
    counterparty: string,
    /**
     * 건별 근접 대조를 하는 판정(차입·대여)의 **거래일**. 주면 매칭 공시를 이 날짜에 가까운
     * 순으로 열어, 조기 종료로 먼저 확인된 한 건이 곧 **최근접 확인 공시**가 되게 한다.
     * 최신순으로 열면 더 가까운 공시를 두고 먼 공시를 근거로 삼아 near_date 판정이 뒤집힌다.
     */
    nearDate?: string,
  ): Promise<CompanyCheck> {
    const counterpartyKey = normalizeCompanyName(counterparty);
    if (overBudgetKeys.has(key)) {
      return {
        outcome: 'not_judged',
        reason:
          `company_budget_exceeded — J001 검색 대상이 ${ranked.length}개사여서 이번 호출에서는 ` +
          `금액 상위 ${MAX_COMPANIES_TO_SEARCH}개사만 새로 대조했습니다. ` +
          '★ **continuation.token 을 같은 인자에 넣어 다시 호출하면 이 회사부터 이어서 봅니다** — ' +
          'complete:true 가 나올 때까지 반복하면 이 회사도 판정됩니다',
      };
    }
    if (joinFailedKeys.has(key)) {
      return {
        outcome: 'not_judged',
        reason:
          'join_failed — 회사명을 DART corp_code 로 잇지 못해 J001 을 조회할 수 없었습니다 ' +
          '(join_failures 참조). resolve_entity 로 corp_code 를 확인하세요',
      };
    }
    // ★ 시간 예산이 끊겨 **검색을 시작조차 못 한** 회사 — "공시 없음"이 아니라 확인 못 한 것이다.
    //   (건수 예산 초과인 company_budget_exceeded 와 사유를 나눈다: 대응이 다르다.)
    if (deadlineSkippedKeys.has(key)) {
      return {
        outcome: 'not_judged',
        reason:
          `time_budget_exceeded — 이 도구의 시간 예산(${budgetSeconds(budgetMs)}초, MCP 60초 벽 대비)이 ` +
          '소진돼 이 회사의 J001 검색을 시작하지 못했습니다. 금액이 큰 회사부터 대조하므로 ' +
          '남은 회사입니다 — ★ **continuation.token 을 같은 인자에 넣어 다시 호출하면 이 회사부터 ' +
          '이어서 검색합니다**(앞 호출이 받아 둔 목록은 다시 받지 않으므로 예산이 이 회사에 ' +
          '쓰입니다). complete:true 가 나올 때까지 반복하면 이 회사도 판정됩니다. ' +
          '급하면 이 회사만 따로 search_disclosures(pblntf_detail_ty:"J001") 로 확인하세요',
      };
    }
    const s = searches.get(key);
    if (!s) {
      return { outcome: 'not_judged', reason: 'internal — 검색 대상에 오르지 않았습니다' };
    }
    if (s.error) {
      return {
        outcome: 'not_judged',
        corp_code: s.corp_code,
        reason: `list_error — J001 목록 조회 실패: ${s.error}`,
      };
    }
    const matching = s.rows.filter(
      (r) => typeFilter(r.report_nm) && !isCancellationReport(r.report_nm),
    );
    const cancelsOfType = s.rows.filter(
      (r) => typeFilter(r.report_nm) && isCancellationReport(r.report_nm),
    );
    for (const r of cancelsOfType) cancelledMatchingSeen.add(r.rcept_no);
    const others = s.rows.filter((r) => !typeFilter(r.report_nm) || isCancellationReport(r.report_nm));
    const common = {
      corp_code: s.corp_code,
      j001_search: { from: s.from, to: s.to, type_filter: typeLabel },
      ...(s.partial ? { search_partial: true } : {}),
      ...(cancelsOfType.length ? { cancelled_of_type: cancelsOfType.length } : {}),
    };
    // ── 유형 미상 J001 원문 대조 (지연 실행) ───────────────────────────────────
    // 보고서명 경로가 상대방을 확인하지 못했을 때도 **이어서** 본다 — 같은 창에 무관한 유형
    // 공시가 한 건 있다는 이유로, 이 거래를 실제로 덮는 `특수관계인과의내부거래` 공시를 못 보고
    // 보류로 끝나면 안 된다 (팀 리드 수정 3).
    const ambiguous = s.rows.filter(
      (r) => isTypeAmbiguousReport(r.report_nm) && !isCancellationReport(r.report_nm),
    );
    const expected = expectedSubjectClass(typeLabel);
    /** 유형 미상 공시를 최신 접수순으로 한 건씩 열어 **커버하는 한 건**을 찾으면 멈춘다 */
    async function scanAmbiguous(): Promise<{
      examined: Disclosure[];
      covering: Disclosure | undefined;
      notExamined: number;
      detail: string;
    }> {
      const byDateDesc = [...ambiguous].sort((a, b) => (a.rcept_dt < b.rcept_dt ? 1 : -1));
      const examined: Disclosure[] = [];
      let covering: Disclosure | undefined;
      let stoppedByBudget = false;
      let stoppedByDeadline = false;
      for (const r of byDateDesc) {
        const rd = await readFilingDoc(r.rcept_no);
        examined.push(r);
        if (rd.read === 'budget_exceeded' || rd.read === 'deadline_exceeded') {
          if (rd.read === 'deadline_exceeded') stoppedByDeadline = true;
          else stoppedByBudget = true;
          break;
        }
        // ★ 상대방 일치만으로는 부족하다 — 같은 쌍의 **다른 유형** 공시가 이 거래를 덮어 버린다
        //   (Codex 검토 ①). 원문 거래대상이 이 판정 유형으로 분류될 때만 "공시 존재".
        if (
          docCoversCounterparty(r.rcept_no, counterpartyKey) &&
          rd.read === 'ok' &&
          classifyAmbiguousSubject(rd.facts.subjects) === expected
        ) {
          covering = r;
          break;
        }
      }
      const notExamined = ambiguous.length - examined.length;
      if (covering) return { examined, covering, notExamined, detail: '' };
      const cpMatched = examined.filter((r) => docCoversCounterparty(r.rcept_no, counterpartyKey));
      const readable = examined.filter((r) => docComparable(r.rcept_no));
      const docCps = [
        ...new Set(
          readable.flatMap((r) => {
            const rd = filingDocReads.get(r.rcept_no);
            return rd?.read === 'ok' ? rd.facts.counterparties : [];
          }),
        ),
      ];
      const cpOnly = cpMatched.map((r) => {
        const rd = filingDocReads.get(r.rcept_no);
        const subj = rd?.read === 'ok' ? rd.facts.subjects.join('/') : '';
        const cls = rd?.read === 'ok' ? classifyAmbiguousSubject(rd.facts.subjects) : '?';
        return `${r.rcept_no}(거래대상 '${subj}' → ${cls})`;
      });
      const tail = stoppedByDeadline
        ? ` 시간 예산(${budgetSeconds(budgetMs)}초, 60초 벽 대비)이 소진돼 ${notExamined + 1}건은 ` +
          '열지 못했습니다 — 원문은 캐시에 남으므로 같은 문서로 이 도구를 다시 실행하면 나머지를 ' +
          '이어서 대조합니다'
        : stoppedByBudget
        ? ` 원문 열기 예산이 소진돼 ${notExamined + 1}건은 열지 못했습니다 — 원문은 캐시에 남으므로 ` +
          '같은 문서로 이 도구를 다시 실행하면 나머지를 이어서 대조합니다'
        : notExamined > 0
        ? ` (나머지 ${notExamined}건은 열지 않았습니다)`
        : '';
      const detail =
        (cpMatched.length > 0
          ? `원문 상대방은 이 거래 상대방과 일치하지만 거래대상이 이 유형(${typeLabel}, ` +
            `${expected})으로 분류되지 않았습니다: ${cpOnly.join(', ')}. 같은 회사 쌍의 다른 유형 ` +
            '거래 공시일 수 있어 "공시 존재"로 올리지 않았습니다 — doc_subjects 를 이 거래와 직접 대조하세요'
          : readable.length === ambiguous.length
          ? `원문을 전부 열어 거래상대방을 읽었으나(${docCps.join(' / ')}) 이 거래의 상대방 ` +
            `'${counterparty}' 과 정규화 일치하는 공시는 없었습니다. 표기 차이(예: 제9호 ↔ 제구호)일 수 ` +
            '있어 "공시 없음"으로 내리지 않고 보류를 유지합니다 — doc_counterparties 를 이 거래 ' +
            '상대방과 직접 대조하세요'
          : `원문 ${readable.length}/${ambiguous.length}건에서 거래상대방을 읽었고` +
            (docCps.length ? `(${docCps.join(' / ')}) ` : ' ') +
            '일치하는 공시는 없었습니다. 나머지는 열지 못했거나(doc_read 참조) 상대방 필드가 없어 ' +
            '대조하지 못했습니다 — 그 건을 read_disclosure 로 직접 확인하세요') + tail;
      return { examined, covering: undefined, notExamined, detail };
    }
    /** 유형 미상 경로가 "공시 존재"를 만들었을 때의 CompanyCheck */
    function ambiguousExists(covering: Disclosure): CompanyCheck {
      ambiguousResolvedToExists++;
      return {
        ...common,
        outcome: 'exists',
        matching: [covering],
        matching_total: ambiguous.length,
        others,
        type_ambiguous: ambiguous,
        resolved_by_document: true,
      };
    }

    if (matching.length > 0) {
      // 취소 접수분이 매칭 공시 수 이상이면 남은 매칭 공시 전부가 취소된 원공시일 수 있다 —
      // 목록만으로는 취소↔원공시를 연결할 수 없으므로 "공시 존재"로 단정하지 않는다 (Codex 4차 M2)
      if (cancelsOfType.length >= matching.length) {
        return {
          ...common,
          outcome: 'not_judged',
          reason:
            `filing_cancelled_status_unknown — 같은 유형 '[공시취소]' 접수분(${cancelsOfType.length}건)이 ` +
            `매칭 공시(${matching.length}건) 수 이상입니다. 매칭 공시가 취소된 원공시일 수 있어 ` +
            '"공시 존재"로 판정하지 않습니다 — matching_filings 와 취소 접수분을 열어 대조하세요',
          matching,
          others,
        };
      }
      // ★ 회사 + 유형 + 검색창만으로 "공시 존재"라 하면 **같은 유형의 다른 상대방 공시**가 이
      //   거래를 확인해 준 것처럼 보인다 (Codex 검토 P0 — 거짓 안심). 유형 미상 경로와 같은
      //   장치로 **원문 거래상대방**까지 대조한다. 보고서명 경로는 유형이 이미 이름으로 확정돼
      //   있으므로 거래대상 분류는 요구하지 않는다 (상대방만).
      //
      // ★ **한 건씩 열고 확인되는 즉시 멈춘다** (팀 리드 수정 1). 실물에서 유가증권 유형은 한
      //   회사에 76·95건씩 매칭돼 전부 여는 설계는 성립하지 않았다(예산 30 대비 필요 305건).
      //   열지 않은 나머지는 **불일치가 아니라 '읽지 않음'**이라 unconfirmed 에 넣지 않고
      //   건수만 남긴다.
      // ★ 정렬 기준: 근접 대조를 하는 판정(차입·대여)은 **거래일에 가까운 순**으로 연다. 최신순으로
      //   열면 먼저 확인된 한 건이 최근접 공시가 아닐 수 있어 near_date 판정이 뒤집힌다.
      const ordered = [...matching].sort((a, b) => {
        if (nearDate) {
          const da = Math.abs(daysBetween(a.rcept_dt, nearDate));
          const db = Math.abs(daysBetween(b.rcept_dt, nearDate));
          if (da !== db) return da - db;
        }
        return a.rcept_dt < b.rcept_dt ? 1 : -1;
      });
      const examined: Disclosure[] = [];
      let confirmed: Disclosure | undefined;
      let stoppedByBudget = false;
      let stoppedByDeadline = false;
      for (const r of ordered) {
        const rd = await readFilingDoc(r.rcept_no);
        examined.push(r);
        if (rd.read === 'budget_exceeded' || rd.read === 'deadline_exceeded') {
          if (rd.read === 'deadline_exceeded') stoppedByDeadline = true;
          else stoppedByBudget = true;
          break;
        }
        if (docCoversCounterparty(r.rcept_no, counterpartyKey)) {
          confirmed = r;
          break;
        }
      }
      const notExamined = matching.length - examined.length;
      // 확인 전에 열어 보고 **실제로 상대방이 달랐던** 건은 그대로 보여 준다 (열지 않은 건과 다르다)
      const unconfirmedBefore = examined.filter(
        (r) => r !== confirmed && !docCoversCounterparty(r.rcept_no, counterpartyKey),
      );
      if (confirmed) {
        typedConfirmed++;
        return {
          ...common,
          outcome: 'exists',
          // ★ 근접 대조(차입일 ± 창)도 **확인된 공시만으로** 한다 — 다른 상대방 공시의 접수일이
          //   가깝다는 이유로 j001_filing_near_date 가 되면 안 된다. 거래일 근접순으로 열었으므로
          //   먼저 확인된 이 한 건이 곧 최근접 확인 공시다.
          matching: [confirmed],
          matching_total: matching.length,
          ...(notExamined > 0 ? { matching_not_examined: notExamined } : {}),
          ...(unconfirmedBefore.length ? { matching_unconfirmed: unconfirmedBefore } : {}),
          others,
          counterparty_confirmed: true,
        };
      }
      // ★ 확인된 공시가 하나도 없다 — 그렇다고 "공시 없음 → 후보"로 내리지 않는다.
      //   실측 반례: 원문 '미래에셋파트너스제9호' vs J004 '미래에셋 파트너스 제구호' (같은 법인인데
      //   정규화로 못 잇는다). 양쪽 다 확정할 수 없으므로 **보류**한다.
      //   ★ 단, 보류로 끝내기 전에 **유형 미상 경로를 이어서 본다** — 그쪽이 이 거래를 덮을 수 있다.
      const amb = ambiguous.length > 0 ? await scanAmbiguous() : null;
      if (amb?.covering) return ambiguousExists(amb.covering);

      const unconfirmed = examined.filter(
        (r) => !docCoversCounterparty(r.rcept_no, counterpartyKey) && docComparable(r.rcept_no),
      );
      const unread = examined.filter((r) => !docComparable(r.rcept_no));
      if (unread.length > 0) typedUnread++;
      else typedUnconfirmed++;
      const docCps = [
        ...new Set(
          unconfirmed.flatMap((r) => {
            const rd = filingDocReads.get(r.rcept_no);
            return rd?.read === 'ok' ? rd.facts.counterparties : [];
          }),
        ),
      ];
      const unreadDetail = unread.length
        ? ` 그중 ${unread.length}건은 원문을 대조하지 못했습니다(matching_filings 의 doc_read: ` +
          `${[...new Set(unread.map((r) => docReadLabel(r.rcept_no)))].join('/')}) — ` +
          'read_disclosure 로 직접 열어 확인하세요.'
        : '';
      const budgetDetail = stoppedByDeadline
        ? ` 시간 예산(${budgetSeconds(budgetMs)}초, 60초 벽 대비)이 소진돼 ${notExamined + 1}건은 ` +
          '열지 못했습니다 — 원문은 캐시에 남으므로 같은 문서로 이 도구를 다시 실행하면 나머지를 ' +
          '이어서 대조합니다.'
        : stoppedByBudget
        ? ` 원문 열기 예산이 소진돼 ${notExamined + 1}건은 열지 못했습니다 — 원문은 캐시에 남으므로 ` +
          '같은 문서로 이 도구를 다시 실행하면 나머지를 이어서 대조합니다.'
        : notExamined > 0
        ? ` (매칭 ${matching.length}건 중 ${examined.length}건까지 열었습니다.)`
        : '';
      const ambDetail = amb
        ? ` 보고서명으로 유형을 알 수 없는 공시 ${ambiguous.length}건도 이어서 대조했으나 이 거래를 ` +
          `커버하지 않았습니다: ${amb.detail}`
        : '';
      return {
        ...common,
        outcome: 'not_judged',
        reason:
          `type_filing_present_counterparty_unconfirmed — 이 유형(${typeLabel}) 공시 ` +
          `${matching.length}건이 창 안에 있으나 원문 거래상대방` +
          (docCps.length ? `(${docCps.join(' / ')})` : '(목록)') +
          `이 이 거래 상대방 '${counterparty}' 과 일치하지 않습니다. 같은 유형의 **다른 상대방** ` +
          '거래 공시일 수 있어 공시 존재로 보지 않고, 표기 차이일 수 있어 공시 없음으로도 내리지 ' +
          '않습니다 — matching_filings 의 doc_counterparties 를 대조하세요.' +
          unreadDetail +
          budgetDetail +
          ambDetail,
        matching: examined,
        matching_total: matching.length,
        ...(notExamined > 0 ? { matching_not_examined: notExamined } : {}),
        others,
        ...(unconfirmed.length ? { matching_unconfirmed: unconfirmed } : {}),
        ...(unread.length ? { matching_unread: unread } : {}),
        ...(amb ? { type_ambiguous: ambiguous } : {}),
      };
    }
    // ★ 이름만으로 유형을 알 수 없는 공시가 창 안에 있으면 "공시 없음"이라 할 수 없다.
    //   실측: '특수관계인과의내부거래'(출자를 이 이름으로 공시한 실물 있음)·'약관에의한금융거래시
    //   계열금융회사의거래상대방의공시'(차입 415억을 이 이름으로 공시한 실물 있음).
    //   "공시 존재"로 삼으면 거짓 안심이므로 후보를 만들지 않고 **판정을 보류**한다.
    if (ambiguous.length > 0) {
      // ★ 원문 상대방 대조 — 커버하는 공시가 하나라도 있으면 "공시 존재" (유형 대조보다 강한 근거:
      //   같은 회사가 **같은 상대방**과의 거래를 창 안에 공시했다). 최신 접수분부터 한 건씩 연다.
      const amb = await scanAmbiguous();
      if (amb.covering) return ambiguousExists(amb.covering);
      return {
        ...common,
        outcome: 'not_judged',
        reason:
          `type_ambiguous_filing_present — 이 유형(${typeLabel})의 J001 공시는 창 안에 없지만, ` +
          `**보고서명만으로 거래유형을 알 수 없는** 공시가 ${ambiguous.length}건 있습니다 ` +
          `(${[...new Set(ambiguous.map((r) => normalizeReportNm(r.report_nm)))].join(', ')}). ` +
          '실측상 이 서식들에는 출자·차입·브랜드 사용료 같은 실제 유형이 담깁니다 — 이 거래를 ' +
          `커버할 수 있으므로 미공시 후보로 올리지 않았습니다. ${amb.detail} ` +
          '("공시 있음"으로 확인한 것이 아닙니다)',
        type_ambiguous: ambiguous,
        others,
      };
    }
    // 수집이 불완전한데 "공시 없음"이면 수집 누락일 수 있다 — 후보로 단정하지 않는다 (교차검토 M-7)
    if (s.partial) {
      return {
        ...common,
        outcome: 'not_judged',
        reason:
          'list_incomplete — 이 회사의 J001 수집이 불완전(절단·부분결과)해 "공시 없음"을 ' +
          '판정할 수 없습니다. 수집 범위를 좁혀 다시 확인하세요',
        others,
      };
    }
    return { ...common, outcome: 'none', others };
  }

  /** 존재/부재 공통 필드를 대상 객체에 옮겨 담는다 */
  function applyCommon(
    target:
      | JudgedBorrowing
      | GoodsSignal
      | GoodsMatrixSignal
      | SecuritySignal
      | LenderSide
      | CounterpartySide,
    chk: CompanyCheck,
    counterparty: string,
    typeLabel: string,
  ): void {
    const key = normalizeCompanyName(counterparty);
    const expected = expectedSubjectClass(typeLabel);
    if (chk.corp_code) target.corp_code = chk.corp_code;
    if (chk.j001_search) target.j001_search = chk.j001_search;
    if (chk.search_partial) target.search_partial = true;
    if (chk.cancelled_of_type) target.cancellations_of_type_in_window = chk.cancelled_of_type;
    if (chk.others) target.other_j001_in_window = chk.others.length;
    // 매칭 공시는 **원문 대조 결과와 함께** 낸다 — doc_counterparties 가 사용자가 직접 대조할
    // 유일한 근거다. 유형 미상 경로로 풀린 건은 거래대상 분류까지 본 것이라 어휘를 구분한다.
    if (chk.matching && chk.matching.length > 0) {
      const mode = chk.resolved_by_document ? 'ambiguous' : 'typed';
      target.matching_filings = chk.matching
        .slice(0, 10)
        .map((d) => toFilingRefWithDoc(d, key, expected, mode));
      // 창 안의 같은 유형 공시 **총수** — matching_filings 는 근거로 삼은 것만 담으므로
      // (조기 종료 시 1건) 총수를 따로 밝히지 않으면 "1건뿐"으로 읽힌다.
      const total = chk.matching_total ?? chk.matching.length;
      if (total > target.matching_filings.length) target.matching_filings_total = total;
    }
    if (chk.matching_not_examined) {
      target.matching_filings_not_examined_total = chk.matching_not_examined;
    }
    if (chk.counterparty_confirmed) target.counterparty_confirmed_by_document = true;
    // ★ 확인되지 않은 매칭 공시는 **버리지 않고 표시한다** — "이 거래의 공시가 아니다"가 아니라
    //   "이 거래의 공시로 확인되지 않았다"는 뜻이고, 표기 차이면 사람이 즉시 뒤집을 수 있다.
    const unconfirmed = [...(chk.matching_unconfirmed ?? []), ...(chk.matching_unread ?? [])];
    if (unconfirmed.length > 0) {
      target.matching_filings_unconfirmed = unconfirmed
        .slice(0, 5)
        .map((d) => toFilingRefWithDoc(d, key, expected, 'typed'));
    }
    if (chk.type_ambiguous && chk.type_ambiguous.length > 0) {
      // 일치한 공시를 앞에 두어 5건 절단에 잘리지 않게 한다
      const ordered = [...chk.type_ambiguous].sort((a, b) => {
        const ca = chk.matching?.includes(a) ? 0 : 1;
        const cb = chk.matching?.includes(b) ? 0 : 1;
        return ca - cb;
      });
      target.type_ambiguous_filings = ordered
        .slice(0, 5)
        .map((d) => toFilingRefWithDoc(d, key, expected, 'ambiguous'));
      if (chk.resolved_by_document) target.type_ambiguous_resolved_by_document = true;
    }
  }

  // 여기부터 상태 확정 구간 — 남은 상류 비용은 J001 **원문 열기**뿐이다 (검색은 끝났다).
  budget.enter('judge');

  for (const b of judgedBorrowings) {
    if (b.status !== 'not_judged' || b.reason) continue; // over 만 남아 있다
    const chk = await checkCompany(
      normalizeCompanyName(b.company),
      isBorrowingReport,
      '자금차입',
      b.counterparty,
      b.date ?? undefined,
    );
    applyCommon(b, chk, b.counterparty, '자금차입');
    if (chk.outcome === 'not_judged') {
      b.status = 'not_judged';
      b.reason = chk.reason!;
      continue;
    }
    if (chk.outcome === 'none') {
      b.status = 'undisclosed_candidate';
      if (chk.others && chk.others.length > 0) {
        b.other_j001_sample = chk.others.slice(0, 5).map(toFilingRef);
      }
      continue;
    }
    // exists — 건별 차입일 근접도로 가른다 (교차검토 C-1)
    const matching = chk.matching!;
    if (!b.date) {
      b.status = 'j001_filing_in_window_only';
      b.reason =
        'transaction_date_unknown — 차입일을 읽지 못해 건별 근접 대조를 할 수 없었습니다. ' +
        '창 안에 같은 유형 공시가 존재한다는 것까지만 확인됐습니다';
      continue;
    }
    const gaps = matching.map((f) => daysBetween(f.rcept_dt, b.date!));
    const nearest = gaps.reduce((a, g) => (Math.abs(g) < Math.abs(a) ? g : a));
    b.nearest_filing_gap_days = nearest;
    const near = gaps.some((g) => g >= -NEAR_BEFORE_DAYS && g <= NEAR_AFTER_DAYS);
    if (near) {
      b.status = 'j001_filing_near_date';
    } else {
      b.status = 'j001_filing_in_window_only';
      b.reason =
        `filing_far_from_date — 창 안에 같은 유형 공시는 있으나 차입일 근방(−${NEAR_BEFORE_DAYS}~` +
        `+${NEAR_AFTER_DAYS}일)에는 없습니다 (최근접 ${nearest}일). 연초 한도 의결이 커버하는 정상 ` +
        '케이스일 수도, **이 건만 공시가 누락된 부분 공시**일 수도 있습니다 — matching_filings 를 ' +
        '열어 이 거래가 실제로 포함되는지 확인하세요';
    }
  }

  // ⑦-b. 대여회사 쪽 상태 확정 — 차입회사와 **같은 함수·같은 창·같은 근접 규칙**을 쓰고
  //       보고서명 필터만 '자금대여' 계열로 바꾼다.
  for (const b of judgedBorrowings) {
    const side = b.lender_side;
    if (!side || side.status !== 'not_judged' || side.reason) continue; // 기준 초과 건만
    const chk = await checkCompany(
      normalizeCompanyName(side.company),
      isLendingReport,
      '자금대여',
      b.company,
      b.date ?? undefined,
    );
    applyCommon(side, chk, b.company, '자금대여');
    if (chk.outcome === 'not_judged') {
      side.reason = chk.reason!;
      continue;
    }
    if (chk.outcome === 'none') {
      side.status = 'undisclosed_candidate';
      side.reason =
        'j001_lending_absent — 대여회사의 창 안에 "특수관계인에 대한 자금대여" 유형 J001 공시가 ' +
        '없습니다. 대여회사에도 별도의 공시의무가 있으므로 미공시 후보입니다 — 다만 차입회사 쪽과 ' +
        '같은 구조적 한계(한도 의결·약관특례·유형 분류)가 그대로 적용됩니다';
      continue;
    }
    const matching = chk.matching!;
    if (!b.date) {
      side.status = 'j001_filing_in_window_only';
      side.reason =
        'transaction_date_unknown — 거래일을 읽지 못해 건별 근접 대조를 할 수 없었습니다. ' +
        '창 안에 자금대여 공시가 존재한다는 것까지만 확인됐습니다';
      continue;
    }
    const gaps = matching.map((f) => daysBetween(f.rcept_dt, b.date!));
    const nearest = gaps.reduce((a, g) => (Math.abs(g) < Math.abs(a) ? g : a));
    side.nearest_filing_gap_days = nearest;
    if (gaps.some((g) => g >= -NEAR_BEFORE_DAYS && g <= NEAR_AFTER_DAYS)) {
      side.status = 'j001_filing_near_date';
    } else {
      side.status = 'j001_filing_in_window_only';
      side.reason =
        `filing_far_from_date — 창 안에 자금대여 공시는 있으나 거래일 근방(−${NEAR_BEFORE_DAYS}~` +
        `+${NEAR_AFTER_DAYS}일)에는 없습니다 (최근접 ${nearest}일) — matching_filings 를 열어 ` +
        '이 거래가 실제로 포함되는지 확인하세요';
    }
  }

  for (const g of signalGoods) {
    // 상품·용역 공시의무는 상대방 요건(동일인·친족 20%↑ 출자 계열사 등)이 전제인데
    // 이 도구는 지분 데이터가 없어 확인하지 못한다 — 모든 신호에 미확인을 명시 (Codex 4차 C1)
    g.counterparty_qualification = 'not_verified';
    const chk = await checkCompany(
      normalizeCompanyName(g.company),
      isGoodsServicesReport,
      '상품·용역',
      g.counterparty,
    );
    applyCommon(g, chk, g.counterparty, '상품·용역');
    if (chk.outcome === 'not_judged') {
      g.status = 'not_judged';
      g.reason = chk.reason!;
      continue;
    }
    if (chk.outcome === 'none') {
      // "미공시 후보"가 아니라 **요건 충족 시 후보** — 요건 미충족 상대방과의 거래는 애초에
      // 공시대상이 아니므로(법 §26①4호 한정) 후보 단정은 오경보다
      g.status = 'candidate_if_counterparty_qualified';
      g.reason =
        'j001_absent_but_qualification_unknown — 이 유형의 J001 공시는 창 안에 없으나, ' +
        '상대방이 동일인(자연인)·친족 합계 20% 이상 출자 계열회사(또는 그 자회사)인지 확인하지 ' +
        '못했습니다. 요건을 충족하는 상대방일 때만 미공시 후보입니다 — 지분 구조를 먼저 확인하세요';
      continue;
    }
    g.status = 'j001_filing_exists';
  }

  // (5) 총괄 보완 신호 — (6) 경로와 **같은 유형 필터·같은 창**을 쓰고, 후보 어휘만
  // 비둘기집 성립 여부로 가른다.
  for (const m of signalGoodsMatrix) {
    // 상대방 요건(동일인·친족 20%↑ 출자) 미확인 한계는 (6)과 똑같이 적용된다
    m.counterparty_qualification = 'not_verified';
    const chk = await checkCompany(
      normalizeCompanyName(m.company),
      isGoodsServicesReport,
      '상품·용역',
      m.counterparty,
    );
    applyCommon(m, chk, m.counterparty, '상품·용역');
    if (chk.outcome === 'not_judged') {
      m.status = 'not_judged';
      m.reason = chk.reason!;
      continue;
    }
    if (chk.outcome === 'none') {
      if (m.quarterly_logic === 'annual_geq_4x_threshold') {
        // 비둘기집이 선다 — (6) 경로와 같은 강도·같은 어휘의 조건부 후보
        m.status = 'candidate_if_counterparty_qualified';
        m.reason =
          'j001_absent_but_qualification_unknown — 연간 총액이 4×기준금액 이상이라 어느 분기 ' +
          '하나는 반드시 기준금액 이상인데(비둘기집) 창 안에 상품·용역 유형 J001 공시가 ' +
          '없습니다. 다만 상대방이 동일인(자연인)·친족 합계 20% 이상 출자 계열회사(또는 그 ' +
          '자회사)인지 확인하지 못했습니다 — 요건을 충족하는 상대방일 때만 미공시 후보입니다';
      } else {
        // ★ 총액만 넘었다 — 분기로 쪼개면 전부 미달일 수 있어 후보로 단정하지 않는다
        m.status = 'candidate_aggregate_only';
        m.reason =
          'j001_absent_for_annual_total — 이 상대방과의 연간 총액은 기준금액 이상인데 창 안에 ' +
          '상품·용역 유형 J001 공시가 없습니다. 다만 기준금액 판단 단위는 **분기 합계액**이고 ' +
          '연간 총액이 4×기준금액 미만이라, 네 분기로 나누면 전부 기준 미만일 수 있습니다 — ' +
          '이것만으로 미공시로 볼 수 없습니다. 분기별 거래액을 확인하세요';
      }
      continue;
    }
    m.status = 'j001_filing_exists';
  }

  for (const sec of signalSecurities) {
    const chk = await checkCompany(
      normalizeCompanyName(sec.company),
      isSecuritiesReport,
      '유가증권',
      sec.counterparty,
    );
    applyCommon(sec, chk, sec.counterparty, '유가증권');
    if (chk.outcome === 'not_judged') {
      sec.status = 'not_judged';
      sec.reason = chk.reason!;
      continue;
    }
    if (chk.outcome === 'none') {
      // ★ "미공시 후보"라고 부르지 않는다 — 이 신호는 연간 총액뿐이라 개별 거래가 기준을
      //   넘었는지 자체를 모른다. 차입(건별 날짜)·상품용역(비둘기집)보다 한 단계 약하다.
      sec.status = 'candidate_aggregate_only';
      sec.reason =
        'j001_absent_for_annual_total — 이 상대방과의 연간 유가증권 거래 총액은 기준금액 ' +
        '이상인데 창 안에 유가증권 유형 J001 공시가 없습니다. 다만 고시 §4③은 유가증권 거래를 ' +
        '"동일 거래상대방과의 **동일 거래대상**에 대한 거래행위" 기준으로 판단하므로, 연간 ' +
        '총액이 기준 이상이어도 거래대상(종목)별로 나누면 개별 거래가 전부 기준 미만일 수 ' +
        '있습니다 — 이것만으로 미공시로 볼 수 없습니다. 개별 거래 내역을 확인하세요';
      continue;
    }
    sec.status = 'j001_filing_exists';
  }

  // ⑦-c. 상대방 관점 상태 확정 — 판매회사 쪽과 **같은 함수·같은 창·같은 유형 필터**를 쓴다.
  //       날짜가 없는 신호라 존재 확인까지만 하고 근접 대조는 하지 않는다.
  for (const { side, kind, origin } of counterSides) {
    if (side.status !== 'not_judged' || side.reason) continue; // 기준 초과 건만
    const chk = await checkCompany(
      normalizeCompanyName(side.company),
      kind === 'goods' ? isGoodsServicesReport : isSecuritiesReport,
      kind === 'goods' ? '상품·용역' : '유가증권',
      origin,
    );
    applyCommon(side, chk, origin, kind === 'goods' ? '상품·용역' : '유가증권');
    if (chk.outcome === 'not_judged') {
      side.reason = chk.reason!;
      continue;
    }
    if (chk.outcome === 'none') {
      if (kind === 'goods') {
        // 상품·용역은 **상대방 요건**이 전제다 — 이 관점에서 상대방은 원래 신호의 판매회사다
        side.status =
          side.quarterly_logic === 'annual_geq_4x_threshold'
            ? 'candidate_if_counterparty_qualified'
            : 'candidate_aggregate_only';
        side.reason =
          side.quarterly_logic === 'annual_geq_4x_threshold'
            ? 'j001_absent_but_qualification_unknown — 이 회사 기준으로도 연간 총액이 4×기준금액 ' +
              '이상이라 어느 분기 하나는 반드시 기준 이상인데(비둘기집) 창 안에 상품·용역 유형 ' +
              'J001 공시가 없습니다. 다만 이 회사의 의무는 **거래상대방**이 동일인·친족 20% 이상 ' +
              '출자 계열회사일 때만 성립하는데(고시 §4①4호) 지분을 확인하지 못했습니다'
            : 'j001_absent_for_annual_total — 이 회사 기준으로 연간 총액은 기준금액 이상이지만 ' +
              '4×에는 못 미쳐 분기로 나누면 전부 미달일 수 있습니다. 상대방 지분 요건도 확인하지 ' +
              '못했습니다 — 미공시로 볼 수 없는 **확인 대상**입니다';
      } else {
        side.status = 'candidate_aggregate_only';
        side.reason =
          'j001_absent_for_annual_total — 이 회사 기준으로도 연간 유가증권 거래 총액이 기준금액 ' +
          '이상인데 창 안에 유가증권 유형 J001 공시가 없습니다. 다만 고시 §4③은 "동일 거래상대방과의 ' +
          '**동일 거래대상**" 기준이라 종목별로 나누면 개별 거래가 전부 기준 미만일 수 있습니다';
      }
      continue;
    }
    side.status = 'j001_filing_exists';
  }

  // 품목 성격상 제외한 행 — 회사가 이미 검색됐으면 참고 정보만 동봉한다 (추가 콜 없음, S-9)
  for (const row of caveatRows) {
    const s = searches.get(normalizeCompanyName(row.company));
    if (!s || s.error) continue;
    row.related_j001 = {
      goods_type_filings_in_window: s.rows.filter(
        (r) => isGoodsServicesReport(r.report_nm) && !isCancellationReport(r.report_nm),
      ).length,
      from: s.from,
      to: s.to,
    };
  }

  // ── ⑧ 집계·정직성 장치 ──
  budget.enter('aggregate');
  const undisclosed = judgedBorrowings.filter((b) => b.status === 'undisclosed_candidate');
  const nearDate = judgedBorrowings.filter((b) => b.status === 'j001_filing_near_date');
  const windowOnly = judgedBorrowings.filter((b) => b.status === 'j001_filing_in_window_only');
  const below = judgedBorrowings.filter((b) => b.status === 'below_threshold');
  const noDuty = judgedBorrowings.filter((b) => b.status === 'no_duty_before_joining');
  const notJudged = judgedBorrowings.filter((b) => b.status === 'not_judged');
  const goodsCandidates = judgedGoods.filter(
    (g) => g.status === 'candidate_if_counterparty_qualified',
  );
  const goodsFilingExists = judgedGoods.filter((g) => g.status === 'j001_filing_exists');
  // 조인 실패·예산 초과로 J001 대조를 못 한 신호 — 출력에서 빠지면 "후보 아님"으로 읽힌다
  const goodsNotJudged = judgedGoods.filter((g) => g.status === 'not_judged');
  const goodsUnjudgeable = judgedGoods.filter(
    (g) => g.quarterly_logic !== 'annual_geq_4x_threshold',
  );
  const goodsItemCaveats4x = caveatRows.filter(
    (r) => r.quarterly_logic === 'annual_geq_4x_threshold',
  );
  // (5) 총괄 보완 — 비둘기집이 서는 후보와 총액만 넘은 확인 대상을 끝까지 분리해 센다
  const gmCandidates = judgedGoodsMatrix.filter(
    (m) => m.status === 'candidate_if_counterparty_qualified',
  );
  const gmAggregateOnly = judgedGoodsMatrix.filter(
    (m) => m.status === 'candidate_aggregate_only',
  );
  const gmFilingExists = judgedGoodsMatrix.filter((m) => m.status === 'j001_filing_exists');
  const gmNotJudged = judgedGoodsMatrix.filter((m) => m.status === 'not_judged');
  const gmBelow = judgedGoodsMatrix.filter((m) => m.status === 'below_threshold');
  const gmForeign = judgedGoodsMatrix.filter(
    (m) => m.status === 'not_applicable_foreign_affiliate',
  );
  const secForeign = judgedSecurities.filter(
    (sec) => sec.status === 'not_applicable_foreign_affiliate',
  );

  const secCandidates = judgedSecurities.filter(
    (sec) => sec.status === 'candidate_aggregate_only',
  );
  const secFilingExists = judgedSecurities.filter((sec) => sec.status === 'j001_filing_exists');
  const secBelow = judgedSecurities.filter((sec) => sec.status === 'below_threshold');
  const secNotJudged = judgedSecurities.filter((sec) => sec.status === 'not_judged');

  // 대여회사 쪽 집계 — 차입 건 단위다 (한 대여회사가 여러 건에 걸릴 수 있다)
  const lenderSides = judgedBorrowings
    .map((b) => b.lender_side)
    .filter((s): s is LenderSide => s !== undefined);
  const lenderCounts: Record<LenderStatus, number> = {
    undisclosed_candidate: 0,
    j001_filing_near_date: 0,
    j001_filing_in_window_only: 0,
    below_threshold: 0,
    no_duty_before_joining: 0,
    not_judged: 0,
    counterparty_not_joined: 0,
    counterparty_not_company: 0,
  };
  for (const s of lenderSides) lenderCounts[s.status]++;
  const lenderCandidates = lenderSides.filter((s) => s.status === 'undisclosed_candidate');

  // 상대방 관점(상품·용역 매입회사 / 유가증권 매도회사) 집계 — 신호 단위다
  const counterCounts: Record<CounterpartySide['status'], number> = {
    candidate_if_counterparty_qualified: 0,
    candidate_aggregate_only: 0,
    j001_filing_exists: 0,
    below_threshold: 0,
    not_judged: 0,
    counterparty_not_joined: 0,
    counterparty_not_company: 0,
  };
  for (const { side } of counterSides) counterCounts[side.status]++;
  const counterCandidates = counterSides.filter(
    (c) =>
      c.side.status === 'candidate_if_counterparty_qualified' ||
      c.side.status === 'candidate_aggregate_only',
  );

  if (typedUnconfirmed + typedUnread > 0) {
    notes.push(
      `⚠️ 같은 유형·같은 창의 J001 공시가 있는데도 **원문 거래상대방이 이 거래 상대방과 확인되지 ` +
        `않아** 보류한 판정이 ${typedUnconfirmed + typedUnread}건입니다 ` +
        `(불일치 ${typedUnconfirmed} / 원문 대조 실패 ${typedUnread}). 종전에는 이 건들이 ` +
        '"공시 존재"로 나갔습니다 — 그중 상당수는 **표기 차이일 뿐 실제로 공시된 거래**일 수 ' +
        '있으니, matching_filings·matching_filings_unconfirmed 의 doc_counterparties 를 이 거래 ' +
        '상대방과 눈으로 대조해 주세요. 반대로 정말 다른 상대방 거래 공시였다면 이 거래는 ' +
        '미공시일 수 있습니다 — 어느 쪽인지 도구는 판단하지 않았습니다',
    );
  }

  /**
   * ── 시간 예산 결산 ──
   * ★ **중단된 상태를 "후보 없음"으로 내보내면 안 된다.** 예산이 끊겨 보지 못한 범위는 판정이
   *   아니라 미판정이므로, 잘렸다는 사실이 summary·coverage·scope_caveats·notes 네 곳 모두에
   *   드러나야 한다. 반대로 완주했으면 아무것도 붙이지 않는다 — 불필요한 경고는 진짜 경고를 묻는다.
   */
  const budgetSkipped = {
    /** 시간 예산으로 J001 검색을 시작하지 못한 회사 수 */
    companies_not_searched: deadlineSkippedKeys.size,
    /** 시간 예산으로 열지 못한 J001 원문 수 */
    filing_docs_not_read: filingDocDeadlineHits,
    /** 시간 예산으로 법인등록번호를 대조하지 못한 미조인 계열사 수 (자동 워밍) */
    warming_names_not_matched: warming?.skipped_deadline ?? 0,
    /** 시간 예산으로 동명 판별을 하지 못한 이름 수 */
    jurir_disambiguations_skipped: jurirDeadlineSkips,
    /** 시간 예산으로 DART 법인 인덱스를 적재하지 않았는가 */
    corp_index_not_loaded: warming?.corp_index_skipped !== undefined,
  };
  const budgetTruncated =
    budgetSkipped.companies_not_searched > 0 ||
    budgetSkipped.filing_docs_not_read > 0 ||
    budgetSkipped.warming_names_not_matched > 0 ||
    budgetSkipped.jurir_disambiguations_skipped > 0 ||
    budgetSkipped.corp_index_not_loaded;

  /* ── 이어보기 결산 — 이 결과가 **온전한 답인가** ────────────────────────────────
   * ★ `incomplete_reasons` 에는 **재호출로 풀리는 것만** 담는다. 조인 실패(DART 에 상호가
   *   없다)·판정불가(threshold_unknown, 자본을 못 읽었다)·유형 미상 보류(원문 상대방이 다르다)
   *   같은 것은 몇 번을 더 불러도 그대로다 — 그건 "다 봤는데 확인하지 못한 것"이고 종전 어휘로
   *   이미 표시돼 있다. 그것까지 미완주로 세면 `complete` 가 영원히 참이 되지 않아, 반복하면
   *   끝난다는 이 장치의 약속 자체가 거짓이 된다.
   */
  const incompleteReasons: IncompleteReason[] = [];
  if (overBudgetKeys.size > 0) incompleteReasons.push('companies_over_count_budget');
  if (deadlineSkippedKeys.size > 0) incompleteReasons.push('companies_over_time_budget');
  if (retryableErrorKeys.size > 0) incompleteReasons.push('company_search_failed_retryable');
  if (filingDocBudgetHits > 0) incompleteReasons.push('filing_docs_over_fetch_budget');
  if (filingDocDeadlineHits > 0) incompleteReasons.push('filing_docs_over_time_budget');
  if (warming?.over_budget || warming?.over_deadline) incompleteReasons.push('warming_over_budget');
  if (warming?.corp_index_skipped !== undefined) incompleteReasons.push('corp_index_not_loaded');
  if (jurirDeadlineSkips > 0 || jurirBudgetSkips > 0) {
    incompleteReasons.push('jurir_disambiguation_skipped');
  }
  const complete = incompleteReasons.length === 0;
  /** 다음 호출이 **다시 시도할** 회사 수 (완주하면 반드시 0이다) */
  const companiesRemaining =
    overBudgetKeys.size + deadlineSkippedKeys.size + retryableErrorKeys.size;
  const contCallIndex = (contMeta?.calls ?? 0) + 1;
  const contCreatedAt = contMeta?.created_at ?? new Date(nowFn()).toISOString();
  /**
   * 이어보기가 **제자리걸음**인가 — 토큰을 들고 왔는데 새 검색도 새 원문도 0인데 완주가 아니다.
   * 이대로 반복하면 영원히 끝나지 않으므로 사용자에게 다른 길을 알려야 한다.
   */
  const contStalled =
    contToken !== null && !complete && newSearchesPerformed === 0 && filingDocFetches === 0;
  let contIssuedToken: string | null = null;
  if (complete) {
    // 완주한 호출은 자기 토큰의 키를 전부 거둔다. ⚠️ **버려진 실행**(사용자가 이어보기를
    // 그만둔 경우)의 키는 남는다 — 회사당 목록 수백 행이라 작고 TTL 이 지나면 무효라
    // 허용한다. 만료 토큰을 다시 들고 오면 그때 지운다.
    if (contToken) deps.kvDeletePrefix(contPrefix(contToken));
  } else {
    // ★ 토큰은 **첫 미완주 호출에서** 만든다 — 완주한 첫 호출은 토큰을 만들지도 저장하지도
    //   않아 종전과 동일한 동작·동일한 저장소 상태로 끝난다.
    contIssuedToken = contToken ?? randomBytes(16).toString('hex');
    const nextMeta: ContinuationMeta = {
      rcept_no: sourceRceptNo,
      today,
      fiscal_year: fiscalYear,
      created_at: contCreatedAt,
      calls: contCallIndex,
    };
    deps.kvSet(`${contPrefix(contIssuedToken)}meta`, JSON.stringify(nextMeta));
    for (const [key, s] of contToPersist) {
      deps.kvSet(`${contPrefix(contIssuedToken)}s:${key}`, JSON.stringify(s));
    }
  }
  const contExpiresAt = new Date(
    Date.parse(contCreatedAt) + CONTINUATION_TTL_MS,
  ).toISOString();
  const contEstimatedCalls = Math.max(
    1,
    Math.ceil(companiesRemaining / MAX_COMPANIES_TO_SEARCH),
  );

  if (budgetTruncated) {
    notes.push(
      `⚠️ **이 결과는 시간 예산으로 중단된 부분 결과입니다.** MCP 클라이언트가 약 60초에 호출을 ` +
        `끊으므로 이 도구는 ${budgetSeconds(budgetMs)}초를 넘기지 않고 **그때까지 만든 판정을 그대로 ` +
        '돌려줍니다** — 못 본 범위는 "후보 없음"이 아니라 **미판정**입니다. ' +
        `못 본 것: J001 검색 미시작 ${budgetSkipped.companies_not_searched}개사 · ` +
        `원문 미대조 ${budgetSkipped.filing_docs_not_read}건 · ` +
        `법인등록번호 미대조 ${budgetSkipped.warming_names_not_matched + budgetSkipped.jurir_disambiguations_skipped}건` +
        (budgetSkipped.corp_index_not_loaded ? ' · 법인 인덱스 미적재' : '') +
        ` (diagnostics.budget 참조. 소진 지점: ${budget.stoppedAt ?? '미상'}). ` +
        '★ **여기서 끝이 아닙니다** — continuation.token 을 같은 인자에 넣어 다시 호출하면 ' +
        '이번에 못 본 회사부터 이어서 봅니다. 앞 호출이 받아 둔 J001 목록은 다시 받지 않고, ' +
        '원문·법인등록번호·법인 인덱스 캐시도 그대로라 호출을 거듭할수록 멀리 갑니다.',
    );
  }

  if (filingDocBudgetHits > 0) {
    notes.push(
      `J001 원문 **새로 내려받기** 예산(${MAX_FILING_DOC_FETCHES}건)을 넘어 ` +
        `${filingDocBudgetHits}건은 상대방을 대조하지 못했습니다 — 그 건이 걸린 거래는 보류로 ` +
        '남습니다 (matching_filings·type_ambiguous_filings 의 doc_read: budget_exceeded). ' +
        `★ **받아 둔 원문 ${filingDocFetches}건은 캐시에 남으므로, 같은 문서로 이 도구를 다시 ` +
        '실행하면 그만큼은 예산을 쓰지 않고 대조되고 예산은 아직 못 본 원문에 쓰입니다** — ' +
        '한 번 더 실행하면 보류가 줄어듭니다. 급하면 그 건을 read_disclosure 로 직접 열어 ' +
        '거래상대방을 대조하세요',
    );
  }

  const scopeCaveats: string[] = [
    // ★ **아직 온전하지 않다**는 사실이 맨 앞에 온다. 아래 caveat 들은 "본 범위 안에서의
    //   한계"인데, 미완주 실행은 그 범위조차 확정되지 않았다.
    ...(complete
      ? []
      : [
          `★ **이 결과는 아직 온전하지 않습니다** — 남은 회사 ${companiesRemaining}개사. ` +
            'continuation.token 을 같은 인자에 넣어 **complete:true 가 나올 때까지 다시 호출**하세요 ' +
            `(예상 ${contEstimatedCalls}회 더). 미완주 사유: ${incompleteReasons.join(', ')}. ` +
            '⚠️ 이 중간 결과를 최종 답으로 제시하지 마세요 — 못 본 범위는 "후보 없음"이 아닙니다.',
        ]),
    // 예산으로 잘렸으면 **맨 앞에** 온다 — 아래 caveat 들은 전부 "다 봤을 때의 한계"를 말하는데,
    // 다 보지 못한 실행에서는 그보다 먼저 알아야 할 사실이다.
    ...(budgetTruncated
      ? [
          `★ **이 실행은 시간 예산(${budgetSeconds(budgetMs)}초, MCP 60초 벽 대비)으로 중단된 ` +
            '부분 결과입니다.** 아래의 다른 한계들은 "본 범위 안에서의 한계"이고, 이 실행은 ' +
            `**범위 자체가 잘렸습니다** — J001 검색 미시작 ${budgetSkipped.companies_not_searched}개사 · ` +
            `원문 미대조 ${budgetSkipped.filing_docs_not_read}건 · 법인등록번호 미대조 ` +
            `${budgetSkipped.warming_names_not_matched + budgetSkipped.jurir_disambiguations_skipped}건` +
            (budgetSkipped.corp_index_not_loaded ? ' · 법인 인덱스 미적재' : '') +
            '. 그 범위의 거래는 not_judged(사유 time_budget_exceeded) 로 남아 있으며 ' +
            '**"후보 없음"이 아닙니다.** 요약 카운터만 보고 "0건이니 문제 없음"으로 읽지 마세요.',
        ]
      : []),
    '★ 모든 결과는 **후보**입니다. undisclosed_candidate 를 "미공시 확정"으로 읽으면 안 되는 구조적 이유: ' +
      `① 이사회 의결은 **한도**로 미리 해 둘 수 있어(연초 한도 의결 → 연중 분할 인출) 그 공시가 ` +
      `검색창(거래일 이전 ${LOOKBACK_DAYS}일 ~ 오늘)보다 앞설 수 있습니다 ② 상대방이 계열 금융회사면 ` +
      '약관특례(고시 §9, 트랙 B) 분기 일괄공시에 실릴 수 있는데 그 서식은 보고서명이 달라 ' +
      '유형 필터에 걸리지 않을 수 있습니다 ③ 보고서명 유형 분류가 원문 표기와 어긋날 수 있습니다 — ' +
      'other_j001_in_window 가 0 이 아니면 그 공시들을 먼저 확인하세요.',
    '★ **보고서명만으로 거래유형을 알 수 없는 J001 서식이 실재합니다** (실측 2026-09-05, 전체시장 ' +
      '2024-01~2026-09 J001 22,794건·보고서명 94종 전수): `특수관계인과의내부거래` 740건은 실물에서 ' +
      '**벤처투자조합 출자**를(20260903000201), `약관에의한금융거래시계열금융회사의거래상대방의공시` ' +
      '433건은 실물에서 **차입금 415.2억**을(20260902000068) 이 이름으로 공시했습니다. 이런 공시가 ' +
      '창 안에 있으면 "유형 공시 없음 → 미공시 후보"로 단정하지 않습니다. 대신 그 **원문을 열어 ' +
      '거래상대방을 읽고** 이 거래의 상대방과 정규화 일치하면 ' +
      '**그리고** 원문 거래대상이 이 판정 유형(자금/유가증권/상품·용역)으로 분류되면 ' +
      '"공시 존재"(type_ambiguous_resolved_by_document)로, 하나라도 어긋나거나 못 읽으면 **보류**' +
      '(not_judged, type_ambiguous_filing_present)로 둡니다. ⚠️ 불일치를 "공시 없음"으로 내리지 ' +
      "않는 이유: 원문과 J004 의 상대방 표기가 다를 수 있습니다(실측 원문 '미래에셋파트너스제9호' " +
      "vs J004 '미래에셋 파트너스 제구호'). 보류 건은 type_ambiguous_filings 의 doc_counterparties·" +
      'doc_subjects 를 이 거래와 직접 대조하세요. 정정본은 **정정후 상대방만** 대조합니다' +
      '(정정전은 doc_superseded_counterparties). 일치로 올린 건도 **상대방·거래대상 분류까지**만 ' +
      '확인한 것이지 금액·거래기간이 이 거래와 같음을 대조한 것은 아닙니다(원문 금액은 doc_amount_text 로 ' +
      '동봉 — 80708 서식은 억원·백만원 표기가 섞여 숫자화하지 않았습니다).',
    '같은 전수 측정에서 J001 에 **“공시취소” 보고서명은 0건**이었습니다 — 고시 §8①단서의 거래 ' +
      '취소는 별도 서식이 아니라 정정([기재정정] 1,496건)·변경 공시로 표현됩니다. ' +
      'cancellations_of_type_in_window 는 서식이 생길 때를 대비한 방어선이며 현재 판정에 관여하지 ' +
      '않습니다.',
    '★ **"공시 존재"(j001_filing_exists · j001_filing_near_date · j001_filing_in_window_only)는 ' +
      '원문 거래상대방까지 이 거래 상대방과 일치함을 확인한 것입니다** — 회사·유형·검색창만 맞는 ' +
      '공시는 근거로 삼지 않습니다. 매칭 공시의 원문을 **거래일에 가까운 순(날짜 없는 신호는 최신순)' +
      `으로 한 건씩 열어** 상대방이 확인되는 즉시 멈춥니다 — 새로 내려받는 원문은 실행당 ` +
      `${MAX_FILING_DOC_FETCHES}건까지이고(캐시된 원문은 예산을 쓰지 않습니다) 유형 미상 경로와 ` +
      '예산을 공유합니다. 정규화 일치를 본 결과가 counterparty_confirmed_by_document 이고, ' +
      '대조에 쓴 값은 matching_filings 의 doc_counterparties 로 동봉합니다. ' +
      '⚠️ matching_filings_not_examined_total 은 **열어 보지 않은** 매칭 공시 수입니다 — ' +
      '상대방이 다르다는 뜻이 아니라 확인이 먼저 끝났거나 예산이 소진됐다는 뜻입니다. ' +
      '★ 원문은 캐시에 남으므로 **같은 문서로 다시 실행하면 예산이 아직 못 본 원문에 쓰여** ' +
      '대조 범위가 넓어집니다 (실측: 유가증권 유형은 한 회사에 76·95건씩 매칭됩니다). ' +
      '⚠️ **상대방까지만 대조한 것이지 금액·거래기간·거래대상이 이 거래와 같음을 대조한 것은 ' +
      '아닙니다** — 그것까지 확인해야 "공시됨"이 확정됩니다. ' +
      '★ 일치하는 공시가 하나도 없으면 후보로 내리지 않고 **보류**합니다 ' +
      '(not_judged, type_filing_present_counterparty_unconfirmed). 이유는 양방향입니다: ' +
      '같은 유형의 **다른 상대방** 공시는 이 거래의 공시가 아니고(그래서 존재로 보지 않고), ' +
      "원문과 J004 의 상대방 표기가 다를 수 있습니다(실측 원문 '미래에셋파트너스제9호' vs " +
      "J004 '미래에셋 파트너스 제구호' — 같은 법인인데 정규화로 못 잇는다). 그래서 없음으로도 " +
      '내리지 않습니다. 그 건은 matching_filings_unconfirmed 의 doc_counterparties 를 직접 ' +
      '대조하세요. 원문을 못 연 건(doc_read: error·budget_exceeded·no_counterparty_field)도 ' +
      '같은 보류로 갑니다 — **확인하지 못한 것**이지 불일치가 아닙니다.',
    `j001_filing_near_date 는 차입일 근방(−${NEAR_BEFORE_DAYS}~+${NEAR_AFTER_DAYS}일)에 상대방이 ` +
      '확인된 같은 유형 공시가 있다는 뜻이고, j001_filing_in_window_only 는 검색창 안 어딘가에만 ' +
      '있다는 뜻입니다 — 후자는 한도 의결이 커버하는 정상 케이스일 수도, **일부 차입만 공시한 부분 ' +
      '누락**일 수도 있습니다 (nearest_filing_gap_days 참조). 근접 대조는 **상대방이 확인된 공시만** ' +
      '으로 계산합니다 — 다른 상대방 공시의 접수일이 가깝다는 이유로 근접 판정이 되지 않습니다.',
    '기준금액은 **J004 재무현황(당해 사업연도말 자본) 기반 근사치**입니다. 고시 §2③의 정확한 기준은 ' +
      '자본총계=주주총회 승인된 최근 사업연도말 재무제표, 자본금=이사회 의결일 직전일 — 거래 시점에 ' +
      '유효한 자본총계는 통상 **그 전년도말** 것이라 이 근사는 양방향으로 어긋날 수 있습니다. ' +
      '거래금액 100억원 이상(certainty:"certain_by_cap")만 자본과 무관하게 확실합니다(령 §33①1호 상한).',
    'below_threshold 도 같은 근사 기준입니다 — **"기준 미달 = 공시의무 없음 확정"이 아닙니다.** ' +
      '경계(±수억) 거래는 정확한 자본(주총 승인 재무제표)으로 check_disclosure_duty 재판정이 필요합니다.',
    '이 도구가 보는 거래유형은 **자금 차입/대여**(차입일 단위)·**상품·용역**((6) 주요 내역 + ' +
      '(5) 총괄표 보완)·**유가증권 총괄**(상대방별 연간 총액)입니다. 담보·채무보증·부동산 임대차· ' +
      '기타자산 등 다른 유형은 보지 않습니다.',
    '★ 유가증권 신호는 **상대방별 연간 총액**뿐입니다 — 고시 §4③은 유가증권 거래의 해당 여부를 ' +
      '"동일 거래상대방과의 **동일 거래대상**에 대한 거래행위" 기준으로 판단하므로, 연간 총액이 ' +
      '기준금액 이상이어도 거래대상(종목)별로 나누면 개별 거래가 전부 기준 미만일 수 있습니다. ' +
      '상품·용역과 달리 **비둘기집 논증이 성립하지 않아**(연간 총액은 분기 하한을 주지 못한다) ' +
      '후보를 candidate_aggregate_only 로만 냅니다 — 미공시 후보가 아니라 "확인이 필요한 총액"입니다. ' +
      '반대 방향은 확실합니다: 연간 총액이 기준 미만이면 그 상대방과의 개별 거래도 전부 미만입니다. ' +
      '또한 계열 금융회사 간 유가증권 매매는 상당수가 약관특례(고시 §9, 트랙 B) 분기 일괄공시 ' +
      '대상이라, 정상 공시를 놓쳐 오경보를 내지 않도록 보고서명 필터를 넓게 잡았습니다 ' +
      '(matching_filings 로 실제 무엇에 걸렸는지 확인하세요).',
    '★ 자금 차입은 **양쪽 관점**을 봅니다 — 대규모내부거래 공시의무는 거래를 하는 계열회사 ' +
      '각자에게 있으므로, 차입회사의 "자금차입" 공시(항목 본문)와 대여회사의 "특수관계인에 대한 ' +
      '자금대여" 공시(lender_side)를 **각자의 자본으로 계산한 기준금액**으로 따로 판정합니다. ' +
      '대여회사가 DART corp_code 로 조인되지 않으면 counterparty_not_joined, 이름이 자연인(동일인·' +
      '친족) 형태면 counterparty_not_company 로 남으며 둘 다 "의무 없음"이 아니라 **확인하지 못한 ' +
      '것**입니다.',
    '★ 상품·용역과 유가증권도 **양쪽 관점**을 봅니다 — 공정위 매뉴얼(2026-04-27 lit26-001)은 ' +
      '"거래규모가 거래당사자 **모두에게** 대규모내부거래에 해당되는 경우 이사회 의결 및 공시의무는 ' +
      '거래당사자 모두에게 있음"이라고 합니다. 상품·용역은 판매회사(항목 본문)와 **매입회사**' +
      '(buyer_side), 유가증권은 매입회사(항목 본문)와 **매도회사**(seller_side)를 각자의 자본으로 ' +
      '계산한 기준금액으로 따로 판정합니다. 다만 **상품·용역은 양쪽 다 상대방 지분 요건이 전제**라 ' +
      '(고시 §4①4호 — 각 당사자의 의무는 *그 상대방*이 동일인·친족 20%↑ 출자 계열회사인지에 ' +
      '달렸습니다. 매뉴얼 lit26-065·066 이 그 비대칭 실례입니다) 어느 쪽도 후보로 단정하지 ' +
      '않습니다. 상대방 쪽은 **날짜가 없는 연간 총액**이라 존재 확인까지만 하고 건별 근접 대조는 ' +
      '하지 않습니다.',
    '★ 상품·용역의 공시의무는 **상대방 요건이 전제**입니다 — 법 §26①4호·령 §33②·고시 §4①4호는 ' +
      '상대방을 "자연인인 동일인이 단독으로 또는 친족과 합하여 20% 이상 출자한 계열회사 또는 그 ' +
      '상법 §342의2 자회사"로 한정합니다. 이 도구는 지분 데이터가 없어 요건을 확인하지 못하므로 ' +
      '상품·용역 신호는 전부 candidate_if_counterparty_qualified(조건부 후보)입니다 — 요건 미충족 ' +
      '상대방과의 거래는 애초에 공시대상이 아니고, **동일인이 법인인 집단은 이 유형의 공시의무 ' +
      '자체가 없습니다**. 자금·유가증권·자산 거래는 이 한정이 없습니다(특수관계인 전반).',
    '상품·용역의 기준은 분기 합계액(고시 §4③2호, 동일 거래상대방 기준)인데 J004 는 연간 합계뿐입니다 ' +
      '— **(판매회사, 거래상대방) 연간 합산**이 ≥ 4×기준금액인 경우만(어느 분기 하나는 반드시 기준 ' +
      '이상이라는 산술) 신호로 쓰고, 그 미만은 분기 집중 여부를 알 수 없어 **원리상 판정하지 ' +
      '않습니다** (goods_services_not_judgeable, 품목 행은 items 로 동봉). 또한 기준은 "이루어질" ' +
      '거래(사전 의결 시점 예상액)인데 J004 는 사후 실적이라 간극이 있을 수 있습니다 — 다만 사후에 ' +
      '해당이 예상되는 경우의 사전 의결·공시 경로(§9의2③)도 있으므로 후보 검토 가치는 있습니다.',
    '★ 상품·용역은 두 표를 함께 봅니다 — 판정의 주 원천인 (6) **주요** 상품ㆍ용역거래 내역은 ' +
      '서식상 "거래한 금액이 **일정 규모 이상**인 경우"만 싣고 그 규모 기준은 우리가 계산하는 ' +
      '기준금액과 다릅니다. 그래서 (5) 계열회사간 상품ㆍ용역거래 **총괄표**(전 쌍 수록)에서 ' +
      '**(6)에 없는 (매출회사, 매입회사) 쌍만** 보완 신호로 냅니다(goods_services_matrix_signals, ' +
      'source:"(5)총괄"). 중복은 정규화된 쌍 키로 제거하지만 **두 표가 같은 회사를 다르게 적으면 ' +
      '그 키가 듣지 않습니다** (실측: (6) "미래에셋생명(주)" vs (5) "미래에셋 생명보험(주)" — 같은 ' +
      '205,454백만 거래가 양쪽에 남았습니다). 같은 매출회사·같은 금액이면 ' +
      'possible_duplicate_of_major_detail 로 표시하니 후보 수를 셀 때 확인하세요. ' +
      '보완 신호는 연간 총액이 ≥ 4×기준금액일 때만 (6)과 같은 강도의 조건부 후보이고, 총액만 ' +
      '기준 이상이면 candidate_aggregate_only(분기로 나누면 전부 미달일 수 있음)입니다. ' +
      '또 총괄표에는 **품목이 없어** 배당·이자·임대차 분리를 적용하지 못합니다.',
    '★ **국외(해외) 계열회사 상대 거래에는 공시의무가 없습니다** — 법 §26①이 "특수관계인(**국외 ' +
      '계열회사는 제외한다**. 이하 이 조에서 같다)"이라 명시하고, 고시 §2③2호도 같은 문언이며, ' +
      '공정위 공시 업무 매뉴얼(2026-04-27)도 "국외 계열회사와 대규모내부거래 등을 하는 경우 ' +
      '이사회 의결 및 공시의무 없음"이라고 답합니다. 그래서 (5) 총괄표가 **그룹 헤더로 ' +
      '"해외계열사"라고 밝힌 열**은 not_applicable_foreign_affiliate 로 분리합니다 — 회사명 ' +
      '모양으로 추측하지 않고 원문 표의 분류만 씁니다(column_group 으로 근거를 함께 냅니다). ' +
      '⚠️ 두 가지 한계: ① 같은 매뉴얼은 "특수관계인이 발행한 주식 등을 **국외 계열회사를 통하여 ' +
      '간접적으로** 매입하는 등 특수관계인을 **위한** 거래"에는 의무가 있다고 하는데 이 표로는 ' +
      '그런 간접거래를 구분할 수 없습니다 ② 그룹 헤더는 병합 셀을 왼쪽부터 이어받아 읽으므로 ' +
      '분류가 틀릴 수 있어, 버리지 않고 금액·기준금액과 함께 출력에 남깁니다.',
    '자금 차입의 대규모내부거래 해당 여부는 고시 §4③에 따라 "동일 거래상대방과의 동일 거래대상" ' +
      '기준으로 판단합니다 — J004 로는 동일 거래대상(같은 약정) 여부를 알 수 없어, 개별 건이 기준 ' +
      '미달이어도 같은 상대방 연간 합산이 기준 이상이면 below_threshold 로 단정하지 않고 not_judged' +
      '(aggregation_unknown)로 남깁니다.',
    'J004 원문 자체가 부정확하거나 늦게 제출됐을 수 있습니다 (J004 정정률 91% 실측) — 정정 반영 ' +
      '최신본을 읽지만 원천 기재 오류·누락은 판별하지 못합니다. J001 대사의 원천이 J004 하나뿐이라 ' +
      'J004 에 안 실린 거래는 애초에 이 도구의 시야 밖입니다.',
    '각 회사가 실제로 공시의무자인지(소속·청산·휴업 등)와 **집단의 지정 연혁**은 판정하지 않습니다 — ' +
      '집단이 그 거래 연도에 공시대상으로 지정돼 있지 않았다면(신규 지정) 전년도 거래 전체가 의무 ' +
      '없음일 수 있습니다. 계열편입일(포털 grinil) 이전 차입만 no_duty_before_joining 으로 분리하며, ' +
      '이는 포털 소속회사 목록을 실제로 불러온 경우에만 가능합니다(diagnostics.population 참조). ' +
      '상품·용역은 연간 합계라 편입 시점 ' +
      '대조가 불가능합니다. 또한 **편입 전 체결 거래라도 편입 후 주요내용을 변경하면 의결·공시의무가 ' +
      '있습니다**(고시 §4④) — 이 도구는 변경 여부를 보지 못하므로 no_duty_before_joining 도 그 ' +
      '한도에서만 유효합니다.',
    // ★ "포털 목록이 아예 없다"와 "목록은 있는데 DART 조인이 0건"은 한계가 서로 다르다 —
    //   같은 문구로 뭉치면 실제로 무엇을 못 했는지가 가려진다.
    populationSource !== 'portal' || population === null
      ? `포털 소속회사 목록 없이 DART 상호 완전일치만으로 조인했습니다 (${populationReason ?? '사유 미상'}) — ` +
        '동명 비계열 회사로 오조인되면 그 회사의 공시가 근거로 잘못 붙을 수 있고, 계열편입일 ' +
        '대조(편입 전 거래 = 의무 없음)도 하지 못합니다.'
      : population.corpCodes.size === 0
        ? `포털 소속회사 목록(${populationGroup}, ${populationYearMonth} 기준, ${population.unjoined.length}개사)은 ` +
          '불러왔으나 **DART corp_code 로 조인된 회사가 한 곳도 없습니다** — 계열사 **명단**이 있어 ' +
          '거래상대방이 계열회사인지는 이름으로 확인하지만, 조회할 corp_code 가 없어 J001 "공시 존재" ' +
          '확인이 **전혀 되지 않고**(대부분 counterparty_not_joined·not_judged 로 남습니다) ' +
          '계열편입일 대조도 하지 못합니다(편입일은 조인된 회사에만 붙습니다). ' +
          '조인 키는 법인등록번호입니다' +
          (warming
            ? ` — 이 실행의 자동 워밍은 ${warming.attempted}개사를 대조해(조회 ${warming.lookups}회) ` +
              `${warming.joined}개사를 조인했습니다(diagnostics.population.warming 참조). ` +
              (warming.over_budget
                ? `조회 예산 ${MAX_WARM_LOOKUPS}회를 넘겨 중단했으니 다시 실행하면 이어서 채웁니다.`
                : '남은 회사는 DART 상호 검색으로 후보를 찾지 못했거나 법인등록번호가 1건으로 ' +
                  `확정되지 않은 것이라, **후보 탐색 규칙이 바뀌지 않는 한**(현 v${WARM_LOGIC_VERSION}) ` +
                  `다시 실행해도 같습니다 — ${WARM_SUPPRESS_DAYS}일간은 재시도하지 않으며 ` +
                  'diagnostics.population.warming.skipped 의 회사는 resolve_entity 로 직접 확인하세요.')
            : '. resolve_entity(fetchJurirNo=true) 로 주요 회사를 조회하면 같은 캐시가 채워집니다.')
        : `회사명 조인에 포털 소속회사 목록(${populationGroup}, ${populationYearMonth} 기준)을 썼습니다 — ` +
          'DART 폴백 조인 결과가 집단 목록 어디에도 없으면 비계열 동명 회사일 수 있어 판정하지 ' +
          '않습니다(dart_join_unverified). 포털 목록은 **연 1회(매년 5/1 기준) 스냅샷**이라 거래 시점의 ' +
          '소속과 다를 수 있고, 목록에는 있으나 DART 법인등록번호 조인 캐시가 비어 있으면 여전히 ' +
          '조인에 실패합니다' +
          (warming && warming.over_budget
            ? ` (자동 워밍이 조회 예산 ${MAX_WARM_LOOKUPS}회를 넘겨 중단됐습니다 — 다시 실행하면 ` +
              '이어서 채웁니다).'
            : '(resolve_entity(fetchJurirNo=true) 로 채울 수 있습니다).'),
  ];

  if (undisclosed.length > 0) {
    notes.push(
      `⚠️ 자금차입 미공시 후보 ${undisclosed.length}건. **반드시 scope_caveats 와 함께 전달하세요** — ` +
        '미공시의 과태료 기본금액(의결 있음 5,000만 / 없음 7,000만원)은 지연(500만+1일 10만)보다 훨씬 ' +
        '무거워, 단정이 틀렸을 때의 대가도 그만큼 큽니다. 각 건은 해당 회사 담당자 확인 → 필요 시 ' +
        'check_disclosure_duty(정확한 자본 입력) 재판정 순서로 검증하세요.',
    );
  }
  if (goodsCandidates.length > 0) {
    notes.push(
      `⚠️ 상품·용역 **조건부 후보** ${goodsCandidates.length}건 (candidate_if_counterparty_qualified) — ` +
        'J001 은 없으나, 이 유형의 공시의무는 상대방이 동일인(자연인)·친족 합계 20% 이상 출자 ' +
        '계열회사(또는 그 자회사)일 때만 성립합니다(법 §26①4호·령 §33②). 이 도구는 지분을 확인하지 ' +
        '못하므로 **"미공시 후보"로 단정하지 마세요** — 상대방의 총수일가 지분 구조를 먼저 확인하고, ' +
        '동일인이 법인인 집단이면 이 유형의 의무 자체가 없습니다.',
    );
  }
  if (gmCandidates.length > 0 || gmAggregateOnly.length > 0) {
    notes.push(
      `⚠️ (5) 상품·용역 **총괄표 보완** 신호 — 조건부 후보 ${gmCandidates.length}건 · ` +
        `총액 확인 대상 ${gmAggregateOnly.length}건. (6) 주요 내역에는 없고 (5) 총괄표에만 있는 ` +
        '쌍입니다 ((6)은 일정 규모 이상만 싣습니다). 총괄표는 **연간 총액·품목 없음**이라 신호가 ' +
        '한 단계 약합니다 — 각 신호의 caveat 와 status 를 그대로 전달하고, 분기별 거래액과 ' +
        '상대방 지분 요건을 확인하세요.',
    );
  }
  if (jurirResolved.length > 0) {
    notes.push(
      `ℹ️ DART 상호가 동명 2건 이상이던 회사 ${jurirResolved.length}곳을 **법인등록번호**로 ` +
        `확정했습니다 (${jurirResolved.map((r) => `${r.company}→${r.corp_code}`).join(', ')}) — ` +
        '포털 소속회사 목록의 jurirno 와 DART 기업개황 jurir_no 를 대조한 결과이며, ' +
        '정확히 1건 일치한 경우만 확정했습니다 (diagnostics.jurir_disambiguation).',
    );
  }
  if (goodsMatrixPossibleDuplicates > 0) {
    const dups = judgedGoodsMatrix.filter((m) => m.possible_duplicate_of_major_detail);
    notes.push(
      `⚠️ (5) 보완 신호 ${goodsMatrixPossibleDuplicates}건은 (6) 주요 내역에 **같은 매출회사· ` +
        `같은 금액** 행이 다른 상대방 이름으로 있습니다 (${dups
          .map((m) => `${m.company}→${m.counterparty}/${m.annual_amount_display}`)
          .join(', ')}) — 두 표가 같은 회사를 다르게 적은 **같은 거래**일 가능성이 높습니다 ` +
        '(실측: (6) "미래에셋생명(주)" vs (5) "미래에셋 생명보험(주)"). 그 경우 양쪽 신호를 ' +
        '하나로 세세요. 우연히 금액이 같은 별개 거래일 수도 있어 버리지 않고 표시만 했습니다.',
    );
  }
  if (goodsPromotedFromMatrix.length > 0) {
    const top = [...goodsPromotedFromMatrix].sort((x, y) => y.to - y.from - (x.to - x.from));
    notes.push(
      `(6) 주요 내역 신호 ${goodsPromotedFromMatrix.length}건은 **(5) 총괄표가 더 큰 금액**을 적어 ` +
        `그 값으로 판정했습니다 (${top
          .slice(0, 3)
          .map((p) => `${p.pair} ${fmtWon(p.from)}→${fmtWon(p.to)}`)
          .join(', ')}${top.length > 3 ? ` 외 ${top.length - 3}건` : ''}) — (6)은 "거래한 금액이 ` +
        '**일정 규모 이상**인 경우"의 내역만 싣는 표라 상대방별 연간 총액을 다 담지 못합니다. ' +
        '두 값을 모두 신호에 실었으니(annual_amount_total ↔ matrix_annual_total) 차액의 성격은 ' +
        '원문 두 표를 대조해 확인하세요 — (5)에는 품목이 없어 배당·이자·임대차가 섞였는지 ' +
        '가려내지 못합니다.',
    );
  }
  if (goodsLabelOverlaps > 0) {
    notes.push(
      `⚠️ (6) 주요 내역에서 ${goodsLabelOverlaps}개 쌍이 '가.(분기)' 표와 '나.(연1회)' 표에 ` +
        '**모두** 실려 있습니다 — 한쪽이 다른 쪽의 부분기간이면 더하는 것이 이중 계상이라 ' +
        '합산하지 않고 큰 쪽만 판정에 썼습니다 (label_overlap 에 두 값을 실었습니다). 두 표가 ' +
        '**별개 거래**를 적은 것이라면 실제 총액은 더 크므로 원문을 대조하세요.',
    );
  }
  if (secCandidates.length > 0) {
    notes.push(
      `⚠️ 유가증권 **총액 확인 대상** ${secCandidates.length}건 (candidate_aggregate_only) — 상대방별 ` +
        '연간 총액이 기준금액 이상인데 창 안에 유가증권 유형 J001 이 없습니다. **미공시 후보로 단정하지 ' +
        '마세요**: 이 표는 연간 총액뿐이라 개별 거래가 기준을 넘었는지 자체를 모릅니다(고시 §4③은 ' +
        '동일 거래상대방과의 **동일 거래대상** 기준). 계열 금융회사 간 매매라면 약관특례(§9) 분기 ' +
        '일괄공시 대상일 수 있습니다 — 개별 거래 내역을 먼저 확인하세요.',
    );
  }
  if (counterCandidates.length > 0) {
    const names = [...new Set(counterCandidates.map((c) => c.side.company))];
    notes.push(
      `⚠️ **상대방 쪽**(상품·용역 매입회사·유가증권 매도회사) 확인 대상 ${counterCandidates.length}건 ` +
        `(${names.join(', ')}) — 공정위 매뉴얼(2026-04-27 lit26-001)은 "거래규모가 거래당사자 ` +
        '**모두에게** 대규모내부거래에 해당되면 공시의무도 거래당사자 모두에게 있다"고 합니다. ' +
        '기준금액은 그 회사 자신의 자본으로 계산했습니다 — buyer_side·seller_side 를 열어 ' +
        'status·matching_filings 를 확인하고 scope_caveats 와 함께 전달하세요.',
    );
  }
  if (lenderCandidates.length > 0) {
    const names = [...new Set(lenderCandidates.map((s) => s.company))];
    notes.push(
      `⚠️ **대여회사 쪽** 자금대여 미공시 후보 ${lenderCandidates.length}건 (${names.join(', ')}) — ` +
        '차입회사가 자금차입을 공시했더라도 자금을 대준 계열회사에는 "특수관계인에 대한 자금대여" ' +
        '공시의무가 **별도로** 있고, 기준금액도 그 회사 자신의 자본으로 계산합니다. ' +
        'lender_side 를 열어 matching_filings·기준금액을 확인하고, scope_caveats 와 함께 전달하세요.',
    );
  }
  if (lenderCounts.counterparty_not_joined + lenderCounts.counterparty_not_company > 0) {
    notes.push(
      `ℹ️ 대여회사 ${lenderCounts.counterparty_not_joined}건은 corp_code 조인 실패, ` +
        `${lenderCounts.counterparty_not_company}건은 자연인(동일인·친족) 추정으로 자금대여 공시를 ` +
        '대조하지 않았습니다 — 조인 실패는 "공시 없음"이 아니라 **확인하지 못한 것**이고, ' +
        '자연인 추정은 이름 모양에 근거한 추정입니다.',
    );
  }
  if (
    undisclosed.length === 0 &&
    goodsCandidates.length === 0 &&
    secCandidates.length === 0 &&
    lenderCandidates.length === 0 &&
    gmCandidates.length === 0 &&
    gmAggregateOnly.length === 0 &&
    counterCandidates.length === 0
  ) {
    notes.push(
      'ℹ️ 미공시 후보 0건은 "미공시 없음"의 확인이 아닙니다 — 이 도구가 보는 유형(자금차입·자금대여·' +
        '상품·용역((6) 주요 내역 + (5) 총괄 보완)·유가증권 총괄)과 이 문서에 실린 거래의 범위 안에서 ' +
        '후보를 찾지 못했다는 뜻입니다 (scope_caveats 참조).',
    );
  }
  if (windowOnly.length > 0) {
    notes.push(
      `⚠️ 창 안에 같은 유형 공시는 있으나 차입일 근방(−${NEAR_BEFORE_DAYS}~+${NEAR_AFTER_DAYS}일)에는 ` +
        `없는 차입이 ${windowOnly.length}건 있습니다 (j001_filing_in_window_only) — 연초 한도 의결이 ` +
        '커버하는 정상 케이스일 수도, **일부 차입만 공시한 부분 누락**일 수도 있습니다. ' +
        'nearest_filing_gap_days 와 matching_filings 내용 대조로 확인하세요.',
    );
    // 같은 회사에서 근접 공시가 있는 차입과 없는 차입이 갈리면 부분 공시 신호가 더 강하다
    const nearCompanies = new Set(nearDate.map((b) => normalizeCompanyName(b.company)));
    const mixed = [
      ...new Set(
        windowOnly
          .filter((b) => nearCompanies.has(normalizeCompanyName(b.company)))
          .map((b) => b.company),
      ),
    ];
    if (mixed.length > 0) {
      notes.push(
        `⚠️ ${mixed.join(', ')} 은(는) **일부 차입에만 근접 공시가 있습니다** — 건별로 공시했다면 ` +
          '나머지 차입의 공시가 누락됐을 가능성이 상대적으로 높은 패턴입니다. 우선 확인 대상입니다.',
      );
    }
  }
  if (noDuty.length > 0) {
    notes.push(
      `ℹ️ 차입 ${noDuty.length}건은 계열편입일(포털 grinil) 이전 거래라 no_duty_before_joining 으로 ` +
        '분리했습니다 — 편입 전에는 공시의무가 없습니다. 단 편입일 데이터 정확성·재편입 여부는 확인하지 않았습니다.',
    );
  }
  if (cancelledMatchingSeen.size > 0) {
    notes.push(
      `ℹ️ '[공시취소]' 접수분 ${cancelledMatchingSeen.size}건은 공시 존재의 근거로 쓰지 않았습니다 — ` +
        '취소는 공시를 없앤 기록입니다 (other_j001_in_window 로 집계).',
    );
  }
  if (joinFailures.length > 0) {
    notes.push(
      `⚠️ 기준 초과 거래가 있는 ${joinFailures.length}개사는 회사명→corp_code 조인 실패로 J001 대조를 ` +
        '하지 못했습니다 (join_failures) — "후보 아님"이 아니라 **확인하지 못한 것**입니다.',
    );
  }
  if (overBudgetKeys.size > 0) {
    notes.push(
      `⚠️ J001 검색 예산(${MAX_COMPANIES_TO_SEARCH}개사) 초과로 ${overBudgetKeys.size}개사는 대조하지 ` +
        '않았습니다 — 금액 상위 회사부터 대조했고, 나머지는 not_judged 로 남아 있습니다.',
    );
  }
  if (goodsUnjudgeable.length > 0) {
    notes.push(
      `ℹ️ 상품·용역 ${goodsUnjudgeable.length}건(상대방별 합산 기준)은 미공시 후보 판정에 올리지 ` +
        '않았습니다 (goods_services_not_judgeable) — 연간 합산이 4×기준금액 미만이면 분기 기준 초과 ' +
        '여부를 원리상 판정할 수 없습니다 (분기별 합계는 각 사 내부 데이터로만 확인됩니다).',
    );
  }
  if (goodsItemCaveats4x.length > 0) {
    notes.push(
      `ℹ️ 연간 금액이 4×기준금액 이상인데도 후보로 올리지 않은 행이 ${goodsItemCaveats4x.length}건 ` +
        '있습니다 (goods_services_item_caveats) — 품목이 배당·이자·임대차 등 **상품·용역 거래의 대가가 ' +
        '아닐 가능성**이 높아서입니다 (item_caveat 참조). 실제로 상품·용역 거래라면 후보에 준해 확인이 필요합니다.',
    );
  }
  if (goodsNotJudged.length > 0) {
    notes.push(
      `⚠️ 상품·용역 신호 ${goodsNotJudged.length}건은 조인 실패·예산 초과·수집 불완전으로 J001 대조를 ` +
        '하지 못했습니다 (goods_services_signals 중 status:"not_judged") — "후보 아님"이 아니라 확인하지 못한 것입니다.',
    );
  }
  if (gmNotJudged.length > 0) {
    notes.push(
      `⚠️ (5) 총괄 보완 신호 ${gmNotJudged.length}건은 기준금액 미상(자본 미확인)·조인 실패·예산 초과· ` +
        '수집 불완전으로 판정하지 못했습니다 (goods_services_matrix_signals 중 status:"not_judged") — ' +
        '"후보 아님"이 아니라 확인하지 못한 것입니다.',
    );
  }
  if (partialLists) {
    notes.push(
      '⚠️ 일부 목록 수집이 불완전합니다 (측정 실패·절단·부분결과) — "공시 없음" 판정이 수집 누락일 수 ' +
        '있으니 diagnostics 를 확인하세요.',
    );
  }
  const zeroRowChecks: Array<[string, number, string]> = [
    ['재무현황', capitals.length, '자본 행'],
    ['자금거래', borrowings.length, '차입 건'],
    ['주요 상품·용역', goods.length, '거래 행'],
  ];
  for (const [section, count, unit] of zeroRowChecks) {
    if (count === 0 && parseDiag.sections_found.includes(section)) {
      notes.push(
        `ℹ️ ${section} 절은 있으나 추출된 ${unit}이 0건입니다 — 실제로 없거나("해당사항 없음"), ` +
          '표 구조가 실측 서식과 달라 파서가 못 읽은 것일 수 있습니다.',
      );
    }
  }
  if (!input.group) {
    notes.push(
      `ℹ️ rcept_no 경로의 fiscal_year(${fiscalYear})는 접수월 기반 추정입니다 — 4월 이후에 제출된 ` +
        '전년도 의무분(해 넘긴 지연 제출)이면 실제 거래 연도와 어긋날 수 있습니다. ' +
        '문서 표지의 대상 연도를 확인하세요.',
    );
  }
  if (sourceIsCorrection) {
    notes.push('ℹ️ 정정 접수분(최신본)을 읽었습니다 — 원본이 아니라 정정 반영 내용 기준입니다.');
  }

  // ★ 미완주 안내는 **notes 맨 앞**에 온다 — 아래 note 들을 다 읽고 나서야 "그런데 이건
  //   부분 결과였다"를 알게 되면 이미 결론을 내린 뒤다. 모든 push 가 끝난 지금 앞에 붙인다.
  if (!complete) {
    notes.unshift(
      `★ **아직 온전한 답이 아닙니다 (continuation.complete:false).** 남은 회사 ` +
        `${companiesRemaining}개사 · 이 토큰으로 ${contCallIndex}번째 호출 · 사유 ` +
        `${incompleteReasons.join(', ')}. **continuation.token 을 같은 인자에 넣어 다시 ` +
        `호출하세요** (예상 ${contEstimatedCalls}회 더, 토큰 수명 ${CONTINUATION_TTL_MS / 3_600_000}시간). ` +
        'complete:true 를 낸 호출의 결과가 온전한 답이고, 그 전 결과를 최종으로 제시하면 안 됩니다.' +
        (contStalled
          ? ' ⚠️ **다만 이번 호출은 새로 검색한 회사도 새로 연 원문도 0건입니다** — 더 불러도 ' +
            '같은 자리일 수 있으니, 남은 회사는 search_disclosures(pblntf_detail_ty:"J001") 로 ' +
            '개별 확인하는 편이 확실합니다.'
          : ''),
    );
  }

  log.info('미공시 교차탐지 완료', {
    rcept_no: sourceRceptNo,
    borrowings: borrowings.length,
    goods: goods.length,
    candidates: undisclosed.length,
    goodsConditionalCandidates: goodsCandidates.length,
    securitiesPairs: securitiesMatrix.cells.length,
    securitiesCandidates: secCandidates.length,
    goodsMatrixSupplemented: judgedGoodsMatrix.length,
    goodsMatrixCandidates: gmCandidates.length + gmAggregateOnly.length,
    lenderCandidates: lenderCandidates.length,
    populationSource,
    listCalls,
  });

  return {
    scope: {
      source_rcept_no: sourceRceptNo,
      source_viewer_url: viewerUrl(sourceRceptNo),
      ...(sourceReportNm ? { source_report_nm: sourceReportNm } : {}),
      ...(meta.acode ? { source_acode: meta.acode } : {}),
      ...(input.group ? { group: input.group, filing_year: filingYear } : {}),
      /** 거래내역이 속한 직전 사업연도 (12월 결산 가정) */
      fiscal_year: fiscalYear,
      judged_at: today,
    },
    /**
     * ── 이어보기 ──
     * ★ **`complete` 가 이 응답에서 가장 먼저 읽어야 할 값이다.** false 면 이 결과는 중간
     *   보고이고, `token` 을 같은 인자에 넣어 다시 부르면 안 본 회사부터 이어서 본다.
     *   true 를 낸 호출의 결과가 온전한 답이다.
     */
    continuation: {
      complete,
      ...(contIssuedToken ? { token: contIssuedToken } : {}),
      /** 이 토큰으로 몇 번째 호출인지 (토큰 없이 시작한 첫 호출은 1) */
      call_index: contCallIndex,
      /**
       * 미완주 사유 — **재호출로 풀리는 것만** 담는다. 조인 실패·판정불가·유형 미상 보류처럼
       * 다시 불러도 그대로인 것은 여기 없고 종전 어휘(not_judged 의 reason)로 표시돼 있다.
       */
      incomplete_reasons: incompleteReasons,
      progress: {
        /** J001 대조가 필요한 회사 총수 (매 호출 같다 — 같은 문서를 읽는다) */
        companies_to_search_total: ranked.length,
        /** 이 실행이 지금까지 목록을 확보한 회사 수 (앞 호출 재사용 + 이번 새 검색) */
        companies_searched_cumulative: contReused + newSearchesPerformed,
        /** 이번 호출에서 **목록을 실제로 받아 낸** 회사 수 (시도가 아니라 성공 — 진전의 척도) */
        companies_searched_this_call: newSearchesPerformed,
        /** 앞 호출의 캐시에서 그대로 가져온 회사 수 — 이만큼은 콜도 예산도 쓰지 않았다 */
        companies_reused_from_token: contReused,
        /** 다음 호출이 다시 시도할 회사 수 (complete:true 면 반드시 0) */
        companies_remaining: companiesRemaining,
        filing_docs_fetched_this_call: filingDocFetches,
        /** 건수·시간 예산으로 열지 못한 원문 수 (합) */
        filing_docs_not_read: filingDocBudgetHits + filingDocDeadlineHits,
      },
      ...(contIssuedToken ? { expires_at: contExpiresAt } : {}),
      next_step: complete
        ? '이 결과가 온전한 답입니다 — 더 호출할 필요가 없습니다.'
        : `같은 인자에 continuation_token 을 넣어 다시 호출하세요. complete:true 가 나올 때까지 ` +
          `반복하면 온전한 답이 됩니다 (남은 ${companiesRemaining}개사, 예상 ${contEstimatedCalls}회 더).`,
      /**
       * 이어보기가 제자리걸음이다 — 새 검색도 새 원문도 0인데 완주가 아니다.
       * 더 부르지 말고 남은 회사를 개별 조회하라는 신호다.
       */
      ...(contStalled ? { stalled: true as const } : {}),
    },
    summary: {
      /** 이 결과가 온전한가 — 최상위 `continuation.complete` 와 같은 값이다 */
      complete,
      /**
       * ★ 시간 예산으로 **범위가 잘린 실행**이다 — 완주한 실행에는 이 키가 없다.
       * 아래 카운터들은 "본 범위 안의" 집계이고, 못 본 범위는 not_judged 에 있다.
       */
      ...(budgetTruncated ? { time_budget_truncated: true, time_budget_skipped: budgetSkipped } : {}),
      capitals_extracted: capitals.length,
      borrowings_extracted: borrowings.length,
      goods_services_extracted: goods.length,
      undisclosed_candidates: undisclosed.length,
      j001_filing_near_date: nearDate.length,
      j001_filing_in_window_only: windowOnly.length,
      below_threshold: below.length,
      no_duty_before_joining: noDuty.length,
      not_judged: notJudged.length,
      /** J001 부재 + 상대방 요건(총수일가 20%↑ 출자) 미확인 — "후보 확정"이 아니다 */
      goods_services_candidates_if_qualified: goodsCandidates.length,
      goods_services_filing_exists: goodsFilingExists.length,
      goods_services_not_judged: goodsNotJudged.length,
      goods_services_not_judgeable: goodsUnjudgeable.length,
      goods_services_item_caveats: caveatRows.length,
      /** (5) 총괄표에서 (6)에 없는 쌍만 뽑은 보완 신호 — 중복은 쌍 키로 제거했다 */
      goods_services_matrix_pairs_extracted: goodsMatrixSeed.cells.length,
      goods_services_matrix_pairs_supplemented: judgedGoodsMatrix.length,
      goods_services_matrix_pairs_also_in_major_detail: goodsMatrixPairsAlsoInDetail,
      /**
       * 회사명이 달라 중복 제거를 비껴갔지만 (6)에 **같은 매출회사·같은 금액** 행이 있는 쌍.
       * 같은 거래가 양쪽에 실렸을 수 있으니 후보 수를 셀 때 이 수를 빼고 세어야 할 수 있다.
       */
      goods_services_matrix_possible_duplicates: goodsMatrixPossibleDuplicates,
      /** 연간 총액 ≥ 4×기준금액(비둘기집 성립) + J001 부재 — (6) 경로와 같은 강도의 조건부 후보 */
      goods_services_matrix_candidates_if_qualified: gmCandidates.length,
      /** 총액만 기준 이상 — 분기로 나누면 전부 미달일 수 있어 "후보"가 아니라 확인 대상이다 */
      goods_services_matrix_candidates_aggregate_only: gmAggregateOnly.length,
      goods_services_matrix_filing_exists: gmFilingExists.length,
      goods_services_matrix_below_threshold: gmBelow.length,
      goods_services_matrix_not_judged: gmNotJudged.length,
      /** 국외 계열회사 상대 — 법 §26①·고시 §2③2호가 특수관계인에서 제외해 후보가 아니다 */
      goods_services_matrix_foreign_affiliate: gmForeign.length,
      securities_foreign_affiliate: secForeign.length,
      securities_pairs_extracted: securitiesMatrix.cells.length,
      /** 연간 총액이 기준금액 이상 + 유형 J001 부재 — "미공시 후보"가 아니라 확인 대상이다 */
      securities_candidates_aggregate_only: secCandidates.length,
      securities_filing_exists: secFilingExists.length,
      securities_below_threshold: secBelow.length,
      securities_not_judged: secNotJudged.length,
      /**
       * 대여회사(자금을 대준 계열회사) 쪽 판정 — 차입 **건 단위** 집계다.
       * 차입회사 쪽 판정과 독립적이다 (기준금액이 각자의 자본이라 한쪽만 초과일 수 있다).
       */
      lender_side: lenderCounts,
      /**
       * 거래 **상대방 쪽** 판정 (상품·용역 매입회사 / 유가증권 매도회사) — 신호 단위 집계다.
       * 판매·매입 쪽 판정과 독립적이다 (기준금액이 각자의 자본이라 한쪽만 초과일 수 있다).
       */
      counterparty_side: counterCounts,
    },
    /** 자금 차입 — 차입일 단위 대조라 신뢰도가 가장 높다 */
    undisclosed_candidates: undisclosed,
    j001_filing_near_date: nearDate,
    j001_filing_in_window_only: windowOnly,
    below_threshold: below,
    ...(noDuty.length ? { no_duty_before_joining: noDuty } : {}),
    ...(notJudged.length ? { not_judged: notJudged } : {}),
    /** 상품·용역 — (판매회사, 상대방) 연간 합산 기반 제한적 신호 (quarterly_logic 참조) */
    goods_services_signals: [...goodsCandidates, ...goodsFilingExists, ...goodsNotJudged],
    ...(goodsUnjudgeable.length
      ? { goods_services_not_judgeable: goodsUnjudgeable }
      : {}),
    ...(caveatRows.length ? { goods_services_item_caveats: caveatRows } : {}),
    /**
     * 상품·용역 (5) **총괄표** 보완 — (6) 주요 내역에 없는 쌍만 담는다.
     * 연간 총액 기반이고 품목이 없어 (6) 신호보다 한 단계 약하다 (각 항목의 caveat 참조).
     */
    ...(judgedGoodsMatrix.length
      ? {
          goods_services_matrix_signals: [
            ...gmCandidates,
            ...gmAggregateOnly,
            ...gmFilingExists,
            ...gmNotJudged,
          ],
          ...(gmBelow.length ? { goods_services_matrix_below_threshold: gmBelow } : {}),
          /** 국외 계열회사 상대 — 공시의무 자체가 없다 (버리지 않고 근거와 함께 남긴다) */
          ...(gmForeign.length ? { goods_services_matrix_foreign_affiliate: gmForeign } : {}),
        }
      : {}),
    /**
     * 유가증권 — 상대방별 **연간 총액** 기반. 개별 거래로 분해되지 않는다는 점에서
     * 차입·상품용역보다 약한 신호다 (scope_caveats 의 §4③ 항목 참조).
     */
    ...(judgedSecurities.length
      ? {
          securities_signals: [...secCandidates, ...secFilingExists, ...secNotJudged],
          ...(secBelow.length ? { securities_below_threshold: secBelow } : {}),
          ...(secForeign.length ? { securities_foreign_affiliate: secForeign } : {}),
        }
      : {}),
    ...(joinFailures.length ? { join_failures: joinFailures } : {}),
    coverage: {
      transaction_types_checked: [
        '자금 차입 — 차입회사 관점 (차입일 단위, 건별 근접 대조)',
        '자금 대여 — 대여회사(거래상대방) 관점 (같은 차입 건을 대여회사 자본 기준으로 재판정)',
        '주요 상품·용역 (6) (상대방별 연간 합산, 4×기준금액 이상만)',
        '상품·용역 총괄 (5) 매트릭스 — (6)에 없는 쌍만 보완 (상대방별 연간 총액)',
        '상품·용역 — 매입회사 관점 (buyer_side, 매입회사 자본 기준으로 재판정)',
        '유가증권 총괄 매트릭스 (상대방별 연간 총액 — 개별 거래로 분해되지 않음)',
        '유가증권 — 매도회사 관점 (seller_side, 매도회사 자본 기준으로 재판정)',
      ],
      undetectable: {
        other_transaction_types: [
          '담보 제공·수취',
          '채무보증',
          '부동산 임대차',
          '기타자산 거래',
        ],
        /** "주요" 기준 미달로 J004 표에 실리지 않은 상품·용역 거래 */
        non_major_goods_services: true,
        /** J004 에 기재 자체가 누락된 거래 — 이 도구의 원천이 J004 하나뿐이다 */
        transactions_missing_from_j004: true,
      },
      /**
       * 시간 예산(60초 벽)이 끊겨 **이번 실행에서 보지 못한 범위**. 완주하면 이 키가 없다.
       * 여기 잡힌 것은 "이상 없음"이 아니라 확인하지 못한 것이다.
       */
      ...(budgetTruncated
        ? {
            not_examined_due_to_time_budget: {
              ...budgetSkipped,
              budget_ms: budget.budgetMs,
              elapsed_ms: budget.elapsedMs(),
              stopped_at: budget.stoppedAt,
              /**
               * 이어보기 토큰으로 다시 부르면 이어서 보는 범위.
               * J001 공시 목록은 캐시하지 않지만(설계 불변식), **같은 실행 안에서만** 유효한
               * 이어보기 캐시가 그 자리를 대신한다 — 토큰 없는 새 호출은 언제나 새로 받는다.
               */
              resumable_with_continuation_token: [
                'J001 공시 목록 검색 (이 실행이 이미 받은 회사는 다시 받지 않는다)',
                'J001 원문',
                '법인등록번호(기업개황)',
                'DART 법인 인덱스',
              ],
            },
          }
        : {}),
    },
    scope_caveats: scopeCaveats,
    notes,
    diagnostics: {
      parse: parseDiag,
      /**
       * 시간 예산 (60초 벽 — 함정 7). `stages` 는 **계측값**이다: 어느 구간이 예산을 먹는지
       * 실물 실행에서 확인해 상수를 좁히는 근거로 쓴다 (특히 `corp_index` 는 실측이 없다).
       *
       * ⚠️ `list_calls` 는 회사당 1 카운터라 HTTP 콜 수가 아니다 — 실제 콜 수는 `dart_http_calls`
       * (일일 카운터 차분, 본문까지 받은 성공 호출만 셈)를 보라.
       */
      budget: {
        budget_ms: budget.budgetMs,
        prep_budget_ms: prepBudget.budgetMs,
        /** 기본 상수인가, 환경변수(`GONGSI_TIME_BUDGET_MS`)로 낮춘 값인가 */
        budget_source: budgetSource,
        elapsed_ms: budget.elapsedMs(),
        expired: budget.isExpired(),
        /** 예산이 **처음** 모자랐던 단계 (없으면 끝까지 여유가 있었다) */
        stopped_at: budget.stoppedAt,
        truncated: budgetTruncated,
        skipped: budgetSkipped,
        /** 단계별 소요 (ms) — 순차 실행이라 합이 elapsed_ms 에 가깝다 */
        stages: budget.stages(),
        /** 새 상류 호출을 시작할 최소 잔여 시간 (실측 단가 근거는 상수 주석) */
        min_start_ms: { list_call: MIN_LIST_CALL_MS, small_call: MIN_SMALL_CALL_MS, corp_index: MIN_CORP_INDEX_MS },
        ...(dartCallsBefore !== null && client
          ? { dart_http_calls: client.todayCalls() - dartCallsBefore }
          : {}),
      },
      /** 포털 소속회사 목록을 실제로 썼는가 — 'none' 이면 DART 상호 완전일치만으로 조인했다 */
      population_source: populationSource,
      population: {
        ...(populationGroup ? { group: populationGroup } : {}),
        ...(populationYearMonth ? { year_month: populationYearMonth } : {}),
        ...(population
          ? {
              joined_companies: population.corpCodes.size,
              unjoined_companies: population.unjoined.length,
              joined_group_at_known: population.joinedGroupAt?.size ?? 0,
            }
          : {}),
        ...(populationReason ? { reason: populationReason } : {}),
        /**
         * 자동 워밍 — 미조인 계열사의 법인등록번호를 실행 중에 채워 조인한 결과.
         * 대상(포털이 법인등록번호를 준 미조인 이름)이 없으면 아예 돌지 않아 이 키가 없다.
         */
        ...(warming ? { warming } : {}),
        /** 문서에서 집단명을 읽어 포털을 조회했는가 (rcept_no 경로 전용) */
        from_document: !input.group && populationSource === 'portal',
      },
      list_calls: listCalls,
      /**
       * ★ 이어보기 호출에서 **앞 호출이 받아 둔 목록을 그대로 쓴 회사 수**.
       *
       * 이 값이 있으면 `list_calls` 만 보고 대조 범위를 판단하면 안 된다 — 이번 호출은 목록을
       * 새로 받지 않았을 뿐, 판정은 `list_calls + 이 값` 만큼의 회사로 이뤄졌다. 실측 예:
       * 같은 문서를 한 번에 완주하면 `list_calls:12`, 3회로 이어 보면 마지막 호출이
       * `list_calls:2` + 이 값 `10` 이고 **판정 결과는 완전히 같다**(2026-09-07 대조 0건).
       */
      ...(contReused > 0 ? { lists_reused_from_continuation: contReused } : {}),
      /**
       * 동명 2건 이상을 **법인등록번호**(포털 jurirno ↔ DART 기업개황 jurir_no)로 확정한 건.
       * 이름으로는 고를 수 없던 회사이므로 근거를 남긴다.
       */
      jurir_disambiguation: {
        lookups: jurirLookups,
        lookup_budget: MAX_JURIR_LOOKUPS,
        max_candidates_per_name: MAX_JURIR_CANDIDATES,
        resolved: jurirResolved,
      },
      /**
       * J001 원문 열기 — 유형 미상 경로와 보고서명 경로가 **같은 예산**을 쓴다.
       * filings_needed = 접수번호 기준 유일 건수 / reads = 실제로 연 건수 /
       * ambiguous_resolved_to_exists = 유형 미상 공시가 원문 대조로 "공시 존재"가 된 판정 수 /
       * typed_* = 보고서명으로 유형이 확정된 매칭 공시의 상대방 대조 결과(판정 단위 — 한 공시가
       * 여러 판정에 걸릴 수 있다).
       */
      filing_docs: {
        filings_needed: filingDocReads.size,
        /** 새로 내려받은 건수 — 예산을 쓰는 것은 이것뿐이다 */
        fetches: filingDocFetches,
        /** 캐시에 이미 있어 콜 없이 읽은 건수 */
        cached_reads: filingDocCachedReads,
        fetch_budget: MAX_FILING_DOC_FETCHES,
        reads_total_budget: MAX_FILING_DOC_READS_TOTAL,
        over_budget: filingDocBudgetHits,
        /** **시간** 예산으로 열지 못한 건수 — 건수 예산 초과(over_budget)와 대응이 다르다 */
        over_deadline: filingDocDeadlineHits,
        read_errors: [...filingDocReads.values()].filter((r) => r.read === 'error').length,
        ambiguous_resolved_to_exists: ambiguousResolvedToExists,
        typed_confirmed: typedConfirmed,
        typed_unconfirmed: typedUnconfirmed,
        typed_unread: typedUnread,
      },
      companies_searched: searches.size,
      companies_over_budget: overBudgetKeys.size,
      partial_results: partialLists,
      j001_window: { lookback_days: LOOKBACK_DAYS, to: 'today' },
      near_window: { before_days: NEAR_BEFORE_DAYS, after_days: NEAR_AFTER_DAYS },
      /** (5) 상품·용역 총괄 매트릭스 — 파서 진단 + (6)과의 중복 제거 결과 */
      goods_services_matrix: {
        tables: goodsMatrixSeed.tables,
        cells: goodsMatrixSeed.cells.length,
        tables_unrecognized: goodsMatrixSeed.tablesUnrecognized,
        tables_without_unit: goodsMatrixSeed.tablesWithoutUnit,
        unit_inherited_tables: goodsMatrixSeed.unitInheritedTables,
        duplicate_pairs: goodsMatrixSeed.duplicatePairs,
        header_promoted_rows: goodsMatrixSeed.headerPromotedRows,
        ragged_rows: goodsMatrixSeed.raggedRows,
        /** (6) 주요 내역에 이미 있어 보완하지 않은 쌍 수 (중복 방지가 실제로 동작한 횟수) */
        pairs_also_in_major_detail: goodsMatrixPairsAlsoInDetail,
        /**
         * 그중 (5) 총액이 (6) 합산보다 커서 **(6) 신호의 판정 금액을 올린** 쌍 수.
         * 종전에는 (6)에 쌍이 있으면 (5) 값을 비교 없이 버려 이 차이가 통째로 사라졌다.
         */
        pairs_promoted_to_major_detail: goodsPromotedFromMatrix.length,
        /** 그 승격 중 차액이 가장 큰 것 (사람이 먼저 볼 것) */
        largest_promotion:
          goodsPromotedFromMatrix.length > 0
            ? (() => {
                const top = [...goodsPromotedFromMatrix].sort(
                  (x, y) => y.to - y.from - (x.to - x.from),
                )[0]!;
                return {
                  pair: top.pair,
                  major_detail_display: fmtWon(top.from),
                  matrix_display: fmtWon(top.to),
                  excess_display: fmtWon(top.to - top.from),
                };
              })()
            : undefined,
        /**
         * (6)의 '가.(분기)' 표와 '나.(연1회)' 표에 **모두** 실려 합산하지 않은 쌍 수.
         * 0 이 아니면 그 쌍들은 `label_overlap` 을 달고 나간다 (이중 계상 방지).
         */
        pairs_in_both_major_detail_tables: goodsLabelOverlaps,
        /** 이름은 달랐지만 (6)에 같은 매출회사·같은 금액 행이 있어 중복 의심으로 표시한 쌍 수 */
        possible_duplicates: goodsMatrixPossibleDuplicates,
        /** 회사 목록에서 확인되지 않은 매입회사 이름 (표기 흔들림·국외 계열사 등) */
        counterparties_not_in_known_list: [
          ...new Set(
            judgedGoodsMatrix
              .filter((m) => m.counterparty_in_known_list === false)
              .map((m) => m.counterparty),
          ),
        ],
      },
      securities_matrix: {
        tables: securitiesMatrix.tables,
        cells: securitiesMatrix.cells.length,
        tables_unrecognized: securitiesMatrix.tablesUnrecognized,
        tables_without_unit: securitiesMatrix.tablesWithoutUnit,
        unit_inherited_tables: securitiesMatrix.unitInheritedTables,
        duplicate_pairs: securitiesMatrix.duplicatePairs,
        header_promoted_rows: securitiesMatrix.headerPromotedRows,
        ragged_rows: securitiesMatrix.raggedRows,
        /** 회사 목록에서 확인되지 않은 거래상대방 이름 (표기 흔들림·국외 계열사 등) */
        counterparties_not_in_known_list: [
          ...new Set(
            judgedSecurities
              .filter((sec) => sec.counterparty_in_known_list === false)
              .map((sec) => sec.counterparty),
          ),
        ],
      },
    },
  };
}
