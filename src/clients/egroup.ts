/**
 * 공정거래위원회 기업집단포털 클라이언트 (공공데이터포털)
 *
 * ⚠️ 함정 둘 (CLAUDE.local.md):
 *  1. **`User-Agent` 헤더가 없으면 HTTP 403 `Forbidden`** (순수 텍스트)이 온다.
 *     키·활용신청 문제로 오진하기 쉽다.
 *  2. 인증키는 계정당 1개를 모든 API가 공유하지만 **활용신청은 서비스별로 따로** 해야 한다.
 *     미신청 서비스는 같은 키로도 403이다 → 대조군을 때려 키인지 신청인지 가른다.
 *
 * 갱신주기는 연 1회(매년 5/1 기준)다. 캐시 TTL 1년, 5월 초 무효화.
 */

import { getConfig } from '../lib/config.js';
import { getLogger } from '../lib/logger.js';
import { getStore } from '../lib/store.js';
import { MissingApiKeyError, ToolError, UpstreamForbiddenError } from '../lib/errors.js';

const log = getLogger('egroup');

const BASE = 'https://apis.data.go.kr/1130000';

/** 기업집단 (지정 현황) */
export interface GroupSummary {
  /** 기업집단명 */
  unityGrupNm: string;
  /** 기업집단코드 (예: 삼성 K1000032) */
  unityGrupCode: string;
  /** 동일인 */
  smerNm: string;
  /** 대표회사 */
  repreCmpny: string;
  /** 소속회사 수 */
  sumCmpnyCo: string;
  /** 출자총액 제한 여부 */
  invstmntLmtt: string;
}

/** 소속회사 */
export interface Affiliate {
  /** 회사명 (한글 음차 표기 — DART 의 영문 약어 표기와 다르다) */
  entrprsNm: string;
  /** 법인등록번호 — DART `jurir_no` 와의 조인 키 */
  jurirno: string;
  /** 사업자등록번호 — 2차 검증 키 */
  bizrno: string;
  rprsntvNm: string;
  /** 설립일 */
  fondDe: string;
  /** 계열편입일 */
  grinil: string;
}

/** 재무현황 — 단위는 전부 **원** */
export interface AffiliateFinance {
  entrprsNm: string;
  jurirno: string;
  assetsTotamt: string;
  /** 자본총액 — 기준금액 산정의 '자본총계' */
  caplTotamt: string;
  /** 자본금 */
  caplAmount: string;
  debtTotamt: string;
  selngAmount: string;
  thstrmNtpfAmount: string;
  /** 결산일 */
  stacntDudt: string;
}

type ServiceName =
  | 'publicYmList'
  | 'appnGroupSttusList'
  | 'appnGroupAffiList'
  | 'financeCompSttusList';

export class EgroupClient {
  private readonly serviceKey: string;
  private readonly store = getStore();

  constructor(serviceKey?: string) {
    const key = serviceKey ?? getConfig().egroupApiKey;
    if (!key) {
      throw new MissingApiKeyError(
        'EGROUP_API_KEY',
        '공정위 기업집단포털(기업집단 구조·계열사·재무) 조회에 필요합니다. 미설정 시 DART 단독 기능만 동작합니다.',
      );
    }
    this.serviceKey = key;
  }

  todayCalls(): number {
    return this.store.todayCallCount('egroup');
  }

  private async call<T>(service: ServiceName, params: Record<string, unknown>): Promise<T[]> {
    const cfg = getConfig();
    const sp = new URLSearchParams({ serviceKey: this.serviceKey, resultType: 'json' });
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      sp.set(k, String(v));
    }
    const url = `${BASE}/${service}/${service}Api?${sp}`;

