/**
 * `audit_group_disclosures` — 대규모내부거래(J001) 기한 감사 (킬러 #2)
 *
 * "우리 집단(회사)이 낸 공시 중 기한을 넘긴 게 있나?"에 근거를 동봉해 답한다.
 * 리서치 실측: 위반의 94~95%가 '기한' 유형이고, 공정위가 밝힌 원인은 "신규 담당자 업무 미숙" —
 * 이 도구는 위반 통보가 아니라 **자진시정 골든타임 안에 잡는 구조**다.
 *
 * 파이프라인:
 *  ① 모집단 확정 — 기업집단(포털 연단위 캐시) 또는 회사 목록 → corp_code 집합
 *  ② 목록 수집 — 계열사별 N회 검색이 아니라 **전체시장 J001 검색 후 corp_code 필터**
 *     (J001은 연 ~1,555건 규모라 시장 전체가 계열사별 순회보다 압도적으로 싸다.
 *      단일 회사는 corp_code 지정 검색 — 장기 구간도 허용된다)
 *  ③ 원본 판정 — 정정분(report_nm '정정')은 판정에서 제외하고 원본 접수분만 본다.
 *     last_reprt_at=N 전수라 정정으로 대체된 원본도 남아 있다 (함정 -1번 — 이게 판정의 성립 조건)
 *  ④ 원문에서 이사회 의결일 추출(영구 캐시) → 상장 3/비상장 7영업일 기한 → 지연 후보 판정
 *  ⑤ 지연 후보에는 예상 과태료 + 자진시정 골든타임 상태를 동봉
 *
 * 60초 벽: 원문 다운로드가 지배 비용(~1.5초/건)이다. 미캐시 문서 수로 사전 예측해
 * 초과 예상이면 range_too_large + 접수일 분포 기반 분할 안내를 반환한다.
 * 캐시는 영구라 재감사는 훨씬 싸다.
 */

import { z } from 'zod';
import { DartClient, viewerUrl, type Disclosure } from '../clients/dart.js';
import { collectAdaptive, type BatchResult } from '../search/batch.js';
import { loadDocument, isDocumentCached, type DocMeta } from './read-disclosure.js';
import { getGroupStructure } from './get-group-structure.js';
import { getStore } from '../lib/store.js';
import { getLogger } from '../lib/logger.js';
import {
  AmbiguousCorpError,
  CorpNotFoundError,
  RangeTooLargeError,
  ToolError,
} from '../lib/errors.js';
import { litDeadline, evaluateCompliance } from '../rules/deadlines.js';
import { selfCorrectionWindow } from '../rules/self-correction.js';
import { estimatePenalty } from '../rules/penalties.js';
import type { PenaltyResult } from '../rules/types.js';
import { toYMD, isValidYMD } from '../rules/business-days.js';

const log = getLogger('audit');

/** 트랙 B — 약관에 의한 금융거래 특례 서식. 이사회 의결일이 없는 게 정상이다 (고시 §9) */
const TRACK_B_ACODES = new Set(['80701', '80751', '80752', '80754']);

/** 원문 다운로드 1건당 예상 소요 (다운로드+ZIP+파싱) */
const SECONDS_PER_DOC = 1.5;
/** 도구 전체 시간 상한 — 클라이언트 60초 벽 대비 여유 */
const MAX_TOOL_SECONDS = 45;
/** 목록 수집 몫을 제외하고 문서 다운로드에 쓸 수 있는 시간 */
const DOC_PHASE_BUDGET_SECONDS = 35;

