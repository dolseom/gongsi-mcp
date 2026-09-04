/**
 * J004 원문의 **매트릭스 표**(교차표)를 `(행회사, 열회사, 금액)` 트리플로 평탄화한다.
 *
 * 왜 필요한가: J004 §거래현황의 유가증권·상품용역 **총괄** 표는 개별 거래 목록이 아니라
 * 매입회사 × 매도회사 교차표다. 지금까지 이 표를 파싱하지 못해
 * `detect_undisclosed_transactions` 가 **유가증권 거래 신호를 통째로 못 봤다**
 * (Codex 4차 M1 — coverage 에 "유가증권 형태 자금조달 미검토"로 고지만 하던 구멍).
 * 거짓 안심 방향의 누락이라 caveat 로 남겨둘 성질이 아니다.
 *
 * ★ 실물 확인 사항 (2026-09-01, 미래에셋 대표회사 20260819000341)
 *  - **한 논리 표가 여러 개의 표로 쪼개져 있다** (열이 많아 페이지 분할). 축 라벨이 같은
 *    연속 표는 같은 매트릭스의 이어지는 페이지다.
 *  - **단위 캡션은 첫 페이지에만 있다.** j004-transactions 의 `readLabeledTables` 는
 *    표마다 단위를 리셋하므로(M-1: 캡션 없는 표가 직전 단위를 계승하면 100~1,000배 오차)
 *    둘째 페이지부터는 단위가 null 이 된다. 여기서는 **축 라벨이 같을 때만** 계승하고
 *    계승 사실을 진단에 남긴다 — M-1 불변식의 예외를 좁고 명시적으로 둔다.
 *  - 헤더 줄 수가 서식마다 다르다 (유가증권 3줄 / 상품·용역 2줄). 줄 번호로 찍으면 깨진다.
 *    → 회사명이 실린 헤더 줄을 **고유 비집계 셀이 가장 많은 줄**로 고른다.
 *  - 값 열과 회사명 열의 구분도 열 번호로 찍지 않는다 — 데이터 행이 전부 숫자('-' 포함)인
 *    열만 값 열로 본다. 병합 헤더 전개 변형에 흔들리지 않는다.
 *  - 소계·합계는 행·열 양쪽에 있다. 열은 헤더 전체 텍스트로 걸러야 한다
 *    (마지막 헤더 줄이 '(매도금액)' 이고 집계라는 사실은 윗줄 '합계'에만 있다).
 *
 * ⚠️ 이 표의 값은 **직전 사업연도 1년 합계**다. 개별 거래 건으로 분해되지 않는다 —
 * 판정 쪽에서 그 한계를 반드시 명시해야 한다.
 */

import { parseDisclosureNumber, normalizeCell, normalizeCompanyName } from './md-table.js';
import {
  sliceSection,
  readLabeledTables,
  isAggregateRow,
  type LabeledTable,
} from './j004-transactions.js';

/** 교차표 한 칸 — 행 회사와 열 회사 사이의 연간 거래액 */
export interface MatrixCell {
  /** 행 축 회사 (축 라벨 `rowAxis` 가 무슨 역할인지 말해준다) */
  rowCompany: string;
  /** 열 축 회사 */
  colCompany: string;
  /** 금액 (원). 단위 캡션으로 환산한 값 — 캡션을 못 읽은 표는 통째로 건너뛴다 */
  amount: number;
  /**
   * 이 열이 속한 **그룹 헤더** 텍스트 — 회사명 줄 위의 헤더 줄들을 병합 전개해 이어붙인 것.
   *
   * 왜 필요한가: 원문이 스스로 열 묶음의 성격을 밝히는 자리다. 실물 (5) 총괄표는
   * `| … | 국내계열사계 | 해외계열사 |  |  |  |` 처럼 **국내/해외 계열사를 그룹 헤더로 구분**한다.
   * 법 §26①·고시 §2③2호가 국외 계열회사를 특수관계인에서 제외하므로, 판정 쪽이 이 정보를
   * 써야 한다 — 회사명 모양(영문 상호 등)으로 추측하면 안 된다.
   *
   * ⚠️ 병합 셀은 첫 칸에만 라벨이 있고 나머지가 비어 있어 **왼쪽 값을 이어받아** 채운다.
   * 라벨이 없는 열에 앞 그룹이 잘못 번질 수 있으므로, 이 값으로 무언가를 **버리면 안 되고**
   * 분류 근거를 사용자에게 함께 보여야 한다.
   */
  colGroup: string;
}

