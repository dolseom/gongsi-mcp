import { describe, expect, it } from 'vitest';
import {
  parseDocument,
  decodeDocument,
  decodeEntities,
  extractBoardDate,
} from '../src/parsers/document.js';

describe('원문 파서 — 표 구조 보존', () => {
  it('단순 표를 마크다운 표로 바꾼다', () => {
    const xml = `<TABLE>
      <TR><TD>항목</TD><TD>내용</TD></TR>
      <TR><TD>거래상대방</TD><TD>(주)한화</TD></TR>
      <TR><TD>거래금액</TD><TD>1,408</TD></TR>
    </TABLE>`;
    const { markdown } = parseDocument(xml);
    expect(markdown).toContain('| 항목 | 내용 |');
    expect(markdown).toContain('| 거래상대방 | (주)한화 |');
    expect(markdown).toContain('| 거래금액 | 1,408 |');
  });

  it('COLSPAN 병합 셀은 빈 칸으로 펼쳐 표 폭을 유지한다', () => {
    // 실물 패턴: <TD COLSPAN="3">2026.07.22</TD>
    const xml = `<TABLE>
      <TR><TD>라벨</TD><TD>a</TD><TD>b</TD><TD>c</TD></TR>
      <TR><TD>3. 이사회 의결일</TD><TD COLSPAN="3">2026.07.22</TD></TR>
    </TABLE>`;
    const { markdown } = parseDocument(xml);
    const lines = markdown.split('\n');
    // 모든 행의 열 수가 같아야 마크다운 표가 깨지지 않는다
    const widths = lines.filter((l) => l.startsWith('|')).map((l) => l.split('|').length);
    expect(new Set(widths).size).toBe(1);
    expect(markdown).toContain('| 3. 이사회 의결일 | 2026.07.22 |  |  |');
  });

  it('ROWSPAN 은 아래 행에 값을 이월한다', () => {
    const xml = `<TABLE>
      <TR><TD ROWSPAN="2">구분</TD><TD>1행</TD></TR>
      <TR><TD>2행</TD></TR>
    </TABLE>`;
    const { markdown } = parseDocument(xml);
    expect(markdown).toContain('| 구분 | 1행 |');
    expect(markdown).toContain('| 구분 | 2행 |');
  });

  it('뒤 열에만 남은 ROWSPAN 이월분을 잃지 않는다 (Codex 지적 회귀)', () => {
    // 이전 구현: 다음 행에 1열 셀만 있으면 3열의 이월분이 소비되지 않고 사라져 열이 어긋났다
    const xml = `<TABLE>
      <TR><TD>a</TD><TD>b</TD><TD ROWSPAN="2">이월</TD></TR>
      <TR><TD>c</TD></TR>
    </TABLE>`;
    const { markdown } = parseDocument(xml);
    expect(markdown).toContain('| a | b | 이월 |');
    expect(markdown).toContain('| c |  | 이월 |');
  });

  it('XML 주석 안의 TABLE 은 표로 파싱하지 않는다 (Codex 지적)', () => {
    const xml = `<!-- <TABLE><TR><TD>가짜</TD></TR></TABLE> -->
      <TABLE><TR><TD>진짜</TD></TR></TABLE>`;
    const { markdown } = parseDocument(xml);
    expect(markdown).toContain('| 진짜 |');
    expect(markdown).not.toContain('가짜');
  });

  it('표 밖 TITLE 은 제목으로, 셀 안 파이프는 이스케이프한다', () => {
    const xml = `<TITLE>대규모내부거래에 대한 이사회 의결 및 공시</TITLE>
      <TABLE><TR><TD>조건</TD><TD>A|B</TD></TR></TABLE>`;
    const { markdown } = parseDocument(xml);
    expect(markdown).toContain('## 대규모내부거래에 대한 이사회 의결 및 공시');
    expect(markdown).toContain('A\\|B');
  });

  it('ACODE·AREGCIK 메타를 뽑는다', () => {
    const xml = `<DOCUMENT ACODE="80734" AREGCIK="00974875" FORMULA-VERSION="6.0"><TABLE><TR><TD>x</TD></TR></TABLE></DOCUMENT>`;
    const parsed = parseDocument(xml);
    expect(parsed.acode).toBe('80734');
    expect(parsed.aregcik).toBe('00974875');
    expect(parsed.formulaVersion).toBe('6.0');
  });

  it('엔티티를 해제한다 (&amp; 는 마지막)', () => {
    expect(decodeEntities('삼성E&amp;A')).toBe('삼성E&A');
    expect(decodeEntities('&amp;lt;')).toBe('&lt;'); // 이중 이스케이프 보존
    expect(decodeEntities('A&nbsp;B')).toBe('A B');
  });
});

