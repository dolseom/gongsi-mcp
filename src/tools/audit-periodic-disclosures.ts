/**
 * `audit_periodic_disclosures` — 정기공시의 **기한·접수** 점검 (기업집단현황 J004 / 하도급대금 J009)
 *
 * `audit_group_disclosures`(J001) 와 다른 점 둘.
 *
 *  ① **원문을 한 건도 받지 않는다.** 단 이건 "기한 계산과 접수 여부"에 한정된 주장이다.
 *     J001 은 기한이 이사회 의결일에 종속돼 원문에서 의결일을 캐야 하지만(건당 ~1.5초,
 *     60초 벽의 원인), J004·J009 는 기한이 달력으로 고정돼 목록의 rcept_dt 만으로 계산된다.
 *     ⚠️ **내용의 정확성·기재 누락은 보지 않는다.** 그건 원문이 필요하다.
 *  ② **미제출을 볼 수 있다.** 기업집단현황공시는 공시대상회사면 무조건 하는 의무라,
 *     기한이 지났는데 접수분이 없으면 그 자체가 신호다. J001 감사가 원리상 못 하는 일이다.
 *     ⚠️ 다만 "공시대상회사인지"를 이 도구가 판정하는 것은 아니다 — scope_caveats 참조.
 *
 * 수집 전략도 반대다. J001 은 시장 전체가 연 ~1,555건이라 전체시장 수집 후 필터가 싸지만,
 * J004 는 회사당 연 4~5건으로 조밀해 **회사별 corp_code 지정 검색**이 훨씬 싸다.
 * corp_code 를 지정하면 DART 의 3개월 기간 제한이 걸리지 않아(함정 10번, batch.ts:230)
 * 긴 구간을 창 하나로 처리한다 — 회사당 측정 1콜 + 수집 1콜(접수 0건이면 측정 1콜로 끝).
 *
 * ★ 서식-의무 대응 (DART 실측 2026-08-27)
 *   '연1회공시및1/4분기용' 서식 1건이 **연1회 의무와 1분기 의무를 동시에 이행**한다.
 *   이걸 한쪽에만 배정하면 나머지 한쪽이 통째로 미제출 후보가 된다 (Codex 7차 치명 1).
 *   그래서 배정은 1:1 이 아니라 1:N 이다.
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
const SUPPORTED = [
  'group_status_annual',
  'group_status_quarterly',
  'subcontract_payment_terms',
] as const;
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
    .describe(
      '기업집단포털 기준월 YYYYMM. 생략하면 **점검 연도의 5월**(YYYY05)을 쓴다 — ' +
        '포털 스냅샷이 매년 5월 1일 기준이라 과거 연도를 점검할 때 최신 스냅샷을 쓰면 모집단이 어긋난다',
    ),
  today: YMD.optional().describe('오늘 날짜 (기본: 시스템 날짜). 기한 도래 여부 판정 기준'),
});

export type AuditPeriodicDisclosuresInput = z.infer<typeof auditPeriodicDisclosuresInput>;

/**
 * 분할을 권고하는 회사 수. **60초 안전 보장값이 아니라 권고선이다** —
 * 실제 호출 수는 선택 duty 수 × (측정 1 + 수집 1) 이고 재시도·페이지 수·지연이 더해진다.
 */
const SPLIT_ADVICE_COMPANIES = 80;

/** 테스트 주입점 — 실제 API 없이 판정 로직을 검증한다 */
export interface PeriodicAuditDeps {
  collectList: (
    corpCode: string,
    detailTy: string,
    from: string,
    to: string,
  ) => Promise<BatchResult>;
}

function realDeps(client: DartClient): PeriodicAuditDeps {
  return {
    collectList: (corpCode, pblntfDetailTy, from, to) =>
      collectAdaptive(
        client,
        {
          pblntfDetailTy,
          corpCode,
          // ★ 강제 false. last_reprt_at=Y 는 정정으로 대체된 **원본**을 목록에서 지운다.
          // 이 감사는 원본 접수일로 판정하므로 Y 면 "제출했는데 미제출"로 뒤집힌다 (함정 -1번).
          // 전역 설정(GONGSI_LAST_REPORT_ONLY)이 켜져 있어도 여기서는 따르지 않는다.
          lastReportOnly: false,
        },
        from,
        to,
      ),
  };
}

/** DART 보고서명에서 읽어내는 서식 종류 (실측 2026-08-27) */
export type FormKind = 'annual_q1' | 'quarterly' | 'subcontract' | 'unknown';

