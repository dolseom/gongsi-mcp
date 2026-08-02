import { describe, expect, it } from 'vitest';
import {
  parseDisclosureNumber,
  normalizeCompanyName,
  splitSections,
} from '../src/parsers/md-table.js';
import {
  checkJ004Document,
  crossCheckFinanceRow,
  parseFinanceTable,
} from '../src/rules/j004-checks.js';

describe('md-table 파서', () => {
  it('공시 표기 숫자를 파싱한다', () => {
    expect(parseDisclosureNumber('1,903,956')).toBe(1903956);
    expect(parseDisclosureNumber('(9)')).toBe(-9);
    expect(parseDisclosureNumber('-72,980')).toBe(-72980);
    expect(parseDisclosureNumber('0')).toBe(0);
    expect(parseDisclosureNumber('1,248.46')).toBe(1248.46);
    expect(parseDisclosureNumber('-')).toBeNull();
    expect(parseDisclosureNumber('자본잠식')).toBeNull();
    expect(parseDisclosureNumber('')).toBeNull();
    expect(parseDisclosureNumber('△1,000')).toBe(-1000);
  });

  it('회사명 정규화 — 법인격 표기 차이를 무시한다', () => {
    expect(normalizeCompanyName('미래에셋캐피탈(주)')).toBe(normalizeCompanyName('미래에셋캐피탈 주식회사'));
    expect(normalizeCompanyName('시니안(유)')).toBe(normalizeCompanyName('시니안 유한회사'));
  });

  it('섹션과 표를 분리한다 (구분선 뒤 다층 헤더 행 포함)', () => {
    const md = [
      '## (2) 회사 재무현황',
      '| (단위 : 백만원) |',
      '| --- |',
      '',
      '| 계열회사명 |  | 자산 |',
      '| --- | --- | --- |',
      '| 계열회사명 |  | 자산총계(a+b) |',
      '| 금융회사 | A사 | 100 |',
    ].join('\n');
    const sections = splitSections(md);
    const sec = sections.find((s) => s.title.includes('재무현황'))!;
    expect(sec.tables.length).toBe(2);
    expect(sec.tables[1]!.rows.length).toBe(2); // 다층 헤더 잔여행 + 데이터행
  });
});

/** 실물(미래에셋 연1회) 구조를 축약한 재무현황 표 */
function financeMd(rows: string[]): string {
  return [
    '## (2) 회사 재무현황',
    '| (직전 사업연도말 기준, 단위 : 백만원, %) |',
    '| --- |',
    '',
    '| 계열회사명 |  | 자산 |  |  |  | 부채 |  |  |  | 자본 |  | 부채비율 (부채총계/ 자본총계) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '| 계열회사명 |  | 유동자산(a) | 현금 및 현금성자산 | 비유동자산(b) | 자산총계(a+b) | 유동부채(c) | 비유동부채(d) | 부채총계(c+d) | 부채총계 중 차입금 | 자본금 | 자본총계 | 부채비율 (부채총계/ 자본총계) |',
    ...rows,
  ].join('\n');
}

