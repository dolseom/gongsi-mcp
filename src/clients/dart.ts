/**
 * OpenDART 클라이언트
 *
 * 참고 MCP(`dart_api.py`)의 검증된 설계를 옮기되 두 가지를 바꾼다:
 *  1. `last_reprt_at` 기본값 Y → **N**. Y는 정정으로 대체된 원본 제출분을 지워
 *     "의결일 대비 기한 초과" 판정을 불가능하게 만든다. (docs §3-4c)
 *  2. 페이지 상한에 걸려 잘리면 **`truncated` 로 알린다.** 참고 MCP는 상한만 올렸을 뿐
 *     여전히 조용히 자른다 — recall 사고의 본질은 상한값이 아니라 무고지였다. (docs §3-5)
 */

import { getConfig, USER_AGENT } from '../lib/config.js';
import { getLogger } from '../lib/logger.js';
import { getStore, nextKstMidnightIso } from '../lib/store.js';
import {
  DartApiError,
  MissingApiKeyError,
  RateLimitError,
  ToolError,
} from '../lib/errors.js';

const log = getLogger('dart');

const BASE_URL = 'https://opendart.fss.or.kr/api';
export const DAILY_LIMIT = 20_000;

export function viewerUrl(rceptNo: string): string {
  return `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}`;
}

/** DART status 코드별 조치 안내 (PRD §6.3) */
const STATUS_HINT: Record<string, string> = {
  '010': '등록되지 않은 인증키입니다. opendart.fss.or.kr 에서 발급받은 키인지 확인하세요.',
  '011': '사용할 수 없는 인증키입니다. 메일로 받은 인증 링크를 클릭했는지 확인하세요.',
  '012': '접근할 수 없는 IP입니다.',
  '013': '조회된 데이터가 없습니다.',
  '014': '파일이 존재하지 않습니다.',
  '020': '일일 요청 한도(20,000건)를 초과했습니다. 한국시간 자정에 리셋됩니다.',
  '021': '조회 가능한 회사 개수를 초과했습니다. 회사 수를 줄여 다시 요청하세요.',
  '100': '요청 파라미터 값이 부적절합니다.',
  '101': '부적절한 접근입니다.',
  '800': 'DART 시스템 점검 중입니다. 잠시 후 다시 시도하세요.',
  '900': 'DART 서버에서 정의되지 않은 오류가 발생했습니다.',
  '901': '인증키 사용자 계정의 개인정보 보유기간이 만료되었습니다. 계정을 갱신하세요.',
};

/** 공시 목록 한 건 */
export interface Disclosure {
  corp_code: string;
  corp_name: string;
  corp_cls: string;
  report_nm: string;
  rcept_no: string;
  flr_nm: string;
  rcept_dt: string;
  /** 비고. 공정위 제출분은 '공' 을 포함한다 ('공정' 처럼 복합 마커도 있으므로 포함 검사) */
  rm: string;
}

export interface ListParams {
  corpCode?: string;
  bgnDe?: string;
  endDe?: string;
  pblntfTy?: string;
  pblntfDetailTy?: string;
  corpCls?: string;
  pageNo?: number;
  pageCount?: number;
  /** 미지정 시 설정값(기본 false = 전수) */
  lastReportOnly?: boolean;
}

export interface ListPage {
  status: string;
  totalCount: number;
  totalPage: number;
  pageNo: number;
  list: Disclosure[];
}

export interface CollectResult {
  rows: Disclosure[];
  /** 페이지 상한에 걸려 잘렸는지 — 절대 조용히 넘기지 않는다 */
  truncated: boolean;
  /** 서버가 알려준 실제 전체 페이지 수 */
  totalPage: number;
  totalCount: number;
  /** 소비한 API 호출 수 */
  calls: number;
}

export class DartClient {
  private readonly apiKey: string;
  private readonly store = getStore();

  constructor(apiKey?: string) {
    const key = apiKey ?? getConfig().dartApiKey;
    if (!key) {
      throw new MissingApiKeyError('DART_API_KEY', 'DART 전자공시 조회에 필요합니다.');
    }
    this.apiKey = key;
  }

  /** 오늘 사용한 호출 수 */
  todayCalls(): number {
    return this.store.todayCallCount('dart');
  }

  /**
   * 한도 확인.
   * 하드스톱은 **원문 다운로드만** 막는다. 목록 조회까지 막으면 도구가 통째로 죽는다.
   */
  private checkRateLimit(requiresBodyFetch: boolean): void {
    const cfg = getConfig();
    const today = this.todayCalls();
    if (requiresBodyFetch && today >= cfg.rateHardStop) {
      throw new RateLimitError(today, DAILY_LIMIT, nextKstMidnightIso());
    }
    if (today >= cfg.rateWarn) {
      log.warn('일일 호출 한도 임박', { today, warn: cfg.rateWarn, limit: DAILY_LIMIT });
    }
  }

