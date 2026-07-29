/**
 * 로컬 저장소 — `node:sqlite` 얇은 어댑터
 *
 * 이 파일이 SQLite 를 아는 **유일한 곳**이다. 나머지 코드는 여기 인터페이스만 쓴다.
 * `node:sqlite` 는 아직 experimental 이므로, API가 바뀌거나 다른 드라이버로 갈아타야 할 때
 * 호출부를 건드리지 않고 이 파일만 교체할 수 있어야 한다.
 * (docs/absorbed-from-dart-mcp.md §2-4)
 *
 * 저장 대상 — 무엇을 캐시하지 *않는지*가 더 중요하다:
 *   ✅ corps(법인코드 인덱스) · bodies(공시 원문) · call_log(일일 호출) · kv(기타 상태)
 *   ❌ **공시 목록은 절대 캐시하지 않는다.** 공시담당자에게는 신선도가 최우선이고,
 *      "방금 접수된 공시"가 안 보이면 도구를 신뢰하지 않는다.
 */

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getConfig } from './config.js';
import { getLogger } from './logger.js';

const log = getLogger('store');

/**
 * `node:sqlite` 는 정적 import 하지 않는다.
 *
 * vite 5 / vite-node 는 `node:` 접두사를 벗긴 뒤 `module.builtinModules` 로 내장 여부를 판단하는데,
 * Node 는 experimental 모듈을 `'node:sqlite'` 로만 등록하고 `'sqlite'` 는 넣지 않는다.
 *   builtinModules.includes('sqlite')      → false
 *   builtinModules.includes('node:sqlite') → true
 * 그래서 번들러가 `sqlite` 라는 패키지를 찾으려다 실패한다(테스트 실행이 통째로 깨진다).
 *
 * `createRequire` 로 로드하면 정적 분석 대상에서 빠지고, 런타임에는 Node 가 내장 모듈로 정상 해석한다.
 * 타입은 `typeof import(...)` 로 가져오므로 타입 안전성은 그대로다.
 */
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;

