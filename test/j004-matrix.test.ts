import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  extractMatrix,
  extractSecuritiesMatrix,
  extractGoodsServicesMatrix,
} from '../src/parsers/j004-matrix.js';
import { normalizeCompanyName } from '../src/parsers/md-table.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MD = readFileSync(join(HERE, 'fixtures', 'j004-matrix.md'), 'utf8');

const MILLION = 1_000_000;

/** 열(거래상대방)별 합계를 백만원 단위로 — 원문 '합 계' 행과 직접 대조하기 위한 것 */
function sumByColumn(cells: Array<{ colCompany: string; amount: number }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of cells) {
    const k = normalizeCompanyName(c.colCompany);
    out.set(k, (out.get(k) ?? 0) + c.amount / MILLION);
  }
  return out;
}

describe('j004 매트릭스 파서 — 계열회사간 유가증권거래 현황', () => {
  const r = extractSecuritiesMatrix(MD);

  it('축 라벨을 원문에서 읽는다 (행=매입회사, 열=매도회사)', () => {
    expect(r.rowAxis).toBe('매입회사');
    expect(r.colAxis).toBe('매도회사');
  });

  it('페이지가 나뉜 표를 하나의 매트릭스로 잇는다', () => {
    expect(r.tables).toBe(2);
    expect(r.tablesUnrecognized).toBe(0);
    expect(r.tablesWithoutUnit).toBe(0);
    // 단위 캡션은 첫 페이지에만 있다 — 둘째 페이지는 같은 축 라벨이라 이어받는다
    expect(r.unitInheritedTables).toBe(1);
    expect(r.duplicatePairs).toBe(0);
  });

  /**
   * ★ 이 테스트가 파서의 정확성을 담보한다.
   * 원문 '합 계' 행의 열별 값과 우리가 뽑은 셀들의 열별 합이 **전부** 일치해야 한다.
   * 하나라도 어긋나면 집계 행/열을 개별 거래로 세었거나 거래를 빠뜨린 것이다.
   */
  it('열별 합계가 원문 합계행과 정확히 일치한다', () => {
    const expected: Record<string, number> = {
      // 첫 페이지 합계행
      '미래에셋 컨설팅(주)': 222_391,
      '미래에셋 캐피탈(주)': 22_006,
      '미래에셋 증권(주)': 23_935_136,
      '미래에셋 자산운용(주)': 6_141_470,
      '미래에셋 생명보험(주)': 1_873_350,
      '미래에셋 벤처투자(주)': 12_485,
      '오딘제8차(유)': 11_877,
      '미래에셋 네이버아시아 그로쓰 사모투자 합자회사': 22_544,
      // 둘째 페이지 합계행
      '미래에셋 큐리어스 구조혁신 기업재무안정 사모투자 합자회사': 2_059,
      '미래에셋 파트너스 제9호 사모투자 합자회사': 2_551,
      '에스케이에스 미래에셋 기업재무안정 사모투자 합자회사': 712,
      '미래에셋 이에스지 기업재무안정 사모투자 합자회사': 1_467,
      '미래에셋 위반도체제1호 창업벤처투자 합자회사': 2_916,
      '미래에셋증권 코리아제이호 사모투자 합자회사': 43_500,
    };
    const actual = sumByColumn(r.cells);
    for (const [name, amount] of Object.entries(expected)) {
      expect(actual.get(normalizeCompanyName(name)), name).toBe(amount);
    }
    // 원문에 없는 열을 만들어내지 않는다
    expect(actual.size).toBe(Object.keys(expected).length);
  });

  it('소계 열을 거래상대방으로 세지 않는다', () => {
    // 원문 첫 페이지에는 비금융회사 '소계' 열이 미래에셋컨설팅과 같은 값으로 붙어 있다.
    // 그걸 회사로 읽으면 총합이 222,391 백만원만큼 부풀어 오른다.
    const total = r.cells.reduce((s, c) => s + c.amount, 0) / MILLION;
    expect(total).toBe(32_294_464);
    // ※ 원문의 총합계 칸은 32,294,463 으로 1백만원 작다 — 행별 합계를 더한 값과
    //   열별 합계를 더한 값이 원문 안에서 이미 어긋나 있다(백만원 미만 반올림).
    //   우리 값은 열별 합계행과 전부 일치하므로 파서 쪽 손실이 아니다.
    expect(total - 32_294_463).toBe(1);
  });

  it('금액을 단위 캡션(백만원)으로 환산한다', () => {
    const cell = r.cells.find(
      (c) =>
        normalizeCompanyName(c.rowCompany) === normalizeCompanyName('미래에셋 캐피탈(주)') &&
        normalizeCompanyName(c.colCompany) === normalizeCompanyName('미래에셋 증권(주)'),
    );
    expect(cell?.amount).toBe(232_910 * MILLION);
  });
});