interface ClassifiedFiling {
  rcept_no: string;
  rcept_dt: string;
  corp_code: string;
  corp_name: string;
  report_nm: string;
  kind: FormKind;
  /** 대표회사 통합 서식인지 */
  representative: boolean;
  /** 정정 접수분. 지연 판정은 원본으로 한다 */
  correction: boolean;
}

/**
 * J004 보고서명 분류.
 * 실측 형태:
 *   대규모기업집단현황공시[연1회공시및1/4분기용(대표회사)]   / (개별회사)
 *   대규모기업집단현황공시[분기별공시(대표회사용)]           / (개별회사용)
 * 연1회 서식은 '(대표회사)', 분기 서식은 '(대표회사용)' 으로 접미사가 달라 둘 다 처리한다.
 *
 * ⚠️ J009 는 이 함수로 분류하지 않는다 — pblntfDetailTy=J009 로 이미 좁혀 조회하므로
 * 보고서명 추정에 기대는 것보다 조회 유형을 그대로 믿는 편이 안전하다 (Codex 7차 사소 12).
 */
export function classifyReportName(reportNm: string): { kind: FormKind; representative: boolean } {
  const nm = reportNm.replace(/\s+/g, '');
  const representative = nm.includes('대표회사');
  if (nm.includes('연1회공시') || nm.includes('1/4분기용')) {
    return { kind: 'annual_q1', representative };
  }
  if (nm.includes('분기별공시')) return { kind: 'quarterly', representative };
  return { kind: 'unknown', representative };
}

/**
 * 정정 접수분 판정 — 보고서명 대괄호 접두사 휴리스틱이다.
 * 실측 형태는 '[기재정정]…' 이고 '[첨부정정]'·'[자진정정]' 같은 변형도 같은 자리에 온다.
 * ⚠️ DART 가 보고서명이 아닌 메타데이터로만 표시하는 형태가 있다면 놓칠 수 있다.
 */
export function isCorrection(reportNm: string): boolean {
  const head = /^\[([^\]]*)\]/.exec(reportNm.replace(/\s+/g, ''));
  if (head?.[1] && /정정|추가|취소/.test(head[1])) return true;
  // 접두사가 아닌 자리에 '정정'이 오는 형태도 방어적으로 잡는다
  // (원본 제목에 '정정'이 들어가는 실사례는 확인되지 않았다)
  return reportNm.includes('정정');
}

/** 분기말·반기말에서 N개월 뒤 같은 성격의 기간 종료일 */
export function addMonthsToPeriodEnd(periodEnd: string, months: number): string {
  const y = Number(periodEnd.slice(0, 4));
  const m = Number(periodEnd.slice(4, 6));
  const target = m + months;
  const ty = y + Math.floor((target - 1) / 12);
  const tm = ((target - 1) % 12) + 1;
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return `${ty}${String(tm).padStart(2, '0')}${String(lastDay).padStart(2, '0')}`;
}

/**
 * 접수분을 배정할 창 (start 초과 ~ end 이하).
 *
 * 달력 목록에서 "다음 항목"을 찾는 방식은 목록 끝에서 창이 무한대로 열려
 * 다음 해 접수분까지 빨아들인다. 그래서 **산술로** 닫는다.
 */
export function assignmentWindow(entry: CalendarEntry): { start: string; end: string } {
  if (entry.period_end === null) {
    // 연1회: 대상이 '금년도 지정일(≈5/1) 기준'이고 기한이 5/31 이다.
    // 4/1 부터 이듬해 3/31 까지를 그 해 연1회분으로 본다 —
    // 연말을 넘겨 늦게 낸 것도 그 해 것으로 잡힌다.
    const y = Number(entry.deadline.slice(0, 4));
    return { start: `${y}0331`, end: `${y + 1}0331` };
  }
  const months = entry.frequency === 'semiannual' ? 6 : 3;
  return { start: entry.period_end, end: addMonthsToPeriodEnd(entry.period_end, months) };
}

/** 그 의무·그 기간을 이행하는 서식 종류 */
export function expectedKind(entry: CalendarEntry): FormKind {
  if (entry.dart_type === 'J009') return 'subcontract';
  if (entry.duty === 'group_status_annual') return 'annual_q1';
  // 1분기분은 연1회와 한 서식으로 함께 나간다 (실측). 2·3·4분기는 '분기별공시'.
  return entry.period.endsWith('1분기') ? 'annual_q1' : 'quarterly';
}

