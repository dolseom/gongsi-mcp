/**
 * 헤더 승격·열 구조 검증 (Codex S1).
 *
 * `readLabeledTables` 는 마크다운 구분선 **뒤에** 오는 다층 헤더 줄을 헤더로 끌어올린다.
 * 판별 기준은 "숫자·날짜가 하나도 없는 선두 행"이라, 열 수가 흔들리거나 값이 전부 '-' 인
 * 데이터 행이 섞이면 값 열을 잘못 잡을 수 있다는 것이 Codex 지적이었다.
 *
 * 여기서 고정하는 계약:
 *  ① 승격 횟수·열 수 불일치를 **세어서 진단에 낸다** (조용히 일어나면 안 된다).
 *  ② 값 열은 **열 번호가 아니라 "데이터가 전부 숫자('-' 포함)인 열"** 로 잡으므로,
 *     행마다 열 수가 달라도 금액을 엉뚱한 칸에서 읽지 않는다.
 *  ③ 값이 전부 '-' 인 선두 데이터 행은 실제로 승격된다 — 금액이 없어 판정에는 영향이 없지만
 *     그 사실이 진단에 드러나야 한다.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLabeledTables, sliceSection, diagnose } from '../src/parsers/j004-transactions.js';
import { extractMatrix, extractSecuritiesMatrix } from '../src/parsers/j004-matrix.js';
import { normalizeCompanyName } from '../src/parsers/md-table.js';

const MATRIX_MD = readFileSync(
  join(import.meta.dirname, 'fixtures', 'j004-matrix.md'),
  'utf8',
);
const TX_MD = readFileSync(
  join(import.meta.dirname, 'fixtures', 'j004-transactions.md'),
  'utf8',
);
const MILLION = 1_000_000;

describe('헤더 승격 계측 (Codex S1)', () => {
  it('실물 유가증권 총괄표에서 승격이 실제로 일어나고 세어진다', () => {
    const sec = sliceSection(MATRIX_MD, '계열회사간 유가증권거래 현황')!;
    const tables = readLabeledTables(sec);
    const promoted = tables.reduce((a, t) => a + t.headerPromotedRows, 0);
    // 구분선 뒤에 오는 다층 헤더 2줄 + 값이 전부 '-' 인 선두 데이터 행까지 끌어올려진다
    expect(promoted).toBeGreaterThan(0);
    for (const t of tables) {
      expect(t.headerPromotedRows).toBeLessThanOrEqual(3); // 가드 상한
      expect(t.width).toBeGreaterThan(0);
    }
  });

  it('매트릭스 결과에 승격·열 불일치 수가 실린다', () => {
    const r = extractSecuritiesMatrix(MATRIX_MD);
    expect(typeof r.headerPromotedRows).toBe('number');
    expect(typeof r.raggedRows).toBe('number');
    expect(r.headerPromotedRows).toBeGreaterThan(0);
  });

  it('diagnose 가 승격·열 불일치를 보고한다', () => {
    const d = diagnose(TX_MD);
    expect(typeof d.header_promoted_rows).toBe('number');
    expect(typeof d.ragged_rows).toBe('number');
    expect(typeof d.tables_with_ragged_rows).toBe('number');
    // 실물 축약 픽스처는 열 수가 고른 표다 — 불일치가 0 이어야 한다
    expect(d.ragged_rows).toBe(0);
    expect(d.tables_with_ragged_rows).toBe(0);
  });
});

describe('열 수가 흔들려도 값 열을 엉뚱하게 잡지 않는다 (Codex S1)', () => {
  /**
   * 병합 헤더 전개가 밀려 **행마다 열 수가 다른** 표.
   * 마지막 두 행은 뒤쪽 빈 칸이 잘려 열 수가 짧다 — 실물 마크다운 변환에서 흔한 형태다.
   */
  const RAGGED = [
    '## (3) 계열회사간 유가증권거래 현황',
    '',
    '| (직전 사업연도 개시일 ~ 종료일 기준, 단위 : 백만원) |',
    '| --- |',
    '',
    '| 매입회사 ＼ 매도회사 |  | 계열회사 |  |  |',
    '| --- | --- | --- | --- | --- |',
    '| (소속회사) |  | 갑회사(주) | 을회사(주) | 소계 |',
    '| 금융회사 | 병회사(주) | 1,500 | 400 | 1,900 |',
    '| 금융회사 | 정회사(주) | 2,000 | 700 |', // 열 2개 짧다
    '| 합 계 |  | 3,500 | 1,100 | 4,600 |',
  ].join('\n');

  it('열 수 불일치를 진단에 세면서도 금액은 정확히 읽는다', () => {
    const r = extractMatrix(RAGGED, '계열회사간 유가증권거래 현황');
    expect(r.raggedRows).toBeGreaterThan(0); // 조용히 넘어가지 않는다

    const get = (row: string, col: string): number | undefined =>
      r.cells.find(
        (c) =>
          normalizeCompanyName(c.rowCompany) === normalizeCompanyName(row) &&
          normalizeCompanyName(c.colCompany) === normalizeCompanyName(col),
      )?.amount;

    // 열이 짧은 행도 앞쪽 값은 제 열에서 읽힌다
    expect(get('병회사(주)', '갑회사(주)')).toBe(1_500 * MILLION);
    expect(get('병회사(주)', '을회사(주)')).toBe(400 * MILLION);
    expect(get('정회사(주)', '갑회사(주)')).toBe(2_000 * MILLION);
    expect(get('정회사(주)', '을회사(주)')).toBe(700 * MILLION);
    // 소계 열은 회사로 둔갑하지 않는다
    expect(r.cells.some((c) => normalizeCompanyName(c.colCompany) === '소계')).toBe(false);
    // 합계 행도 거래로 세지 않는다
    expect(r.cells.some((c) => c.rowCompany.includes('합'))).toBe(false);
    expect(r.cells).toHaveLength(4);
  });

  /**
   * ★ 값 열 판별이 "열 번호"였다면 깨졌을 배치 — 회사명 칸이 하나 더 있는 표.
   * "데이터가 전부 숫자인 열" 규칙이라 앞쪽 문자열 칸이 몇 개든 값 열을 정확히 고른다.
   */
  const SHIFTED = [
    '## (3) 계열회사간 유가증권거래 현황',
    '',
    '| (단위 : 백만원) |',
    '| --- |',
    '',
    '| 매입회사 ＼ 매도회사 |  |  | 계열회사 |  |',
    '| --- | --- | --- | --- | --- |',
    '| 구분 | 그룹 | (소속회사) | 갑회사(주) | 을회사(주) |',
    '| 금융회사 | 국내 | 병회사(주) | 1,500 | 400 |',
    '| 합 계 |  |  | 1,500 | 400 |',
  ].join('\n');

  it('회사명 칸이 하나 더 있어도 값 열을 열 번호로 찍지 않는다', () => {
    const r = extractMatrix(SHIFTED, '계열회사간 유가증권거래 현황');
    expect(r.cells).toHaveLength(2);
    const byCol = new Map(r.cells.map((c) => [normalizeCompanyName(c.colCompany), c.amount]));
    expect(byCol.get(normalizeCompanyName('갑회사(주)'))).toBe(1_500 * MILLION);
    expect(byCol.get(normalizeCompanyName('을회사(주)'))).toBe(400 * MILLION);
    // 행 회사명은 값 열 **직전**의 마지막 비어 있지 않은 칸이다
    expect(r.cells.every((c) => c.rowCompany === '병회사(주)')).toBe(true);
  });

  /** 값이 전부 '-' 인 선두 데이터 행은 승격된다 — 금액이 없어 판정에는 영향이 없다 */
  it("값이 전부 '-' 인 선두 행은 헤더로 승격되지만 거래를 만들지도 잃지도 않는다", () => {
    const DASH = [
      '## (3) 계열회사간 유가증권거래 현황',
      '',
      '| (단위 : 백만원) |',
      '| --- |',
      '',
      '| 매입회사 ＼ 매도회사 |  | 계열회사 |  |',
      '| --- | --- | --- | --- |',
      '| (소속회사) |  | 갑회사(주) | 을회사(주) |',
      '| 비금융사 | - | - | - |',
      '| 금융회사 | 병회사(주) | 1,500 | 400 |',
      '| 합 계 |  | 1,500 | 400 |',
    ].join('\n');
    const r = extractMatrix(DASH, '계열회사간 유가증권거래 현황');
    expect(r.headerPromotedRows).toBeGreaterThanOrEqual(2);
    // '-' 행은 금액이 없으므로 어차피 거래가 아니다 — 승격돼도 잃는 값이 없다
    expect(r.cells).toHaveLength(2);
    expect(r.cells.every((c) => c.rowCompany === '병회사(주)')).toBe(true);
    // 승격된 '-' 행이 열 이름을 오염시키지 않는다
    expect(r.cells.some((c) => c.colCompany === '-' || c.colCompany === '비금융사')).toBe(false);
  });
});