export interface MatrixResult {
  /** 행 축이 무엇인지 (예: '매입회사' / '매출') — 원문 축 라벨 그대로 */
  rowAxis: string;
  /** 열 축이 무엇인지 (예: '매도회사' / '매입회사') */
  colAxis: string;
  cells: MatrixCell[];
  /** 매트릭스로 읽어낸 표(페이지) 수 */
  tables: number;
  /** 축 라벨은 매트릭스인데 회사명 헤더 줄을 못 고른 표 수 */
  tablesUnrecognized: number;
  /** 단위 캡션이 없고 계승도 못 해 건너뛴 표 수 — 금액을 추측하지 않는다 */
  tablesWithoutUnit: number;
  /** 직전 페이지에서 단위를 이어받은 표 수 (같은 축 라벨의 연속일 때만) */
  unitInheritedTables: number;
  /** 같은 (행,열) 쌍이 두 번 나온 수 — 첫 값을 쓴다. 0 이 아니면 표 구조를 의심할 것 */
  duplicatePairs: number;
  /**
   * 회사명 목록(`knownCompanies`)에 없어서 버린 열 이름들.
   * 국외 계열사와 미처 못 거른 집계 열이 여기 모인다 — 조용히 버리지 않는다.
   */
  droppedColumns: string[];
}

export interface MatrixOptions {
  /**
   * 회사명 화이트리스트. 주면 목록 밖의 열 이름은 거래상대방으로 쓰지 않고
   * `droppedColumns` 에 남긴다. 총계 열이 회사로 둔갑하는 사고를 막는 2차 방어선이다.
   * (이름은 `normalizeCompanyName` 으로 정규화해 비교한다.)
   */
  knownCompanies?: Iterable<string>;
}

function emptyResult(): MatrixResult {
  return {
    rowAxis: '',
    colAxis: '',
    cells: [],
    tables: 0,
    tablesUnrecognized: 0,
    tablesWithoutUnit: 0,
    unitInheritedTables: 0,
    duplicatePairs: 0,
    droppedColumns: [],
  };
}

/** '매입회사 ＼ 매도회사' · '매출 / 매입회사' → 행 축 / 열 축 */
function splitAxis(label: string): { row: string; col: string } | null {
  const m = /^(.*?)\s*[＼\\／/]\s*(.*)$/.exec(label.replace(/\s+/g, ' ').trim());
  if (!m) return null;
  const row = (m[1] ?? '').trim();
  const col = (m[2] ?? '').trim();
  if (!row || !col) return null;
  return { row, col };
}

/**
 * 집계 라벨인가. 빈 셀도 회사명이 아니므로 여기서 함께 거른다.
 *
 * ★ 실물의 집계 열 이름은 한 가지가 아니다 (미래에셋 상품·용역 총괄표에서 실측):
 * '소계' · '계' · '국내계열사계' · '국내 매출액' · '해외 매출액' · '(매도금액)'.
 * 이름 하나만 막으면 총계 열이 거래상대방 회사로 둔갑해 **없는 거래를 만들어낸다**.
 * 회사명은 '…(주)' · '…회사' · 'Ltd.' 처럼 끝나므로 아래 규칙에 걸리지 않는다.
 */
function isAggregateLabel(cell: string): boolean {
  const n = normalizeCell(cell);
  if (n === '' || n === '-' || n === '–') return true;
  if (/(합계|소계)/.test(n)) return true;
  if (/^(계|총계)$/.test(n)) return true;
  // '국내계열사계' 처럼 '계' 로 끝나는 집계 열
  if (/계$/.test(n)) return true;
  // 회사가 아니라 금액 범주를 가리키는 열
  if (/(매출액|매입액|거래액|금액|잔액)/.test(n)) return true;
  return false;
}