    let res: Response;
    try {
      res = await fetch(url, {
        // ⚠️ 이 헤더가 없으면 403 이다. 지우지 말 것.
        headers: { 'User-Agent': 'dart-ftc-mcp/0.1.0' },
        signal: AbortSignal.timeout(cfg.readTimeoutMs),
      });
    } catch (err) {
      throw new ToolError(
        'egroup_api_error',
        `기업집단포털 요청에 실패했습니다 (${err instanceof Error ? err.name : '알 수 없는 오류'}).`,
        { service },
      );
    }
    this.store.incrementCall('egroup', 1);

    if (res.status === 403) throw new UpstreamForbiddenError(service);
    if (!res.ok) {
      throw new ToolError('egroup_api_error', `기업집단포털이 HTTP ${res.status} 를 반환했습니다.`, {
        service,
        status: res.status,
      });
    }

    const text = await res.text();
    // resultType=json 을 줘도 XML 로 돌아오는 경우가 있다
    if (!text.trimStart().startsWith('{')) {
      return parseXmlItems<T>(text);
    }
    const data = JSON.parse(text) as Record<string, unknown>;
    const body = (data['response'] as Record<string, unknown> | undefined)?.['body'] ?? data;
    const items = (body as Record<string, unknown>)?.['items'];
    if (!items) return [];
    const item = (items as Record<string, unknown>)['item'] ?? items;
    return (Array.isArray(item) ? item : [item]) as T[];
  }

  /** 공개년월 목록. jobSeCode: 0001 지정현황 / 0003 지주회사 */
  async publicYearMonths(jobSeCode: '0001' | '0003', presentnYear?: string): Promise<unknown[]> {
    return this.call('publicYmList', { jobSeCode, presentnYear });
  }

  /** 지정 기업집단 목록. presentnYear 는 YYYYMM (예: 202605) */
  async groups(presentnYear: string): Promise<GroupSummary[]> {
    return this.call<GroupSummary>('appnGroupSttusList', { presentnYear, numOfRows: 200 });
  }

  /** 소속회사 전수 — 공시의무 모집단이다 */
  async affiliates(presentnYear: string, unityGrupCode: string): Promise<Affiliate[]> {
    return this.call<Affiliate>('appnGroupAffiList', {
      presentnYear,
      unityGrupCode,
      numOfRows: 500,
    });
  }

  /** 계열사 재무현황. jurirno 로 특정 회사만 조회할 수 있다. 단위는 원. */
  async finances(
    presentnYear: string,
    unityGrupCode: string,
    jurirno?: string,
  ): Promise<AffiliateFinance[]> {
    return this.call<AffiliateFinance>('financeCompSttusList', {
      presentnYear,
      unityGrupCode,
      jurirno,
      numOfRows: 500,
    });
  }

  /** 기업집단명으로 코드를 찾는다. 부분일치 후보도 함께 돌려준다. */
  async findGroup(
    name: string,
    presentnYear: string,
  ): Promise<{ exact: GroupSummary | null; candidates: GroupSummary[] }> {
    const all = await this.groups(presentnYear);
    const norm = (s: string) => s.replace(/[\s()㈜]/g, '');
    const target = norm(name);
    const exact = all.find((g) => norm(g.unityGrupNm) === target) ?? null;
    const candidates = exact ? [] : all.filter((g) => norm(g.unityGrupNm).includes(target)).slice(0, 5);
    log.debug('기업집단 조회', { name, found: !!exact, candidates: candidates.length });
    return { exact, candidates };
  }
}

/** XML 응답에서 <item> 들을 뽑는다 (정규식 — 스키마가 단순하고 평면적이다) */
function parseXmlItems<T>(xml: string): T[] {
  const out: T[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const inner = m[1] ?? '';
    const obj: Record<string, string> = {};
    const fieldRe = /<([A-Za-z0-9_]+)>([\s\S]*?)<\/\1>/g;
    let f: RegExpExecArray | null;
    while ((f = fieldRe.exec(inner)) !== null) {
      const key = f[1];
      if (key) obj[key] = decodeXmlEntities((f[2] ?? '').trim());
    }
    out.push(obj as T);
  }
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
