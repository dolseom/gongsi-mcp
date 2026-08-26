/**
 * `audit_periodic_disclosures` — 정기공시 이행 점검 (기업집단현황 J004 / 하도급대금 J009)
 *
 * `audit_group_disclosures`(J001) 와 결정적으로 다른 점이 둘 있다.
 *
 *  ① **원문을 한 건도 받지 않는다.** J001 은 기한이 이사회 의결일에 종속돼 원문에서
 *     의결일을 캐야 하지만(건당 ~1.5초, 60초 벽의 원인), J004·J009 는 기한이 달력으로
 *     고정돼 있어 목록의 rcept_dt 만으로 판정이 끝난다.
 *  ② **미제출을 볼 수 있다.** 기업집단현황공시는 공시대상회사면 무조건 하는 의무라,
 *     기한이 지났는데 접수분이 없으면 그 자체가 신호다. J001 감사가 원리상 못 하는 일이다.
 *     (다만 확정이 아니라 "후보" — 고시 §2① 단서 제외 대상일 수 있다.)
 *
 * 수집 전략도 반대다. J001 은 시장 전체가 연 ~1,555건이라 전체시장 수집 후 필터가 싸지만,
 * J004 는 회사당 연 4~5건으로 조밀해 **회사별 corp_code 지정 검색**이 훨씬 싸다.
 * corp_code 를 지정하면 DART 의 3개월 기간 제한이 걸리지 않아(함정 10번, batch.ts:230)
 * 1년 구간을 창 하나로 처리한다 — 회사당 측정 1콜 + 수집 1콜(접수 0건이면 측정 1콜로 끝),
 * 즉 계열사 60개면 60~120콜이다. 전체시장 J004 는 연 2만여 건이라 200콜을 훌쩍 넘는다.
 */

import { z } from 'zod';
import { DartClient, viewerUrl } from '../clients/dart.js';
import { collectAdaptive, type BatchResult } from '../search/batch.js';
import { resolvePopulation, type Population } from './audit-group-disclosures.js';
import { buildPeriodicCalendar, type CalendarEntry } from '../rules/periodic-calendar.js';
import { getLogger } from '../lib/logger.js';
import { ToolError } from '../lib/errors.js';
import { isValidYMD, toYMD } from '../rules/business-days.js';

const log = getLogger('audit-periodic');

const YMD = z
  .string()
  .regex(/^\d{8}$/, 'YYYYMMDD 형식이어야 합니다')
  .refine(isValidYMD, '실존하지 않는 날짜입니다');

/** 이 도구가 다루는 의무 — 기한이 달력 고정이고 DART 목록만으로 판정되는 것 */
const SUPPORTED = ['group_status_annual', 'group_status_quarterly', 'subcontract_payment_terms'] as const;
type SupportedDuty = (typeof SUPPORTED)[number];

export const auditPeriodicDisclosuresInput = z.object({
  group: z.string().min(1).optional().describe('기업집단명 (companies 와 동시 사용 불가)'),
  companies: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe('회사명 또는 corp_code(8자리) 목록 (group 과 동시 사용 불가)'),
  year: z
    .number()
    .int()
    .min(2020)
    .max(2100)
    .describe('점검할 연도 — 그 해에 **기한이 도래하는** 정기공시를 본다'),
  duties: z
    .array(z.enum(SUPPORTED))
    .optional()
    .describe(
      '점검할 의무 (기본: 기업집단현황 연1회·분기). subcontract_payment_terms 를 넣으면 하도급대금 결제조건도 본다',
    ),
  year_month: z
    .string()
    .regex(/^\d{6}$/)
    .optional()
    .describe('기업집단포털 기준월 YYYYMM (group 경로에서 소속회사 스냅샷 선택)'),
  today: YMD.optional().describe('오늘 날짜 (기본: 시스템 날짜). 기한 도래 여부 판정 기준'),
});

export type AuditPeriodicDisclosuresInput = z.infer<typeof auditPeriodicDisclosuresInput>;

/** 회사 수가 이보다 많으면 60초 벽에 걸릴 위험이 커 분할을 안내한다 */
const MAX_COMPANIES_PER_CALL = 80;

/** 테스트 주입점 — 실제 API 없이 판정 로직을 검증한다 */
export interface PeriodicAuditDeps {
  collectList: (corpCode: string, detailTy: string, from: string, to: string) => Promise<BatchResult>;
}

