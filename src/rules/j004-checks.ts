/**
 * J004(기업집단현황공시) 정합성 점검 룰
 *
 * 리서치 근거: 공시의무 위반 건수의 84%가 J004이고 공정위 공식 원인 1위가 "담당자 업무 미숙".
 * 제출 전에 기계적으로 잡을 수 있는 오류(합산·항등식·비율·단위)를 잡아 주는 것이 목적이다.
 *
 * 실측 설계 근거 (2026-08-02, 미래에셋 연1회 대표회사 공시 실물):
 *  - 재무현황 표: 유동자산(a)+비유동자산(b)=자산총계, 유동부채(c)+비유동부채(d)=부채총계,
 *    자산총계=부채총계+자본총계, 부채비율=부채총계/자본총계 — 전부 열이 명시돼 재계산 가능
 *  - 실물에서 실제 불일치 2건 발견 (파트너스제11호 자산 합산, 큐리어스 부채 합산) — 룰이 실전에서 잡는다
 *  - 부채비율은 백만원 반올림 때문에 분모·분자가 작으면 노이즈가 크다 (시니안 실측) → 하한 가드
 *  - 값 표기: '1,234' / '(9)'=음수 / '-72,980' / '-'=없음 / '자본잠식' 텍스트
 */

import {
  splitSections,
  parseDisclosureNumber,
  normalizeCell,
  normalizeCompanyName,
  type DocSection,
  type MdTable,
} from '../parsers/md-table.js';

export type IssueSeverity = 'error' | 'warning';

export interface ConsistencyIssue {
  severity: IssueSeverity;
  section: string;
  rowLabel: string;
  check:
    | 'asset_sum'
    | 'liability_sum'
    | 'balance_identity'
    | 'debt_ratio'
    | 'subtotal_sum'
    | 'total_sum'
    | 'cross_doc_mismatch';
  detail: string;
  expected: number;
  actual: number;
  /** 단위 오기 등 원인 추정 */
  hint?: string;
}

export interface FinanceRow {
  group: string;
  company: string;
  currentAssets: number | null;
  nonCurrentAssets: number | null;
  totalAssets: number | null;
  currentLiabilities: number | null;
  nonCurrentLiabilities: number | null;
  totalLiabilities: number | null;
  paidInCapital: number | null;
  totalEquity: number | null;
  debtRatio: number | null;
  isSubtotal: boolean;
  isTotal: boolean;
}

/**
 * 항등식 허용오차 — 반올림 먼지(수백만원대 표에서 ±수 단위)는 위반이 아니라 노이즈다.
 * 실측: 미래에셋 실물에서 diff 3·10(반올림 성격)과 diff 728(실제 불일치)이 공존 —
 * 상대 오차(0.01%)로 가르면 전자는 걸러지고 후자만 남는다.
 */
function identityTolerance(reference: number): number {
  return Math.max(2, Math.abs(reference) * 1e-4);
}
function sumTolerance(rowCount: number): number {
  return Math.max(5, Math.ceil(rowCount * 0.5) + 2);
}

/** 재무현황 표의 열 인덱스를 헤더 키워드로 찾는다 */
interface FinanceCols {
  company: number;
  currentAssets?: number;
  nonCurrentAssets?: number;
  totalAssets?: number;
  currentLiabilities?: number;
  nonCurrentLiabilities?: number;
  totalLiabilities?: number;
  paidInCapital?: number;
  totalEquity?: number;
  debtRatio?: number;
}

function mapFinanceColumns(table: MdTable): FinanceCols | null {
  // 다층 헤더가 구분선 뒤 첫 행들로 밀려올 수 있어 헤더행 + 앞쪽 데이터행까지 훑는다
  const candidates = [...table.headerRows, ...table.rows.slice(0, 3)];
  let cols: FinanceCols | null = null;
  for (const row of candidates) {
    const found: FinanceCols = { company: 1 };
    let hits = 0;
    row.forEach((cell, i) => {
      const c = normalizeCell(cell);
      if (c === '') return;
      if (c.includes('유동자산') && !c.includes('비유동') && !c.includes('현금')) {
        found.currentAssets = i;
        hits++;
      } else if (c.includes('비유동자산')) {
        found.nonCurrentAssets = i;
        hits++;
      } else if (c.includes('자산총계')) {
        found.totalAssets = i;
        hits++;
      } else if (c.includes('유동부채') && !c.includes('비유동')) {
        found.currentLiabilities = i;
        hits++;
      } else if (c.includes('비유동부채')) {
        found.nonCurrentLiabilities = i;
        hits++;
      } else if (c.includes('부채총계') && !c.includes('차입금') && !c.includes('부채비율')) {
        found.totalLiabilities = i;
        hits++;
      } else if (c === '자본금') {
        found.paidInCapital = i;
        hits++;
      } else if (c.includes('자본총계') && !c.includes('부채')) {
        found.totalEquity = i;
        hits++;
      } else if (c.includes('부채비율')) {
        found.debtRatio = i;
        hits++;
      }
    });
    // 가장 구체적인 행(적중 열이 많은 행)을 채택한다
    if (hits >= 4 && (!cols || hits > countCols(cols))) cols = found;
  }
  return cols;
}