describe('j004 매트릭스 파서 — 계열회사간 상품ㆍ용역거래 현황', () => {
  const r = extractGoodsServicesMatrix(MD);

  it('축 라벨을 원문에서 읽는다 (행=매출회사, 열=매입회사)', () => {
    expect(r.rowAxis).toBe('매출');
    expect(r.colAxis).toBe('매입회사');
  });

  it('첫 페이지 열별 합계가 원문 합계행과 일치한다', () => {
    const expected: Record<string, number> = {
      '미래에셋 캐피탈(주)': 2_971,
      '미래에셋 증권(주)': 35_500,
      '미래에셋 생명보험(주)': 211_653,
      '미래에셋 자산운용(주)': 3_048,
      '미래에셋 벤처투자(주)': 348,
      '미래에셋 금융서비스(주)': 619,
      '에너지인프라 자산운용(주)': 13,
      '미래에셋네이버 아시아그로쓰 사모투자합자회사': 4_535,
      '미래에셋 파트너스제9호 사모투자합자회사': 1_511,
    };
    const actual = sumByColumn(r.cells);
    for (const [name, amount] of Object.entries(expected)) {
      expect(actual.get(normalizeCompanyName(name)), name).toBe(amount);
    }
  });

  /**
   * ★ 실물에서 집계 열 이름은 한 가지가 아니었다:
   * '소계' · '계' · '국내계열사계' · '국내 매출액' · '해외 매출액'.
   * 하나라도 회사로 새면 **없는 거래**가 후보로 올라간다 (오경보 최악 방향).
   */
  it('집계 열을 거래상대방으로 만들어내지 않는다', () => {
    const names = new Set(r.cells.map((c) => normalizeCompanyName(c.colCompany)));
    for (const bad of ['소계', '계', '국내계열사계', '국내 매출액', '해외 매출액', '합계']) {
      expect(names.has(normalizeCompanyName(bad)), bad).toBe(false);
    }
  });

  /**
   * 총괄표(5)와 주요 내역(6)의 교차 검증 — 같은 거래가 두 표에 같은 값으로 실린다.
   * 실측: 미래에셋금융서비스 → 미래에셋생명보험 보험판매 205,454 백만원.
   */
  it('주요 상품·용역 내역(별도 표)과 같은 값을 준다', () => {
    const cell = r.cells.find(
      (c) =>
        normalizeCompanyName(c.rowCompany) === normalizeCompanyName('미래에셋 금융서비스(주)') &&
        normalizeCompanyName(c.colCompany) === normalizeCompanyName('미래에셋 생명보험(주)'),
    );
    expect(cell?.amount).toBe(205_454 * MILLION);

    const yk = r.cells.find(
      (c) =>
        normalizeCompanyName(c.rowCompany) === normalizeCompanyName('와이케이 디벨롭먼트(주)') &&
        normalizeCompanyName(c.colCompany) === normalizeCompanyName('미래에셋 증권(주)'),
    );
    // 주요 내역 표의 (골프장운영 5,890 + 부동산관리 1,299) 소계와 일치한다
    expect(yk?.amount).toBe(7_189 * MILLION);
  });
});

describe('j004 매트릭스 파서 — 안전장치', () => {
  it('회사명 화이트리스트 밖의 열은 버리고 진단에 남긴다', () => {
    const known = [
      '미래에셋캐피탈',
      '미래에셋증권',
      '미래에셋생명보험',
      '미래에셋자산운용',
      '미래에셋금융서비스',
      '와이케이디벨롭먼트',
    ];
    const r = extractGoodsServicesMatrix(MD, { knownCompanies: known });
    const cols = new Set(r.cells.map((c) => normalizeCompanyName(c.colCompany)));
    for (const k of cols) expect(known.map(normalizeCompanyName)).toContain(k);
    // 국외 계열사는 목록 밖이라 버려지되 조용히 사라지지 않는다
    expect(r.droppedColumns.some((n) => /Mirae Asset/i.test(n))).toBe(true);
    // 행도 같은 목록으로 거른다
    const rows = new Set(r.cells.map((c) => normalizeCompanyName(c.rowCompany)));
    for (const k of rows) expect(known.map(normalizeCompanyName)).toContain(k);
  });

  it('없는 절을 요구하면 빈 결과를 준다 (예외를 던지지 않는다)', () => {
    const r = extractMatrix(MD, '있을 리 없는 절 제목');
    expect(r.cells).toEqual([]);
    expect(r.tables).toBe(0);
  });

  /**
   * 특수관계인(개인) 거래표는 열이 회사가 아니라 '동일인,배우자,혈족 1촌' 같은 관계 구분이다.
   * 화이트리스트를 주면 거래상대방으로 오인하지 않는다 — 개인은 corp_code 조인 대상이 아니다.
   */
  it('특수관계인 표의 관계 구분을 회사로 오인하지 않는다', () => {
    const r = extractMatrix(MD, '특수관계인에 대한 유가증권거래 현황', {
      knownCompanies: ['미래에셋증권'],
    });
    expect(r.cells).toEqual([]);
    expect(r.droppedColumns).toContain('동일인,배우자,혈족 1촌');
  });
});
