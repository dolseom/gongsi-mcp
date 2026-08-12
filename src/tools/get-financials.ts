/**
 * `get_financials` — 단일회사 재무제표 (축 3 기본기)
 *
 * 참고 MCP `financial.py` 이식. 반드시 지킬 두 가지 (docs/absorbed-from-dart-mcp.md §6):
 * - 단위 변환은 `display` 만 만들고 `raw`(원문)·`value`(정수 원)는 **절대 변형하지 않는다**
 * - 전기 대비 증감의 flow(IS/CIS/CF) 누적 필드는 **둘 다 값이 있을 때만** 쓰고 아니면
 *   당기/전기 필드로 폴백 — 사업보고서가 `thstrm_add_amount=''` 로 오는 경우가 있어
 *   폴백 없이는 연간 증감률이 통째로 누락된다 (원 프로젝트 v0.6.0 버그픽스)
 *
 * 자본총계·자본금을 key_metrics 로 뽑아 check_disclosure_duty 입력에 바로 쓸 수 있게 한다.
 */

import { z } from 'zod';
import { DartClient } from '../clients/dart.js';
import { resolveCorp } from '../resolver/corp-index.js';
import { ToolError } from '../lib/errors.js';

const STATEMENT_TYPES = ['BS', 'IS', 'CIS', 'CF', 'SCE'] as const;
const FLOW_STATEMENTS = new Set(['IS', 'CIS', 'CF']);

const UNIT_DIVISORS = {
  won: 1,
  thousand: 1_000,
  million: 1_000_000,
  hundred_million: 100_000_000,
} as const;

const REPORT_CODES = {
  annual: '11011',
  half: '11012',
  q1: '11013',
  q3: '11014',
} as const;

const AMOUNT_FIELD_ORDER = [
  'thstrm_amount',
  'thstrm_add_amount',
  'frmtrm_amount',
  'frmtrm_q_amount',
  'frmtrm_add_amount',
  'bfefrmtrm_amount',
] as const;

export const getFinancialsInput = z.object({
  query: z
    .string()
    .min(1)
    .optional()
    .describe('회사명·종목코드·corp_code — resolve_entity 와 같은 규칙'),
  corp_code: z.string().regex(/^\d{8}$/).optional().describe('DART 법인코드 8자리'),
  year: z
    .string()
    .regex(/^\d{4}$/, '연도는 4자리입니다')
    .optional()
    .describe('사업연도 (기본: 직전 연도). 사업보고서는 보통 3월 말 제출이므로 없으면 그 전 해로 다시 시도'),
  report: z
    .enum(['annual', 'half', 'q1', 'q3'])
    .optional()
    .describe('보고서 종류 (기본 annual=사업보고서)'),
  fs_div: z
    .enum(['CFS', 'OFS'])
    .optional()
    .describe('CFS=연결(기본) / OFS=별도. 연결이 없으면 별도로 자동 폴백합니다 (비상장 다수는 별도만 있음)'),
  statement: z
    .enum(['all', 'BS', 'IS', 'CIS', 'CF', 'SCE'])
    .optional()
    .describe('재무제표 종류 (기본 BS=재무상태표). all 은 응답이 큽니다'),
  unit: z
    .enum(['won', 'thousand', 'million', 'hundred_million'])
    .optional()
    .describe('display 표시 단위 (기본 million=백만원). raw/value 는 항상 원 단위 그대로'),
});

export type GetFinancialsInput = z.infer<typeof getFinancialsInput>;

/**
 * DART 금액 문자열 → 정수(원). "1,234" / "(123)" 음수 / "-"·""·"N/A" → null.
 * 해석 불가는 null 이 아니라 예외다 — 조용히 0 으로 만들면 판정이 뒤집힌다.
 */
export function parseAmount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  let text = String(value).trim();
  if (text === '' || text === '-' || text.toUpperCase() === 'N/A') return null;
  const negativeParen = text.startsWith('(') && text.endsWith(')');
  if (negativeParen) text = text.slice(1, -1);
  const normalized = text.replace(/,/g, '').replace(/ /g, '');
  if (!/^-?\d+$/.test(normalized)) {
    throw new ToolError('dart_api_error', `금액으로 해석할 수 없습니다: ${String(value)}`);
  }
  const parsed = Number(normalized);
  return negativeParen ? -Math.abs(parsed) : parsed;
}

interface AmountEntry {
  raw: unknown;
  value: number | null;
  display: number | null;
}

export interface NormalizedAccount {
  account_id: string;
  account_nm: string;
  sj_div: string;
  sj_nm: string;
  ord: unknown;
  currency: string;
  amounts: Record<string, AmountEntry>;
  change: {
    amount: number;
    display_amount: number;
    rate_percent: number;
    current_field: string;
    previous_field: string;
  } | null;
}