function countCols(c: FinanceCols): number {
  return Object.keys(c).length - 1;
}

function isHeaderLike(row: string[]): boolean {
  return row.every((c) => parseDisclosureNumber(c) === null);
}

function rowMarker(row: string[]): 'subtotal' | 'total' | null {
  for (const cell of row.slice(0, 3)) {
    const c = normalizeCell(cell);
    if (c === '소계') return 'subtotal';
    if (c === '합계' || c === '총계' || c === '계') return 'total';
  }
  return null;
}

/** 재무현황 표를 구조화한다. 열 매핑 실패 시 null */
export function parseFinanceTable(table: MdTable): FinanceRow[] | null {
  const cols = mapFinanceColumns(table);
  if (!cols || cols.totalAssets === undefined || cols.totalEquity === undefined) return null;

  const num = (row: string[], i?: number): number | null =>
    i === undefined ? null : parseDisclosureNumber(row[i] ?? '');

  const out: FinanceRow[] = [];
  let currentGroup = '';
  for (const row of table.rows) {
    if (isHeaderLike(row)) {
      // 다층 헤더 잔여 행 — 구분(금융/비금융) 라벨만 갱신될 수 있다
      continue;
    }
    const marker = rowMarker(row);
    const group = normalizeCell(row[0] ?? '');
    if (group !== '') currentGroup = group;
    out.push({
      group: currentGroup,
      company: (row[1] ?? '').trim() || (row[0] ?? '').trim(),
      currentAssets: num(row, cols.currentAssets),
      nonCurrentAssets: num(row, cols.nonCurrentAssets),
      totalAssets: num(row, cols.totalAssets),
      currentLiabilities: num(row, cols.currentLiabilities),
      nonCurrentLiabilities: num(row, cols.nonCurrentLiabilities),
      totalLiabilities: num(row, cols.totalLiabilities),
      paidInCapital: num(row, cols.paidInCapital),
      totalEquity: num(row, cols.totalEquity),
      debtRatio: num(row, cols.debtRatio),
      isSubtotal: marker === 'subtotal',
      isTotal: marker === 'total',
    });
  }
  return out.length > 0 ? out : null;
}

function unitHint(expected: number, actual: number): string | undefined {
  if (expected === 0 || actual === 0) return undefined;
  const ratio = Math.abs(expected / actual);
  if ((ratio > 900 && ratio < 1100) || (ratio > 1 / 1100 && ratio < 1 / 900)) {
    return '차이가 약 1,000배입니다 — 단위(원/천원/백만원) 오기 가능성을 확인하세요.';
  }
  return undefined;
}

function pushDiff(
  issues: ConsistencyIssue[],
  severity: IssueSeverity,
  section: string,
  rowLabel: string,
  check: ConsistencyIssue['check'],
  detail: string,
  expected: number,
  actual: number,
): void {
  issues.push({
    severity,
    section,
    rowLabel,
    check,
    detail,
    expected,
    actual,
    ...(unitHint(expected, actual) ? { hint: unitHint(expected, actual) } : {}),
  });
}

