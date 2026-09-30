/**
 * 로컬 저장소 — `node:sqlite` 얇은 어댑터
 *
 * 이 파일이 SQLite 를 아는 **유일한 곳**이다. 나머지 코드는 여기 인터페이스만 쓴다.
 * `node:sqlite` 는 아직 experimental 이므로, API가 바뀌거나 다른 드라이버로 갈아타야 할 때
 * 호출부를 건드리지 않고 이 파일만 교체할 수 있어야 한다.
 * (docs/absorbed-from-dart-mcp.md §2-4)
 *
 * 저장 대상 — 무엇을 캐시하지 *않는지*가 더 중요하다:
 *   ✅ corps(법인코드 인덱스) · docs(공시 원문) · call_log(일일 호출) · kv(기타 상태)
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

/**
 * 공시 원문 캐시 — 일반 테이블 + rcept_no PRIMARY KEY.
 *
 * 종전에는 FTS5 가상 테이블 `bodies` 였다. 그러나 ① `WHERE rcept_no = ?` 가 UNINDEXED 열이라
 * **전체 스캔**이었고(실캐시 508건에서 건당 약 10ms, 문서 수에 비례 — detect/audit 는 60초 예산
 * 안에서 isDocumentCached 를 수백 번 부른다) ② FTS5 가 없는 SQLite 빌드에서는 원문 캐시 자체가
 * 꺼졌으며 ③ 전문검색(searchBodies)은 src 어디에서도 쓰이지 않았다. 그래서 일반 테이블로 옮겼다.
 * 기존 `bodies` 는 기동 시 1회 이관한다 (migrateLegacyBodies).
 */
const DOCS_DDL = `CREATE TABLE IF NOT EXISTS docs (
   rcept_no   TEXT PRIMARY KEY,
   content    TEXT NOT NULL,
   fetched_at TEXT,
   rm         TEXT
 )`;

export class Store {
  private db: DatabaseSync;
  /** 실제 열린 DB 경로 (진단용) */
  readonly dbPath: string;

  constructor(path?: string) {
    const dbPath = path ?? getConfig().cacheDbPath;
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
    for (const stmt of DDL) this.db.exec(stmt);
    this.db.exec(DOCS_DDL);
    this.migrateLegacyBodies();
  }

