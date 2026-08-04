/**
 * 공정위 Q&A 지식베이스 테스트
 *
 * 1) 무결성 — 430건(전문 330 + 아카이브 제목 21 + 2026 매뉴얼 사례 79), 전 항목 출처 URL, 옛 문서 caveat
 * 2) 검색 품질 — 실제 실무 질의 형태로 기대 항목이 상위에 오는지 (회귀 고정)
 * 3) 도구 — search_ftc_qna 응답 규격, check_disclosure_duty 의 situation 연동
 */

import { describe, it, expect } from 'vitest';
import { kbStalenessNote, loadQnaKb, searchQna } from '../src/kb/qna.js';
import { searchFtcQna } from '../src/tools/search-ftc-qna.js';
import { checkDisclosureDuty } from '../src/tools/check-disclosure-duty.js';

describe('지식베이스 무결성', () => {
  const kb = loadQnaKb();

  it('총 430건 — 전문 330 + 아카이브 제목 21 + 2026 매뉴얼 사례 79', () => {
    expect(kb.entries.length).toBe(430);
    const withAnswer = kb.entries.filter((e) => e.answer !== null);
    expect(withAnswer.length).toBe(330 + 79);
  });

  it('카테고리 분포가 수집 보고서와 일치한다', () => {
    const byCat = new Map<string, number>();
    for (const e of kb.entries) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);
    expect(byCat.get('internal_transaction')).toBe(132 + 21 + 79); // 전문 132 + 아카이브 21 + 2026 매뉴얼 79
    expect(byCat.get('unlisted_material')).toBe(71);
    expect(byCat.get('group_status')).toBe(69);
    expect(byCat.get('subcontract')).toBe(58);
  });

  it('전 항목이 질문·출처 문서·URL을 가진다', () => {
    for (const e of kb.entries) {
      expect(e.question.length, e.id).toBeGreaterThan(5);
      expect(e.doc.length, e.id).toBeGreaterThan(0);
      expect(e.url, e.id).toMatch(/^https?:\/\//);
    }
  });

  it('전문 항목의 답변은 비어 있지 않다', () => {
    for (const e of kb.entries) {
      if (e.answer !== null) expect(e.answer.length, e.id).toBeGreaterThan(3);
    }
  });

  it('2015년 이하 옛 문서에는 반드시 연식 caveat 이 달려 있다', () => {
    for (const e of kb.entries) {
      if (e.docYear !== null && e.docYear <= 2015 && !e.id.startsWith('arch-')) {
        expect(
          e.caveats.some((c) => c.includes('년 문서')),
          `${e.id} (${e.doc})`,
        ).toBe(true);
      }
    }
  });

  it("옛 기준금액 '50억' 언급 항목에 현행 기준 caveat 이 달려 있다", () => {
    const e = kb.entries.find((x) => x.id === 'lit-003'); // 50억 출자 자회사 설립
    expect(e).toBeDefined();
    expect(e!.caveats.some((c) => c.includes('min(100억원'))).toBe(true);
  });

  it("옛 기한 '1일 이내' 언급 항목에 현행 기한 caveat 이 달려 있다", () => {
    const flagged = kb.entries.filter((e) =>
      e.caveats.some((c) => c.includes('3영업일')),
    );
    expect(flagged.length).toBeGreaterThan(0);
  });

  it('신선도 경고 — 매뉴얼 확인 기한(2027-05-31) 전엔 없고, 지나면 갱신 안내가 붙는다', () => {
    expect(kb.manualCheckDue).toBe('2027-05-31');
    expect(kbStalenessNote(new Date('2027-05-31T00:00:00Z'))).toBeNull();
    const note = kbStalenessNote(new Date('2027-06-01T00:00:00Z'));
    expect(note).toContain('매년 4월');
    expect(note).toContain('bordCd=101');
  });

  it('아카이브 복원분은 답변이 null 이고 유실 caveat 을 가진다', () => {
    const arch = kb.entries.filter((e) => e.id.startsWith('arch-'));
    expect(arch.length).toBe(21);
    for (const e of arch) {
      expect(e.answer).toBeNull();
      expect(e.caveats.some((c) => c.includes('아카이브'))).toBe(true);
    }
  });
});