/** 재무현황 표 점검 — 행별 항등식 + 소계·합계 재합산 */
export function checkFinanceRows(section: string, rows: FinanceRow[]): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const dataRows = rows.filter((r) => !r.isSubtotal && !r.isTotal);

  // 구성항목의 '-'(무액)는 0으로 보고 합산한다 — 한쪽만 '-' 인 행에서 항등식을 통째로 건너뛰면
  // 실제 오류(실측: 유동부채 52 + '-' ≠ 부채총계 34)를 놓친다 (Codex 3차).
  // 단 두 구성항목이 모두 '-' 면 검증 근거가 없으므로 건너뛴다.
  for (const r of dataRows) {
    if (r.totalAssets !== null && (r.currentAssets !== null || r.nonCurrentAssets !== null)) {
      const sum = (r.currentAssets ?? 0) + (r.nonCurrentAssets ?? 0);
      if (Math.abs(sum - r.totalAssets) > identityTolerance(r.totalAssets)) {
        pushDiff(
          issues, 'error', section, r.company, 'asset_sum',
          `유동자산+비유동자산(${fmt(sum)}) ≠ 자산총계(${fmt(r.totalAssets)})`,
          sum, r.totalAssets,
        );
      }
    }
    if (
      r.totalLiabilities !== null &&
      (r.currentLiabilities !== null || r.nonCurrentLiabilities !== null)
    ) {
      const sum = (r.currentLiabilities ?? 0) + (r.nonCurrentLiabilities ?? 0);
      if (Math.abs(sum - r.totalLiabilities) > identityTolerance(r.totalLiabilities)) {
        pushDiff(
          issues, 'error', section, r.company, 'liability_sum',
          `유동부채+비유동부채(${fmt(sum)}) ≠ 부채총계(${fmt(r.totalLiabilities)})`,
          sum, r.totalLiabilities,
        );
      }
    }
    if (r.totalAssets !== null && r.totalLiabilities !== null && r.totalEquity !== null) {
      const sum = r.totalLiabilities + r.totalEquity;
      if (Math.abs(sum - r.totalAssets) > identityTolerance(r.totalAssets)) {
        pushDiff(
          issues, 'error', section, r.company, 'balance_identity',
          `부채총계+자본총계(${fmt(sum)}) ≠ 자산총계(${fmt(r.totalAssets)}) — 재무상태표 항등식 위반`,
          sum, r.totalAssets,
        );
      }
    }
    // 부채비율(%) 재계산 — 백만원 반올림 노이즈 방지: 분자·분모 100백만원 이상일 때만
    if (
      r.debtRatio !== null &&
      r.totalLiabilities !== null &&
      r.totalEquity !== null &&
      r.totalEquity >= 100 &&
      r.totalLiabilities >= 100
    ) {
      const expected = (r.totalLiabilities / r.totalEquity) * 100;
      const tol = Math.max(1.0, expected * 0.02);
      if (Math.abs(expected - r.debtRatio) > tol) {
        pushDiff(
          issues, 'warning', section, r.company, 'debt_ratio',
          `부채비율 기재값 ${r.debtRatio}% vs 재계산 ${expected.toFixed(2)}% (부채총계/자본총계)`,
          Number(expected.toFixed(2)), r.debtRatio,
        );
      }
    }
  }

  // 소계(구분별)·합계 재합산 — 비율 열은 합산 대상이 아니므로 제외
  const numericKeys: Array<keyof FinanceRow> = [
    'currentAssets', 'nonCurrentAssets', 'totalAssets',
    'currentLiabilities', 'nonCurrentLiabilities', 'totalLiabilities',
    'paidInCapital', 'totalEquity',
  ];
  const colLabel: Record<string, string> = {
    currentAssets: '유동자산', nonCurrentAssets: '비유동자산', totalAssets: '자산총계',
    currentLiabilities: '유동부채', nonCurrentLiabilities: '비유동부채', totalLiabilities: '부채총계',
    paidInCapital: '자본금', totalEquity: '자본총계',
  };

  for (const sub of rows.filter((r) => r.isSubtotal)) {
    const groupRows = dataRows.filter((r) => r.group === sub.group);
    if (groupRows.length === 0) continue;
    for (const key of numericKeys) {
      const declared = sub[key];
      if (declared === null || typeof declared !== 'number') continue;
      const sum = groupRows.reduce((a, r) => a + ((r[key] as number | null) ?? 0), 0);
      if (Math.abs(sum - declared) > sumTolerance(groupRows.length)) {
        pushDiff(
          issues, 'error', section, `${sub.group} 소계`, 'subtotal_sum',
          `${colLabel[key]} 소계 ${fmt(declared)} vs 소속 ${groupRows.length}개사 재합산 ${fmt(sum)}`,
          sum, declared,
        );
      }
    }
  }
  const totalRow = rows.find((r) => r.isTotal);
  if (totalRow && dataRows.length > 0) {
    for (const key of numericKeys) {
      const declared = totalRow[key];
      if (declared === null || typeof declared !== 'number') continue;
      const sum = dataRows.reduce((a, r) => a + ((r[key] as number | null) ?? 0), 0);
      if (Math.abs(sum - declared) > sumTolerance(dataRows.length)) {
        pushDiff(
          issues, 'error', section, '합계', 'total_sum',
          `${colLabel[key]} 합계 ${fmt(declared)} vs 전체 ${dataRows.length}개사 재합산 ${fmt(sum)}`,
          sum, declared,
        );
      }
    }
  }
  return issues;
}

