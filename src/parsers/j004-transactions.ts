/**
 * J004(기업집단현황공시) 원문에서 **계열회사 간 실제 거래내역**과 **자본 수치**를 뽑는다.
 *
 * 왜 필요한가: `audit_group_disclosures`(J001) 는 DART 에 접수된 공시만 보므로
 * **미공시(아예 공시하지 않은 거래)를 원리상 탐지하지 못한다.** 그런데 J004 에는
 * 계열회사 간 실제 거래가 거래상대방·금액 단위로 실려 있다. 이 둘을 대조하면
 * "실제로 거래는 했는데 J001 공시가 없는 건"을 후보로 뽑을 수 있다 —
 * 이 프로젝트에서 미공시 신호를 얻는 유일한 경로다.
 *
 * ★ 실물 확인 사항 (2026-08-27, 미래에셋 대표회사 서식 20260601001646)
 *  - 거래현황 절 번호는 **서식마다 다르다** (대표회사 §7 / 개별회사 §6) → 제목으로 앵커한다.
 *  - 자금거래 '가. 일반 차입' 표에는 **차입일이 있다** → 그 날짜로 J001 공시 유무를 정밀 대조할 수 있다.
 *  - 주요 상품·용역거래 내역에는 날짜가 없고 **연간 합계**다 → 신뢰도가 낮은 신호로만 쓴다.
 *  - 재무현황 표에 **자본금·자본총계**가 계열사별로 있다 → 기준금액을 같은 문서에서 계산할 수 있다.
 *  - 단위는 캡션(`단위 : 백만원`)에 있다. **가정하지 않는다** — 1,000배 오차가 판정을 뒤집는다.
 */

import { parseDisclosureNumber, normalizeCell } from './md-table.js';

/** 단위 표기 → 원 환산 배수 */
const UNIT_FACTORS: Array<[RegExp, number]> = [
  [/단위\s*[:：]?\s*백만\s*원/, 1_000_000],
  [/단위\s*[:：]?\s*천\s*원/, 1_000],
  [/단위\s*[:：]?\s*억\s*원/, 100_000_000],
  // '단위 : 원' 은 '백만원'·'천원' 을 먼저 걸러낸 뒤에만 매칭돼야 한다
  [/단위\s*[:：]?\s*원/, 1],
];

/** 표 한 덩어리 — 앞선 '가./나./다.' 표지와 단위를 함께 들고 있다 */
interface LabeledTable {
  /** 직전에 나온 '가. 일반 차입' 같은 표지 (없으면 '') */
  label: string;
  /** 캡션에서 읽은 단위 배수. 못 읽었으면 null — 금액을 쓰면 안 된다 */
  unitFactor: number | null;
  /** 원문 캡션 그대로 (진단용) */
  unitCaption: string | null;
  header: string[][];
  rows: string[][];
}

function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function isSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c) || c === '');
}

function unitOf(text: string): { factor: number; caption: string } | null {
  for (const [re, factor] of UNIT_FACTORS) {
    if (re.test(text)) return { factor, caption: text.trim() };
  }
  return null;
}

/**
 * 지정한 '## ' 제목을 **포함하는** 절의 원문을 잘라낸다.
 * 절 번호는 서식마다 다르므로 번호가 아니라 제목 키워드로 찾는다.
 */
export function sliceSection(markdown: string, titleKeyword: string): string | null {
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,4})\s+(.*)$/.exec(lines[i] ?? '');
    if (!m) continue;
    const title = normalizeCell(m[2] ?? '');
    if (start === -1) {
      if (title.includes(normalizeCell(titleKeyword))) {
        start = i;
        startLevel = (m[1] ?? '').length;
      }
      continue;
    }
    // 같은 레벨의 다음 제목에서 끊는다
    if ((m[1] ?? '').length <= startLevel) return lines.slice(start, i).join('\n');
  }
  return start === -1 ? null : lines.slice(start).join('\n');
}

