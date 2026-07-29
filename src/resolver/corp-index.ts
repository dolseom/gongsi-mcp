/**
 * 법인 인덱스 — `corpCode.xml` 적재와 식별자 해석
 *
 * DART 는 118,000여 개 법인을 ZIP(약 3.4MB → 28MB XML)으로 한 번에 준다.
 * 비상장이 96.6%이며, **공정위공시 대상 대부분이 여기 속한다** — 상장사 위주로 설계된
 * 기존 DART MCP 들이 사실상 다루지 않는 영역이다.
 *
 * ⚠️ `corpCode.xml` 에는 **법인등록번호(`jurir_no`)가 없다.** 기업개황 API 를 법인별로
 * 따로 호출해야 얻는다. 이 번호가 기업집단포털과의 유일한 신뢰 조인 키다.
 */

import type { DartClient } from '../clients/dart.js';
import { getStore, type CorpRecord } from '../lib/store.js';
import { getLogger } from '../lib/logger.js';
import { readFirstEntry } from '../lib/zip.js';
import { AmbiguousCorpError, CorpNotFoundError, ToolError } from '../lib/errors.js';

const log = getLogger('corp-index');

/** 적재 후 이만큼 지나면 갱신을 권한다 (DART 는 매일 갱신되지만 변동은 완만하다) */
const REFRESH_AFTER_DAYS = 7;
const LOADED_AT_KEY = 'corps_loaded_at';

/** `corpCode.xml` 을 내려받아 corps 테이블에 적재한다 */
export async function loadCorpIndex(client: DartClient): Promise<number> {
  const store = getStore();
  log.info('법인코드 전체 다운로드 시작');
  const zip = await client.downloadCorpCode();

  const entry = readFirstEntry(zip, (n) => n.toLowerCase().endsWith('.xml'));
  if (!entry) throw new Error('법인코드 ZIP 안에 XML이 없습니다.');

  const xml = new TextDecoder('utf-8').decode(entry.content);
  const records = parseCorpCodeXml(xml);
  const n = store.upsertCorps(records);
  store.set(LOADED_AT_KEY, new Date().toISOString());
  log.info('법인코드 적재 완료', { records: n, total: store.corpCount() });
  return n;
}

/** corps 가 비어 있으면 1회 적재한다 */
export async function ensureCorpIndex(client: DartClient): Promise<void> {
  const store = getStore();
  if (store.corpCount() > 0) return;
  await loadCorpIndex(client);
}

/** 적재한 지 오래됐는지 */
export function corpIndexIsStale(): boolean {
  const at = getStore().get(LOADED_AT_KEY);
  if (!at) return true;
  const age = Date.now() - new Date(at).getTime();
  return age > REFRESH_AFTER_DAYS * 86_400_000;
}

/**
 * `corpCode.xml` 파싱.
 * 구조가 평면적이라 정규식으로 충분하다 (실측: 118,556건 약 50ms).
 */
export function parseCorpCodeXml(xml: string): CorpRecord[] {
  const out: CorpRecord[] = [];
  const listRe = /<list>([\s\S]*?)<\/list>/g;
  let m: RegExpExecArray | null;
  while ((m = listRe.exec(xml)) !== null) {
    const inner = m[1] ?? '';
    const corpCode = field(inner, 'corp_code');
    const corpName = field(inner, 'corp_name');
    if (!corpCode || !corpName) continue;
    const stockCode = field(inner, 'stock_code');
    const modifyDate = field(inner, 'modify_date');
    out.push({
      corpCode,
      corpName,
      // 비상장은 공백 문자열로 온다
      stockCode: stockCode || null,
      jurirNo: null, // corpCode.xml 에는 없다 — 기업개황 API 로만 얻는다
      modifyDate: modifyDate || null,
    });
  }
  return out;
}