// ── 손익현황 표 — 재무현황과 같은 금융/비금융 소계+합계 구조 (실측 확인) ──

export interface IncomeRow {
  group: string;
  company: string;
  revenue: number | null;
  operatingIncome: number | null;
  otherIncome: number | null;
  otherExpenses: number | null;
  interestExpense: number | null;
  netIncome: number | null;
  isSubtotal: boolean;
  isTotal: boolean;
}

interface IncomeCols {
  revenue?: number;
  operatingIncome?: number;
  otherIncome?: number;
  otherExpenses?: number;
  interestExpense?: number;
  netIncome?: number;
}

function mapIncomeColumns(table: MdTable): IncomeCols | null {
  const candidates = [...table.headerRows, ...table.rows.slice(0, 3)];
  let cols: IncomeCols | null = null;
  for (const row of candidates) {
    const found: IncomeCols = {};
    let hits = 0;
    row.forEach((cell, i) => {
      const c = normalizeCell(cell);
      if (c === '') return;
      if (c.includes('매출액') || c.includes('영업수익')) {
        found.revenue = i;
        hits++;
      } else if (c.includes('영업이익')) {
        found.operatingIncome = i;
        hits++;
      } else if (c.includes('기타수익')) {
        found.otherIncome = i;
        hits++;
      } else if (c.includes('이자비용')) {
        // '기타비용등 중 이자비용'이 '기타비용' 키워드보다 먼저 걸리지 않도록 이자비용을 우선 판정
        found.interestExpense = i;
        hits++;
      } else if (c.includes('기타비용')) {
        found.otherExpenses = i;
        hits++;
      } else if (c.includes('당기순이익') || c.includes('당기순손익')) {
        found.netIncome = i;
        hits++;
      }
    });
    if (hits >= 3 && (!cols || hits > Object.keys(cols).length)) cols = found;
  }
  return cols;
}

export function parseIncomeTable(table: MdTable): IncomeRow[] | null {
  const cols = mapIncomeColumns(table);
  if (!cols || cols.revenue === undefined || cols.netIncome === undefined) return null;
  const num = (row: string[], i?: number): number | null =>
    i === undefined ? null : parseDisclosureNumber(row[i] ?? '');

  const out: IncomeRow[] = [];
  let currentGroup = '';
  for (const row of table.rows) {
    if (isHeaderLike(row)) continue;
    const marker = rowMarker(row);
    const group = normalizeCell(row[0] ?? '');
    if (group !== '') currentGroup = group;
    out.push({
      group: currentGroup,
      company: (row[1] ?? '').trim() || (row[0] ?? '').trim(),
      revenue: num(row, cols.revenue),
      operatingIncome: num(row, cols.operatingIncome),
      otherIncome: num(row, cols.otherIncome),
      otherExpenses: num(row, cols.otherExpenses),
      interestExpense: num(row, cols.interestExpense),
      netIncome: num(row, cols.netIncome),
      isSubtotal: marker === 'subtotal',
      isTotal: marker === 'total',
    });
  }
  return out.length > 0 ? out : null;
}