/**
 * 절 안의 표들을 **순서대로** 읽는다.
 *
 * `splitSections` 를 쓰지 않는 이유: 그쪽은 표와 표 밖 텍스트를 각각 모아 돌려주어
 * "이 표가 '가. 일반 차입' 밑에 있다"는 순서 정보가 사라진다. 여기서는 그게 핵심이다.
 */
export function readLabeledTables(sectionMarkdown: string): LabeledTable[] {
  const lines = sectionMarkdown.split(/\r?\n/);
  const out: LabeledTable[] = [];
  let label = '';
  let unit: { factor: number; caption: string } | null = null;
  let buf: string[][] = [];
  let header: string[][] = [];
  let sawSeparator = false;

  const flush = () => {
    if (buf.length === 0 && header.length === 0) return;
    // 다층 헤더의 둘째 줄부터는 마크다운 구분선 **뒤에** 온다 — 그대로 두면 데이터 행으로
    // 섞여 열 이름을 못 찾는다. 숫자가 하나도 없는 선두 행은 헤더 잔여로 보고 끌어올린다.
    // (데이터 행에는 반드시 금액·비율 같은 숫자가 있다 — 실측 표 전부에서 성립.)
    for (let guard = 0; guard < 3 && buf.length > 1; guard++) {
      const first = buf[0]!;
      const hasNumber = first.some((c) => parseDisclosureNumber(c) !== null);
      if (hasNumber) break;
      header.push(first);
      buf.shift();
    }
    // 캡션만 있는 1열 표(단위·설명)는 데이터 표가 아니다
    const isCaption = header.length + buf.length <= 2 && (header[0]?.length ?? 0) <= 1;
    if (!isCaption) {
      out.push({
        label,
        unitFactor: unit?.factor ?? null,
        unitCaption: unit?.caption ?? null,
        header,
        rows: buf,
      });
    }
    buf = [];
    header = [];
    sawSeparator = false;
    // ★ 단위는 표마다 캡션에서 새로 읽는다 — 리셋하지 않으면 캡션 없는(또는 인식 못 한 표기의)
    // 표가 직전 표의 단위를 계승해, "단위를 모르면 건너뛴다" 불변식이 조용히 뚫린다
    // (100~1,000배 오차가 below_threshold 거짓 안심으로 직결. 교차검토 M-1).
    unit = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('|')) {
      const cells = splitRow(line);
      if (isSeparator(cells)) {
        sawSeparator = true;
        continue;
      }
      // 1열짜리 줄은 캡션이다 — 단위를 여기서 읽고 표에는 넣지 않는다
      if (cells.length === 1) {
        const u = unitOf(cells[0] ?? '');
        if (u) unit = u;
        continue;
      }
      if (sawSeparator) buf.push(cells);
      else header.push(cells);
      continue;
    }
    // 표가 끝났다
    if (buf.length || header.length) flush();
    if (line === '') continue;
    // '가. 일반 차입' 같은 표지
    const m = /^([가-하])\.\s*(.+)$/.exec(line);
    if (m) {
      label = `${m[1]}. ${m[2]}`;
      continue;
    }
    const u = unitOf(line);
    if (u) unit = u;
  }
  flush();
  return out;
}

/** 헤더 여러 줄을 열 단위로 합쳐 키워드 검색이 되게 한다 */
function headerText(t: LabeledTable, col: number): string {
  return t.header.map((r) => normalizeCell(r[col] ?? '')).join('');
}

/** 헤더에 주어진 키워드를 **전부** 가진 열의 인덱스 (없으면 -1) */
function findCol(t: LabeledTable, ...keywords: string[]): number {
  const width = Math.max(...t.header.map((r) => r.length), 0);
  for (let c = 0; c < width; c++) {
    const h = headerText(t, c);
    if (keywords.every((k) => h.includes(normalizeCell(k)))) return c;
  }
  return -1;
}

/** 소계·합계 행인가 — 집계 행을 개별 거래로 세면 금액이 두 배가 된다 */
function isAggregateRow(cells: string[]): boolean {
  return cells.some((c) => /^(소\s*계|합\s*계|계|총\s*계|.*합계|.*소계)$/.test(normalizeCell(c)));
}