interface NotFiledRow {
  corp_name: string;
  corp_code: string;
  /** 대상 기간 종료 후에 계열편입된 회사 — 첫 공시 의무 시점이 애매하다 */
  recently_joined?: string;
  /**
   * 직후 기간에 이른 접수가 있어 **이 기간분을 늦게 낸 것일 수 있다**.
   * 접수일만으로는 어느 기간분인지 가릴 수 없다 — 원문을 봐야 확정된다.
   */
  possibly_filed_late?: { rcept_no: string; rcept_dt: string; viewer_url: string };
}

interface DeadlineReport {
  duty: string;
  label: string;
  dart_type: string;
  period: string;
  deadline: string;
  statutory_date: string;
  adjusted_to_next_business_day: boolean;
  due: boolean;
  non_filing_is_signal: boolean;
  summary: { on_time: number; late_candidate: number; not_filed_candidate: number };
  on_time: Array<{
    corp_name: string;
    corp_code: string;
    rcept_no: string;
    rcept_dt: string;
    /** 직전 기간이 미제출인데 이 접수가 있다 — 직전 기간분일 수 있다 */
    ambiguous_assignment?: boolean;
  }>;
  late_candidates: Array<{
    corp_name: string;
    corp_code: string;
    rcept_no: string;
    rcept_dt: string;
    delay_days: number;
    viewer_url: string;
  }>;
  not_filed_candidates: NotFiledRow[];
  out_of_scope: Array<{ corp_name: string; corp_code: string; joined_group_at: string }>;
  representative_filings: Array<{ corp_name: string; corp_code: string; rcept_no: string }>;
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

  // 포털 소속회사 스냅샷은 매년 5월 1일 기준이다. 과거 연도를 점검하면서 최신 스냅샷을 쓰면
  // 그 사이 편입·제외된 회사 때문에 모집단이 통째로 어긋난다 (Codex 7차 치명 4).
  const yearMonth = input.year_month ?? `${input.year}05`;
  const yearMonthDefaulted = !input.year_month;

  const population: Population = await resolvePopulation({
    ...(input.group ? { group: input.group, year_month: yearMonth } : {}),
    ...(input.companies ? { companies: input.companies } : {}),
  });