function realDeps(client: DartClient): PeriodicAuditDeps {
  return {
    collectList: (corpCode, pblntfDetailTy, from, to) =>
      collectAdaptive(client, { pblntfDetailTy, corpCode }, from, to),
  };
}

/** DART 보고서명에서 읽어내는 서식 종류 (실측 2026-08-27) */
type FormKind = 'annual_q1' | 'quarterly' | 'subcontract' | 'unknown';

interface ClassifiedFiling {
  rcept_no: string;
  rcept_dt: string;
  corp_code: string;
  corp_name: string;
  report_nm: string;
  kind: FormKind;
  /** 대표회사 통합 서식인지 — 개별회사 접수분이 없는 이유가 될 수 있다 */
  representative: boolean;
  /** 정정 접수분. 지연 판정은 원본으로 한다 */
  correction: boolean;
}

/**
 * 보고서명 분류.
 * 실측 형태:
 *   대규모기업집단현황공시[연1회공시및1/4분기용(대표회사)]   / (개별회사)
 *   대규모기업집단현황공시[분기별공시(대표회사용)]           / (개별회사용)
 * 연1회 서식은 '(대표회사)', 분기 서식은 '(대표회사용)' 으로 접미사가 달라 둘 다 처리한다.
 */
export function classifyReportName(reportNm: string): { kind: FormKind; representative: boolean } {
  const nm = reportNm.replace(/\s+/g, '');
  const representative = nm.includes('대표회사');
  if (nm.includes('연1회공시') || nm.includes('1/4분기용')) {
    return { kind: 'annual_q1', representative };
  }
  if (nm.includes('분기별공시')) return { kind: 'quarterly', representative };
  if (nm.includes('하도급') || nm.includes('결제조건')) return { kind: 'subcontract', representative };
  return { kind: 'unknown', representative };
}

function isCorrection(reportNm: string): boolean {
  return reportNm.includes('정정');
}

/**
 * 접수분을 기한에 배정한다.
 *
 * 배정 규칙: 대상 기간 종료일 다음 날부터 **다음 대상 기간 종료일까지** 접수된 것을
 * 그 기한의 제출로 본다. 실측상 접수는 기한 직전에 극단적으로 몰려 있어(9일간 3,880건)
 * 이 창으로 대부분 정확히 갈린다.
 *
 * ⚠️ 한계: 아주 늦은 제출(예: 1분기분을 9월에 제출)은 다음 분기 창으로 들어가
 * "이른 제출"처럼 보일 수 있다. 그래서 창에 못 넣은 접수분은 버리지 않고
 * unmatched_filings 로 전부 돌려주고, 배정 근거(assignment)를 응답에 명시한다.
 */
function assignWindow(
  entries: CalendarEntry[],
  filing: ClassifiedFiling,
): CalendarEntry | null {
  const candidates = entries.filter((e) => e.period_end !== null || e.duty === 'group_status_annual');
  let best: CalendarEntry | null = null;
  for (const e of candidates) {
    const start = e.period_end ?? `${e.deadline.slice(0, 4)}0331`;
    if (filing.rcept_dt <= start) continue;
    // 같은 종류의 다음 기한 대상기간 종료일 전까지
    const next = candidates
      .filter((c) => c.duty === e.duty && (c.period_end ?? '') > start)
      .map((c) => c.period_end!)
      .sort()[0];
    if (next && filing.rcept_dt > next) continue;
    if (!best || (e.period_end ?? '') > (best.period_end ?? '')) best = e;
  }
  return best;
}

type CompanyStatus = 'on_time' | 'late_candidate' | 'not_filed_candidate' | 'not_due';