/** 계열사별 자본 수치 (원 단위) */
export interface CapitalRow {
  company: string;
  paidInCapital: number | null;
  totalEquity: number | null;
}

/**
 * 재무현황 표에서 계열사별 자본금·자본총계를 뽑는다 (기준금액 계산용).
 * 고시 §2③ 기준금액 = min(100억, max(5억, max(자본총계, 자본금) × 5%))
 */
export function extractCapitals(markdown: string): CapitalRow[] {
  const sec = sliceSection(markdown, '회사 재무현황');
  if (!sec) return [];
  const out: CapitalRow[] = [];
  for (const t of readLabeledTables(sec)) {
    const cCompany = findCol(t, '계열회사명');
    const cCapital = findCol(t, '자본금');
    const cEquity = findCol(t, '자본총계');
    // 부채비율 열도 '자본총계' 를 품고 있어 자본 열보다 오른쪽이다 — 가장 왼쪽을 쓴다
    if (cCompany === -1 || cEquity === -1) continue;
    if (t.unitFactor === null) continue;
    for (const row of t.rows) {
      if (isAggregateRow(row)) continue;
      // 첫 열은 금융/비금융 구분, 회사명은 그 다음 열이다 (rowspan 전개됨)
      const name = (row[cCompany + 1] ?? row[cCompany] ?? '').trim();
      if (!name || name === '-') continue;
      const equity = parseDisclosureNumber(row[cEquity] ?? '');
      const capital = cCapital === -1 ? null : parseDisclosureNumber(row[cCapital] ?? '');
      out.push({
        company: name,
        paidInCapital: capital === null ? null : capital * t.unitFactor,
        totalEquity: equity === null ? null : equity * t.unitFactor,
      });
    }
  }
  return out;
}

/** 계열회사 간 자금 차입 1건 */
export interface FundBorrowing {
  /** 차입한 회사 (소속회사) */
  company: string;
  /** 자금을 대준 계열회사 */
  counterparty: string;
  /** 차입금액 (원) */
  amount: number;
  /** 차입일 (YYYYMMDD). 원문 표기가 다양해 못 읽으면 null */
  date: string | null;
  /** 원문 표기 그대로 (진단용) */
  rawDate: string;
  /** '가. 일반 차입' 등 표지 */
  label: string;
}

/** '2025-02-19' / '2025.02.19' / '2025년 2월 19일' → '20250219' */
export function parseLooseDate(raw: string): string | null {
  const s = raw.replace(/\s+/g, '');
  const m = /^(\d{4})[.\-/년]?(\d{1,2})[.\-/월]?(\d{1,2})일?$/.exec(s);
  if (!m) return null;
  const [, y, mo, d] = m;
  const ymd = `${y}${String(Number(mo)).padStart(2, '0')}${String(Number(d)).padStart(2, '0')}`;
  // round-trip 으로 실존 날짜인지 확인 (2026.2.31 같은 원문 오기 차단)
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const back = `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(
    dt.getUTCDate(),
  ).padStart(2, '0')}`;
  return back === ymd ? ymd : null;
}

/**
 * 자금거래 현황에서 개별 차입 건을 뽑는다.
 *
 * 실측 헤더: `차입회사 (소속회사) | | 거래상대방 | 차입금액 | 차입일 | 만기일 | 약정이자율(%) | …`
 * 리스부채 표는 '리스부채금액' 이라 '차입금액' 열이 없어 자연히 걸러진다.
 */
