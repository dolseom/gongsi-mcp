/**
 * 공정위 공시 매뉴얼 본문 지식베이스 테스트 (data/ftc-manual.json · src/kb/manual.ts)
 *
 * 1) 빌드 산출물 무결성 — 스키마·id 유일·빈 본문 없음·문서 4종·필수 규칙 문장 4개
 * 2) 검색 품질 — 실무자식 검색어로 매뉴얼 본문에만 있는 규칙이 상위 3 안에 (튜닝 근거 고정)
 * 3) search_ftc_qna 통합 — manualPassages 형식·하위호환·문답 0건일 때의 안내 문구
 */

import { describe, it, expect } from 'vitest';
import { canonicalize, excerpt, expandTimeTokens, loadManualKb, searchManual } from '../src/kb/manual.js';
import { searchFtcQna } from '../src/tools/search-ftc-qna.js';

describe('매뉴얼 본문 지식베이스 무결성', () => {
  const kb = loadManualKb();

  it('문서 4종이 모두 들어 있고 구절 수가 하한 이상이다', () => {
    const byDoc = new Map<string, number>();
    for (const p of kb.passages) byDoc.set(p.docKey, (byDoc.get(p.docKey) ?? 0) + 1);
    expect(byDoc.get('lit')).toBeGreaterThanOrEqual(60);
    expect(byDoc.get('unlisted')).toBeGreaterThanOrEqual(40);
    expect(byDoc.get('group_affiliate')).toBeGreaterThanOrEqual(60);
    expect(byDoc.get('group_owner')).toBeGreaterThanOrEqual(10);
  });

  it('id 유일 · 빈 본문·제목 없음 · 출처 URL 은 공정위 게시글', () => {
    expect(new Set(kb.passages.map((p) => p.id)).size).toBe(kb.passages.length);
    for (const p of kb.passages) {
      expect(p.text.trim().length, p.id).toBeGreaterThanOrEqual(30);
      expect(p.heading.trim().length, p.id).toBeGreaterThan(0);
      expect(p.url, p.id).toMatch(/^https:\/\/www\.ftc\.go\.kr\/www\/selectBbsNttView\.do\?key=725&bordCd=101&nttSn=\d+$/);
      expect(p.printedPage, p.id).toBeLessThan(p.page); // 인쇄 쪽은 표지·목차만큼 PDF 쪽보다 작다
    }
  });

  it('버전·출처·매뉴얼 확인 기한이 있다', () => {
    expect(kb.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(kb.manualDate).toBe('2026-04-27');
    expect(kb.manualCheckDue).toBe('2027-05-31');
    expect(kb.source).toContain('공정거래위원회');
  });

  it('대규모내부거래 <참고: 주요 사례>(PDF 32~63쪽)는 문답 KB(lit26-*)와 중복이라 제외했다', () => {
    const cases = kb.passages.filter((p) => p.docKey === 'lit' && p.page >= 32 && p.page <= 63);
    expect(cases).toEqual([]);
  });

  it.each([
    ['lit', '주식을 계열증권사를 통해 장내시장에서 거래하는 경우 (다만, 장 종료 후 시간외거래는 공시대상임)'],
    ['lit', '“특수관계인에 대한 출자”양식의 상대방이 기재하는 양식임'],
    ['unlisted', '공시양식이 내부거래공시와 동일한 경우 내부거래공시로 갈음'],
    ['group_affiliate', '18:00 이후에 제출할 경우 다음 업무 일에 공시한 것으로 처리됨'],
  ])('필수 규칙 문장이 한 구절에 온전히 있다 (%s) — %s', (docKey, sentence) => {
    expect(kb.passages.some((p) => p.docKey === docKey && p.text.includes(sentence))).toBe(true);
  });

  it('서식 「특수관계인의 유상증자 참여」 기재상의 주의가 서식 제목과 함께 남아 있다 (작성 주체 근거)', () => {
    const p = kb.passages.find((x) => x.heading.includes('유상증자 참여'));
    expect(p?.kind).toBe('form_note');
    expect(p?.text).toContain('기재상의 주의');
  });

  it('순수 서식 틀(칸 이름 나열)은 구절이 되지 않는다 — 서식 구절은 기재 주의 표지로 시작한다', () => {
    for (const p of kb.passages.filter((x) => x.kind === 'form_note')) {
      expect(p.text, p.id).toMatch(/^(기재상의\s*주의|<\s*기재요령\s*>|주\s?\d{1,2}\))/);
    }
  });
});