/** 전기 대비 비교에 쓸 필드 쌍 — flow 누적 필드는 둘 다 있을 때만 (핵심 버그픽스) */
export function comparisonFields(
  sjDiv: string,
  amounts: Record<string, AmountEntry>,
): [string, string] | null {
  if (sjDiv === 'BS') return ['thstrm_amount', 'frmtrm_amount'];
  if (FLOW_STATEMENTS.has(sjDiv)) {
    const cumulative: [string, string] = ['thstrm_add_amount', 'frmtrm_add_amount'];
    if (cumulative.every((f) => amounts[f]?.value !== null && amounts[f]?.value !== undefined)) {
      return cumulative;
    }
    return ['thstrm_amount', 'frmtrm_amount'];
  }
  return null;
}

export function normalizeAccount(
  row: Record<string, unknown>,
  divisor: number,
): NormalizedAccount {
  const sjDiv = String(row['sj_div'] ?? '').toUpperCase();
  const amounts: Record<string, AmountEntry> = {};
  const fields: string[] = [
    ...AMOUNT_FIELD_ORDER.filter((f) => f in row),
    ...Object.keys(row)
      .filter((k) => k.endsWith('_amount') && !(AMOUNT_FIELD_ORDER as readonly string[]).includes(k))
      .sort(),
  ];
  for (const f of fields) {
    const value = parseAmount(row[f]);
    amounts[f] = { raw: row[f], value, display: value === null ? null : value / divisor };
  }

  const currency = String(row['currency'] ?? '');
  const currentCurrency = String(row['thstrm_currency'] ?? currency);
  const previousCurrency = String(row['frmtrm_currency'] ?? currency);
  const comparable = currentCurrency === previousCurrency;

  let change: NormalizedAccount['change'] = null;
  const pair = comparisonFields(sjDiv, amounts);
  if (comparable && pair) {
    const [curField, prevField] = pair;
    const cur = amounts[curField]?.value;
    const prev = amounts[prevField]?.value;
    if (cur !== null && cur !== undefined && prev !== null && prev !== undefined && prev !== 0) {
      const delta = cur - prev;
      change = {
        amount: delta,
        display_amount: delta / divisor,
        rate_percent: (delta / Math.abs(prev)) * 100,
        current_field: curField,
        previous_field: prevField,
      };
    }
  }

  return {
    account_id: String(row['account_id'] ?? ''),
    account_nm: String(row['account_nm'] ?? ''),
    sj_div: sjDiv,
    sj_nm: String(row['sj_nm'] ?? ''),
    ord: row['ord'],
    currency,
    amounts,
    change,
  };
}

/**
 * 판정 입력용 핵심 지표 — BS 에서 자본총계·자본금을 뽑는다.
 * check_disclosure_duty 의 totalEquity / paidInCapital 로 그대로 쓴다 (단위: 원).
 */
export function extractKeyMetrics(bsAccounts: NormalizedAccount[]): Record<string, unknown> {
  const find = (names: string[], ids: string[]): NormalizedAccount | undefined =>
    bsAccounts.find((a) => ids.includes(a.account_id)) ??
    bsAccounts.find((a) => names.includes(a.account_nm.replace(/\s+/g, '')));
  const equity = find(['자본총계'], ['ifrs-full_Equity', 'ifrs_Equity']);
  const capital = find(['자본금'], ['ifrs-full_IssuedCapital', 'ifrs_IssuedCapital']);
  const assets = find(['자산총계'], ['ifrs-full_Assets', 'ifrs_Assets']);
  return {
    total_equity: equity?.amounts['thstrm_amount']?.value ?? null,
    paid_in_capital: capital?.amounts['thstrm_amount']?.value ?? null,
    total_assets: assets?.amounts['thstrm_amount']?.value ?? null,
    unit: '원',
    note: 'total_equity/paid_in_capital 은 check_disclosure_duty 의 totalEquity/paidInCapital 입력으로 그대로 쓸 수 있습니다.',
  };
}

function ordValue(v: unknown): number {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 2 ** 31 - 1;
}