interface DeadlineReport {
  duty: string;
  label: string;
  dart_type: string;
  period: string;
  deadline: string;
  statutory_date: string;
  adjusted_to_next_business_day: boolean;
  /** 기한이 아직 오지 않았으면 판정하지 않는다 — 미제출로 몰면 거짓 경보다 */
  due: boolean;
  /** 이 의무에서 "접수 없음"이 신호가 되는가 (무조건 의무만 true) */
  non_filing_is_signal: boolean;
  summary: { on_time: number; late_candidate: number; not_filed_candidate: number };
  on_time: Array<{ corp_name: string; corp_code: string; rcept_no: string; rcept_dt: string }>;
  late_candidates: Array<{
    corp_name: string;
    corp_code: string;
    rcept_no: string;
    rcept_dt: string;
    delay_days: number;
    viewer_url: string;
  }>;
  not_filed_candidates: Array<{
    corp_name: string;
    corp_code: string;
    /** 대상 기간 종료 후에 계열편입된 회사 — 첫 공시 의무 시점이 애매하다 */
    recently_joined?: string;
  }>;
  /**
   * 이 기한에 **공시의무가 없었던** 회사 — 계열편입일이 기한보다 뒤다.
   * 미제출 후보에서 빼고 여기로 옮긴다. 신규 지정 집단에서 이게 대량으로 나온다.
   */
  out_of_scope: Array<{ corp_name: string; corp_code: string; joined_group_at: string }>;
  /** 대표회사 통합 서식이 접수된 경우 — 개별회사 미접수의 설명이 될 수 있다 */
  representative_filings: Array<{ corp_name: string; corp_code: string; rcept_no: string }>;
  /**
   * 모집단 전체가 한 건도 안 낸 기한 — 집단이 그때 아직 지정되지 않았거나
   * 조회 범위가 잘못됐다는 신호다. "집단 전체가 위반"보다 이쪽이 압도적으로 흔하다.
   */
  likely_out_of_scope?: boolean;
}

function daysBetween(from: string, to: string): number {
  const d = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.round((d(to) - d(from)) / 86_400_000);
}

