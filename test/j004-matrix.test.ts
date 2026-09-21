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

/**
 * 회사명 헤더 줄을 **값 열 앵커**로 고르는 규칙의 실물 회귀 (2026-09-21 44문서 전수 스캔).
 *
 * 종전 규칙("고유 비집계 라벨이 가장 많은 줄, 3개 이상")은 세 가지 모양으로 깨졌고, 그 결과가
 * 전부 **조용한 손실**이었다 — 상대방 이름이 묶음 이름으로 바뀌거나(25셀), 표가 통째로
 * 사라지거나(4표), 집계값이 거래로 둔갑했다(1셀). 되돌리면 이 describe 가 깨진다.
 */
describe('j004 매트릭스 파서 — 회사명 줄 선택 (실물 서식 변형)', () => {
  const load = (name: string): string => readFileSync(join(HERE, 'fixtures', name), 'utf8');

  it('그룹 헤더 줄과 동점이어도 회사명 줄을 고른다 (미래에셋 20260609000355)', () => {
    const r = extractSecuritiesMatrix(load('j004-matrix-tiebreak.md'));
    expect(r.cells.map((c) => c.colCompany)).toEqual(['미래에셋컨설팅(주)', '미래에셋자산운용(주)']);
    expect(r.cells.map((c) => c.amount)).toEqual([216_476 * MILLION, 279_551 * MILLION]);
    // 묶음 이름이 거래상대방으로 새지 않는다
    expect(r.cells.some((c) => /^(비금융회사|금융회사)$/.test(c.colCompany))).toBe(false);
    expect(r.groupLabelColumns).toEqual([]);
    expect(r.tablesUnrecognized).toBe(0);
  });

  it('거래상대방 회사가 1개뿐인 표도 읽는다 (태광 20260608000327)', () => {
    const r = extractSecuritiesMatrix(load('j004-matrix-single-company.md'));
    expect(r.tables).toBe(1);
    expect(r.tablesUnrecognized).toBe(0);
    expect(r.cells).toHaveLength(1);
    expect(r.cells[0]?.rowCompany).toBe('흥국자산운용㈜');
    expect(r.cells[0]?.colCompany).toBe('흥국증권㈜');
    expect(r.cells[0]?.amount).toBe(3_508_645.1 * MILLION);
  });

  it('회사명 줄이 그룹 헤더 줄보다 라벨이 적어도 고른다 (태광 20260604000627)', () => {
    const r = extractGoodsServicesMatrix(load('j004-matrix-sparse-name-row.md'));
    expect(r.cells).toHaveLength(1);
    expect(r.cells[0]?.colCompany).toBe('흥국생명보험(주)');
    expect(r.cells[0]?.amount).toBe(3_457.8 * MILLION);
  });

  it('같은 묶음의 둘째 회사 칸이 살아남는다 (소노 20260615000445)', () => {
    const r = extractSecuritiesMatrix(load('j004-matrix-sibling-columns.md'));
    const byCol = new Map(r.cells.map((c) => [c.colCompany, c.amount]));
    expect(byCol.get('(주)소노인터내셔널')).toBe(190_000 * MILLION);
    // ★ 종전에는 이 칸이 빈 셀(그룹 헤더 줄)이라 통째로 사라졌다
    expect(byCol.get('(주)소노스퀘어')).toBe(20_000 * MILLION);
    expect(r.cells.every((c) => c.rowCompany === '(주)트리니티항공')).toBe(true);
  });

  it('총계 전용 페이지는 집계값을 거래로 만들지 않고 정상 스킵으로 센다 (태광 20260605000550)', () => {
    const r = extractGoodsServicesMatrix(load('j004-matrix-total-only-page.md'));
    // 값 열 이름이 전부 집계 라벨인 마지막 페이지는 tablesUnrecognized 가 아니라 정상 스킵이다
    expect(r.tablesAggregateOnly).toBe(1);
    expect(r.tablesUnrecognized).toBe(0);
    // '국내계열사 계(매출액) 12,013.1' 이 회사와의 120.13억 거래로 둔갑하지 않는다
    expect(r.cells.some((c) => /계열회사|계열사/.test(c.colCompany))).toBe(false);
    expect(r.cells.some((c) => c.amount === 12_013.1 * MILLION)).toBe(false);
    expect(r.cells.map((c) => c.colCompany)).toEqual([
      '태광산업(주)',
      '대한화섬(주)',
      '서한물산(주)',
      '(주)티시스',
    ]);
  });

  /**
   * ★ 오경보 방지선. 계열 상대방 열이 전부 '-' 라 셀이 0개인 것은 **정상 0건**이다
   * (실물 3문서 — 매출액 총계는 비계열을 포함하므로 쌍으로 쓸 수 없다).
   * 여기서 tablesUnrecognized 가 켜지면 detect 가 매번 헛경보를 낸다.
   */
  it('계열 상대방 열이 전부 "-" 인 정상 0건은 경보하지 않는다 (라인 20260602000557)', () => {
    const r = extractGoodsServicesMatrix(load('j004-matrix-no-affiliate-columns.md'));
    expect(r.cells).toEqual([]);
    expect(r.tablesUnrecognized).toBe(0);
    // 금액이 없는 묶음 이름 열('국외계열회사')은 잃는 거래가 없으므로 진단에도 올리지 않는다
    expect(r.groupLabelColumns).toEqual([]);
  });

  /**
   * 헤더 승격(`readLabeledTables`)은 값이 전부 '-' 인 선두 데이터 행도 헤더로 올린다.
   * 그 행이 "마지막 헤더 줄"이 되어 회사명 줄을 가리면 안 된다 — 값 열 칸이 전부 '-' 라
   * 집계 라벨로 걸러지고 한 줄 위(진짜 회사명 줄)가 앵커가 된다.
   */
  it('승격된 비데이터 행이 회사명 줄을 가리지 않는다', () => {
    const md = [
      '## (3) 계열회사간 유가증권거래 현황',
      '',
      '| (단위 : 백만원) |',
      '| --- |',
      '',
      '| 매입회사 ＼매도회사(소속회사) |  | 계열회사 |  |',
      '| --- | --- | --- | --- |',
      '| 매입회사 ＼매도회사(소속회사) |  | 갑회사(주) | 을회사(주) |',
      '| 비금융사 | - | - | - |',
      '| 비금융회사 | 병회사(주) | 1,000 | 2,000 |',
      '',
    ].join('\n');
    const r = extractSecuritiesMatrix(md);
    expect(r.cells.map((c) => c.colCompany)).toEqual(['갑회사(주)', '을회사(주)']);
    expect(r.cells.map((c) => c.amount)).toEqual([1_000 * MILLION, 2_000 * MILLION]);
  });

  /**
   * 값 열 앵커로도 그룹 헤더 줄이 회사명 줄로 뽑히는 모르는 서식이 나오면,
   * 틀린 이름으로 판정하지 말고 진단에 남긴다 (조용히 틀리는 것이 가장 나쁘다).
   */
  it('회사명이 위 헤더 줄 라벨과 같으면 거래상대방으로 쓰지 않고 진단에 남긴다', () => {
    const md = [
      '## (3) 계열회사간 유가증권거래 현황',
      '',
      '| (단위 : 백만원) |',
      '| --- |',
      '',
      '| 매입회사 ＼매도회사(소속회사) |  | 비금융회사 |  |',
      '| --- | --- | --- | --- |',
      '| 매입회사 ＼매도회사(소속회사) |  | 비금융회사 | 갑회사(주) |',
      '| 비금융회사 | 을회사(주) | 5,000 | 7,000 |',
      '',
    ].join('\n');
    const r = extractSecuritiesMatrix(md);
    expect(r.cells.map((c) => c.colCompany)).toEqual(['갑회사(주)']);
    expect(r.groupLabelColumns).toEqual(['비금융회사']);
  });
});