export const auditGroupDisclosuresInput = z.object({
  group: z
    .string()
    .optional()
    .describe('기업집단명("삼성") 또는 집단코드("K1000032"). companies 와 둘 중 하나 필수'),
  companies: z
    .array(z.string())
    .min(1)
    .max(50)
    .optional()
    .describe('회사 목록 — 회사명 또는 corp_code(8자리). 집단 전체 대신 특정 회사만 감사할 때'),
  from: z
    .string()
    .regex(/^\d{8}$/, 'YYYYMMDD')
    .refine(isValidYMD, '실존하지 않는 날짜입니다')
    .describe('감사 기간 시작일 (접수일 기준)'),
  to: z
    .string()
    .regex(/^\d{8}$/, 'YYYYMMDD')
    .refine(isValidYMD, '실존하지 않는 날짜입니다')
    .describe('감사 기간 종료일'),
  today: z
    .string()
    .regex(/^\d{8}$/, 'YYYYMMDD')
    .refine(isValidYMD, '실존하지 않는 날짜입니다')
    .optional()
    .describe('판정 기준일 (기본: 오늘). 자진시정 골든타임 계산에 쓴다'),
  year_month: z
    .string()
    .regex(/^\d{6}$/)
    .optional()
    .describe('집단 소속회사 기준 공개년월 (기본: 최신 지정연도)'),
});

export type AuditGroupDisclosuresInput = z.infer<typeof auditGroupDisclosuresInput>;

interface LateCandidate {
  corp_name: string;
  corp_code: string;
  rcept_no: string;
  report_nm: string;
  acode: string | null;
  board_date: string;
  listing: 'listed' | 'unlisted';
  deadline: string;
  rcept_dt: string;
  delay_days: number;
  penalty_estimate: PenaltyResult;
  self_correction: { status: string; window_end: string; business_days_remaining?: number };
  viewer_url: string;
}

interface SkippedRow {
  corp_name: string;
  rcept_no: string;
  report_nm: string;
  rcept_dt: string;
  reason: string;
  viewer_url: string;
  /** board_date_missing 행의 미추출 원인 (구버전 캐시 메타에는 없다) */
  board_date_status?: string;
}

/** 테스트에서 실제 API 없이 판정 로직을 검증하기 위한 주입점 */
export interface AuditDeps {
  collectList: (corpCode: string | undefined, from: string, to: string) => Promise<BatchResult>;
  loadDoc: (rceptNo: string) => Promise<{ meta: DocMeta }>;
  isCached: (rceptNo: string) => boolean;
}

function realDeps(client: DartClient): AuditDeps {
  return {
    collectList: (corpCode, from, to) =>
      collectAdaptive(client, { pblntfDetailTy: 'J001', corpCode }, from, to),
    loadDoc: (rceptNo) => loadDocument(rceptNo, client),
    isCached: (rceptNo) => isDocumentCached(rceptNo),
  };
}

/** 모집단 — 감사 대상 회사들 */
interface Population {
  corpCodes: Map<string, string>; // corp_code → 표시 이름
  group: Record<string, unknown> | null;
  unjoined: string[]; // 집단 소속인데 corp_code 미조인이라 감사에서 빠진 회사
  codeValidationSkipped?: boolean; // 법인코드 인덱스가 비어 있어 corp_code 존재 검증을 못 한 경우
}