export async function auditPeriodicDisclosures(
  input: AuditPeriodicDisclosuresInput,
  depsOverride?: PeriodicAuditDeps,
): Promise<unknown> {
  if (!input.group && !input.companies) {
    throw new ToolError('invalid_argument', 'group 또는 companies 중 하나는 필수입니다.');
  }
  if (input.group && input.companies) {
    throw new ToolError('invalid_argument', 'group 과 companies 는 동시에 쓸 수 없습니다.');
  }

  const today = input.today ?? toYMD(new Date());
  const duties: SupportedDuty[] = input.duties?.length
    ? input.duties
    : ['group_status_annual', 'group_status_quarterly'];

  const population: Population = await resolvePopulation({
    ...(input.group ? { group: input.group } : {}),
    ...(input.companies ? { companies: input.companies } : {}),
    ...(input.year_month ? { year_month: input.year_month } : {}),
  });

  if (population.corpCodes.size > MAX_COMPANIES_PER_CALL) {
    throw new ToolError(
      'range_too_large',
      `대상 회사가 ${population.corpCodes.size}개입니다 — 한 번에 ${MAX_COMPANIES_PER_CALL}개까지만 ` +
        '처리합니다(회사당 1회 조회라 60초 벽에 걸립니다). companies 로 나눠 호출하세요.',
      { companies: population.corpCodes.size, max_per_call: MAX_COMPANIES_PER_CALL },
    );
  }

  const calendar = buildPeriodicCalendar(input.year).filter((e) =>
    duties.includes(e.duty as SupportedDuty),
  );
  if (calendar.length === 0) {
    throw new ToolError(
      'invalid_argument',
      `${input.year}년에 기한이 도래하는 대상 의무가 없습니다: ${duties.join(', ')}`,
    );
  }

  const deps = depsOverride ?? realDeps(new DartClient());

  // 수집 구간: 그 해 기한들의 대상기간 시작 언저리부터 오늘(또는 연말)까지.
  // 전년도 4분기분(기한 2월 말)이 포함되므로 전년도 10월부터 잡는다.
  const from = `${input.year - 1}1001`;
  const to = today < `${input.year}1231` ? today : `${input.year}1231`;

  const needJ004 = duties.some((d) => d.startsWith('group_status'));
  const needJ009 = duties.includes('subcontract_payment_terms');

  const filings: ClassifiedFiling[] = [];
  const listErrors: Array<{ corp_name: string; corp_code: string; error: string }> = [];
  let listCalls = 0;
  let partial = false;

  const targets = [...population.corpCodes.entries()];
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= targets.length) return;
      const [corpCode, corpName] = targets[i]!;
      for (const ty of [...(needJ004 ? ['J004'] : []), ...(needJ009 ? ['J009'] : [])]) {
        try {
          const r = await deps.collectList(corpCode, ty, from, to);
          listCalls++;
          if (r.diagnostics.partial_results || r.diagnostics.truncated) partial = true;
          for (const row of r.rows) {
            const c = classifyReportName(row.report_nm);
            filings.push({
              rcept_no: row.rcept_no,
              rcept_dt: row.rcept_dt,
              corp_code: corpCode,
              corp_name: corpName,
              report_nm: row.report_nm,
              kind: c.kind,
              representative: c.representative,
              correction: isCorrection(row.report_nm),
            });
          }
        } catch (err) {
          listErrors.push({
            corp_name: corpName,
            corp_code: corpCode,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, () => worker()));

  // 지연 판정은 **원본 접수분** 기준이다 (정정은 원본을 대체하지 않는다 — 함정 -1번과 같은 이유)
  const originals = filings.filter((f) => !f.correction);
  const corrections = filings.filter((f) => f.correction);

  const matched = new Map<string, ClassifiedFiling[]>(); // `${duty}|${period}` → filings
  const unmatched: ClassifiedFiling[] = [];
  for (const f of originals) {
    const wantKind: FormKind =
      f.kind === 'subcontract' ? 'subcontract' : f.kind === 'annual_q1' ? 'annual_q1' : 'quarterly';
    const pool = calendar.filter((e) => {
      if (e.dart_type === 'J009') return wantKind === 'subcontract';
      if (e.duty === 'group_status_annual') return wantKind === 'annual_q1';
      // 분기 의무: 1분기분은 연1회 서식으로 나가므로 annual_q1 도 받는다
      return wantKind === 'quarterly' || (wantKind === 'annual_q1' && e.period.endsWith('1분기'));
    });
    const hit = f.kind === 'unknown' ? null : assignWindow(pool, f);
    if (!hit) {
      unmatched.push(f);
      continue;
    }
    const key = `${hit.duty}|${hit.period}`;
    matched.set(key, [...(matched.get(key) ?? []), f]);
  }

  const reports: DeadlineReport[] = calendar.map((e) => {
    const key = `${e.duty}|${e.period}`;
    const rows = matched.get(key) ?? [];
    const due = e.deadline <= today;
    // 무조건 의무만 "접수 없음"이 신호가 된다. 하도급은 원사업자·거래 있는 경우만이라
    // 미제출을 신호로 쓰면 대부분이 거짓 경보가 된다.
    const nonFilingIsSignal = e.obligation === 'unconditional';

    const byCompany = new Map<string, ClassifiedFiling[]>();
    for (const r of rows) byCompany.set(r.corp_code, [...(byCompany.get(r.corp_code) ?? []), r]);

    const onTime: DeadlineReport['on_time'] = [];
    const late: DeadlineReport['late_candidates'] = [];
    const notFiled: DeadlineReport['not_filed_candidates'] = [];
    const outOfScope: DeadlineReport['out_of_scope'] = [];
    const repFilings: DeadlineReport['representative_filings'] = [];

    for (const [corpCode, corpName] of population.corpCodes) {
      const mine = byCompany.get(corpCode) ?? [];
      for (const f of mine.filter((x) => x.representative)) {
        repFilings.push({ corp_name: corpName, corp_code: corpCode, rcept_no: f.rcept_no });
      }
      // 계열편입일이 기한보다 뒤면 그 기한에는 공시의무 자체가 없었다.
      // 이걸 빼지 않으면 신규 지정 집단에서 과거 기한이 통째로 "미제출"로 뜬다.
      const joinedAt = population.joinedGroupAt?.get(corpCode);
      if (mine.length === 0 && joinedAt && joinedAt > e.deadline) {
        outOfScope.push({ corp_name: corpName, corp_code: corpCode, joined_group_at: joinedAt });
        continue;
      }
      if (mine.length === 0) {
        if (due && nonFilingIsSignal) {
          const joinedAfterPeriod = !!joinedAt && joinedAt > (e.period_end ?? '');
          notFiled.push({
            corp_name: corpName,
            corp_code: corpCode,
            ...(joinedAfterPeriod ? { recently_joined: joinedAt } : {}),
          });
        }
        continue;
      }
      // 같은 기한에 여러 건이면 가장 이른 접수를 그 회사의 이행으로 본다
      const earliest = mine.reduce((a, b) => (a.rcept_dt <= b.rcept_dt ? a : b));
      if (earliest.rcept_dt <= e.deadline) {
        onTime.push({
          corp_name: corpName,
          corp_code: corpCode,
          rcept_no: earliest.rcept_no,
          rcept_dt: earliest.rcept_dt,
        });
      } else {
        late.push({
          corp_name: corpName,
          corp_code: corpCode,
          rcept_no: earliest.rcept_no,
          rcept_dt: earliest.rcept_dt,
          delay_days: daysBetween(e.deadline, earliest.rcept_dt),
          viewer_url: viewerUrl(earliest.rcept_no),
        });
      }
    }
    late.sort((a, b) => b.delay_days - a.delay_days);

    return {
      duty: e.duty,
      label: e.label,
      dart_type: e.dart_type,
      period: e.period,
      deadline: e.deadline,
      statutory_date: e.statutory_date,
      adjusted_to_next_business_day: e.adjusted_to_next_business_day,
      due,
      non_filing_is_signal: nonFilingIsSignal,
      summary: {
        on_time: onTime.length,
        late_candidate: late.length,
        not_filed_candidate: notFiled.length,
      },
      on_time: onTime,
      late_candidates: late,
      not_filed_candidates: notFiled,
      out_of_scope: outOfScope,
      representative_filings: repFilings,
      // 여러 회사를 봤는데 접수가 0건이면 "집단 전체 위반"이 아니라 범위 오류로 읽는 게 옳다
      ...(due && rows.length === 0 && population.corpCodes.size > 1
        ? { likely_out_of_scope: true }
        : {}),
    };
  });

  const totalLate = reports.reduce((n, r) => n + r.late_candidates.length, 0);
  const totalNotFiled = reports.reduce((n, r) => n + r.not_filed_candidates.length, 0);

  const notes: string[] = [
    '지연·미제출은 모두 **"후보"**입니다 — 확정이 아닙니다. 각 건을 DART 원문(viewer_url)으로 확인한 뒤 판단하세요.',
    '판정 기준: 원본 접수분(정정 제외)의 접수일 vs 법정 기한(마지막 날이 비영업일이면 다음 최초 영업일). ' +
      '이 도구는 원문을 내려받지 않습니다 — 기한이 달력으로 고정돼 있어 목록만으로 판정됩니다.',
    '접수분을 기한에 배정하는 규칙은 **접수일 창**입니다 (대상 기간 종료 다음 날 ~ 다음 대상 기간 종료일). ' +
      '아주 늦은 제출은 다음 기간의 이른 제출처럼 보일 수 있어, 창에 못 넣은 접수분은 버리지 않고 ' +
      'unmatched_filings 로 전부 돌려줍니다.',
  ];

  if (totalNotFiled > 0) {
    notes.push(
      `⚠️ 미제출 후보 ${totalNotFiled}건 — 기업집단현황공시는 공시대상회사면 무조건 하는 의무라 ` +
        '접수분이 없으면 신호입니다. 다만 확정 전에 세 가지를 확인하세요: ' +
        '① 고시 §2① 단서 — 직전 사업연도말 자산총액 100억원 미만이면서 청산 절차 진행 중이거나 ' +
        '1년 이상 휴업 중인 회사는 공시대상회사가 아닙니다. ' +
        '② 그 회사가 **그 기한 시점에** 실제로 집단 소속이었는지 — 포털 소속회사 스냅샷은 ' +
        '매년 5월 1일 기준 연 1회라, 그 뒤 편입·제외된 회사는 반영되지 않습니다. ' +
        '③ recently_joined 가 붙은 회사는 대상 기간이 끝난 뒤 편입돼 첫 공시 의무 시점이 애매합니다.',
    );
  }
  const outOfScopeTotal = reports.reduce((n, r) => n + r.out_of_scope.length, 0);
  if (outOfScopeTotal > 0) {
    notes.push(
      `ℹ️ 계열편입일이 기한보다 뒤여서 **공시의무가 없었던** 회사-기한 조합 ${outOfScopeTotal}건을 ` +
        '미제출 후보에서 제외했습니다 (out_of_scope). 신규 지정 집단·신규 편입 회사에서 나옵니다.',
    );
  }
  if (reports.some((r) => r.likely_out_of_scope)) {
    const which = reports.filter((r) => r.likely_out_of_scope).map((r) => r.period);
    notes.push(
      `🚨 모집단 ${population.corpCodes.size}개사 전부가 한 건도 내지 않은 기한이 있습니다 (${which.join(', ')}). ` +
        '이건 "집단 전체가 위반"보다 **그 시점에 이 집단이 아직 공시대상기업집단으로 지정되지 않았거나 ' +
        '조회 범위가 잘못됐다**는 신호일 가능성이 훨씬 높습니다 — 지정 시점을 먼저 확인하세요.',
    );
  }
  if (!population.joinedGroupAt && input.group) {
    notes.push(
      'ℹ️ 계열편입일 정보를 얻지 못해 "편입 전이라 의무 없음" 판정을 하지 못했습니다 — ' +
        '미제출 후보에 편입 전 기간이 섞여 있을 수 있습니다.',
    );
  }
  if (input.companies) {
    notes.push(
      'ℹ️ companies 로 직접 지정한 경우에는 계열편입일을 알 수 없어 "편입 전이라 의무 없음" 판정을 ' +
        '하지 않습니다. 신규 편입 회사가 섞여 있으면 미제출 후보가 과다할 수 있습니다 — ' +
        'group 으로 호출하면 편입일을 반영합니다.',
    );
  }
  const repCount = reports.reduce((n, r) => n + r.representative_filings.length, 0);
  if (repCount > 0) {
    notes.push(
      `ℹ️ 대표회사 통합 서식 접수분이 ${repCount}건 있습니다. 대표회사는 개별회사 공시사항을 취합하고 ` +
        '일부 항목(계열제외 내역·순환출자 현황 등)을 집단 대표로 작성합니다(고시 §3③⑤) — ' +
        '다만 이것이 개별회사의 공시의무를 대체하는지는 이 도구가 판단하지 않습니다.',
    );
  }
  if (unmatched.length > 0) {
    notes.push(
      `⚠️ 어느 기한에도 배정하지 못한 접수분이 ${unmatched.length}건 있습니다 (unmatched_filings) — ` +
        '아주 늦은 제출이거나 이 도구가 모르는 서식명일 수 있습니다. 직접 확인하세요.',
    );
  }
  if (population.unjoined.length > 0) {
    notes.push(
      `⚠️ 집단 소속 ${population.unjoined.length}개사는 DART corp_code 미조인이라 이번 점검에서 빠졌습니다 ` +
        '(coverage 참조) — resolve_entity(fetchJurirNo=true) 로 캐시를 채운 뒤 재점검하세요.',
    );
  }
  if (listErrors.length > 0) {
    notes.push(
      `⚠️ ${listErrors.length}개사는 목록 조회가 실패했습니다 (list_errors) — 이 회사들은 ` +
        '"제출함"도 "미제출"도 아니라 **확인하지 못한 것**입니다.',
    );
  }
  if (partial) {
    notes.push('⚠️ 목록 수집이 불완전합니다 — 이 결과로 "누락 없음"을 결론내지 마세요.');
  }
  if (reports.some((r) => !r.due)) {
    notes.push(
      `ℹ️ 아직 기한이 오지 않은 항목(due:false)은 미제출 판정을 하지 않습니다 — ` +
        `오늘(${today}) 기준입니다.`,
    );
  }

  log.info('정기공시 점검 완료', {
    companies: population.corpCodes.size,
    deadlines: reports.length,
    filings: filings.length,
    late: totalLate,
    notFiled: totalNotFiled,
    listCalls,
  });

  return {
    scope: {
      ...(population.group ? { group: population.group } : {}),
      companies_audited: population.corpCodes.size,
      year: input.year,
      duties,
      judged_at: today,
      collection_period: { from, to },
    },
    summary: {
      deadlines_checked: reports.filter((r) => r.due).length,
      deadlines_not_due: reports.filter((r) => !r.due).length,
      filings_found: filings.length,
      corrections_excluded: corrections.length,
      late_candidates: totalLate,
      not_filed_candidates: totalNotFiled,
    },
    deadlines: reports,
    ...(unmatched.length ? { unmatched_filings: unmatched } : {}),
    ...(listErrors.length ? { list_errors: listErrors } : {}),
    coverage: {
      companies_with_corp_code: population.corpCodes.size,
      companies_unjoined: population.unjoined,
      collected_types: [...(needJ004 ? ['J004'] : []), ...(needJ009 ? ['J009'] : [])],
      /** J001 감사와 달리 미제출을 볼 수 있다 — 단 무조건 의무에 한한다 */
      detects_non_filing: reports.some((r) => r.non_filing_is_signal),
      undetectable: {
        /** 내용의 정확성은 보지 않는다 — 냈는지·언제 냈는지만 본다 */
        content_accuracy: true,
        other_duty_types: ['J001', 'J005', 'J008'],
      },
    },
    notes,
    diagnostics: {
      list_calls: listCalls,
      partial_results: partial,
      unmatched: unmatched.length,
    },
  };
}