/** 헤더 여러 줄을 한 열로 이어붙인 텍스트 — 집계 열 판별용 */
function headerColText(t: LabeledTable, col: number): string {
  return t.header.map((r) => normalizeCell(r[col] ?? '')).join('');
}

/**
 * 회사명이 실린 헤더 줄을 고른다.
 * 줄 번호로 찍지 않는 이유: 유가증권 표는 헤더 3줄, 상품·용역 표는 2줄이고,
 * `readLabeledTables` 의 헤더 승격이 데이터 아닌 선두 행을 헤더로 더 올리기도 한다.
 * 회사명 줄은 **서로 다른 비집계 라벨이 가장 많은 줄**이라는 성질로 잡는다.
 */
function pickNameRow(header: string[][]): number {
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < header.length; i++) {
    const seen = new Set<string>();
    for (const cell of header[i] ?? []) {
      if (isAggregateLabel(cell)) continue;
      seen.add(normalizeCell(cell));
    }
    if (seen.size > bestScore) {
      bestScore = seen.size;
      best = i;
    }
  }
  // 축 라벨 1 + 회사 2 이상이어야 교차표로 인정한다
  return bestScore >= 3 ? best : -1;
}

/**
 * 값 열의 인덱스들. 데이터 행에서 **비어 있지 않은 셀이 전부 숫자이거나 '-'** 인 열만 값으로 본다.
 * 회사명 열은 문자열이 섞여 자연히 탈락한다 — 열 번호를 가정하지 않으므로
 * 병합 헤더 전개가 한 칸 밀려도 대주(對株)를 금액으로 읽는 사고가 나지 않는다.
 */
function valueCols(t: LabeledTable): number[] {
  const dataRows = t.rows.filter((r) => !isAggregateRow(r));
  const width = Math.max(
    0,
    ...t.header.map((r) => r.length),
    ...t.rows.map((r) => r.length),
  );
  const out: number[] = [];
  for (let c = 0; c < width; c++) {
    let total = 0;
    let numeric = 0;
    for (const r of dataRows) {
      const cell = (r[c] ?? '').trim();
      if (cell === '') continue;
      total++;
      if (cell === '-' || cell === '–' || parseDisclosureNumber(cell) !== null) numeric++;
    }
    if (total > 0 && numeric === total) out.push(c);
  }
  return out;
}

/**
 * 교차표 절을 (행회사, 열회사, 금액) 트리플로 평탄화한다.
 *
 * @param sectionKeyword `sliceSection` 에 넘길 절 제목 키워드 (번호가 아니라 제목으로 앵커한다)
 */