export function extractFundBorrowings(markdown: string): FundBorrowing[] {
  const sec = sliceSection(markdown, '계열회사간 자금거래 현황');
  if (!sec) return [];
  const out: FundBorrowing[] = [];
  for (const t of readLabeledTables(sec)) {
    const cCompany = findCol(t, '차입회사');
    const cParty = findCol(t, '거래상대방');
    const cAmount = findCol(t, '차입금액');
    const cDate = findCol(t, '차입일');
    if (cCompany === -1 || cParty === -1 || cAmount === -1) continue;
    if (t.unitFactor === null) continue;
    for (const row of t.rows) {
      const party = (row[cParty] ?? '').trim();
      if (!party || party === '-') continue;
      if (isAggregateRow(row)) continue;
      const amount = parseDisclosureNumber(row[cAmount] ?? '');
      if (amount === null || amount <= 0) continue;
      const name = (row[cCompany + 1] ?? row[cCompany] ?? '').trim();
      if (!name || name === '-') continue;
      const rawDate = cDate === -1 ? '' : (row[cDate] ?? '').trim();
      out.push({
        company: name,
        counterparty: party,
        amount: amount * t.unitFactor,
        date: rawDate ? parseLooseDate(rawDate) : null,
        rawDate,
        label: t.label,
      });
    }
  }
  return out;
}

/** 주요 상품·용역거래 1건 (연간 합계) */
export interface GoodsServiceRow {
  company: string;
  counterparty: string;
  item: string;
  /** 연간 매출액 (원) */
  annualAmount: number;
  label: string;
}

/**
 * 주요 상품·용역거래 내역.
 * ⚠️ **거래일이 없고 연간 합계다.** 대규모내부거래 기준은 §4③2호에 따라 **분기 합계액**이므로,
 * 이 값으로는 분기별 초과 여부를 직접 판정할 수 없다 — 낮은 신뢰도 신호로만 쓴다.
 */
export function extractMajorGoodsServices(markdown: string): GoodsServiceRow[] {
  const sec = sliceSection(markdown, '주요 상품ㆍ용역거래 내역');
  if (!sec) return [];
  const out: GoodsServiceRow[] = [];
  for (const t of readLabeledTables(sec)) {
    const cCompany = findCol(t, '소속회사명');
    const cParty = findCol(t, '거래상대방');
    const cAmount = findCol(t, '매출액');
    if (cCompany === -1 || cParty === -1 || cAmount === -1) continue;
    if (t.unitFactor === null) continue;
    const cItem = findCol(t, '품목');
    for (const row of t.rows) {
      const party = (row[cParty] ?? '').trim();
      if (!party || party === '-') continue;
      if (isAggregateRow(row)) continue;
      const amount = parseDisclosureNumber(row[cAmount] ?? '');
      if (amount === null || amount <= 0) continue;
      const name = (row[cCompany + 1] ?? row[cCompany] ?? '').trim();
      if (!name || name === '-') continue;
      out.push({
        company: name,
        counterparty: party,
        item: cItem === -1 ? '' : (row[cItem] ?? '').trim(),
        annualAmount: amount * t.unitFactor,
        label: t.label,
      });
    }
  }
  return out;
}

/** 파서가 본 표들의 요약 — 무엇을 못 읽었는지 밝히기 위한 진단 */
export interface ParseDiagnostics {
  capital_rows: number;
  fund_borrowings: number;
  goods_services: number;
  /** 단위 캡션을 못 읽어 통째로 건너뛴 표 수 — 금액을 추측하지 않는다 */
  tables_without_unit: number;
  sections_found: string[];
  sections_missing: string[];
}

export function diagnose(markdown: string): ParseDiagnostics {
  const wanted: Array<[string, string]> = [
    ['재무현황', '회사 재무현황'],
    ['자금거래', '계열회사간 자금거래 현황'],
    ['주요 상품·용역', '주요 상품ㆍ용역거래 내역'],
  ];
  const found: string[] = [];
  const missing: string[] = [];
  let noUnit = 0;
  for (const [label, keyword] of wanted) {
    const sec = sliceSection(markdown, keyword);
    if (!sec) {
      missing.push(label);
      continue;
    }
    found.push(label);
    for (const t of readLabeledTables(sec)) {
      if (t.unitFactor === null && t.rows.length > 0) noUnit++;
    }
  }
  return {
    capital_rows: extractCapitals(markdown).length,
    fund_borrowings: extractFundBorrowings(markdown).length,
    goods_services: extractMajorGoodsServices(markdown).length,
    tables_without_unit: noUnit,
    sections_found: found,
    sections_missing: missing,
  };
}