/** 손익현황 표 점검 — 금융/비금융 소계·합계 재합산 (행 내 항등식은 법인세 등으로 성립하지 않아 보지 않는다) */
export function checkIncomeRows(section: string, rows: IncomeRow[]): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const dataRows = rows.filter((r) => !r.isSubtotal && !r.isTotal);
  const keys: Array<[keyof IncomeRow & string, string]> = [
    ['revenue', '매출액(영업수익)'],
    ['operatingIncome', '영업이익'],
    ['otherIncome', '기타수익등'],
    ['otherExpenses', '기타비용등'],
    ['interestExpense', '이자비용'],
    ['netIncome', '당기순이익'],
  ];

  for (const sub of rows.filter((r) => r.isSubtotal)) {
    const groupRows = dataRows.filter((r) => r.group === sub.group);
    if (groupRows.length === 0) continue;
    for (const [key, label] of keys) {
      const declared = sub[key];
      if (typeof declared !== 'number') continue;
      const sum = groupRows.reduce((a, r) => a + ((r[key] as number | null) ?? 0), 0);
      if (Math.abs(sum - declared) > sumTolerance(groupRows.length)) {
        pushDiff(
          issues, 'error', section, `${sub.group} 소계`, 'subtotal_sum',
          `${label} 소계 ${fmt(declared)} vs 소속 ${groupRows.length}개사 재합산 ${fmt(sum)}`,
          sum, declared,
        );
      }
    }
  }
  const totalRow = rows.find((r) => r.isTotal);
  if (totalRow && dataRows.length > 0) {
    for (const [key, label] of keys) {
      const declared = totalRow[key];
      if (typeof declared !== 'number') continue;
      const sum = dataRows.reduce((a, r) => a + ((r[key] as number | null) ?? 0), 0);
      if (Math.abs(sum - declared) > sumTolerance(dataRows.length)) {
        pushDiff(
          issues, 'error', section, '합계', 'total_sum',
          `${label} 합계 ${fmt(declared)} vs 전체 ${dataRows.length}개사 재합산 ${fmt(sum)}`,
          sum, declared,
        );
      }
    }
  }
  return issues;
}

/**
 * 일반 표의 합계·소계 재합산 점검 (실험적 — 기본 꺼짐).
 * 비율·율·% 열은 합산 개념이 아니므로 헤더 키워드로 제외한다.
 *
 * ⚠️ 실측(미래에셋 실물): 다층 구분·병합 셀 전개 표에서는 "합계 = 재합산의 정확히 절반" 류
 * 오탐이 다수 발생한다 (연속 중복 제거로도 안 잡히는 구조적 중복). 구조를 아는
 * 재무현황·손익현황 표만 기본 점검하고, 이 함수는 opt-in 으로만 쓴다.
 */
export function checkGenericTotals(section: string, table: MdTable): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];
  const rows = table.rows.filter((r) => !isHeaderLike(r));
  const totalRows = rows.filter((r) => rowMarker(r) === 'total');
  if (totalRows.length !== 1) return issues; // 합계 행이 정확히 1개인 표만 — 다층 합계는 오탐 위험
  const totalRow = totalRows[0]!;
  const dataRows = rows.filter((r) => rowMarker(r) === null);
  if (dataRows.length < 2) return issues;

  // 비율성 열 제외
  const headerAll = [...table.headerRows, ...table.rows.filter(isHeaderLike)];
  const ratioCols = new Set<number>();
  for (const h of headerAll) {
    h.forEach((cell, i) => {
      const c = normalizeCell(cell);
      if (/비율|율\)|율$|%|지분/.test(c)) ratioCols.add(i);
    });
  }

  const width = Math.max(totalRow.length, ...dataRows.map((r) => r.length));
  for (let i = 0; i < width; i++) {
    if (ratioCols.has(i)) continue;
    const declared = parseDisclosureNumber(totalRow[i] ?? '');
    if (declared === null) continue;
    const values = dataRows.map((r) => parseDisclosureNumber(r[i] ?? ''));
    const numericCount = values.filter((v) => v !== null).length;
    if (numericCount < 2) continue;
    const sum = values.reduce<number>((a, v) => a + (v ?? 0), 0);

    // ⚠️ 병합 셀 전개(rowspan 이월)가 같은 값을 여러 행에 복제한 표에서는 단순 재합산이
    // 이중 계산이 된다 (실측: 미래에셋 거래현황 표들에서 합계의 정확히 2배 오탐 다수).
    // 연속 중복값을 1회만 세는 합산도 함께 구해 어느 쪽이든 맞으면 정상으로 본다.
    let dedupSum = 0;
    let prev: number | null = null;
    for (const v of values) {
      if (v !== null && v !== prev) dedupSum += v;
      prev = v;
    }

    const tol = sumTolerance(dataRows.length);
    if (Math.abs(sum - declared) > tol && Math.abs(dedupSum - declared) > tol) {
      pushDiff(
        issues, 'warning', section, '합계', 'total_sum',
        `${i + 1}번째 열 합계 ${fmt(declared)} vs 데이터 행 재합산 ${fmt(sum)}` +
          (dedupSum !== sum ? ` (연속 중복 제거 시 ${fmt(dedupSum)})` : ''),
        sum, declared,
      );
    }
  }
  return issues;
}