export function extractMatrix(
  markdown: string,
  sectionKeyword: string,
  options: MatrixOptions = {},
): MatrixResult {
  const res = emptyResult();
  const sec = sliceSection(markdown, sectionKeyword);
  if (!sec) return res;

  const known = options.knownCompanies
    ? new Set([...options.knownCompanies].map((n) => normalizeCompanyName(n)))
    : null;
  const dropped = new Set<string>();
  const seenPairs = new Set<string>();
  let prevAxisKey = '';
  let prevUnit: number | null = null;

  for (const t of readLabeledTables(sec)) {
    const axisRaw = (t.header[0]?.[0] ?? '').trim();
    const axis = splitAxis(axisRaw);
    // 축 라벨이 'A ＼ B' 꼴이 아니면 교차표가 아니다 (같은 절의 일반 표는 조용히 지나간다)
    if (!axis) continue;
    const axisKey = normalizeCell(axisRaw);

    const nameRow = pickNameRow(t.header);
    if (nameRow === -1) {
      res.tablesUnrecognized++;
      continue;
    }

    // 단위 계승 — 같은 축 라벨의 연속 페이지에 한한다 (파일 상단 주석 참조)
    let unit = t.unitFactor;
    if (unit === null && axisKey !== '' && axisKey === prevAxisKey && prevUnit !== null) {
      unit = prevUnit;
      res.unitInheritedTables++;
    }
    if (unit === null) {
      res.tablesWithoutUnit++;
      continue;
    }

    const cols = valueCols(t);
    if (cols.length === 0) {
      res.tablesUnrecognized++;
      continue;
    }
    const firstValueCol = Math.min(...cols);

    // 열 그룹 헤더 — 회사명 줄 **위의** 줄들만 쓴다 (회사명 줄 자체는 열 이름이다).
    // 병합 셀은 첫 칸에만 라벨이 있으므로 왼쪽 값을 이어받아 전개한다 (MatrixCell.colGroup 주석).
    const tableWidth = Math.max(
      0,
      ...t.header.map((r) => r.length),
      ...t.rows.map((r) => r.length),
    );
    const groupText: string[] = new Array<string>(tableWidth).fill('');
    for (let i = 0; i < nameRow; i++) {
      let carry = '';
      for (let c = 0; c < tableWidth; c++) {
        const cell = normalizeCell(t.header[i]?.[c] ?? '');
        if (cell !== '') carry = cell;
        groupText[c] = `${groupText[c] ?? ''}${carry}|`;
      }
    }

    // 열 회사명 — 값 열이면서 헤더 어디에도 집계 표기가 없는 열만 쓴다
    const colNames = new Map<number, string>();
    for (const c of cols) {
      const raw = (t.header[nameRow]?.[c] ?? '').trim();
      if (isAggregateLabel(raw)) continue;
      if (/(합계|소계)/.test(headerColText(t, c))) continue;
      if (known && !known.has(normalizeCompanyName(raw))) {
        dropped.add(raw);
        continue;
      }
      colNames.set(c, raw);
    }
    if (colNames.size === 0) {
      res.tablesUnrecognized++;
      continue;
    }

    res.tables++;
    if (!res.rowAxis) {
      res.rowAxis = axis.row;
      res.colAxis = axis.col;
    }
    prevAxisKey = axisKey;
    prevUnit = unit;

    for (const row of t.rows) {
      if (isAggregateRow(row)) continue;
      // 행 회사명 = 값 열이 시작되기 전 칸들 중 마지막 비어 있지 않은 값
      // (첫 칸은 금융/비금융 구분이 rowspan 전개돼 있다)
      let rowCompany = '';
      for (let c = 0; c < firstValueCol; c++) {
        const cell = (row[c] ?? '').trim();
        if (cell !== '') rowCompany = cell;
      }
      if (!rowCompany || rowCompany === '-' || isAggregateLabel(rowCompany)) continue;

      if (known && !known.has(normalizeCompanyName(rowCompany))) {
        continue;
      }
      for (const [c, colCompany] of colNames) {
        const amount = parseDisclosureNumber(row[c] ?? '');
        if (amount === null || amount <= 0) continue;
        const key = `${normalizeCell(rowCompany)} ${normalizeCell(colCompany)}`;
        if (seenPairs.has(key)) {
          res.duplicatePairs++;
          continue;
        }
        seenPairs.add(key);
        res.cells.push({
          rowCompany,
          colCompany,
          amount: amount * unit,
          colGroup: groupText[c] ?? '',
        });
      }
    }
  }
  res.droppedColumns = [...dropped];
  return res;
}

/**
 * 계열회사 간 유가증권 거래 총괄 (행 = 매입회사, 열 = 매도회사).
 * 법 §26①2호 '유가증권 거래' 에 대응한다.
 */
export function extractSecuritiesMatrix(
  markdown: string,
  options: MatrixOptions = {},
): MatrixResult {
  return extractMatrix(markdown, '계열회사간 유가증권거래 현황', options);
}

/**
 * 계열회사 간 상품·용역 거래 총괄 (행 = 매출회사, 열 = 매입회사).
 *
 * `extractMajorGoodsServices`(주요 상품·용역거래 **내역**) 와 다른 표다.
 * '내역' 은 일정 규모 이상만 실리는 반면 이 총괄표는 **모든 쌍**을 담는다 —
 * 내역에 없는 쌍이 여기에는 있다.
 */
export function extractGoodsServicesMatrix(
  markdown: string,
  options: MatrixOptions = {},
): MatrixResult {
  return extractMatrix(markdown, '계열회사간 상품ㆍ용역거래 현황', options);
}