  private buildUrl(path: string, params: Record<string, unknown>): string {
    const sp = new URLSearchParams({ crtfc_key: this.apiKey });
    for (const [k, v] of Object.entries(params)) {
      // 빈 값은 키 자체를 빼야 한다 — OpenDART 는 빈값에 거동이 불안정하다
      if (v === undefined || v === null || v === '') continue;
      sp.set(k, String(v));
    }
    return `${BASE_URL}/${path}?${sp}`;
  }

  /**
   * 재시도 포함 요청. **본문 수신까지** 재시도 범위에 넣는다 —
   * 헤더만 받고 반환하면 body 읽기 중의 timeout/절단이 재시도되지 않는다(Codex 지적).
   * 대상: 네트워크 오류 · 429 · 5xx. 백오프 min(2^n, 8)초, 최대 3회.
   *
   * ⚠️ 예외 메시지에 URL을 절대 넣지 않는다 — 쿼리스트링에 인증키가 들어 있다.
   */
  private async request(
    path: string,
    params: Record<string, unknown>,
  ): Promise<{ status: number; contentType: string; bytes: Uint8Array }> {
    const cfg = getConfig();
    const url = this.buildUrl(path, params);
    let lastErrName = '';

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // NOTE: connect/read 타임아웃 분리는 undici Agent 가 필요하다.
        // 지금은 전체 타임아웃만 적용한다. (TODO: dispatcher 도입 시 분리)
        const res = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(cfg.readTimeoutMs),
        });

        if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
          log.warn('재시도 가능한 상태코드', { path, status: res.status, attempt: attempt + 1 });
          await sleep(Math.min(2 ** attempt, 8) * 1000);
          continue;
        }

        const bytes = new Uint8Array(await res.arrayBuffer());
        // 본문까지 온전히 받은 시점에만 카운트한다 (재시도는 성공분만)
        this.store.incrementCall('dart', 1);
        return {
          status: res.status,
          contentType: res.headers.get('content-type')?.toLowerCase() ?? '',
          bytes,
        };
      } catch (err) {
        lastErrName = err instanceof Error ? err.name : 'UnknownError';
        log.warn('요청 실패', { path, error: lastErrName, attempt: attempt + 1 });
        await sleep(Math.min(2 ** attempt, 8) * 1000);
      }
    }
    throw new ToolError('dart_api_error', `DART 요청이 3회 재시도 후에도 실패했습니다 (${lastErrName || 'HTTP 오류'}).`, {
      path,
    });
  }

  /** 응답 바이트 → JSON. 파싱 실패는 규격 에러로 바꾼다. */
  private parseJson(bytes: Uint8Array): Record<string, unknown> {
    try {
      const data: unknown = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      if (data && typeof data === 'object') return data as Record<string, unknown>;
    } catch {
      // 아래로
    }
    throw new DartApiError('invalid_json', 'DART 응답이 JSON 형식이 아닙니다.');
  }

  /**
   * 외부에서 온 메시지를 응답에 싣기 전 인증키 흔적을 걷어낸다.
   * 프록시·서버가 요청 URL 을 메시지에 반사하는 경우를 대비한 방어다(Codex 지적).
   */
  private sanitize(message: string): string {
    let out = message.split(this.apiKey).join('***');
    out = out.replace(/crtfc_key=[^&\s"']+/g, 'crtfc_key=***');
    return out;
  }

  private handleStatus(status: string, message: string, allowEmpty: boolean): void {
    if (status === '000') return;
    if (status === '013' && allowEmpty) return;
    if (status === '020') {
      throw new RateLimitError(this.todayCalls(), DAILY_LIMIT, nextKstMidnightIso());
    }
    throw new DartApiError(status, this.sanitize(message || '(메시지 없음)'), STATUS_HINT[status]);
  }

  /** 공시 목록 한 페이지 */
  async listPage(p: ListParams): Promise<ListPage> {
    this.checkRateLimit(false);
    const cfg = getConfig();
    const lastOnly = p.lastReportOnly ?? cfg.lastReportOnly;

    const { bytes } = await this.request('list.json', {
      corp_code: p.corpCode,
      bgn_de: p.bgnDe,
      end_de: p.endDe,
      pblntf_ty: p.pblntfTy,
      pblntf_detail_ty: p.pblntfDetailTy,
      corp_cls: p.corpCls,
      // ⚠️ 기본 N. Y로 바꾸면 정정 이전 원본이 사라져 지연 판정이 불가능해진다.
      last_reprt_at: lastOnly ? 'Y' : 'N',
      page_no: p.pageNo ?? 1,
      page_count: p.pageCount ?? 100,
      sort: 'date',
      sort_mth: 'desc',
    });

    const data = this.parseJson(bytes);
    const status = String(data['status'] ?? '');
    this.handleStatus(status, String(data['message'] ?? ''), true);

    if (status === '013') {
      return { status, totalCount: 0, totalPage: 0, pageNo: p.pageNo ?? 1, list: [] };
    }
    return {
      status,
      totalCount: Number(data['total_count'] ?? 0),
      totalPage: Number(data['total_page'] ?? 1),
      pageNo: Number(data['page_no'] ?? p.pageNo ?? 1),
      list: (data['list'] as Disclosure[] | undefined) ?? [],
    };
  }

  /**
   * 총 건수만 재는 1회 호출. 적응형 분할과 범위 사전 예측에 쓴다.
   * `page_count=1` 로 최소 페이로드만 받는다.
   */
  async measure(p: ListParams): Promise<number> {
    const page = await this.listPage({ ...p, pageNo: 1, pageCount: 1 });
    return page.totalCount;
  }

  /**
   * 페이지네이션 전체 수집.
   * `total_page` 를 보고 자동 종료하므로 상한을 올려도 불필요한 호출은 생기지 않는다.
   * 상한에 걸리면 `truncated: true` 와 실제 `totalPage` 를 함께 돌려준다.
   */
  async collect(p: ListParams, maxPages?: number): Promise<CollectResult> {
    const limit = Math.max(1, maxPages ?? getConfig().maxPages);
    const rows: Disclosure[] = [];
    let pageNo = 1;
    let totalPage = 1;
    let totalCount = 0;
    let calls = 0;

    do {
      const page = await this.listPage({ ...p, pageNo });
      calls++;
      rows.push(...page.list);
      totalPage = page.totalPage;
      totalCount = page.totalCount;
      if (page.list.length === 0) break;
      pageNo++;
    } while (pageNo <= Math.min(totalPage, limit));

    // 상한 초과만 보면 중간 빈 페이지로 인한 조기 종료를 놓친다(Codex 지적) —
    // 수집 건수가 서버 신고 총건수에 못 미치면 그것도 절단이다.
    const truncated = totalPage > limit || rows.length < totalCount;
    if (truncated) {
      log.warn('결과가 완전하지 않습니다 (페이지 상한 또는 조기 종료)', {
        totalPage,
        maxPages: limit,
        collected: rows.length,
        totalCount,
      });
    }
    return { rows, truncated, totalPage, totalCount, calls };
  }

  /**
   * 공시 원문 ZIP 다운로드.
   * DART 는 오류도 HTTP 200 + JSON 으로 주므로 **`PK` 매직을 먼저 검사**한다.
   */
  async downloadDocument(rceptNo: string): Promise<Uint8Array> {
    this.checkRateLimit(true);
    const { bytes } = await this.request('document.xml', { rcept_no: rceptNo });

    if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return bytes; // 'PK'

    // ZIP 이 아니면 오류 페이로드다
    const text = new TextDecoder('utf-8').decode(bytes.slice(0, 2000));
    const m = /"status"\s*:\s*"(\d+)"/.exec(text);
    const msg = /"message"\s*:\s*"([^"]*)"/.exec(text);
    if (m?.[1]) this.handleStatus(m[1], msg?.[1] ?? '', false);
    throw new DartApiError(
      'invalid_payload',
      `원문이 ZIP 형식이 아닙니다 (${bytes.length} bytes)`,
      `접수번호 ${rceptNo} 를 확인하세요.`,
    );
  }

  /** 법인코드 전체 ZIP (CORPCODE.xml) */
  async downloadCorpCode(): Promise<Uint8Array> {
    this.checkRateLimit(false);
    const { bytes } = await this.request('corpCode.xml', {});
    if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return bytes;

    const text = new TextDecoder('utf-8').decode(bytes.slice(0, 2000));
    const m = /"status"\s*:\s*"(\d+)"/.exec(text);
    const msg = /"message"\s*:\s*"([^"]*)"/.exec(text);
    if (m?.[1]) this.handleStatus(m[1], msg?.[1] ?? '', false);
    throw new DartApiError('invalid_payload', '법인코드 응답이 ZIP 형식이 아닙니다.');
  }

  /**
   * 단일회사 전체 재무제표 (fnlttSinglAcntAll).
   * reprt_code: 11011 사업 / 11012 반기 / 11013 1분기 / 11014 3분기
   * 데이터 없음(013)은 빈 배열로 돌려준다 — CFS→OFS 폴백 판단은 호출부가 한다.
   */
  async financialStatements(p: {
    corpCode: string;
    bsnsYear: string;
    reprtCode: string;
    fsDiv: 'CFS' | 'OFS';
  }): Promise<Array<Record<string, unknown>>> {
    this.checkRateLimit(false);
    const { bytes } = await this.request('fnlttSinglAcntAll.json', {
      corp_code: p.corpCode,
      bsns_year: p.bsnsYear,
      reprt_code: p.reprtCode,
      fs_div: p.fsDiv,
    });
    const data = this.parseJson(bytes);
    const status = String(data['status'] ?? '');
    this.handleStatus(status, String(data['message'] ?? ''), true);
    if (status === '013') return [];
    return (data['list'] as Array<Record<string, unknown>> | undefined) ?? [];
  }

  /** 기업개황 — `jurir_no`(법인등록번호)를 얻는 유일한 경로다 */
  async companyProfile(corpCode: string): Promise<Record<string, unknown>> {
    this.checkRateLimit(false);
    const { bytes } = await this.request('company.json', { corp_code: corpCode });
    const data = this.parseJson(bytes);
    this.handleStatus(String(data['status'] ?? ''), String(data['message'] ?? ''), false);
    return data;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