  /**
   * 옛 FTS5 `bodies` → `docs` 1회 이관.
   *
   * - `bodies` 가 없으면(신규 DB·이관 완료 DB) 아무것도 하지 않는다 — 두 번째 기동부터는 조회 1회뿐.
   * - 복사와 DROP 은 한 트랜잭션이다. 중간에 실패하면 둘 다 되돌려 `bodies` 가 남고 다음 기동에 재시도한다.
   * - `INSERT OR IGNORE` — `docs` 에 이미 있는 rcept_no 는 `docs` 쪽을 지킨다. 이관 조건을
   *   "docs 가 비어 있을 때"로 좁히지 않은 이유: 옛 버전 서버가 같은 DB 를 열면 `bodies` 를 다시
   *   만들어 쓸 수 있고, docs 가 비어 있지 않다는 이유로 영영 이관하지 않으면 옛 테이블이 남는다.
   * - FTS5 가 없는 빌드에서는 가상 테이블을 읽지도 지우지도 못한다(no such module). 그때는 경고만
   *   남기고 건너뛴다 — 원문은 다시 받으면 되는 캐시이고, 빈 `docs` 로도 모든 경로가 정상 동작한다.
   */
  private migrateLegacyBodies(): void {
    const legacy = this.db
      .prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'bodies'`)
      .get();
    if (!legacy) return;
    this.db.exec('BEGIN');
    try {
      const r = this.db
        .prepare(
          `INSERT OR IGNORE INTO docs(rcept_no, content, fetched_at, rm)
           SELECT rcept_no, COALESCE(content, ''), fetched_at, rm
           FROM bodies WHERE rcept_no IS NOT NULL`,
        )
        .run();
      this.db.exec('DROP TABLE bodies');
      this.db.exec('COMMIT');
      log.info('원문 캐시를 bodies(FTS5) → docs 로 이관했습니다', { rows: Number(r.changes ?? 0) });
      // 복사 후 DROP 이라 옛 FTS 페이지가 빈 페이지로 남아 파일이 커진다(실측 33 → 41MB) — 1회만 압축한다.
      // 실패해도 캐시 동작에는 영향이 없다.
      try {
        this.db.exec('VACUUM');
      } catch (err) {
        log.warn('이관 후 VACUUM 실패 — 파일 크기만 줄지 않습니다', {
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 트랜잭션이 이미 끝났으면 무시 */
      }
      log.warn('옛 원문 캐시(bodies) 이관 실패 — 건너뜁니다 (원문은 필요할 때 다시 받습니다)', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  close(): void {
    this.db.close();
  }

  /** 캐시 규모 스냅샷 — server_info 진단용 */
  stats(): { corps: number; bodies: number } {
    const count = (sql: string): number => {
      const row = this.db.prepare(sql).get() as Record<string, unknown> | undefined;
      return row ? Number(Object.values(row)[0]) : 0;
    };
    return {
      corps: count('SELECT COUNT(*) FROM corps'),
      bodies: count('SELECT COUNT(*) FROM docs'),
    };
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
    const row = this.db.prepare(`SELECT 1 AS x FROM docs WHERE rcept_no = ?`).get(rceptNo);
    return row !== undefined;
  }

  getBody(rceptNo: string): { rceptNo: string; content: string; fetchedAt: string } | null {
    const row = this.db
      .prepare(`SELECT rcept_no, content, fetched_at FROM docs WHERE rcept_no = ?`)
      .get(rceptNo) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      rceptNo: String(row['rcept_no']),
      content: String(row['content']),
      fetchedAt: String(row['fetched_at']),
    };
  }

  /**
   * 원문 저장. 같은 rcept_no 재저장은 교체다(force_refresh 경로) — 단일 UPSERT 문이라 원자적이다.
   * 파싱에 실패한 원문도 빈 문자열로 저장해 재다운로드를 막는다.
   *
   * ★ 영구 캐시(TTL 없음)가 안전한 이유는 **rcept_no 불변 전제** 하나뿐이다:
   *   원본 접수분의 내용은 제출 후 변하지 않고, 정정은 항상 **새 rcept_no** 로
   *   접수된다 (J004 정정률 91% 실측에서도 원본이 그대로 남는 것으로 확인).
   *   이 전제가 깨지는 데이터(목록·검색 결과·집계)는 이 테이블에 넣으면 안 된다 —
   *   목록 캐시 금지 결정(docs/absorbed-from-dart-mcp.md)과 같은 뿌리다.
   *   회귀 테스트: test/tools.test.ts "원문 영구 캐시는 rcept_no 불변 전제".
   */
  storeBody(rceptNo: string, content: string, rm = ''): void {
    this.db
      .prepare(
        `INSERT INTO docs(rcept_no, content, fetched_at, rm) VALUES (?, ?, ?, ?)
         ON CONFLICT(rcept_no) DO UPDATE SET
           content    = excluded.content,
           fetched_at = excluded.fetched_at,
           rm         = excluded.rm`,
      )
      .run(rceptNo, content, new Date().toISOString(), rm);
  }

  invalidateBody(rceptNo: string): void {
    this.db.prepare(`DELETE FROM docs WHERE rcept_no = ?`).run(rceptNo);
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

  /**
   * 접두사가 같은 kv 행을 전부 지운다 — 지운 행 수를 돌려준다.
   *
   * 이어보기(continuation) 캐시처럼 **한 실행에 딸린 키 묶음**을 그 실행이 끝날 때 통째로
   * 거두기 위한 것이다. 키 하나씩 지우려면 무엇을 썼는지 목록을 따로 들고 있어야 하는데,
   * 그 목록 자체가 또 하나의 상태가 된다.
   *
   * ⚠️ LIKE 의 와일드카드(`%` `_`)는 이스케이프한다 — 접두사에 그 글자가 들어오면
   * 의도보다 넓은 범위가 지워진다.
   */
  deletePrefix(prefix: string): number {
    const escaped = prefix.replace(/[\\%_]/g, '\\$&');
    const r = this.db
      .prepare(`DELETE FROM kv WHERE key LIKE ? ESCAPE '\\'`)
      .run(`${escaped}%`);
    return Number(r.changes ?? 0);
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
