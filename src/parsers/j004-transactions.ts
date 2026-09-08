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

import { parseDisclosureNumber, normalizeCell, normalizeCompanyName } from './md-table.js';

/** 단위 표기 → 원 환산 배수 */
const UNIT_FACTORS: Array<[RegExp, number]> = [
  [/단위\s*[:：]?\s*백만\s*원/, 1_000_000],
  [/단위\s*[:：]?\s*천\s*원/, 1_000],
  [/단위\s*[:：]?\s*억\s*원/, 100_000_000],
  // '단위 : 원' 은 '백만원'·'천원' 을 먼저 걸러낸 뒤에만 매칭돼야 한다
  [/단위\s*[:：]?\s*원/, 1],
];

/** 표 한 덩어리 — 앞선 '가./나./다.' 표지와 단위를 함께 들고 있다 */
export interface LabeledTable {
  /** 직전에 나온 '가. 일반 차입' 같은 표지 (없으면 '') */
  label: string;
  /** 캡션에서 읽은 단위 배수. 못 읽었으면 null — 금액을 쓰면 안 된다 */
  unitFactor: number | null;
  /** 원문 캡션 그대로 (진단용) */
  unitCaption: string | null;
  header: string[][];
  rows: string[][];
  /**
   * 구분선 뒤 선두 행을 헤더로 **승격시킨 횟수** (Codex S1).
   *
   * 다층 헤더의 둘째 줄부터는 마크다운 구분선 뒤에 오므로 끌어올려야 열 이름을 찾는다.
   * 다만 판별 기준이 "숫자·날짜가 하나도 없는 행"이라, **값이 전부 '-' 인 데이터 행**도
   * 승격된다 (실측: 유가증권 총괄표의 `| 비금융사 | - | - | … |` 행이 실제로 승격된다).
   * 금액이 없어 판정에는 영향이 없지만 조용히 일어나면 안 되므로 세어서 진단에 낸다.
   */
  headerPromotedRows: number;
  /** 헤더 최대 열 수 — 값 열 판별의 기준 폭 */
  width: number;
  /** 헤더 폭과 열 수가 다른 데이터 행 수 (병합 전개 밀림·서식 변형 신호) */
  raggedRows: number;
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

  // 데이터 행 판별용 — 값으로 쓰는 게 아니라 "이 행이 헤더 잔여가 아니다"를 판별할 뿐이다.
  // 날짜('2025-02-19')와 각주 붙은 금액('16,000 (주1)')은 parseDisclosureNumber 가 null 을
  // 돌려주지만 명백한 데이터다 — 이들만 있는 선두 행을 헤더로 승격시키면 그 거래가
  // 어떤 진단에도 안 잡히고 소멸한다 (M-3 의 또 다른 경로).
  const looksLikeData = (c: string): boolean => {
    if (parseDisclosureNumber(c) !== null) return true;
    if (parseLooseDate(c.trim()) !== null) return true;
    const stripped = c.replace(/\((주)?\s*\d*\)\s*$/, '').trim();
    return stripped !== c.trim() && parseDisclosureNumber(stripped) !== null;
  };