function field(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return decodeEntities((m?.[1] ?? '').trim());
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 상호 정규화 — 법인격 표기·공백 차이를 흡수한다.
 * 법인격은 **앞·뒤에서만** 걷어낸다 — 상호 중간에 "주식회사"가 들어간 회사가 실재할 수 있어
 * 위치 무관 제거는 서로 다른 법인을 같은 이름으로 뭉갤 위험이 있다(Codex 지적).
 */
const CORP_SUFFIX =
  '(?:주식회사|유한회사|유한책임회사|합자회사|합명회사|재단법인|사단법인|\\(주\\)|㈜|\\(유\\)|\\(재\\)|\\(사\\))';
const CORP_LEAD_RE = new RegExp(`^${CORP_SUFFIX}`);
const CORP_TAIL_RE = new RegExp(`${CORP_SUFFIX}$`);

export function normalizeName(name: string): string {
  let s = name.replace(/\s+/g, '');
  s = s.replace(CORP_LEAD_RE, '').replace(CORP_TAIL_RE, '');
  return s.toLowerCase();
}

export type IdentifierKind = 'corp_code' | 'stock_code' | 'jurir_no' | 'name';

/** 입력이 어떤 식별자인지 판정한다 */
export function detectIdentifier(query: string): IdentifierKind {
  const q = query.trim();
  if (/^\d{8}$/.test(q)) return 'corp_code';
  if (/^\d{6}$/.test(q)) return 'stock_code';
  if (/^\d{13}$/.test(q) || /^\d{6}-?\d{7}$/.test(q)) return 'jurir_no';
  return 'name';
}

export interface ResolveOptions {
  /** 상호가 여러 법인에 걸릴 때 예외 대신 후보를 돌려받는다 */
  allowAmbiguous?: boolean;
  /** 법인등록번호가 없으면 기업개황 API 로 채운다 (호출 1회 소비) */
  fetchJurirNo?: boolean;
}

export interface ResolvedCorp extends CorpRecord {
  /** 어떤 식별자로 찾았는지 */
  matchedBy: IdentifierKind;
  /** 상호 완전일치가 아니라 정규화 후 일치인 경우 */
  normalizedMatch?: boolean;
}

/**
 * 회사 하나를 특정한다.
 *
 * 동명 법인이 실제로 많다(삼성물산 2건, 에스티엠 4건 — 합병 전후 별개 법인).
 * 이럴 때 임의로 하나를 고르지 않고 `AmbiguousCorpError` 로 후보를 돌려준다.
 */
export async function resolveCorp(
  query: string,
  client: DartClient,
  opts: ResolveOptions = {},
): Promise<ResolvedCorp | { ambiguous: true; candidates: CorpRecord[] }> {
  const store = getStore();
  await ensureCorpIndex(client);

  const q = query.trim();
  const kind = detectIdentifier(q);

  let matches: CorpRecord[] = [];
  let normalizedMatch = false;

  switch (kind) {
    case 'corp_code': {
      const rec = store.getCorpByCode(q);
      matches = rec ? [rec] : [];
      break;
    }
    case 'stock_code':
      matches = store.findCorpsByStockCode(q);
      break;
    case 'jurir_no':
      matches = store.findCorpsByJurirNo(q.replace(/-/g, ''));
      break;
    case 'name': {
      matches = store.findCorpsByName(q);
      if (!matches.length) {
        // 법인격 표기·공백만 다른 경우를 흡수한다
        const target = normalizeName(q);
        const near = store.searchCorpsByName(q.replace(/\(주\)|㈜|주식회사|\s+/g, ''), 50);
        matches = near.filter((c) => normalizeName(c.corpName) === target);
        normalizedMatch = matches.length > 0;
      }
      break;
    }
  }

  // 숫자 형식은 "추정"일 뿐이다 — 상호가 숫자로만 된 회사가 있을 수 있으므로(Codex 지적)
  // 코드 조회가 비면 이름으로 한 번 더 본다
  if (matches.length === 0 && kind !== 'name') {
    const byName = store.findCorpsByName(q);
    if (byName.length) matches = byName;
  }

  if (matches.length === 0) {
    if (kind === 'jurir_no') {
      // corpCode.xml 에는 법인등록번호가 없다 — 기업개황 API 로 채워진 회사만 이 경로로 찾아진다
      throw new ToolError(
        'corp_not_found',
        `법인등록번호 '${q}' 로 등록된 회사가 인덱스에 없습니다. ` +
          `법인등록번호는 회사를 한 번이라도 조회해 기업개황을 채운 뒤에만 검색됩니다. ` +
          `회사명이나 corp_code 로 먼저 조회하세요 (fetchJurirNo=true 권장).`,
        { query: q },
      );
    }
    const suggestions = store
      .searchCorpsByName(q.length > 2 ? q.slice(0, Math.max(2, q.length - 1)) : q, 5)
      .map((c) => ({ corpCode: c.corpCode, corpName: c.corpName }));
    throw new CorpNotFoundError(q, suggestions);
  }

  if (matches.length > 1) {
    if (opts.allowAmbiguous) return { ambiguous: true, candidates: matches };
    throw new AmbiguousCorpError(
      q,
      matches.map((c) => ({
        corp_code: c.corpCode,
        corp_name: c.corpName,
        stock_code: c.stockCode,
        jurir_no: c.jurirNo,
      })),
    );
  }

  const found = matches[0]!;
  const result: ResolvedCorp = { ...found, matchedBy: kind };
  if (normalizedMatch) result.normalizedMatch = true;

  if (opts.fetchJurirNo && !found.jurirNo) {
    const jurirNo = await fetchJurirNo(found.corpCode, client);
    if (jurirNo) result.jurirNo = jurirNo;
  }
  return result;
}

/**
 * 기업개황 API 로 법인등록번호를 채운다.
 * `corpCode.xml` 에 없는 유일한 핵심 필드이며, 기업집단포털 조인의 전제다.
 */
export async function fetchJurirNo(corpCode: string, client: DartClient): Promise<string | null> {
  const store = getStore();
  const cached = store.getCorpByCode(corpCode);
  if (cached?.jurirNo) return cached.jurirNo;

  try {
    const profile = await client.companyProfile(corpCode);
    const jurirNo = String(profile['jurir_no'] ?? '').replace(/-/g, '').trim();
    if (jurirNo) {
      store.setJurirNo(corpCode, jurirNo);
      return jurirNo;
    }
  } catch (err) {
    log.warn('기업개황 조회 실패', {
      corpCode,
      error: err instanceof Error ? err.name : String(err),
    });
  }
  return null;
}