async function resolvePopulation(input: AuditGroupDisclosuresInput): Promise<Population> {
  const store = getStore();

  if (input.group) {
    const gs = (await getGroupStructure({
      group: input.group,
      join_dart: true,
      ...(input.year_month ? { year_month: input.year_month } : {}),
    })) as Record<string, unknown>;
    const affiliates = gs['affiliates'] as Array<Record<string, unknown>>;
    const corpCodes = new Map<string, string>();
    const unjoined: string[] = [];
    for (const a of affiliates) {
      const code = a['corp_code'];
      if (typeof code === 'string') corpCodes.set(code, String(a['name']));
      else unjoined.push(String(a['name']));
    }
    if (corpCodes.size === 0) {
      throw new ToolError(
        'corp_not_found',
        `'${input.group}' 소속회사 중 DART corp_code 가 조인된 회사가 없습니다. ` +
          `resolve_entity(fetchJurirNo=true) 로 주요 회사를 먼저 조회해 법인등록번호 캐시를 채우세요.`,
        { affiliates_total: affiliates.length },
      );
    }
    return { corpCodes, group: gs['group'] as Record<string, unknown>, unjoined };
  }

  // companies 경로
  const corpCodes = new Map<string, string>();
  // 인덱스가 비어 있으면(신규 설치 직후 등) 존재 검증이 불가능하다 — 막지 말고 아래에서 notes 로 알린다
  const canValidateCodes = store.corpCount() > 0;
  let codeValidationSkipped = false;
  for (const q of input.companies!) {
    const t = q.trim();
    if (/^\d{8}$/.test(t)) {
      const rec = store.getCorpByCode(t);
      if (!rec) {
        // 이름 경로는 CorpNotFoundError 를 던지는데 코드 경로만 무검증이었다 (P2-마 20) —
        // 오타 코드가 모집단에 들어가면 "감사 완료, 지연 0건"이라는 거짓 안심으로 귀결된다.
        if (canValidateCodes) {
          throw new ToolError(
            'corp_not_found',
            `corp_code '${t}' 가 DART 법인코드 목록(${store.corpCount().toLocaleString()}건)에 없습니다. ` +
              '오타이거나 폐지된 코드일 수 있습니다 — 회사명으로 다시 지정하거나 resolve_entity 로 확인하세요.',
            { corp_code: t },
          );
        }
        codeValidationSkipped = true;
      }
      corpCodes.set(t, rec?.corpName ?? t);
      continue;
    }
    const matches = store.findCorpsByName(t);
    if (matches.length === 0) {
      throw new CorpNotFoundError(
        t,
        store.searchCorpsByName(t, 5).map((c) => ({ corpCode: c.corpCode, corpName: c.corpName })),
      );
    }
    if (matches.length > 1) {
      throw new AmbiguousCorpError(
        t,
        matches.map((m) => ({ corp_code: m.corpCode, corp_name: m.corpName, jurir_no: m.jurirNo })),
      );
    }
    corpCodes.set(matches[0]!.corpCode, matches[0]!.corpName);
  }
  return { corpCodes, group: null, unjoined: [], codeValidationSkipped };
}

/**
 * 접수일 분포 기반 분할 제안 — 미캐시 문서가 청크당 예산에 들어가도록 실제 날짜로 자른다.
 * (균등 날짜 분할은 시즌 집중 때문에 금지 — batch.ts 와 같은 원칙)
 */
export function suggestDocSplits(
  dates: string[], // 미캐시 문서들의 rcept_dt (정렬 무관)
  from: string,
  to: string,
  docsPerCall: number,
): Array<{ from: string; to: string }> {
  const sorted = [...dates].sort();
  const splits: Array<{ from: string; to: string }> = [];
  let start = from;
  let count = 0;
  let lastDate = from;
  for (const d of sorted) {
    if (count >= docsPerCall && d !== lastDate) {
      splits.push({ from: start, to: lastDate });
      start = d < to ? d : to;
      count = 0;
    }
    count++;
    lastDate = d;
  }
  splits.push({ from: start, to });
  return splits;
}