  const flush = () => {
    if (buf.length === 0 && header.length === 0) return;
    let promoted = 0;
    // 다층 헤더의 둘째 줄부터는 마크다운 구분선 **뒤에** 온다 — 그대로 두면 데이터 행으로
    // 섞여 열 이름을 못 찾는다. 숫자가 하나도 없는 선두 행은 헤더 잔여로 보고 끌어올린다.
    // (데이터 행에는 반드시 금액·비율·날짜 같은 숫자가 있다 — 실측 표 전부에서 성립.)
    for (let guard = 0; guard < 3 && buf.length > 1; guard++) {
      const first = buf[0]!;
      if (first.some(looksLikeData)) break;
      header.push(first);
      buf.shift();
      promoted++;
    }
    // 캡션만 있는 1열 표(단위·설명)는 데이터 표가 아니다
    const isCaption = header.length + buf.length <= 2 && (header[0]?.length ?? 0) <= 1;
    if (!isCaption) {
      const width = Math.max(0, ...header.map((r) => r.length));
      out.push({
        label,
        unitFactor: unit?.factor ?? null,
        unitCaption: unit?.caption ?? null,
        header,
        rows: buf,
        headerPromotedRows: promoted,
        width,
        raggedRows: width > 0 ? buf.filter((r) => r.length !== width).length : 0,
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

/**
 * 같은 뜻의 열 이름 여러 개 중 **먼저 걸리는** 열 (없으면 -1).
 *
 * ★ 왜 필요한가 (실물 40문서 실측, 2026-09-08): 같은 J004 서식인데도 회사명 열 이름이
 * 문서마다 다르다 — 재무현황 절의 첫 열 헤더는 **`소속회사명` 39표 vs `계열회사명` 1표**였다.
 * 한 이름만 찾으면 나머지 문서의 표가 통째로 버려지고, 재무현황이 사라지면 기준금액
 * (령 §33① = min(100억, max(5억, max(자본총계, 자본금) × 5%)))을 아예 계산하지 못해
 * 판정이 전부 `threshold_unknown` 으로 떨어진다. 실제로 그 상태였다.
 */
function findColAny(t: LabeledTable, names: string[], ...alsoRequired: string[]): number {
  for (const n of names) {
    const c = findCol(t, n, ...alsoRequired);
    if (c !== -1) return c;
  }
  return -1;
}

/**
 * 회사명 열의 이름 변형 — 실물에서 확인된 것만 넣는다 (추측으로 넓히지 않는다).
 * 넓게 잡을수록 엉뚱한 열을 회사명으로 읽을 위험이 커진다.
 */
const COMPANY_COL_NAMES = ['소속회사명', '계열회사명'];

/**
 * 소계·합계 행인가 — 집계 행을 개별 거래로 세면 금액이 두 배가 된다.
 * '소계(주1)' 같은 각주 접미 변형도 집계 행이다 — 놓치면 소계가 개별 거래로 승격돼
 * 오경보가 된다 (교차검토 S-8).
 */
export function isAggregateRow(cells: string[]): boolean {
  return cells.some((c) => {
    const n = normalizeCell(c);
    // 각주 접미는 괄호·대괄호·대시 어느 표기든 올 수 있다 (Codex 4차 S1)
    return /^(계|총계)([([\-–].*)?$/.test(n) || /^.*(합계|소계)([([\-–].*)?$/.test(n);
  });
}

/**
 * 추출 중 걸러진 행의 집계 — "조용히 사라진 행"을 진단으로 승격하기 위한 통로.
 * 넘기지 않으면 집계 없이 동작만 같다.
 */
export interface ExtractStats {
  /** 거래상대방은 있는데 금액을 못 읽어(각주 '16,000 (주1)' 등) 버려진 행 수 (교차검토 M-3) */
  rowsAmountUnparsable: number;
  /** 회사와 거래상대방이 같은 이름으로 읽힌 행 수 — 열 배치 오인 신호 (교차검토 M-2) */
  rowsCompanyEqualsCounterparty: number;
}

export function newExtractStats(): ExtractStats {
  return { rowsAmountUnparsable: 0, rowsCompanyEqualsCounterparty: 0 };
}

/**
 * 회사명 셀 선택. 실측 서식은 첫 열이 '금융/비금융 구분'이라 회사명이 그 다음 열(cCompany+1)에
 * 오지만, 병합 헤더 전개 변형으로 cCompany+1 이 다른 데이터 열(거래상대방·금액 등)과 겹치면
 * 그 가정을 버리고 cCompany 를 그대로 쓴다 — 대주(거래상대방)를 차입회사로 오인하면
 * 대주의 공시가 실제 차입회사의 미공시를 은폐한다 (교차검토 M-2).
 */
function companyCell(row: string[], cCompany: number, otherCols: number[]): string {
  if (otherCols.includes(cCompany + 1)) return (row[cCompany] ?? '').trim();
  return (row[cCompany + 1] ?? row[cCompany] ?? '').trim();
}

/**
 * 문서 표지의 **기업집단명**을 뽑는다 (실측: 대표회사 연1회 서식 20260819000341 의
 * `| 기업집단명 : | 미래에셋 |` 행. 픽스처도 같은 형태).
 *
 * 왜 필요한가: rcept_no 로 문서를 직접 지정하면 어느 기업집단인지 입력이 없어,
 * 포털 소속회사 목록(조인 품질·계열편입일·계열사 화이트리스트)을 통째로 못 쓴다.
 * 문서가 스스로 밝히는 집단명을 읽어 group 경로와 같은 모집단을 불러올 수 있다.
 *
 * 앵커는 **행 제목**이다 (절 번호·행 위치는 서식마다 다르다). 첫 일치만 쓰고,
 * 값이 비었거나 다시 제목처럼 생겼으면 못 읽은 것으로 본다 — 추측하지 않는다.
 */
export function extractGroupName(markdown: string): string | null {
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.includes('|')) continue;
    const cells = splitRow(line);
    if (cells.length < 2) continue;
    // '기업집단명', '기업집단명 :', '기업집단 명' 등 표기 흔들림을 흡수한다
    const head = normalizeCell(cells[0] ?? '').replace(/[\s:：]/g, '');
    if (head !== '기업집단명') continue;
    for (const raw of cells.slice(1)) {
      const v = normalizeCell(raw).replace(/^[:：]\s*/, '').trim();
      if (!v || v === '-' || /^-{3,}$/.test(v)) continue;
      if (v.replace(/[\s:：]/g, '') === '기업집단명') continue;
      return v;
    }
  }
  return null;
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
    const cCompany = findColAny(t, COMPANY_COL_NAMES);
    const cCapital = findCol(t, '자본금');
    const cEquity = findCol(t, '자본총계');
    // 부채비율 열도 '자본총계' 를 품고 있어 자본 열보다 오른쪽이다 — 가장 왼쪽을 쓴다
    if (cCompany === -1 || cEquity === -1) continue;
    if (t.unitFactor === null) continue;
    for (const row of t.rows) {
      if (isAggregateRow(row)) continue;
      // 첫 열은 금융/비금융 구분, 회사명은 그 다음 열이다 (rowspan 전개됨) — 단 열 겹침 가드
      const name = companyCell(row, cCompany, [cCapital, cEquity]);
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
export function extractFundBorrowings(
  markdown: string,
  stats?: ExtractStats,
): FundBorrowing[] {
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
      const name = companyCell(row, cCompany, [cParty, cAmount, cDate]);
      if (!name || name === '-') continue;
      // 회사 = 거래상대방이면 열 배치를 오인한 것일 가능성이 높다 — 쓰지 않고 센다 (M-2)
      if (normalizeCompanyName(name) === normalizeCompanyName(party)) {
        if (stats) stats.rowsCompanyEqualsCounterparty++;
        continue;
      }
      const amount = parseDisclosureNumber(row[cAmount] ?? '');
      if (amount === null) {
        // 각주('16,000 (주1)') 등으로 금액을 못 읽은 행 — 금액을 추측하지 않되,
        // 조용히 사라지면 그 거래가 "없는 것"이 된다. 집계로 승격한다 (M-3).
        if (stats) stats.rowsAmountUnparsable++;
        continue;
      }
      if (amount <= 0) continue;
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
export function extractMajorGoodsServices(
  markdown: string,
  stats?: ExtractStats,
): GoodsServiceRow[] {
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
      const name = companyCell(row, cCompany, [cParty, cAmount, cItem]);
      if (!name || name === '-') continue;
      if (normalizeCompanyName(name) === normalizeCompanyName(party)) {
        if (stats) stats.rowsCompanyEqualsCounterparty++;
        continue;
      }
      const amount = parseDisclosureNumber(row[cAmount] ?? '');
      if (amount === null) {
        if (stats) stats.rowsAmountUnparsable++;
        continue;
      }
      if (amount <= 0) continue;
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
  /** 거래상대방은 있는데 금액을 못 읽어 판정에서 빠진 행 수 (각주 등 — 교차검토 M-3) */
  rows_amount_unparsable: number;
  /** 회사 = 거래상대방으로 읽혀 버린 행 수 — 열 배치 오인 신호 (교차검토 M-2) */
  rows_company_equals_counterparty: number;
  /** 구분선 뒤 선두 행을 헤더로 승격시킨 횟수 (Codex S1 — 값이 전부 '-' 인 행도 승격된다) */
  header_promoted_rows: number;
  /** 헤더 폭과 열 수가 다른 데이터 행 수 — 병합 전개 밀림·서식 변형 신호 (Codex S1) */
  ragged_rows: number;
  /** 그런 행이 하나라도 있는 표 수 */
  tables_with_ragged_rows: number;
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
  let promoted = 0;
  let ragged = 0;
  let raggedTables = 0;
  for (const [label, keyword] of wanted) {
    const sec = sliceSection(markdown, keyword);
    if (!sec) {
      missing.push(label);
      continue;
    }
    found.push(label);
    for (const t of readLabeledTables(sec)) {
      if (t.unitFactor === null && t.rows.length > 0) noUnit++;
      promoted += t.headerPromotedRows;
      ragged += t.raggedRows;
      if (t.raggedRows > 0) raggedTables++;
    }
  }
  const stats = newExtractStats();
  return {
    capital_rows: extractCapitals(markdown).length,
    fund_borrowings: extractFundBorrowings(markdown, stats).length,
    goods_services: extractMajorGoodsServices(markdown, stats).length,
    tables_without_unit: noUnit,
    rows_amount_unparsable: stats.rowsAmountUnparsable,
    rows_company_equals_counterparty: stats.rowsCompanyEqualsCounterparty,
    header_promoted_rows: promoted,
    ragged_rows: ragged,
    tables_with_ragged_rows: raggedTables,
    sections_found: found,
    sections_missing: missing,
  };
}
