/**
 * 원문 캐시 `docs`(일반 테이블) — 옛 FTS5 `bodies` 이관과 인덱스 조회 고정.
 *
 * 종전 `bodies` 는 FTS5 가상 테이블이라 `WHERE rcept_no = ?` 가 전체 스캔이었다
 * (실캐시 508건에서 건당 약 10ms). detect/audit 는 60초 예산 안에서 isDocumentCached 를
 * 수백 번 부르므로, 조회가 PRIMARY KEY 를 타는지를 쿼리 플랜으로 고정한다.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/lib/store.js';

// store.ts 와 같은 이유로 createRequire 로 로드한다 (vite 가 'node:sqlite' 를 내장으로 못 알아본다)
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

/** 0.3.x 까지의 원문 캐시 DDL 그대로 */
const LEGACY_FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS bodies USING fts5(
   rcept_no UNINDEXED, content, fetched_at UNINDEXED, rm UNINDEXED,
   tokenize='trigram')`;

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gongsi-store-'));
  dbPath = join(dir, 'cache.db');
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 파일 잠금 — 임시 폴더라 무시 */
  }
});

function makeLegacyDb(rows: Array<[string, string, string, string]>): void {
  const db = new DatabaseSync(dbPath);
  db.exec(LEGACY_FTS_DDL);
  const ins = db.prepare(`INSERT INTO bodies(rcept_no, content, fetched_at, rm) VALUES (?, ?, ?, ?)`);
  for (const r of rows) ins.run(...r);
  db.close();
}

function tables(): string[] {
  const db = new DatabaseSync(dbPath);
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all() as Array<{ name: string }>;
  db.close();
  return rows.map((r) => r.name);
}

function docsRows(): Array<Record<string, unknown>> {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare(`SELECT * FROM docs ORDER BY rcept_no`).all() as Array<Record<string, unknown>>;
  db.close();
  return rows;
}

describe('원문 캐시 이관 — 옛 FTS5 bodies → docs', () => {
  it('기동 시 1회 복사하고 bodies(와 FTS 그림자 테이블)를 지운다', () => {
    makeLegacyDb([
      ['20260101000001', '원문 하나', '2026-01-01T00:00:00.000Z', '공'],
      ['20260101000002', '', '2026-01-02T00:00:00.000Z', ''], // 파싱 불가 원문 — 빈 값도 그대로
      ['20260101000003', '원문 셋', '2026-01-03T00:00:00.000Z', '공정'],
    ]);
    expect(tables()).toContain('bodies');

    const s = new Store(dbPath);
    expect(s.stats().bodies).toBe(3);
    expect(s.hasBody('20260101000002')).toBe(true);
    expect(s.getBody('20260101000002')?.content).toBe('');
    expect(s.getBody('20260101000001')).toEqual({
      rceptNo: '20260101000001',
      content: '원문 하나',
      fetchedAt: '2026-01-01T00:00:00.000Z', // fetched_at 보존 (이관 시각으로 덮지 않는다)
    });
    s.close();

    const after = tables();
    expect(after).not.toContain('bodies');
    expect(after.filter((t) => t.startsWith('bodies_'))).toEqual([]);
    expect(docsRows().map((r) => r['rm'])).toEqual(['공', '', '공정']);
  });

  it('두 번째 기동은 아무것도 바꾸지 않는다', () => {
    makeLegacyDb([['20260101000001', '원문', '2026-01-01T00:00:00.000Z', '공']]);
    new Store(dbPath).close();
    const first = { tables: tables(), rows: docsRows() };

    new Store(dbPath).close();
    expect(tables()).toEqual(first.tables);
    expect(docsRows()).toEqual(first.rows);
  });

  it('docs 에 이미 있는 rcept_no 는 docs 쪽을 지킨다 (INSERT OR IGNORE)', () => {
    new Store(dbPath).close(); // docs 생성
    const db = new DatabaseSync(dbPath);
    db.prepare(`INSERT INTO docs(rcept_no, content, fetched_at, rm) VALUES (?, ?, ?, ?)`).run(
      '20260101000001',
      '새 캐시',
      '2026-09-01T00:00:00.000Z',
      '공',
    );
    db.close();
    // 옛 버전 서버가 같은 DB 를 열어 bodies 를 다시 만든 상황
    makeLegacyDb([
      ['20260101000001', '옛 캐시', '2026-01-01T00:00:00.000Z', '공'],
      ['20260101000009', '옛 캐시에만', '2026-01-01T00:00:00.000Z', '공'],
    ]);

    const s = new Store(dbPath);
    expect(s.getBody('20260101000001')?.content).toBe('새 캐시');
    expect(s.getBody('20260101000009')?.content).toBe('옛 캐시에만');
    s.close();
    expect(tables()).not.toContain('bodies');
  });

  it('옛 bodies 를 읽지 못하면 되돌리고 건너뛴다 — Store 는 정상 동작', () => {
    // FTS5 없는 빌드를 직접 재현할 수 없어, 같은 이름의 읽을 수 없는(열 누락) 테이블로 실패 경로를 탄다
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE bodies (rcept_no TEXT, content TEXT)`); // fetched_at·rm 없음 → SELECT 실패
    db.prepare(`INSERT INTO bodies VALUES ('20260101000001', 'x')`).run();
    db.close();

    const s = new Store(dbPath);
    expect(s.stats().bodies).toBe(0);
    expect(s.hasBody('20260101000001')).toBe(false);
    s.storeBody('20260101000002', '새 원문', '공');
    expect(s.getBody('20260101000002')?.content).toBe('새 원문');
    s.close();
    expect(tables()).toContain('bodies'); // ROLLBACK — 지우지 않았다
  });
});

describe('원문 캐시 조회는 인덱스를 탄다 (전체 스캔 회귀 방지)', () => {
  it('hasBody·getBody·invalidateBody 의 WHERE rcept_no = ? 는 PRIMARY KEY 검색이다', () => {
    const s = new Store(dbPath);
    for (let i = 0; i < 50; i++) s.storeBody(`202601010${String(i).padStart(5, '0')}`, `원문 ${i}`, '공');
    s.close();

    const db = new DatabaseSync(dbPath);
    const sqls = [
      `SELECT 1 AS x FROM docs WHERE rcept_no = ?`,
      `SELECT rcept_no, content, fetched_at FROM docs WHERE rcept_no = ?`,
      `DELETE FROM docs WHERE rcept_no = ?`,
    ];
    for (const sql of sqls) {
      const detail = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('x') as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join(' | ');
      expect(detail, sql).toMatch(/^SEARCH docs USING (COVERING )?INDEX sqlite_autoindex_docs_1 \(rcept_no=\?\)/);
      expect(detail, sql).not.toMatch(/\bSCAN\b/);
    }
    db.close();
  });

  it('재저장은 교체이고 다른 rcept_no 에 영향이 없다 · invalidate 후에는 없다', () => {
    const s = new Store(dbPath);
    s.storeBody('20260101000001', '처음', '공');
    s.storeBody('20260101000002', '다른 공시', '공');
    s.storeBody('20260101000001', '갱신', '공정');
    expect(s.stats().bodies).toBe(2);
    expect(s.getBody('20260101000001')?.content).toBe('갱신');
    s.invalidateBody('20260101000001');
    expect(s.hasBody('20260101000001')).toBe(false);
    expect(s.getBody('20260101000001')).toBeNull();
    expect(s.getBody('20260101000002')?.content).toBe('다른 공시');
    s.close();
  });
});