describe('검색 품질 (회귀 고정)', () => {
  it('"발행어음 자동연장" → 자동연장 Q&A(lit-006)가 최상위', () => {
    const r = searchQna('발행어음 자동연장');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]!.entry.question).toContain('자동연장');
  });

  it('"자회사 설립 출자" → 자회사 설립 판정 Q&A가 상위 3위 안', () => {
    const r = searchQna('자회사 설립 출자', { category: 'internal_transaction' });
    const top3 = r.slice(0, 3).map((m) => m.entry.question);
    expect(top3.some((q) => q.includes('자회사를 설립'))).toBe(true);
  });

  it('"퇴직연금 거래금액 산정" → 퇴직연금 관련 항목이 나온다', () => {
    const r = searchQna('퇴직연금 거래금액 산정');
    expect(r.some((m) => m.entry.question.includes('퇴직'))).toBe(true);
  });

  it('조사가 붙은 질의("변경계약을 체결하면 공시의무가")도 bigram 으로 매칭된다', () => {
    const r = searchQna('임대료 변경계약을 체결하면 공시의무가 있는지');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]!.entry.question).toContain('변경계약');
  });

  it('category 필터가 다른 유형을 배제한다', () => {
    const r = searchQna('공시 기한', { category: 'subcontract', limit: 10 });
    for (const m of r) expect(m.entry.category).toBe('subcontract');
  });

  it('limit 을 지킨다', () => {
    expect(searchQna('공시', { limit: 3 }).length).toBeLessThanOrEqual(3);
  });

  it('무의미한 질의는 빈 결과', () => {
    expect(searchQna('zzqx')).toEqual([]);
  });

  it('무관한 한국어 질의는 bigram 우연 일치만으로 반환되지 않는다 (Codex 중간 6)', () => {
    expect(searchQna('강아지 예방접종')).toEqual([]);
    expect(searchQna('오늘 점심 메뉴 추천')).toEqual([]);
  });

  it('초장문 질의도 잘라서 처리한다 — 이벤트 루프 점유 방지 (Codex 중간 10)', () => {
    const long = '대규모내부거래 '.repeat(20_000); // 20만+ 자
    const t0 = Date.now();
    const r = searchQna(long);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.length).toBeGreaterThan(0); // 앞 500자에 유효 토큰이 있으므로 검색은 된다
  });

  it('개정판 간 중복 문답은 한 건만 남는다 (계열 카드결제 — 2009/2015/2026 중복)', () => {
    const r = searchQna('계열 카드사 결제 할부금융', { limit: 5 });
    const cardQ = r.filter((m) => m.entry.question.includes('할부금융이나 카드결제'));
    // 전문 항목은 1건으로 접히고, 아카이브 제목(답변 null·질문 상이)은 별도로 남을 수 있다
    expect(cardQ.filter((m) => m.entry.answer !== null).length).toBe(1);
    // 남는 것은 최신판(2026 매뉴얼)이어야 한다
    expect(cardQ[0]!.entry.docYear).toBe(2026);
    expect(cardQ[0]!.entry.id).toMatch(/^lit26-/);
  });

  it('2026 매뉴얼 사례가 검색된다 — 발행어음 자동연장의 현행판이 구판보다 위', () => {
    const r = searchQna('발행어음 자동연장', { limit: 5 });
    const hit = r.find((m) => m.entry.question.includes('자동연장'));
    expect(hit).toBeDefined();
    expect(hit!.entry.docYear).toBe(2026);
    expect(hit!.entry.caveats).toEqual([]);
  });
});

describe('search_ftc_qna 도구', () => {
  it('정상 검색 — 결과·출처·caveats·diagnostics 동봉', () => {
    const r = searchFtcQna({ query: '발행어음 자동연장' });
    expect(r.results.length).toBeGreaterThan(0);
    const top = r.results[0]!;
    expect(top.question).toContain('자동연장');
    expect(top.answer).toBeTruthy();
    expect(top.source.url).toMatch(/^https/);
    expect(r.diagnostics.kbEntries).toBe(430);
    // 옛 문서 결과가 있으면 반드시 경고 노트가 있어야 한다
    if (r.results.some((x) => x.caveats.length > 0)) {
      expect(r.notes.some((n) => n.includes('caveats'))).toBe(true);
    }
  });

  it('0건은 에러가 아니라 안내 노트를 담은 정상 응답', () => {
    const r = searchFtcQna({ query: 'zzqx' });
    expect(r.results).toEqual([]);
    expect(r.diagnostics.matched).toBe(0);
    expect(r.notes[0]).toContain('찾지 못했습니다');
  });
});

describe('check_disclosure_duty 연동', () => {
  it('situation 을 주면 relatedOfficialQna 가 첨부된다', () => {
    const r = checkDisclosureDuty({
      duty: 'large_internal_transaction',
      listing: 'unlisted',
      boardDate: '20260722',
      totalEquity: 120_000_000_000,
      paidInCapital: 50_000_000_000,
      amount: 7_000_000_000,
      situation: '계열사 발행어음이 만기 후 자동연장되는 경우',
    });
    expect('error' in r).toBe(false);
    if ('relatedOfficialQna' in r && r.relatedOfficialQna) {
      expect(r.relatedOfficialQna.length).toBeGreaterThan(0);
      expect(r.relatedOfficialQna.length).toBeLessThanOrEqual(3);
      expect(r.relatedOfficialQna[0]!.question).toContain('자동연장');
      expect(r.notes.some((n) => n.includes('relatedOfficialQna'))).toBe(true);
    } else {
      throw new Error('relatedOfficialQna 가 없습니다');
    }
  });

  it('situation 이 없으면 relatedOfficialQna 도 없다 (기존 거동 불변)', () => {
    const r = checkDisclosureDuty({
      duty: 'large_internal_transaction',
      listing: 'unlisted',
      boardDate: '20260722',
      totalEquity: 120_000_000_000,
      paidInCapital: 50_000_000_000,
      amount: 7_000_000_000,
    });
    expect('relatedOfficialQna' in r).toBe(false);
  });

  it('duty 에 맞는 카테고리로 좁혀 검색한다 (group_status → J004 문서권)', () => {
    const r = checkDisclosureDuty({
      duty: 'group_status',
      year: 2026,
      situation: '해외계열사 거래내역 포함 여부',
    });
    if ('relatedOfficialQna' in r && r.relatedOfficialQna) {
      // J004 FAQ 문서에서 나와야 한다
      expect(
        r.relatedOfficialQna.every((q) => q.source.doc.includes('기업집단현황')),
      ).toBe(true);
    }
  });
});