export async function getFinancials(input: GetFinancialsInput): Promise<unknown> {
  if (input.query && input.corp_code) {
    throw new ToolError('invalid_argument', 'query 와 corp_code 는 함께 지정할 수 없습니다.');
  }
  if (!input.query && !input.corp_code) {
    throw new ToolError('invalid_argument', 'query 또는 corp_code 를 지정하세요.');
  }
  const client = new DartClient();

  let corpCode = input.corp_code;
  let corpName: string | undefined;
  if (input.query) {
    const r = await resolveCorp(input.query, client);
    if ('ambiguous' in r) {
      throw new ToolError('ambiguous_corp', `'${input.query}' 후보가 여럿입니다.`);
    }
    corpCode = r.corpCode;
    corpName = r.corpName;
  }

  const year = input.year ?? String(new Date().getFullYear() - 1);
  const reprtCode = REPORT_CODES[input.report ?? 'annual'];
  const requestedFsDiv = input.fs_div ?? 'CFS';
  const statement = input.statement ?? 'BS';
  const unit = input.unit ?? 'million';
  const divisor = UNIT_DIVISORS[unit];

  // CFS 없으면 OFS 폴백 — 비상장 다수는 별도재무제표만 낸다
  let fsDiv: 'CFS' | 'OFS' = requestedFsDiv;
  let apiCalls = 1;
  let rows = await client.financialStatements({ corpCode: corpCode!, bsnsYear: year, reprtCode, fsDiv });
  let fsDivFallback = false;
  if (rows.length === 0 && requestedFsDiv === 'CFS' && !input.fs_div) {
    fsDiv = 'OFS';
    apiCalls++;
    rows = await client.financialStatements({ corpCode: corpCode!, bsnsYear: year, reprtCode, fsDiv });
    fsDivFallback = rows.length > 0;
  }

  if (rows.length === 0) {
    // fs_div 를 명시하면 자동 폴백이 꺼진다 — 그 사실을 말하지 않으면 별도(OFS)엔 있는
    // 재무제표가 "없습니다"로 읽힌다 (비상장 다수가 별도만 제출, P2-라 14번)
    const fsDivHint =
      input.fs_div === 'CFS'
        ? ` fs_div:"CFS"(연결)를 명시해 별도(OFS) 자동 폴백이 꺼져 있습니다 — ` +
          `비상장사 다수는 별도만 제출하니 fs_div:"OFS" 로 다시 시도해 보세요.`
        : input.fs_div === 'OFS'
          ? ` fs_div:"OFS"(별도)를 명시했습니다 — 연결(CFS)만 있는 회사라면 fs_div 를 빼고 다시 시도해 보세요.`
          : '';
    throw new ToolError(
      'document_not_found',
      `${corpName ?? corpCode} 의 ${year}년 재무제표(${input.report ?? 'annual'})가 없습니다.` +
        fsDivHint +
        ` 사업보고서는 보통 다음 해 3월 말 제출됩니다 — year 를 한 해 앞당겨 보거나, ` +
        `외부감사 대상이 아닌 회사는 DART 에 재무제표가 없을 수 있습니다 ` +
        `(그 경우 get_group_structure 의 include_financials 로 포털 재무를 확인하세요).`,
      { corp_code: corpCode, year, report: input.report ?? 'annual', fs_div: input.fs_div ?? null },
    );
  }

  const selectedTypes = statement === 'all' ? STATEMENT_TYPES : ([statement] as const);
  const statements: Record<string, NormalizedAccount[]> = {};
  for (const t of selectedTypes) statements[t] = [];
  for (const row of rows) {
    const sjDiv = String(row['sj_div'] ?? '').toUpperCase();
    if (sjDiv in statements) statements[sjDiv]!.push(normalizeAccount(row, divisor));
  }
  for (const accounts of Object.values(statements)) {
    accounts.sort((a, b) => ordValue(a.ord) - ordValue(b.ord));
  }

  // key_metrics 는 statement 선택과 무관하게 BS 에서 뽑는다 (BS 미포함 요청이어도 rows 에는 있다)
  const bsAll = rows
    .filter((r) => String(r['sj_div'] ?? '').toUpperCase() === 'BS')
    .map((r) => normalizeAccount(r, divisor));

  // 요청한 재무제표가 비어 있으면 실제 존재하는 종류를 안내한다
  // (금융사는 IS 없이 CIS 만 내는 경우가 많다 — 삼성카드 실측)
  const availableStatements = [...new Set(rows.map((r) => String(r['sj_div'] ?? '').toUpperCase()))];
  const requestedEmpty =
    statement !== 'all' && (statements[statement]?.length ?? 0) === 0;

  return {
    corp_code: corpCode,
    ...(corpName ? { corp_name: corpName } : {}),
    year,
    report: input.report ?? 'annual',
    fs_div: fsDiv,
    statement,
    available_statements: availableStatements,
    ...(requestedEmpty
      ? {
          note: `${statement} 가 없습니다. 이 회사가 제출한 재무제표: ${availableStatements.join(', ')} — statement 를 바꿔 다시 호출하세요.`,
        }
      : {}),
    unit,
    key_metrics: extractKeyMetrics(bsAll),
    statements,
    total_accounts: Object.values(statements).reduce((s, a) => s + a.length, 0),
    diagnostics: {
      api_calls: apiCalls,
      ...(fsDivFallback
        ? { fs_div_fallback: '연결(CFS)이 없어 별도(OFS)로 자동 전환했습니다.' }
        : {}),
    },
  };
}