export async function auditGroupDisclosures(
  input: AuditGroupDisclosuresInput,
  depsOverride?: AuditDeps,
): Promise<unknown> {
  if (!input.group && !input.companies) {
    throw new ToolError('invalid_argument', 'group 또는 companies 중 하나는 필수입니다.');
  }
  if (input.group && input.companies) {
    throw new ToolError('invalid_argument', 'group 과 companies 는 동시에 쓸 수 없습니다.');
  }
  if (input.from > input.to) {
    throw new ToolError('invalid_argument', 'from 이 to 보다 늦습니다.');
  }

  const today = input.today ?? toYMD(new Date());
  const startedAt = Date.now();

  const population = await resolvePopulation(input);
  const deps = depsOverride ?? realDeps(new DartClient());

  // ── 목록 수집 ──
  // 단일 회사는 corp_code 지정(장기 구간 허용), 여럿이면 전체시장 J001 후 필터.
  const single = population.corpCodes.size === 1;
  const singleCode = single ? [...population.corpCodes.keys()][0] : undefined;
  const batch = await deps.collectList(singleCode, input.from, input.to);

  const rows = single
    ? batch.rows
    : batch.rows.filter((r) => population.corpCodes.has(r.corp_code));

  // ── 원본/정정 분리 — 판정은 원본 접수분에만 한다 ──
  const originals: Disclosure[] = [];
  let correctionsSkipped = 0;
  for (const r of rows) {
    if (r.report_nm.includes('정정')) correctionsSkipped++;
    else originals.push(r);
  }

  // ── 60초 벽 사전 예측 (문서 다운로드 단계) ──
  const uncached = originals.filter((r) => !deps.isCached(r.rcept_no));
  const elapsed = (Date.now() - startedAt) / 1000;
  const docSeconds = uncached.length * SECONDS_PER_DOC;
  if (elapsed + docSeconds > MAX_TOOL_SECONDS) {
    const docsPerCall = Math.max(5, Math.floor(DOC_PHASE_BUDGET_SECONDS / SECONDS_PER_DOC));
    throw new RangeTooLargeError(
      `원문 ${uncached.length}건 다운로드 (${population.corpCodes.size}개사, ${input.from}~${input.to})`,
      Math.round(elapsed + docSeconds),
      suggestDocSplits(uncached.map((r) => r.rcept_dt), input.from, input.to, docsPerCall),
    );
  }

  // ── 원문에서 의결일 추출 + 판정 ──
  const lateCandidates: LateCandidate[] = [];
  const trackB: SkippedRow[] = [];
  const boardDateMissing: SkippedRow[] = [];
  const unparsable: SkippedRow[] = [];
  let boardDateInvalid = 0;
  let onTime = 0;
  let docDownloads = 0;
  let docCacheHits = 0;
  let docErrors = 0;

  let next = 0;
  const list = originals;
  async function worker(): Promise<void> {
    while (next < list.length) {
      const r = list[next++]!;
      let meta: DocMeta;
      try {
        const wasCached = deps.isCached(r.rcept_no);
        const loaded = await deps.loadDoc(r.rcept_no);
        meta = loaded.meta;
        if (wasCached) docCacheHits++;
        else docDownloads++;
      } catch (err) {
        docErrors++;
        unparsable.push({
          corp_name: r.corp_name,
          rcept_no: r.rcept_no,
          report_nm: r.report_nm,
          rcept_dt: r.rcept_dt,
          reason: `원문 로드 실패: ${err instanceof Error ? err.message : String(err)}`,
          viewer_url: viewerUrl(r.rcept_no),
        });
        continue;
      }

      if (!meta.bodyParsable) {
        unparsable.push({
          corp_name: r.corp_name,
          rcept_no: r.rcept_no,
          report_nm: r.report_nm,
          rcept_dt: r.rcept_dt,
          reason: '원문에 파싱 가능한 텍스트가 없음 (HWP 첨부 등)',
          viewer_url: viewerUrl(r.rcept_no),
        });
        continue;
      }
      if (meta.acode && TRACK_B_ACODES.has(meta.acode)) {
        trackB.push({
          corp_name: r.corp_name,
          rcept_no: r.rcept_no,
          report_nm: r.report_nm,
          rcept_dt: r.rcept_dt,
          reason: `약관에 의한 금융거래 특례 서식(ACODE ${meta.acode}) — 이사회 의결 불요, 분기 종료 후 익월 10영업일 기한 (별도 판정 필요)`,
          viewer_url: viewerUrl(r.rcept_no),
        });
        continue;
      }
      if (!meta.boardDate) {
        // 미추출 원인을 성질별로 구분한다 (Codex 7차 치명 3) — 특히 invalid_date(실존하지 않는
        // 날짜 기재)는 원문 오기·거짓기재 신호인데 정당한 "-" 와 같은 바구니에 넣으면 안 된다.
        // 구버전 캐시 메타는 boardDateStatus 가 없다 — 그 경우 종전 문구를 유지한다.
        const REASON_BY_STATUS: Record<string, string> = {
          invalid_date:
            '⚠️ 원문에 실존하지 않는 날짜가 이사회 의결일로 기재됨 (예: "2026.2.31") — 원문 오기 또는 ' +
            '거짓기재 신호입니다. 지연 여부를 판정할 수 없으므로 반드시 원문을 확인하세요',
          value_empty:
            '원문 의결일 값이 "-" — 기공시 재약정·변경공시의 정당한 무기재일 수 있습니다',
          label_missing:
            '서식에 이사회 의결일 항목이 없음 — 서식 분류를 확인하세요 (트랙 B 는 위에서 분리됩니다)',
          unparsed:
            '의결일 항목은 있으나 날짜 추출 실패 (표기 변형 가능) — read_disclosure 로 원문을 확인하세요',
        };
        if (meta.boardDateStatus === 'invalid_date') boardDateInvalid++;
        boardDateMissing.push({
          corp_name: r.corp_name,
          rcept_no: r.rcept_no,
          report_nm: r.report_nm,
          rcept_dt: r.rcept_dt,
          ...(meta.boardDateStatus ? { board_date_status: meta.boardDateStatus } : {}),
          reason:
            (meta.boardDateStatus && REASON_BY_STATUS[meta.boardDateStatus]) ??
            '이사회 의결일 미추출 — 기공시 재약정·변경공시의 정당한 "-" 이거나 표기 변형입니다. read_disclosure 로 원문을 확인하세요',
          viewer_url: viewerUrl(r.rcept_no),
        });
        continue;
      }

      // corp_cls: Y(유가)·K(코스닥)·N(코넥스) = 주권상장법인 / E(기타) = 비상장
      const listing: 'listed' | 'unlisted' = r.corp_cls === 'E' ? 'unlisted' : 'listed';
      const deadline = litDeadline(meta.boardDate, listing);
      const c = evaluateCompliance(deadline.deadline, r.rcept_dt);
      if (c.onTime) {
        onTime++;
        continue;
      }
      const w = selfCorrectionWindow(deadline.deadline, 'art26_29', today);
      lateCandidates.push({
        corp_name: r.corp_name,
        corp_code: r.corp_code,
        rcept_no: r.rcept_no,
        report_nm: r.report_nm,
        acode: meta.acode,
        board_date: meta.boardDate,
        listing,
        deadline: deadline.deadline,
        rcept_dt: r.rcept_dt,
        delay_days: c.delayDays,
        penalty_estimate: estimatePenalty({
          regime: 'art26_29',
          boardResolution: true,
          disclosed: true,
          onTime: false,
          delayDays: c.delayDays,
        }),
        self_correction: {
          status: w.status,
          window_end: w.windowEnd,
          ...(w.businessDaysRemaining !== undefined
            ? { business_days_remaining: w.businessDaysRemaining, is_last_day: w.isLastDay }
            : {}),
        },
        viewer_url: viewerUrl(r.rcept_no),
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, () => worker()));

  lateCandidates.sort((a, b) => b.delay_days - a.delay_days);

  const notes: string[] = [
    '지연 "후보"입니다 — 확정이 아닙니다. 원문 의결일이 최초 의결일이 아닐 수 있고(재약정·변경), ' +
      '개별 사정(수탁기관 보정요청 등)이 있을 수 있습니다. 각 건을 read_disclosure 로 확인한 뒤 판단하세요.',
    '판정 기준: 원본 접수분(정정 제외)의 접수일 vs 원문 이사회 의결일 + 상장(유가·코스닥·코넥스) 3영업일 / 비상장 7영업일.',
  ];
  if (lateCandidates.some((l) => l.penalty_estimate.isUpperBound)) {
    // 목록 단계에서는 거래금액을 알 수 없어 거래금액별 적용비율(고시 Ⅵ.2)을 적용할 수 없다.
    // 중첩된 penalty_estimate.caveats 만으로는 놓치기 쉬우므로 상위 notes 로 올린다.
    notes.push(
      '⚠️ 예상 과태료는 **상한선**입니다 (penalty_estimate.isUpperBound=true). 이 감사는 거래금액을 추출하지 않아 ' +
        '거래금액별 적용비율(고시 Ⅵ.2)을 적용할 수 없습니다 — 거래금액이 100억원 미만이면 실제 금액은 ' +
        '90~50%로 내려가며 20억원 미만이면 절반입니다. 해당 건의 거래금액을 확인해 ' +
        'check_disclosure_duty(amount=거래금액) 로 다시 산정하세요.',
    );
  }
  if (lateCandidates.some((l) => l.self_correction.status === 'open')) {
    notes.push(
      '⚠️ 자진시정 10영업일 기간이 아직 열려 있는 건이 있습니다. 단, 지연 공시 자체는 면제 대상이 아닙니다 — ' +
        '면제는 위반공시사항을 **시정하여 다시 공시**하고 고시 Ⅴ의 사유(신규 지정·편입 30일 내, 사소한 부주의 등)가 ' +
        '함께 성립할 때만 검토됩니다(공정위 재량). 지연일수 감경(3일 이하 75% 등)은 별개로 적용됩니다.',
    );
  }
  if (population.unjoined.length > 0) {
    notes.push(
      `⚠️ 집단 소속 ${population.unjoined.length}개사는 DART corp_code 미조인이라 이번 감사에서 실제로 빠졌습니다 (coverage 참조). ` +
        '포털과 DART 는 이름 표기가 달라 이름으로는 잡을 수 없습니다 — resolve_entity(fetchJurirNo=true) 로 ' +
        '해당 회사들을 조회해 법인등록번호 캐시를 채운 뒤 재감사하세요.',
    );
  }
  if (batch.diagnostics.partial_results || batch.diagnostics.truncated) {
    notes.push('⚠️ 목록 수집이 불완전합니다 (diagnostics.list 참조) — 이 결과로 "누락 없음"을 결론내지 마세요.');
  }
  if (boardDateInvalid > 0) {
    notes.push(
      `⚠️ 원문에 **실존하지 않는 날짜**가 의결일로 기재된 공시가 ${boardDateInvalid}건 있습니다 ` +
        '(board_date_missing 중 board_date_status:"invalid_date") — 원문 오기 또는 거짓기재 신호입니다. ' +
        '해당 건은 지연 판정이 불가능하므로 반드시 원문을 직접 확인하세요.',
    );
  }
  if (population.codeValidationSkipped) {
    notes.push(
      '⚠️ 법인코드 인덱스가 비어 있어 corp_code 존재 검증을 건너뛰었습니다 — 코드에 오타가 있으면 ' +
        '해당 회사의 공시가 0건으로 잡혀 "지연 없음"처럼 보일 수 있습니다. resolve_entity 로 코드를 확인하세요.',
    );
  }
  if (originals.length === 0) {
    // 판정 대상 0건 = "적법 확인"이 아니다 (P2-마 20) — 기간·모집단 오설정과 구분할 수 없다
    notes.push(
      'ℹ️ 이 기간·모집단에서 판정 대상 공시가 0건입니다. "지연 후보 0건"은 공시가 없었다는 뜻이지 ' +
        '적법을 확인했다는 뜻이 아닙니다 — 기간(from/to)과 대상 회사가 의도한 범위인지, ' +
        '목록 수집이 완전한지(diagnostics.list)를 함께 확인하세요.',
    );
  }

  log.info('감사 완료', {
    companies: population.corpCodes.size,
    scanned: originals.length,
    late: lateCandidates.length,
    docDownloads,
  });

  return {
    scope: {
      ...(population.group ? { group: population.group } : {}),
      companies_audited: population.corpCodes.size,
      period: { from: input.from, to: input.to },
      judged_at: today,
      preset: 'internal_transaction (J001)',
    },
    summary: {
      disclosures_scanned: originals.length,
      on_time: onTime,
      late_candidates: lateCandidates.length,
      omnibus_track_b: trackB.length,
      board_date_missing: boardDateMissing.length,
      ...(boardDateInvalid > 0 ? { board_date_invalid: boardDateInvalid } : {}),
      unparsable: unparsable.length,
      corrections_excluded: correctionsSkipped,
    },
    late_candidates: lateCandidates,
    omnibus_track_b: trackB,
    board_date_missing: boardDateMissing,
    ...(unparsable.length ? { unparsable } : {}),
    coverage: {
      companies_with_corp_code: population.corpCodes.size,
      companies_unjoined: population.unjoined,
    },
    notes,
    diagnostics: {
      list: batch.diagnostics,
      doc_downloads: docDownloads,
      doc_cache_hits: docCacheHits,
      doc_errors: docErrors,
    },
  };
}