  if (population.corpCodes.size > SPLIT_ADVICE_COMPANIES) {
    throw new ToolError(
      'range_too_large',
      `대상 회사가 ${population.corpCodes.size}개입니다 — 한 번에 ${SPLIT_ADVICE_COMPANIES}개까지만 ` +
        '처리합니다(회사당 조회가 들어가 60초 벽에 걸립니다). companies 로 나눠 호출하세요.',
      { companies: population.corpCodes.size, max_per_call: SPLIT_ADVICE_COMPANIES },
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

  // 수집 구간.
  // 시작: 전년도 4분기분(기한 2월 말)을 잡으려면 전년도 10월부터.
  // 끝: **오늘까지**. 연말로 자르면 해를 넘겨 늦게 낸 공시를 구조적으로 놓쳐
  //     "제출했는데 미제출"이 된다 (Codex 7차 치명 3).
  const from = `${input.year - 1}1001`;
  const to = today;

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
          // 측정 실패도 불완전이다 — total 이 과소 신고되고 창 예측이 무력해진다
          const d = r.diagnostics as unknown as Record<string, unknown>;
          if (
            r.diagnostics.partial_results ||
            r.diagnostics.truncated ||
            d['total_count_incomplete'] === true ||
            (typeof d['measure_failures'] === 'number' && d['measure_failures'] > 0)
          ) {
            partial = true;
          }
          for (const row of r.rows) {
            // J009 는 조회 유형으로 이미 좁혀졌다 — 보고서명 추정에 기대지 않는다
            const c =
              ty === 'J009'
                ? { kind: 'subcontract' as FormKind, representative: false }
                : classifyReportName(row.report_nm);
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

  // 지연 판정은 **원본 접수분** 기준이다 (정정은 원본을 대체하지 않는다)
  const originals = filings.filter((f) => !f.correction);
  const corrections = filings.filter((f) => f.correction);

  // ★ 1:N 배정 — '연1회공시및1/4분기용' 한 건이 연1회와 1분기 두 의무를 동시에 이행한다.
  const keyOf = (e: CalendarEntry) => `${e.duty}|${e.period}`;
  const matched = new Map<string, ClassifiedFiling[]>();
  const unmatched: ClassifiedFiling[] = [];
  for (const f of originals) {
    let hit = false;
    for (const e of calendar) {
      if (f.kind === 'unknown' || f.kind !== expectedKind(e)) continue;
      const w = assignmentWindow(e);
      if (f.rcept_dt <= w.start || f.rcept_dt > w.end) continue;
      const k = keyOf(e);
      matched.set(k, [...(matched.get(k) ?? []), f]);
      hit = true;
    }
    if (!hit) unmatched.push(f);
  }

  // 같은 duty 안에서 시간순 — "직전/직후 기간"을 찾기 위해
  const byDuty = new Map<string, CalendarEntry[]>();
  for (const e of calendar) {
    byDuty.set(e.duty, [...(byDuty.get(e.duty) ?? []), e]);
  }
  for (const list of byDuty.values()) list.sort((a, b) => (a.deadline < b.deadline ? -1 : 1));

  const reports: DeadlineReport[] = calendar.map((e) => {
    const rows = matched.get(keyOf(e)) ?? [];
    const due = e.deadline <= today;
    // 무조건 의무만 "접수 없음"이 신호가 된다. 하도급은 원사업자·거래 있는 경우만이라
    // 미제출을 신호로 쓰면 대부분이 거짓 경보가 된다.
    const nonFilingIsSignal = e.obligation === 'unconditional';

    const siblings = byDuty.get(e.duty) ?? [];
    const idx = siblings.findIndex((s) => keyOf(s) === keyOf(e));
    const prev = idx > 0 ? siblings[idx - 1] : undefined;
    const prevRows = prev ? (matched.get(keyOf(prev)) ?? []) : [];

    const byCompany = new Map<string, ClassifiedFiling[]>();
    for (const r of rows) byCompany.set(r.corp_code, [...(byCompany.get(r.corp_code) ?? []), r]);
    const prevByCompany = new Set(prevRows.map((r) => r.corp_code));

    const onTime: DeadlineReport['on_time'] = [];
    const late: DeadlineReport['late_candidates'] = [];
    const notFiled: NotFiledRow[] = [];
    const outOfScope: DeadlineReport['out_of_scope'] = [];
    const repFilings: DeadlineReport['representative_filings'] = [];

    for (const [corpCode, corpName] of population.corpCodes) {
      const mine = byCompany.get(corpCode) ?? [];
      for (const f of mine.filter((x) => x.representative)) {
        repFilings.push({ corp_name: corpName, corp_code: corpCode, rcept_no: f.rcept_no });
      }
      // 계열편입일이 기한보다 뒤면 그 기한에는 공시의무 자체가 없었다.
      const joinedAt = population.joinedGroupAt?.get(corpCode);
      if (mine.length === 0 && joinedAt && joinedAt > e.deadline) {
        outOfScope.push({ corp_name: corpName, corp_code: corpCode, joined_group_at: joinedAt });
        continue;
      }
      if (mine.length === 0) {
        if (!due || !nonFilingIsSignal) continue;
        // 직후 기간에 이른 접수가 있으면 이 기간분을 늦게 낸 것일 수 있다.
        // 접수일만으로는 가릴 수 없으므로 단정하지 않고 함께 보여준다.
        // ⚠️ 서식 종류가 같을 때만 의미가 있다. 예컨대 4분기는 '분기별공시' 서식이고
        // 다음 기간인 1분기는 '연1회공시및1/4분기용' 통합 서식이라 종류가 다르다 —
        // 종류가 다르면 "그 기간분을 늦게 낸 것"일 수 없다.
        // (실측에서 이 구분 없이 붙였다가 웅진씽크빅 건에서 오탐 2건이 났다.)
        const next = siblings[idx + 1];
        const nextEarly =
          next && expectedKind(next) === expectedKind(e)
            ? (matched.get(keyOf(next)) ?? [])
                .filter((r) => r.corp_code === corpCode && r.rcept_dt <= next.deadline)
                .sort((a, b) => (a.rcept_dt <= b.rcept_dt ? -1 : 1))[0]
            : undefined;
        notFiled.push({
          corp_name: corpName,
          corp_code: corpCode,
          ...(joinedAt && joinedAt > (e.period_end ?? '') ? { recently_joined: joinedAt } : {}),
          ...(nextEarly
            ? {
                possibly_filed_late: {
                  rcept_no: nextEarly.rcept_no,
                  rcept_dt: nextEarly.rcept_dt,
                  viewer_url: viewerUrl(nextEarly.rcept_no),
                },
              }
            : {}),
        });
        continue;
      }
      // 같은 기한에 여러 건이면 가장 이른 접수를 그 회사의 이행으로 본다
      const earliest = mine.reduce((a, b) => (a.rcept_dt <= b.rcept_dt ? a : b));
      if (earliest.rcept_dt <= e.deadline) {
        // 직전 기간이 미제출인데 이 접수가 있다 — 직전 기간분을 늦게 낸 것일 수 있다.
        // 단 **같은 서식 종류일 때만** 성립한다 (위 nextEarly 와 같은 이유).
        const prevUnfiled =
          !!prev &&
          prev.deadline <= today &&
          expectedKind(prev) === expectedKind(e) &&
          !prevByCompany.has(corpCode);
        onTime.push({
          corp_name: corpName,
          corp_code: corpCode,
          rcept_no: earliest.rcept_no,
          rcept_dt: earliest.rcept_dt,
          ...(prevUnfiled ? { ambiguous_assignment: true } : {}),
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
      ...(due && rows.length === 0 && population.corpCodes.size > 1
        ? { likely_out_of_scope: true }
        : {}),
    };
  });

  const totalLate = reports.reduce((n, r) => n + r.late_candidates.length, 0);
  const totalNotFiled = reports.reduce((n, r) => n + r.not_filed_candidates.length, 0);
  const totalAmbiguous =
    reports.reduce((n, r) => n + r.on_time.filter((o) => o.ambiguous_assignment).length, 0) +
    reports.reduce(
      (n, r) => n + r.not_filed_candidates.filter((o) => o.possibly_filed_late).length,
      0,
    );

  /** 이 도구가 **판정하지 않는** 것들 — 미제출 후보를 확정으로 읽지 않게 하는 목록 */
  const scopeCaveats = [
    '고시 §2① 단서: 직전 사업연도말 자산총액 100억원 미만이면서 청산 절차 진행 중이거나 1년 이상 휴업 중인 회사는 ' +
      '공시대상회사가 아닙니다 — 이 도구는 각 회사의 자산·청산·휴업 상태를 조회하지 않습니다.',
    `모집단은 기업집단포털 ${yearMonth} 스냅샷입니다. 포털은 매년 5월 1일 기준 연 1회 갱신이라 ` +
      '그 뒤 편입·제외된 회사는 반영되지 않고, **분기별 소속 상태는 판정하지 않습니다**.',
    '대표회사 제출은 개별회사의 일반적 공시의무를 **대체하지 않습니다** — 고시 §3⑤가 대표회사 책임으로 정한 것은 ' +
      '계열회사 제외 내역, 자산 100억원 미만 청산·휴업 회사 정보, 순환출자 현황 등 특정 항목뿐이고, ' +
      '개별회사는 §3①에 따라 자기회사 사항을 각자 공시합니다 ' +
      '(실측: 상장 계열사가 대표회사 공시와 별도로 개별회사 서식을 직접 제출합니다).',
    '접수분의 **내용**(기재 누락·오기·항목 정확성)은 보지 않습니다 — 그건 원문이 필요합니다. ' +
      'J004 내용 점검은 check_j004_consistency 입니다.',
    '어느 기간분인지는 **접수일 창**으로 추정합니다. 접수일만으로는 아주 늦은 제출과 다음 기간의 이른 제출을 ' +
      '가릴 수 없어, 의심되는 자리에 ambiguous_assignment·possibly_filed_late 를 답니다.',
  ];
  if (input.companies) {
    scopeCaveats.unshift(
      'companies 로 직접 지정한 경우 **그 회사가 공시대상기업집단 소속인지 검증하지 않습니다** — ' +
        '비소속 회사를 넣으면 그대로 미제출 후보가 됩니다. 계열편입일도 알 수 없어 편입 전 기간을 걸러내지 못합니다. ' +
        'group 으로 호출하면 둘 다 반영됩니다.',
    );
  }

  const notes: string[] = [
    '지연·미제출은 모두 **"후보"**입니다 — 확정이 아닙니다. 각 건을 DART 원문(viewer_url)으로 확인한 뒤 판단하세요.',
    '이 도구가 판정하는 것은 **기한과 접수 여부**뿐입니다. 기한이 달력으로 고정돼 있어 원문 없이 계산되지만, ' +
      '내용의 정확성·대상회사 해당 여부는 보지 않습니다 (scope_caveats 참조).',
    '판정 기준: 원본 접수분(정정 제외)의 접수일 vs 법정 기한(마지막 날이 비영업일이면 다음 최초 영업일). ' +
      'DART 목록은 정정 이전 원본을 포함하도록 강제 조회합니다(last_reprt_at=N).',
    "★ '연1회공시및1/4분기용' 서식 1건은 **연1회 의무와 1분기 의무를 동시에 이행**합니다 — " +
      '한 접수분이 두 기한 모두에 이행으로 잡히는 것이 정상입니다.',
  ];

  if (totalNotFiled > 0) {
    notes.push(
      `⚠️ 미제출 후보 ${totalNotFiled}건 — 기업집단현황공시는 공시대상회사면 무조건 하는 의무라 ` +
        '접수분이 없으면 신호입니다. 다만 **확정 전에 scope_caveats 를 반드시 읽으세요** — ' +
        '이 도구가 판정하지 않는 항목이 여럿 있고, 그중 어느 하나만 걸려도 미제출이 아닙니다.',
    );
  }
  if (totalAmbiguous > 0) {
    notes.push(
      `⚠️ 기간 배정이 모호한 자리가 ${totalAmbiguous}건 있습니다 (ambiguous_assignment / possibly_filed_late). ` +
        '접수일만으로는 "직전 기간분을 늦게 낸 것"과 "이번 기간분을 일찍 낸 것"을 가릴 수 없습니다 — ' +
        '해당 접수번호를 read_disclosure 로 열어 대상 기간을 확인하세요.',
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
  if (yearMonthDefaulted && input.group) {
    notes.push(
      `ℹ️ 기업집단포털 기준월을 ${yearMonth}(점검 연도의 5월)로 자동 설정했습니다 — ` +
        '포털 스냅샷이 매년 5월 1일 기준이기 때문입니다. 다른 시점의 소속회사로 보려면 year_month 를 지정하세요.',
    );
  }
  if (input.group && !population.joinedGroupAt) {
    notes.push(
      'ℹ️ 계열편입일 정보를 얻지 못해 "편입 전이라 의무 없음" 판정을 하지 못했습니다 — ' +
        '미제출 후보에 편입 전 기간이 섞여 있을 수 있습니다.',
    );
  }
  if (input.companies) {
    notes.push(
      'ℹ️ companies 경로에서는 계열편입일을 알 수 없어 "편입 전이라 의무 없음" 판정을 하지 않습니다.',
    );
  }
  if (unmatched.length > 0) {
    notes.push(
      `⚠️ 어느 기한에도 배정하지 못한 접수분이 ${unmatched.length}건 있습니다 (unmatched_filings) — ` +
        '이 도구가 모르는 서식명이거나 배정 창을 크게 벗어난 접수입니다. 직접 확인하세요.',
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
    notes.push(
      '⚠️ 목록 수집이 불완전합니다 (측정 실패·절단·부분결과) — 이 결과로 "누락 없음"을 결론내지 마세요.',
    );
  }
  if (reports.some((r) => !r.due)) {
    notes.push(
      `ℹ️ 아직 기한이 오지 않은 항목(due:false)은 미제출 판정을 하지 않습니다 — 오늘(${today}) 기준입니다.`,
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
      portal_year_month: yearMonth,
      /** 모집단이 실제로 그 집단 소속임을 확인했는가 — companies 경로는 확인하지 않는다 */
      scope_verified: !input.companies,
    },
    summary: {
      deadlines_checked: reports.filter((r) => r.due).length,
      deadlines_not_due: reports.filter((r) => !r.due).length,
      filings_found: filings.length,
      corrections_excluded: corrections.length,
      late_candidates: totalLate,
      not_filed_candidates: totalNotFiled,
      ambiguous_assignments: totalAmbiguous,
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
        /** 각 회사가 실제로 공시대상회사인지 판정하지 않는다 */
        obligation_eligibility: true,
        other_duty_types: ['J001', 'J005', 'J008'],
      },
    },
    scope_caveats: scopeCaveats,
    notes,
    diagnostics: {
      list_calls: listCalls,
      partial_results: partial,
      unmatched: unmatched.length,
      split_advice_companies: SPLIT_ADVICE_COMPANIES,
      split_advice_note:
        '회사 수 상한은 60초 안전 보장값이 아니라 권고선입니다 — 실제 호출 수는 ' +
        '선택 duty 수 × (측정 1 + 수집 1) 이고 재시도·페이지 수·네트워크 지연이 더해집니다.',
    },
  };
}