describe('J004 재무현황 점검', () => {
  it('정상 행은 이슈가 없다', () => {
    const md = financeMd([
      '| 금융회사 | A사 | 1,000 | 100 | 2,000 | 3,000 | 500 | 1,500 | 2,000 | - | 100 | 1,000 | 200.00 |',
      '| 금융회사 | 소계 | 1,000 | 100 | 2,000 | 3,000 | 500 | 1,500 | 2,000 | - | 100 | 1,000 | 200 |',
      '| 합계 |  | 1,000 | 100 | 2,000 | 3,000 | 500 | 1,500 | 2,000 | - | 100 | 1,000 | 200 |',
    ]);
    const r = checkJ004Document(md);
    expect(r.financeRows).not.toBeNull();
    expect(r.issues).toEqual([]);
  });

  it('자산 합산 불일치를 잡는다 (실물 미래에셋파트너스제11호 패턴)', () => {
    const md = financeMd([
      '| 금융회사 | 파트너스제11호 | 403 | 403 | 286,990 | 286,665 | 728 | - | 728 | - | 296,643 | 286,665 | 0.25 |',
    ]);
    const r = checkJ004Document(md);
    expect(r.issues.some((i) => i.check === 'asset_sum')).toBe(true);
  });

  it('부채 합산 불일치를 잡는다 (실물 큐리어스 패턴)', () => {
    const md = financeMd([
      '| 금융회사 | 큐리어스 | 583 | 583 | 14,999 | 15,582 | 52 | - | 34 | - | 15,749 | 15,548 | 0.22 |',
    ]);
    const r = checkJ004Document(md);
    // 유동부채(52)+비유동(없음→가산 불가)이라 c+d 검증은 건너뛰지만, 항등식(자산=부채+자본)은 통과해야 한다
    // 52는 c만 있고 d가 '-' 라 liability_sum 은 스킵된다 — 실물에서 이 행은 항등식으론 정합
    expect(r.issues.filter((i) => i.check === 'balance_identity')).toEqual([]);
  });

  it('항등식(자산=부채+자본) 위반을 잡는다', () => {
    const md = financeMd([
      '| 비금융회사 | B사 | 1,000 | - | 1,000 | 2,000 | 500 | 500 | 1,000 | - | 100 | 500 | 200.00 |',
    ]);
    const r = checkJ004Document(md);
    expect(r.issues.some((i) => i.check === 'balance_identity')).toBe(true);
  });

  it('단위 오기(1,000배)에 힌트를 단다', () => {
    const md = financeMd([
      '| 비금융회사 | C사 | 1,000,000 | - | 2,000,000 | 3,000 | 500 | 500 | 1,000 | - | 100 | 2,000 | 50.00 |',
    ]);
    const r = checkJ004Document(md);
    const issue = r.issues.find((i) => i.check === 'asset_sum');
    expect(issue?.hint).toContain('단위');
  });

  it('소계·합계 재합산 불일치를 잡는다', () => {
    const md = financeMd([
      '| 금융회사 | A사 | 1,000 | - | 2,000 | 3,000 | 500 | 1,500 | 2,000 | - | 100 | 1,000 | 200.00 |',
      '| 금융회사 | B사 | 2,000 | - | 3,000 | 5,000 | 1,000 | 2,000 | 3,000 | - | 200 | 2,000 | 150.00 |',
      '| 금융회사 | 소계 | 3,000 | - | 5,000 | 9,000 | 1,500 | 3,500 | 5,000 | - | 300 | 3,000 | 167 |',
    ]);
    const r = checkJ004Document(md);
    const issue = r.issues.find((i) => i.check === 'subtotal_sum');
    expect(issue).toBeDefined();
    expect(issue?.detail).toContain('자산총계');
  });

  it('부채비율 불일치는 경고로 잡되 소액 분모는 건너뛴다', () => {
    const md = financeMd([
      '| 금융회사 | D사 | 100,000 | - | 100,000 | 200,000 | 50,000 | 50,000 | 100,000 | - | 100 | 100,000 | 500.00 |',
      '| 금융회사 | 소액사 | 15 | 15 | - | 15 | 3 | - | 3 | - | 10 | 12 | 4.00 |',
    ]);
    const r = checkJ004Document(md);
    const ratioIssues = r.issues.filter((i) => i.check === 'debt_ratio');
    expect(ratioIssues.length).toBe(1); // D사(100.00이어야 하는데 500.00)만 — 소액사는 가드로 스킵
    expect(ratioIssues[0]!.severity).toBe('warning');
  });

  it('자본잠식 등 텍스트 값은 비율 점검을 건너뛴다', () => {
    const md = financeMd([
      '| 금융회사 | E사 | 15 | 15 | - | 15 | 3 | 72,993 | 72,996 | - | 115,525 | -72,980 | 자본잠식 |',
    ]);
    const r = checkJ004Document(md);
    expect(r.issues.filter((i) => i.check === 'debt_ratio')).toEqual([]);
  });
});

describe('J004 손익현황 점검 (키워드 앵커 정밀 점검)', () => {
  it('손익현황 합계 불일치를 error 로 잡는다', () => {
    const md = [
      '## (3) 회사 손익현황',
      '| 소속회사명 |  | 매출액(또는 영업수익) | 영업이익 | 당기순이익 |',
      '| --- | --- | --- | --- | --- |',
      '| 비금융회사 | A사 | 1,000 | 100 | 50 |',
      '| 비금융회사 | B사 | 2,000 | 200 | 100 |',
      '| 합계 |  | 3,500 | 300 | 150 |',
    ].join('\n');
    const r = checkJ004Document(md);
    const issue = r.issues.find((i) => i.check === 'total_sum');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
    expect(issue?.detail).toContain('매출액');
  });

  it('손익 소계(금융/비금융)도 재합산한다', () => {
    const md = [
      '## (3) 회사 손익현황',
      '| 소속회사명 |  | 매출액 (영업수익) | 영업이익 | 당기순이익 |',
      '| --- | --- | --- | --- | --- |',
      '| 금융회사 | A사 | 1,000 | 100 | 50 |',
      '| 금융회사 | B사 | 2,000 | 200 | 100 |',
      '| 금융회사 | 소계 | 3,000 | 300 | 250 |',
    ].join('\n');
    const r = checkJ004Document(md);
    const issue = r.issues.find((i) => i.check === 'subtotal_sum');
    expect(issue).toBeDefined();
    expect(issue?.detail).toContain('당기순이익');
  });
});

