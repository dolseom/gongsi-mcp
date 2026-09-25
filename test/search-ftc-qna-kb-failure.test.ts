/**
 * Codex 리뷰(2026-09-25) 13 — 문답 KB 로드 실패가 독립된 매뉴얼 KB 검색까지 막지 않는다.
 * loadQnaKb 를 모듈 단위로 실패시키므로 파일을 따로 둔다.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/kb/qna.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/kb/qna.js')>();
  return {
    ...actual,
    loadQnaKb: () => {
      throw new Error('ftc-qna.json 읽기 실패 (테스트 주입)');
    },
  };
});

const { searchFtcQna } = await import('../src/tools/search-ftc-qna.js');

describe('13. 문답 KB 장애 격리', () => {
  it('문답 KB 가 실패해도 매뉴얼 구절은 돌려주고 실패를 알린다', () => {
    const r = searchFtcQna({ query: '18:00 이후 제출' });
    expect(r.results).toEqual([]);
    expect(r.manualPassages.length).toBeGreaterThan(0);
    expect(r.notes.join(' ')).toContain('ftc-qna.json');
    expect(r.diagnostics.kbVersion).toBeNull();
  });
});