describe('매뉴얼 검색 — 실무자식 검색어 (상위 3 고정)', () => {
  // [검색어, 정답 구절 id 후보] — 앞 4개는 eval/b2a 에서 모델이 못 찾던 규칙, 뒤 5개는 튜닝용 추가 질의
  const CASES: [string, string[]][] = [
    ['장내 매수 계열사 주식 공시', ['man-lit-p19-1']],
    ['유상증자 참여 양식 누가 작성', ['man-lit-p106-1']],
    ['비상장 중요사항 대규모내부거래 중복 공시', ['man-unl-p6-3']],
    ['현황공시 6시 넘어서 제출', ['man-gaf-p8-1']],
    ['약관 금융거래 이사회 의결 면제', ['man-lit-p24-3', 'man-lit-p24-2', 'man-lit-p25-1']],
    ['비상장사 공시기한 며칠 이내', ['man-unl-p7-2']],
    ['현황공시 해당사항 없으면 공란으로 둬도 되나', ['man-gaf-p7-1']],
    ['담보제공 거래금액 산정 기준', ['man-lit-p15-1', 'man-lit-p107-1']],
    ['상품용역거래 실제 금액 20% 감소하면 다시 공시', ['man-lit-p27-3']],
  ];

  it.each(CASES)('"%s" → 상위 3 안에 정답 구절', (query, want) => {
    const top = searchManual(query, { limit: 3 }).map((m) => m.passage.id);
    expect(top.some((id) => want.includes(id)), `${query} → ${top.join(', ')}`).toBe(true);
  });

  it('무관 질의는 0건 — bigram 우연 일치로 근거처럼 내놓지 않는다', () => {
    expect(searchManual('강아지 예방접종')).toEqual([]);
    expect(searchManual('zzqx')).toEqual([]);
  });

  it('흔한 낱말만 맞는 질의("공시")는 근거로 내놓지 않는다', () => {
    expect(searchManual('공시')).toEqual([]);
  });

  it('docKeys 로 매뉴얼을 좁힌다', () => {
    const r = searchManual('공시기한', { docKeys: ['unlisted'], limit: 5 });
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((m) => m.passage.docKey === 'unlisted')).toBe(true);
  });

  it('시각 보강 — "6시" → 18:00, "오전 9시" → 09:00, "시간" 은 시각이 아니다', () => {
    expect(expandTimeTokens('6시 넘어서 제출')).toEqual(['18:00']);
    expect(expandTimeTokens('오전 9시')).toEqual(['09:00']);
    expect(expandTimeTokens('18시 이후')).toEqual(['18:00']);
    expect(expandTimeTokens('3시간 걸림')).toEqual([]);
  });

  it('실무 표현 정규화 — 계열회사/계열사, 상품ㆍ용역/상품용역, 취득/매수', () => {
    expect(canonicalize('계열회사')).toBe(canonicalize('계열사'));
    expect(canonicalize('상품ㆍ용역거래')).toBe(canonicalize('상품용역거래'));
    expect(canonicalize('주식 취득')).toBe(canonicalize('주식 매수'));
  });

  it('긴 본문 발췌는 질의 낱말 주변을 남기고 잘림을 표시한다', () => {
    const long = '가'.repeat(1000) + ' 시간외거래 ' + '나'.repeat(1000);
    const ex = excerpt(long, '시간외거래', 300);
    expect(ex.truncated).toBe(true);
    expect(ex.text).toContain('시간외거래');
    expect(ex.text.startsWith('…')).toBe(true);
  });
});

describe('search_ftc_qna — 문답 + 매뉴얼 본문', () => {
  it('manualPassages 에 문서·쪽·소제목·본문·URL·현행 표시가 붙는다 (문답 results 형식은 그대로)', () => {
    const r = searchFtcQna({ query: '장내 매수 계열사 주식 공시' });
    expect(r.manualPassages.length).toBeGreaterThan(0);
    expect(r.manualPassages.length).toBeLessThanOrEqual(3);
    const hit = r.manualPassages.find((p) => p.id === 'man-lit-p19-1');
    expect(hit).toBeDefined();
    expect(hit!.doc).toContain('대규모내부거래');
    expect(hit!.page).toBe(17); // 인쇄 쪽
    expect(hit!.pdfPage).toBe(19);
    expect(hit!.text).toContain('시간외거래는 공시대상임');
    expect(hit!.url).toMatch(/nttSn=47396$/);
    expect(hit!.status).toBe('2026-04-27 매뉴얼 본문(현행)');
    expect(r.notes.some((n) => n.includes('현행 본문'))).toBe(true);
    // 하위호환 — 기존 필드 유지
    for (const x of r.results) {
      expect(x).toHaveProperty('question');
      expect(x).toHaveProperty('caveats');
      expect(x.source).toHaveProperty('url');
    }
    expect(r.diagnostics.kbEntries).toBe(430);
    expect(r.diagnostics.manualMatched).toBe(r.manualPassages.length);
  });

  it('문답 0건·매뉴얼만 적중 — "찾지 못했다"로 끝내지 않고 매뉴얼 근거를 가리킨다 (범위 고지는 유지)', () => {
    const r = searchFtcQna({ query: '시간외거래' });
    expect(r.results).toEqual([]);
    expect(r.manualPassages.map((p) => p.id)).toContain('man-lit-p19-1');
    expect(r.notes[0]).toContain('문답은 찾지 못했습니다');
    expect(r.notes[0]).toContain('manualPassages');
    expect(r.notes.some((n) => n.includes('여기 없다고 해서 규정이 없는 것이 아닙니다'))).toBe(true);
  });

  it('둘 다 0건 — 기존 안내(찾지 못했습니다) + 매뉴얼 포함 명시', () => {
    const r = searchFtcQna({ query: '강아지 예방접종' });
    expect(r.results).toEqual([]);
    expect(r.manualPassages).toEqual([]);
    expect(r.notes[0]).toContain('찾지 못했습니다');
    expect(r.notes[0]).toContain('매뉴얼 본문 포함');
  });

  it('category 로 매뉴얼도 좁힌다 — 하도급대금은 매뉴얼 본문이 없어 manualPassages 가 비고, manual_limit:0 은 생략', () => {
    const unl = searchFtcQna({ query: '공시기한 7영업일', category: 'unlisted_material' });
    expect(unl.manualPassages.every((p) => p.id.startsWith('man-unl-'))).toBe(true);
    const sub = searchFtcQna({ query: '하도급대금 결제조건', category: 'subcontract' });
    expect(sub.manualPassages).toEqual([]);
    const off = searchFtcQna({ query: '장내 매수 계열사 주식 공시', manual_limit: 0 });
    expect(off.manualPassages).toEqual([]);
  });

  it('서식 기재 주의가 걸리면 form_note 안내가 붙는다', () => {
    const r = searchFtcQna({ query: '유상증자 참여 양식 누가 작성' });
    expect(r.manualPassages[0]?.kind).toBe('form_note');
    expect(r.notes.some((n) => n.includes("form_note"))).toBe(true);
  });
});