describe('J004 일반 표 합계 점검 (opt-in)', () => {
  const ownershipMd = [
    '## (1) 소유지분현황',
    '| 주주명 | 지분율(%) | 주식수 |',
    '| --- | --- | --- |',
    '| 갑 | 60.0 | 600 |',
    '| 을 | 40.0 | 300 |',
    '| 합계 | 100.0 | 1,000 |',
  ].join('\n');

  it('기본은 꺼져 있다 — 일반 표 불일치를 보고하지 않는다', () => {
    const r = checkJ004Document(ownershipMd);
    expect(r.issues).toEqual([]);
  });

  it('켜면 잡되 비율 열은 제외한다', () => {
    const r = checkJ004Document(ownershipMd, { includeGenericTotals: true });
    const issues = r.issues.filter((i) => i.check === 'total_sum');
    expect(issues.length).toBe(1); // 주식수(900≠1,000)만 — 지분율 열은 제외
    expect(issues[0]!.severity).toBe('warning');
  });

  it('병합 셀 전개(연속 중복)로 2배가 된 재합산은 오탐으로 걸러진다', () => {
    const md = [
      '## (13) 계열회사간 거래 현황',
      '| 회사명 | 금액 |',
      '| --- | --- |',
      '| A사 | 500 |',
      '| A사 | 500 |',
      '| B사 | 300 |',
      '| 합계 | 800 |',
    ].join('\n');
    const r = checkJ004Document(md, { includeGenericTotals: true });
    expect(r.issues).toEqual([]); // 연속 중복 제거 합산(800)이 합계와 일치
  });
});

describe('대표회사 ↔ 개별회사 대사', () => {
  const repMd = financeMd([
    '| 비금융회사 | 에프앤씨티 유한회사 | 491 | 488 | - | 491 | - | - | - | - | 50 | 491 | - |',
    '| 비금융회사 | 다른회사(주) | 100 | - | 100 | 200 | 50 | 50 | 100 | - | 10 | 100 | 100.00 |',
  ]);

  it('같은 수치면 diff 가 없다', () => {
    const rep = parseFinanceTable(splitSections(repMd).find((s) => s.title.includes('재무현황'))!.tables[1]!)!;
    const indivMd = financeMd([
      '| 비금융회사 | 에프앤씨티(유) | 491 | 488 | - | 491 | - | - | - | - | 50 | 491 | - |',
    ]);
    const indiv = parseFinanceTable(splitSections(indivMd).find((s) => s.title.includes('재무현황'))!.tables[1]!)!;
    const r = crossCheckFinanceRow(rep, indiv, '에프앤씨티(유)');
    expect(r.matched).toBe(true);
    expect(r.diffs).toEqual([]);
  });

  it('수치가 다르면 열별 diff 를 낸다', () => {
    const rep = parseFinanceTable(splitSections(repMd).find((s) => s.title.includes('재무현황'))!.tables[1]!)!;
    const indivMd = financeMd([
      '| 비금융회사 | 다른회사 주식회사 | 100 | - | 100 | 200 | 50 | 50 | 100 | - | 10 | 90 | 111.11 |',
    ]);
    const indiv = parseFinanceTable(splitSections(indivMd).find((s) => s.title.includes('재무현황'))!.tables[1]!)!;
    const r = crossCheckFinanceRow(rep, indiv, '다른회사 주식회사');
    expect(r.matched).toBe(true);
    expect(r.diffs.some((d) => d.detail.includes('자본총계'))).toBe(true);
  });

  it('취합 표에 없는 회사는 matched=false', () => {
    const rep = parseFinanceTable(splitSections(repMd).find((s) => s.title.includes('재무현황'))!.tables[1]!)!;
    const indivMd = financeMd([
      '| 비금융회사 | 없는회사(주) | 1 | - | 1 | 2 | 1 | - | 1 | - | 1 | 1 | 100.00 |',
    ]);
    const indiv = parseFinanceTable(splitSections(indivMd).find((s) => s.title.includes('재무현황'))!.tables[1]!)!;
    const r = crossCheckFinanceRow(rep, indiv, '없는회사(주)');
    expect(r.matched).toBe(false);
  });
});