/** 문서 전체 점검 결과 */
export interface DocCheckResult {
  issues: ConsistencyIssue[];
  financeRows: FinanceRow[] | null;
  incomeSection: string | null;
  stats: { sectionsScanned: number; tablesScanned: number; financeRowsChecked: number };
}

export function checkJ004Document(
  markdown: string,
  opts: { includeGenericTotals?: boolean } = {},
): DocCheckResult {
  const sections = splitSections(markdown);
  const issues: ConsistencyIssue[] = [];
  let financeRows: FinanceRow[] | null = null;
  let incomeSection: string | null = null;
  let tablesScanned = 0;
  let financeRowsChecked = 0;

  for (const sec of sections) {
    const isFinance = sec.title.includes('재무현황');
    const isIncome = sec.title.includes('손익현황');
    if (isIncome) incomeSection = sec.title;

    for (const table of sec.tables) {
      if (table.rows.length === 0) continue;
      tablesScanned++;
      if (isFinance) {
        const parsed = parseFinanceTable(table);
        if (parsed) {
          financeRows = parsed;
          financeRowsChecked = parsed.filter((r) => !r.isSubtotal && !r.isTotal).length;
          issues.push(...checkFinanceRows(sec.title, parsed));
          continue;
        }
      }
      if (isIncome) {
        const parsed = parseIncomeTable(table);
        if (parsed) {
          issues.push(...checkIncomeRows(sec.title, parsed));
          continue;
        }
      }
      if (opts.includeGenericTotals) {
        issues.push(...checkGenericTotals(sec.title, table));
      }
    }
  }
  return {
    issues,
    financeRows,
    incomeSection,
    stats: { sectionsScanned: sections.length, tablesScanned, financeRowsChecked },
  };
}

/** 대표회사 취합분과 개별회사 공시의 재무현황 행 대사 */
export function crossCheckFinanceRow(
  repRows: FinanceRow[],
  indivRows: FinanceRow[],
  indivCompanyName: string,
): { matched: boolean; matchedName?: string; diffs: ConsistencyIssue[] } {
  const indivData = indivRows.filter((r) => !r.isSubtotal && !r.isTotal);
  const target = indivData[0];
  if (!target) return { matched: false, diffs: [] };

  const rawName = (indivCompanyName || target.company).trim();
  const repData = repRows.filter((r) => !r.isSubtotal && !r.isTotal);

  // 원문 표기 그대로의 일치를 우선한다. 정규화 매칭은 법인격 표기 차이용 폴백인데,
  // 'ABC(주)'와 'ABC유한회사'가 같은 키로 합쳐질 수 있어 후보가 복수면 매칭하지 않는다 (Codex 3차).
  let repMatch = repData.find((r) => r.company.trim() === rawName);
  if (!repMatch) {
    const targetName = normalizeCompanyName(rawName);
    const candidates = repData.filter((r) => normalizeCompanyName(r.company) === targetName);
    if (candidates.length !== 1) return { matched: false, diffs: [] };
    repMatch = candidates[0]!;
  }

  const diffs: ConsistencyIssue[] = [];
  const keys: Array<[keyof FinanceRow, string]> = [
    ['currentAssets', '유동자산'], ['nonCurrentAssets', '비유동자산'], ['totalAssets', '자산총계'],
    ['currentLiabilities', '유동부채'], ['nonCurrentLiabilities', '비유동부채'], ['totalLiabilities', '부채총계'],
    ['paidInCapital', '자본금'], ['totalEquity', '자본총계'],
  ];
  for (const [key, label] of keys) {
    const a = repMatch[key];
    const b = target[key];
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    if (Math.abs(a - b) > 0) {
      pushDiff(
        diffs, 'error', '대표회사↔개별회사 대사', repMatch.company, 'cross_doc_mismatch',
        `${label}: 대표회사 취합 ${fmt(a)} vs 개별회사 공시 ${fmt(b)} (차이 ${fmt(a - b)})`,
        b, a,
      );
    }
  }
  return { matched: true, matchedName: repMatch.company, diffs };
}

function fmt(n: number): string {
  return n.toLocaleString('ko-KR');
}