/** KST 기준 오늘 (YYYY-MM-DD). DART 한도 리셋이 한국시간 자정 기준이다. */
export function todayKst(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

/** 다음 KST 자정 (ISO). rate limit 응답의 `resetAtKst` 로 쓴다. */
export function nextKstMidnightIso(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  kst.setUTCHours(0, 0, 0, 0);
  kst.setUTCDate(kst.getUTCDate() + 1);
  return new Date(kst.getTime() - 9 * 60 * 60 * 1000).toISOString();
}

export interface CorpRecord {
  corpCode: string;
  corpName: string;
  stockCode: string | null;
  jurirNo: string | null;
  modifyDate: string | null;
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS corps (
     corp_code   TEXT PRIMARY KEY,
     corp_name   TEXT NOT NULL,
     stock_code  TEXT,
     jurir_no    TEXT,
     modify_date TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_corps_name ON corps(corp_name)`,
  // 법인등록번호는 기업집단포털 조인 키다 — 이 프로젝트 최대의 기술 자산
  `CREATE INDEX IF NOT EXISTS idx_corps_jurir ON corps(jurir_no)`,
  `CREATE INDEX IF NOT EXISTS idx_corps_stock ON corps(stock_code)`,
  `CREATE TABLE IF NOT EXISTS call_log (
     date  TEXT NOT NULL,
     api   TEXT NOT NULL,
     count INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (date, api)
   )`,
  `CREATE TABLE IF NOT EXISTS kv (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

// FTS5 는 빌드에 따라 없을 수 있어 실패를 허용한다 (원문 검색만 비활성화된다)
const FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS bodies USING fts5(
   rcept_no UNINDEXED, content, fetched_at UNINDEXED, rm UNINDEXED,
   tokenize='trigram')`;

export class Store {
  private db: DatabaseSync;
  /** FTS5 를 쓸 수 있는지. 없으면 원문 전문검색만 막고 나머지는 정상 동작한다. */
  readonly ftsAvailable: boolean;

  constructor(path?: string) {
    const dbPath = path ?? getConfig().cacheDbPath;
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
    for (const stmt of DDL) this.db.exec(stmt);

    let fts = false;
    try {
      this.db.exec(FTS_DDL);
      fts = true;
    } catch (err) {
      log.warn('FTS5 사용 불가 — 원문 전문검색이 비활성화됩니다', {
        reason: err instanceof Error ? err.name : String(err),
      });
    }
    this.ftsAvailable = fts;
  }

  close(): void {
    this.db.close();
  }

  // ---- 일일 호출 카운터 ----

  /** 호출 1건 기록하고 오늘 누계를 반환한다 */
  incrementCall(api: 'dart' | 'egroup', n = 1): number {
    const date = todayKst();
    this.db
      .prepare(
        `INSERT INTO call_log(date, api, count) VALUES (?, ?, ?)
         ON CONFLICT(date, api) DO UPDATE SET count = count + excluded.count`,
      )
      .run(date, api, n);
    return this.todayCallCount(api);
  }

  todayCallCount(api: 'dart' | 'egroup'): number {
    const row = this.db
      .prepare(`SELECT count FROM call_log WHERE date = ? AND api = ?`)
      .get(todayKst(), api) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  /** 오래된 카운터 정리 */
  purgeCallLog(keepDays = 90): void {
    const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString().slice(0, 10);
    this.db.prepare(`DELETE FROM call_log WHERE date < ?`).run(cutoff);
  }

  // ---- 법인 인덱스 ----

  upsertCorps(records: CorpRecord[]): number {
    if (!records.length) return 0;
    const stmt = this.db.prepare(
      `INSERT INTO corps(corp_code, corp_name, stock_code, jurir_no, modify_date)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(corp_code) DO UPDATE SET
         corp_name   = excluded.corp_name,
         stock_code  = excluded.stock_code,
         -- jurir_no 는 별도 API로만 얻으므로 새 값이 없으면 기존 값을 지키다
         jurir_no    = COALESCE(excluded.jurir_no, corps.jurir_no),
         modify_date = excluded.modify_date`,
    );
    this.db.exec('BEGIN');
    try {
      for (const r of records) {
        stmt.run(r.corpCode, r.corpName, r.stockCode, r.jurirNo, r.modifyDate);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return records.length;
  }

  corpCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM corps`).get() as { n?: number };
    return Number(row?.n ?? 0);
  }

  getCorpByCode(corpCode: string): CorpRecord | null {
    const row = this.db.prepare(`SELECT * FROM corps WHERE corp_code = ?`).get(corpCode);
    return row ? toCorp(row) : null;
  }

  /** 상호 완전일치. 동명 법인이 여럿일 수 있어 배열로 돌려준다. */
  findCorpsByName(name: string): CorpRecord[] {
    const rows = this.db.prepare(`SELECT * FROM corps WHERE corp_name = ?`).all(name);
    return rows.map(toCorp);
  }

  /** 상호 부분일치 — 후보 제안용 */
  searchCorpsByName(fragment: string, limit = 5): CorpRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM corps WHERE corp_name LIKE ? LIMIT ?`)
      .all(`%${fragment}%`, limit);
    return rows.map(toCorp);
  }

  /** 법인등록번호로 조회 — 기업집단포털 `jurirno` 와의 조인 키 */
  findCorpsByJurirNo(jurirNo: string): CorpRecord[] {
    const rows = this.db.prepare(`SELECT * FROM corps WHERE jurir_no = ?`).all(jurirNo);
    return rows.map(toCorp);
  }

  /** 종목코드(6자리)로 조회 */
  findCorpsByStockCode(stockCode: string): CorpRecord[] {
    const rows = this.db.prepare(`SELECT * FROM corps WHERE stock_code = ?`).all(stockCode);
    return rows.map(toCorp);
  }

  setJurirNo(corpCode: string, jurirNo: string): void {
    this.db.prepare(`UPDATE corps SET jurir_no = ? WHERE corp_code = ?`).run(jurirNo, corpCode);
  }

  // ---- 공시 원문 ----

  hasBody(rceptNo: string): boolean {
    if (!this.ftsAvailable) return false;
    const row = this.db.prepare(`SELECT 1 AS x FROM bodies WHERE rcept_no = ?`).get(rceptNo);
    return row !== undefined;
  }

  getBody(rceptNo: string): { rceptNo: string; content: string; fetchedAt: string } | null {
    if (!this.ftsAvailable) return null;
    const row = this.db
      .prepare(`SELECT rcept_no, content, fetched_at FROM bodies WHERE rcept_no = ?`)
      .get(rceptNo) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      rceptNo: String(row['rcept_no']),
      content: String(row['content']),
      fetchedAt: String(row['fetched_at']),
    };
  }

  /**
   * 원문 저장. 재저장은 DELETE + INSERT 를 한 트랜잭션으로 한다 —
   * FTS5 는 REPLACE 거동에 편차가 있다.
   * 파싱에 실패한 원문도 빈 문자열로 저장해 재다운로드를 막는다.
   */
  storeBody(rceptNo: string, content: string, rm = ''): void {
    if (!this.ftsAvailable) return;
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`DELETE FROM bodies WHERE rcept_no = ?`).run(rceptNo);
      this.db
        .prepare(`INSERT INTO bodies(rcept_no, content, fetched_at, rm) VALUES (?, ?, ?, ?)`)
        .run(rceptNo, content, new Date().toISOString(), rm);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  invalidateBody(rceptNo: string): void {
    if (!this.ftsAvailable) return;
    this.db.prepare(`DELETE FROM bodies WHERE rcept_no = ?`).run(rceptNo);
  }

  /**
   * 원문 키워드 검색.
   * trigram 토크나이저는 3글자 미만을 매칭하지 못하므로 2글자 이하는 LIKE 로 폴백한다.
   */
  searchBodies(keyword: string, rceptNos?: string[], limit = 100): Array<{ rceptNo: string; snippet: string }> {
    if (!this.ftsAvailable) return [];
    const kw = keyword.trim();
    if (!kw) return [];
    if (rceptNos && rceptNos.length === 0) return [];
    // SQLite 바인딩 변수 한도(구버전 999) 방어 — 대상 집합이 크면 잘라서 처리한다
    if (rceptNos && rceptNos.length > 500) {
      const out: Array<{ rceptNo: string; snippet: string }> = [];
      for (let i = 0; i < rceptNos.length && out.length < limit; i += 500) {
        out.push(...this.searchBodies(kw, rceptNos.slice(i, i + 500), limit - out.length));
      }
      return out;
    }

    const filter = rceptNos ? ` AND rcept_no IN (${rceptNos.map(() => '?').join(',')})` : '';
    const params: unknown[] = [];

    if (kw.length >= 3) {
      // MATCH 는 자체 질의 문법이 있어 `"`·`OR` 같은 입력이 구문 오류를 일으킨다(Codex 지적).
      // 사용자 키워드는 항상 구문 요소가 아닌 **문자열 리터럴(구문)** 로 감싼다.
      params.push(`"${kw.replace(/"/g, '""')}"`);
      if (rceptNos) params.push(...rceptNos);
      params.push(limit);
      const rows = this.db
        .prepare(
          `SELECT rcept_no, snippet(bodies, 1, '[', ']', '...', 20) AS s
           FROM bodies WHERE content MATCH ?${filter} LIMIT ?`,
        )
        .all(...(params as never[])) as Array<Record<string, unknown>>;
      return rows.map((r) => ({ rceptNo: String(r['rcept_no']), snippet: String(r['s']) }));
    }

    params.push(`%${kw}%`);
    if (rceptNos) params.push(...rceptNos);
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT rcept_no, content FROM bodies WHERE content LIKE ?${filter} LIMIT ?`)
      .all(...(params as never[])) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const content = String(r['content']);
      const idx = content.indexOf(kw);
      const snippet =
        idx < 0
          ? content.slice(0, 80)
          : `${idx > 20 ? '...' : ''}${content.slice(Math.max(0, idx - 20), idx)}[${kw}]` +
            `${content.slice(idx + kw.length, idx + kw.length + 20)}...`;
      return { rceptNo: String(r['rcept_no']), snippet };
    });
  }

  // ---- 기타 상태 ----

  get(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO kv(key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }
}

function toCorp(row: unknown): CorpRecord {
  const r = row as Record<string, unknown>;
  return {
    corpCode: String(r['corp_code']),
    corpName: String(r['corp_name']),
    stockCode: r['stock_code'] == null ? null : String(r['stock_code']),
    jurirNo: r['jurir_no'] == null ? null : String(r['jurir_no']),
    modifyDate: r['modify_date'] == null ? null : String(r['modify_date']),
  };
}

let singleton: Store | null = null;

export function getStore(): Store {
  if (!singleton) singleton = new Store();
  return singleton;
}

/** 테스트용 — 저장소를 교체한다 */
export function __setStore(store: Store | null): void {
  singleton = store;
}