describe('인코딩 감지', () => {
  it('UTF-8 은 그대로, 깨진 UTF-8 은 EUC-KR 로 폴백한다', () => {
    const utf8 = new TextEncoder().encode('이사회 의결일');
    expect(decodeDocument(utf8)).toMatchObject({ encoding: 'utf-8' });

    // "한글" 의 EUC-KR 바이트 (C7 D1 B1 DB) — UTF-8 로는 불법 시퀀스
    const euckr = new Uint8Array([0xc7, 0xd1, 0xb1, 0xdb]);
    const r = decodeDocument(euckr);
    expect(r.encoding).toBe('euc-kr');
    expect(r.text).toBe('한글');
  });
});

describe('이사회 의결일 정밀 추출', () => {
  it('공백 있는 표기와 없는 표기를 모두 잡는다', () => {
    // 실측: 80734 는 "이사회 의결일", 80702 는 "이사회의결일"
    expect(
      extractBoardDate('<TD>3. 이사회 의결일</TD><TD>2026.07.22</TD>'),
    ).toBe('20260722');
    expect(
      extractBoardDate('<TD>3. 이사회의결일</TD><TD>2026.07.23</TD>'),
    ).toBe('20260723');
  });

  it('다양한 날짜 표기를 흡수한다', () => {
    expect(extractBoardDate('<TD>이사회의결일</TD><TD>2026.5.19</TD>')).toBe('20260519');
    expect(extractBoardDate('<TD>이사회 의결일</TD><TD>2026-07-01</TD>')).toBe('20260701');
    expect(extractBoardDate('<TD>이사회 의결일</TD><TD>2026년 7월 3일</TD>')).toBe('20260703');
  });

  it('약관 금융거래(트랙 B)처럼 의결일이 없으면 null', () => {
    expect(extractBoardDate('<TD>1. 거래기간</TD><TD>2026. 2분기</TD>')).toBeNull();
    // 라벨은 있는데 값이 '-' 면 날짜가 안 잡혀야 한다
    expect(extractBoardDate('<TD>3. 이사회의결일</TD><TD>-</TD>')).toBeNull();
  });

  it('의결일이 "-" 일 때 뒤 항목의 날짜를 오인하지 않는다 (실물 80703 회귀)', () => {
    // 80703 실물 패턴: 의결일 "-" 뒤에 "7. 관련공시일" 의 날짜가 온다
    const xml =
      '<TD>3. 이사회의결일</TD><TD>-</TD><TD>사외이사참석여부</TD>' +
      '<TD>7. 관련공시일</TD><TD>2026.04.28</TD>';
    expect(extractBoardDate(xml)).toBeNull();
  });

  it('띄어 쓴 날짜("2026. 7. 22")를 항목 번호로 오인해 끊지 않는다', () => {
    expect(extractBoardDate('<TD>3. 이사회 의결일</TD><TD>2026. 7. 22</TD>')).toBe('20260722');
  });

  it("아포스트로피 2자리 연도(\"'26. 7.23\")를 잡는다 — 삼성생명 실측", () => {
    expect(extractBoardDate("<TD>7. 이사회 의결일</TD><TD>'26. 7.23</TD>")).toBe('20260723');
    // 아포스트로피 없는 2자리 숫자 나열은 날짜로 오인하지 않는다
    expect(extractBoardDate('<TD>이사회 의결일</TD><TD>- 참석 12. 3.45 아님</TD>')).toBeNull();
  });

  it('달력에 없는 날짜는 반환하지 않는다 (Codex 지적)', () => {
    expect(extractBoardDate('<TD>이사회 의결일</TD><TD>2026.99.99</TD>')).toBeNull();
    expect(extractBoardDate('<TD>이사회 의결일</TD><TD>2026.13.01</TD>')).toBeNull();
    expect(extractBoardDate('<TD>이사회 의결일</TD><TD>2026.12.31</TD>')).toBe('20261231');
  });

  it('월별 말일을 넘는 날짜는 round-trip 으로 거른다 (Codex 3차 백로그)', () => {
    // 종전 검증은 일 1~31 범위만 봐서 2월 31일이 통과했다 — Date 롤오버로 3월 초 기한이 나온다
    expect(extractBoardDate('<TD>이사회 의결일</TD><TD>2026.2.31</TD>')).toBeNull();
    expect(extractBoardDate('<TD>이사회 의결일</TD><TD>2026.4.31</TD>')).toBeNull();
    expect(extractBoardDate('<TD>이사회 의결일</TD><TD>2026.2.29</TD>')).toBeNull(); // 평년
    expect(extractBoardDate('<TD>이사회 의결일</TD><TD>2024.2.29</TD>')).toBe('20240229'); // 윤년
  });
});
