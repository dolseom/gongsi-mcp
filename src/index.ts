#!/usr/bin/env node
/**
 * gongsi-mcp — 공정거래위원회 기업집단 공시 특화 MCP 서버
 *
 * ⚠️ stdout 은 MCP 프로토콜 전용이다. 어떤 로그도 stdout 으로 내보내지 않는다.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadDotEnv, getConfig, unknownEnvVars, VERSION } from './lib/config.js';
import { getLogger } from './lib/logger.js';
import { ToolError, toErrorResponse } from './lib/errors.js';
import { serializeToolResult } from './lib/tool-output.js';
import { SERVER_INSTRUCTIONS } from './server-instructions.js';
import {
  checkDisclosureDuty,
  checkDisclosureDutyInput,
} from './tools/check-disclosure-duty.js';
import { resolveEntity, resolveEntityInput } from './tools/resolve-entity.js';
import { readDisclosure, readDisclosureInput } from './tools/read-disclosure.js';
import { searchDisclosures, searchDisclosuresInput } from './tools/search-disclosures.js';
import { findPrecedents, findPrecedentsInput } from './tools/find-precedents.js';
import { getGroupStructure, getGroupStructureInput } from './tools/get-group-structure.js';
import { getFinancials, getFinancialsInput } from './tools/get-financials.js';
import { searchFtcQna, searchFtcQnaInput } from './tools/search-ftc-qna.js';
import {
  auditGroupDisclosures,
  auditGroupDisclosuresInput,
} from './tools/audit-group-disclosures.js';
import {
  auditPeriodicDisclosures,
  auditPeriodicDisclosuresInput,
  SPLIT_ADVICE_COMPANIES,
} from './tools/audit-periodic-disclosures.js';
import {
  assessCorrectionRisk,
  assessCorrectionRiskInput,
} from './tools/assess-correction-risk.js';
import {
  checkJ004Consistency,
  checkJ004ConsistencyInput,
} from './tools/check-j004-consistency.js';
import {
  detectUndisclosedTransactionsInput,
  TIME_BUDGET_MS,
  MAX_COMPANIES_TO_SEARCH,
} from './tools/detect-undisclosed-transactions.js';
import { detectReview } from './tools/detect-review.js';
import {
  readDetectionResult,
  readDetectionResultInput,
  MAX_READ_CHARS,
} from './tools/read-detection-result.js';
import { calcBusinessDays, calcBusinessDaysInput } from './tools/calc-business-days.js';
import {
  disclosureCalendar,
  disclosureCalendarInput,
} from './tools/disclosure-calendar.js';
import { serverInfo, serverInfoInput } from './tools/server-info.js';
import { SNAPSHOT_TTL_MS } from './lib/detection-results.js';
import { CAP_100, 억 } from './rules/thresholds.js';

loadDotEnv();
const log = getLogger('server');

/**
 * detect 도구 설명에 쓸 시간 예산 "초" 표기.
 * `GONGSI_TIME_BUDGET_MS` 로 예산을 낮췄으면 **설명도 낮춘 값을 말해야 한다** — 설명은
 * 50초라는데 실제로 8초에 멈추면 부분 결과의 이유를 모델도 사용자도 재현하지 못한다.
 */
function detectBudgetSeconds(): string {
  const ms = getConfig().detectTimeBudgetMs ?? TIME_BUDGET_MS;
  const s = ms / 1000;
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
}

const server = new McpServer(
  { name: 'gongsi-mcp', version: VERSION },
  { instructions: SERVER_INSTRUCTIONS },
);

/** MCP SDK 가 도구 콜백에 넘기는 요청 맥락 중 우리가 쓰는 부분 */
interface ToolCallContext {
  /** 클라이언트가 `notifications/cancelled` 를 보내면 abort 된다 */
  signal?: AbortSignal;
}

/**
 * 도구 핸들러 공통 래퍼.
 * **도구는 예외를 밖으로 던지지 않는다** — 규격 에러 응답으로 바꿔 돌려준다.
 */
function wrap<T>(name: string, fn: (input: T) => unknown | Promise<unknown>) {
  // 두 번째 인자(의존성 주입 등)를 받는 도구에 요청 맥락을 실수로 넘기지 않는다 — 입력만 전달한다
  return wrapWithContext<T>(name, (input) => fn(input));
}

/**
 * 요청 맥락(취소 신호)이 필요한 도구용 래퍼 — 지금은 detect 어댑터만 쓴다.
 * ★ 2026-09-13 live 실측: 취소된 탐지가 끝까지 돌아 snapshot 을 저장하고 앞 result_id 를 회수시켰다.
 */
function wrapWithContext<T>(
  name: string,
  fn: (input: T, ctx: ToolCallContext) => unknown | Promise<unknown>,
) {
  return async (input: T, extra?: ToolCallContext) => {
    try {
      const result = await fn(input, extra?.signal ? { signal: extra.signal } : {});
      // 직렬화는 **한 함수**로만 한다 — 어댑터·상세 읽기 도구가 재는 바이트와 실제 전송
      // 문자열이 달라지면 크기 예산이 무의미해진다 (src/lib/tool-output.ts).
      return { content: [{ type: 'text' as const, text: serializeToolResult(result) }] };
    } catch (err) {
      // 도메인 에러(회사 없음·한도 도달 등)는 예상된 흐름이다 — 스택 없이 짧게 남긴다.
      // 스택트레이스는 진짜 예상 밖 예외에만 쓴다.
      if (err instanceof ToolError) {
        log.warn(`${name}: ${err.code}`, err.message);
      } else {
        log.error(`${name} 실패`, err instanceof Error ? err.stack : String(err));
      }
      return {
        content: [{ type: 'text' as const, text: serializeToolResult(toErrorResponse(err)) }],
        isError: true,
      };
    }
  };
}

server.registerTool(
  'check_disclosure_duty',
  {
    title: '공시의무 진단·기한 계산',
    description:
      '공정거래법상 공시의무 대상 여부를 판정하고 공시기한·지연 시 예상 과태료를 계산합니다. ' +
      '외부 API를 쓰지 않으므로 인증키 없이 동작합니다.\n\n' +
      '판정 결과에는 항상 근거 조문과 계산식이 포함됩니다. ' +
      '자본총계·자본금이 없으면 추정하지 않고 insufficient_data 를 반환하므로, ' +
      '그때는 get_financials 로 재무수치를 먼저 조회하세요.\n\n' +
      '⚠️ 거래금액 산정 방식(amountBasis)에 주의하세요 — 담보제공은 담보한도액, ' +
      '부동산임대차는 연간임대료+보증금환산액, 보험은 보험료총액, 상품·용역은 분기 합계액입니다. ' +
      '틀리면 판정이 뒤집힙니다.\n\n' +
      '- 약관 금융거래(omnibus_financial): 이사회 의결 생략은 금융·보험회사가 자기 일상적 금융·보험업무로 하는 약관거래뿐입니다 ' +
      '(고시 제9조제1항). isFinancialCompany·routineFinancialBusiness 를 모르면 도구가 경로별 조건부 결과(omnibus.scenarios)를 줍니다 — ' +
      '"의결 불요"로 단정해 전달하지 마세요.\n' +
      '- 국외 계열회사 직접 거래·장내시장 주식거래·부수적 거래·공익법인의 소속회사 주식 거래는 해당 입력을 주면 판정에 반영됩니다.\n' +
      '- 날짜 없이 "N일 늦었다"만 알면 delayDays(+delayDayBasis·delayFilingState)로 조건부 과태료(delayScenario)를 받습니다.\n' +
      '- 결과의 `review`(conclusion·assumptions·evidence·unresolved·next_actions) 순서대로 전달하고, 원본 근거' +
      '(threshold·deadline·penalty·notes·disclaimer)는 지우지 마세요. 다음 행동은 next_actions 범위 안에서만 씁니다.\n' +
      '- missing_inputs 의 purpose 가 duty(대상 판정용)·deadline(기한 계산용)으로 갈립니다 — "대상이야?"에 이사회 의결일을 캐묻지 마세요.\n' +
      '- 기한을 계산하지 못한 결과에는 지연일수·과태료가 없습니다 — "기한 내"도 "지연"도 아닙니다.',
    inputSchema: checkDisclosureDutyInput.shape,
  },
  wrap('check_disclosure_duty', checkDisclosureDuty),
);

server.registerTool(
  'calc_business_days',
  {
    title: '영업일·공휴일·기한 날짜 계산',
    description:
      '한국 영업일·공휴일 기준 날짜 계산 (키 불요). 영업일 여부·공휴일 명칭·기한 조정·N영업일/N달력일 기한· ' +
      '남은 영업일 세기를 돌려줍니다.\n\n' +
      '⚠️ 공휴일은 법령 개정으로 바뀝니다 — 2027년부터 노동절(5/1) 공휴일 신설로 2027-05-03(월)이 ' +
      '대체공휴일입니다. **모델의 자체 달력 지식은 최신 개정을 모릅니다 — 기한·영업일·공휴일이 걸린 ' +
      '날짜 질문에는 반드시 이 도구를 호출하세요.**\n\n' +
      '- 건너뛴 비영업일 목록(날짜·요일·공휴일 명칭)과 근거 조문이 동봉됩니다\n' +
      '- 근로자의 날(5/1)은 관공서 공휴일이 아니어서 민법 기간계산과 고시 영업일 계산이 갈립니다 ' +
      '(2027년부터 차이 소멸)\n' +
      '- 공휴일 데이터가 없거나 미검증인 연도는 warnings 로 알립니다',
    inputSchema: calcBusinessDaysInput.shape,
  },
  wrap('calc_business_days', calcBusinessDays),
);

server.registerTool(
  'disclosure_calendar',
  {
    title: '정기공시 연간 캘린더',
    description:
      '"올해 언제 무엇을 공시해야 하나"에 답합니다 (키 불요). 기한이 달력으로 고정된 정기 공시의 ' +
      '마감일을 전부 계산해 D-day 와 함께 시간순으로 돌려줍니다.\n\n' +
      '- 담는 것: 기업집단현황 연1회(5/31)·분기(분기 종료 후 2개월), 약관 금융거래 분기(분기 종료 후 익월 10영업일), ' +
      '상품·용역 20% 이상 감소(분기 종료 후 45일), 비상장 주요주주 지분변동 분기, 하도급대금 결제조건 반기(45일)\n' +
      '- 마지막 날이 비영업일이면 다음 최초 영업일로 조정된 **실제 기한**을 줍니다 (대체공휴일 반영)\n' +
      '- 각 항목에 그날 무엇을 쓰는지(items)와 **항목별 기준일·기준기간**이 붙습니다 — ' +
      '분기 공시는 "공시기한일의 직전 분기" 기준이라 가장 자주 틀리는 지점입니다\n' +
      '- 같은 날 겹치는 기한(collisions)도 알려줍니다\n\n' +
      '⚠️ **캘린더에 없다고 공시할 것이 없다는 뜻이 아닙니다.** 대규모내부거래 개별거래와 ' +
      '비상장회사 중요사항(사유 발생 후 7영업일)은 사유 발생형이라 달력에 올릴 수 없습니다 — ' +
      'not_in_calendar 를 반드시 함께 전달하세요.',
    inputSchema: disclosureCalendarInput.shape,
  },
  wrap('disclosure_calendar', disclosureCalendar),
);

server.registerTool(
  'resolve_entity',
  {
    title: '회사·기업집단 식별',
    description:
      '회사명·종목코드·법인코드·법인등록번호·기업집단명을 받아 corp_code·stock_code·법인등록번호· ' +
      '소속 기업집단으로 풀어줍니다.\n\n' +
      '- 동명 법인이 여럿이면 임의로 고르지 않고 status="ambiguous" 와 후보 목록을 돌려줍니다 ' +
      '(상호가 같아도 별개 법인일 수 있음) — 후보의 corp_code 로 다시 호출하세요\n' +
      '- includeGroup=true 는 **EGROUP_API_KEY 필요**. 최초 1회는 전 기업집단을 순회해 ' +
      '포털 호출 ~103회를 소비합니다 (이후 1년간 캐시)',
    inputSchema: resolveEntityInput.shape,
  },
  wrap('resolve_entity', resolveEntity),
);

server.registerTool(
  'read_disclosure',
  {
    title: '공시 원문 읽기',
    description:
      '접수번호(rcept_no)로 공시 원문을 표 구조를 보존한 마크다운으로 돌려줍니다.\n\n' +
      '- 표가 그대로 마크다운 표로 나오므로 항목별 기재 내용을 바로 비교할 수 있습니다\n' +
      '- board_date(이사회 의결일)를 원문에서 추출해 함께 줍니다\n' +
      '- HWP 첨부만 있는 공시는 body_unparsable 에러와 함께 뷰어 URL 을 안내합니다',
    inputSchema: readDisclosureInput.shape,
  },
  wrap('read_disclosure', readDisclosure),
);

server.registerTool(
  'search_disclosures',
  {
    title: '공시 검색',
    description:
      '공시를 검색합니다. 공정위 기업집단 공시 프리셋 6종(preset)이 내장되어 있습니다.\n\n' +
      '- mode:"page"(기본) = 한 페이지씩 조회. mode:"batch" = 기간 전체 전수 수집 (중복 제거·건수 집계 포함)\n' +
      '- 범위가 크면 range_too_large 와 분할 구간을 안내합니다 — 안내된 구간대로 나눠 다시 호출하세요\n' +
      '- diagnostics 의 truncated/partial_results 가 true 면 결과가 불완전한 것입니다\n' +
      '- 정정 이전 원본 접수분을 포함합니다 (last_report_only 기본 false — 지연 판정에 필수)',
    inputSchema: searchDisclosuresInput.shape,
  },
  wrap('search_disclosures', searchDisclosures),
);

server.registerTool(
  'find_precedents',
  {
    title: '타사 선례·문안 참고',
    description:
      '"다른 회사는 이 항목을 어떻게 썼나"에 답합니다. 보고서명 키워드로 같은 유형의 최근 공시를 찾아 ' +
      '회사당 1건씩 골라 원문(표 구조 보존 마크다운)을 함께 돌려줍니다. 기본 범위는 대규모내부거래(J001)입니다.\n\n' +
      '- **정정이 반영된 최종본 기준입니다** (문안 참고 목적이라 지연 판정과 반대)\n' +
      '- coverage 에 실제로 훑은 구간이 나옵니다 — 0건은 "그런 공시가 없다"가 아닙니다',
    inputSchema: findPrecedentsInput.shape,
  },
  wrap('find_precedents', findPrecedents),
);

server.registerTool(
  'get_group_structure',
  {
    title: '기업집단 구조 조회',
    description:
      '공정위 지정 기업집단의 개요(동일인·대표회사·소속회사 수)와 소속회사 전수를 돌려줍니다. ' +
      '소속회사 목록이 곧 공정위 공시의무의 모집단입니다. **EGROUP_API_KEY 필요.**\n\n' +
      '- DART corp_code 조인은 법인등록번호 기준입니다 — 이름 매칭은 포털과 DART 의 표기 체계가 달라 불가능합니다\n' +
      '- 포털 데이터는 연 1회(매년 5/1) 갱신되며 연단위로 캐시됩니다\n' +
      '- 집단명은 공정위 표기를 씁니다: "SK" 가 아니라 "에스케이"',
    inputSchema: getGroupStructureInput.shape,
  },
  wrap('get_group_structure', getGroupStructure),
);

server.registerTool(
  'get_financials',
  {
    title: '재무제표 조회',
    description:
      '단일회사 재무제표를 조회합니다 (기본: 직전 연도 사업보고서의 재무상태표).\n\n' +
      '- key_metrics 의 total_equity(자본총계)·paid_in_capital(자본금)은 기준금액 산정의 ' +
      'totalEquity/paidInCapital 입력으로 그대로 쓸 수 있습니다 (단위: 원)\n' +
      '- 금액은 raw/value(원 단위)/display 세 값을 함께 줍니다\n' +
      '- change 는 전기 대비 증감입니다 (손익·현금흐름은 누적 필드가 있을 때만 누적 기준)\n' +
      '- 외부감사 대상이 아닌 회사는 DART 에 재무제표가 없을 수 있습니다 — 집단 소속사면 포털 재무가 대안입니다',
    inputSchema: getFinancialsInput.shape,
  },
  wrap('get_financials', getFinancials),
);

server.registerTool(
  'search_ftc_qna',
  {
    title: '공정위 공식 문답 + 매뉴얼 본문 검색',
    description:
      '공정위가 배포한 해설서·FAQ·매뉴얼에서 추출한 공식 질의응답 430건 ' +
      '(2026. 4. 27. 공시 업무 매뉴얼 주요 사례 79건 포함)과 **2026. 4. 27. 공시 업무 매뉴얼 4종 본문** ' +
      '(대규모내부거래·비상장사 중요사항·기업집단 현황공시 소속회사용/동일인용)을 함께 검색합니다 (키 불요). ' +
      '규칙만으로 판정할 수 없는 경계사례에 공식 근거를 대는 용도입니다.\n\n' +
      '- 문답은 results, 매뉴얼 본문 구절은 manualPassages(문서명·쪽·소제목·본문)로 돌려줍니다. ' +
      '문답에 없는 규칙(대상에서 빠지는 거래·서식 작성 주체·공시 중복 시 갈음·제출 시각 등)은 매뉴얼 본문에만 있습니다\n' +
      '- 검색어는 핵심 명사 위주가 잘 맞습니다. category 로 공시유형을 좁힐 수 있습니다\n' +
      '- 매뉴얼 본문은 현행 원문이라 옛 문답과 다르면 매뉴얼이 우선합니다\n' +
      '- ⚠️ 구판 문서(2008~2015)에는 **폐지된 기준(50억·기한 1일 등)**이 실려 있습니다 — 각 결과의 caveats 를 ' +
      '반드시 함께 읽고, 같은 주제의 2026 매뉴얼 문답(lit26-*)이 있으면 그쪽을 우선하세요',
    inputSchema: searchFtcQnaInput.shape,
  },
  wrap('search_ftc_qna', searchFtcQna),
);

server.registerTool(
  'audit_group_disclosures',
  {
    title: '대규모내부거래 기한 감사',
    description:
      '기업집단(또는 회사 목록)의 대규모내부거래(J001) 공시를 기간 단위로 감사해 기한 지연 후보를 찾습니다. ' +
      '원본 접수분의 접수일과 원문에서 추출한 이사회 의결일을 대조합니다 (상장 3영업일 / 비상장 7영업일).\n\n' +
      '- 지연 후보에는 지연일수·예상 과태료·자진시정 골든타임 상태·근거가 동봉됩니다 (확정이 아닌 후보)\n' +
      '- 약관 금융거래 특례 서식(의결일 없음)은 별도 분류로 나옵니다\n' +
      '- 정정 제출분은 빼고 원본 접수분만 봅니다 (지연 판정의 성립 조건)\n' +
      '- 범위가 크면 range_too_large 와 분할 구간을 안내합니다\n' +
      '- 집단 감사는 **EGROUP_API_KEY 필요**. coverage 의 미조인 회사는 감사에서 빠진 것입니다\n\n' +
      '⚠️ **이 감사는 "미공시"를 탐지하지 못합니다.** DART 접수분만 조회하므로 아예 공시하지 않은 거래는 ' +
      '기록 자체가 없습니다. 판정 범위도 J001 중 **트랙 A(의결형)** 뿐입니다. ' +
      '**"지연 후보 0건" ≠ "공시의무 이행에 문제 없음"** — coverage.undetectable·coverage.not_judged 를 ' +
      '함께 전달하세요.\n' +
      '시행령 별표9 **기본금액**: 미공시는 의결 있음 5,000만원 / 의결 없음 7,000만원, 기한초과는 500만원 + 1일 10만원 ' +
      '(어느 쪽도 최종 부과액이 아닙니다).',
    inputSchema: auditGroupDisclosuresInput.shape,
  },
  wrap('audit_group_disclosures', auditGroupDisclosures),
);

server.registerTool(
  'audit_periodic_disclosures',
  {
    title: '정기공시 이행 점검 (제출 여부·지연·미제출)',
    description:
      '기업집단현황(J004)·하도급대금 결제조건(J009)의 **정기 공시를 실제로 냈는지, 기한을 지켰는지** ' +
      '회사별로 점검합니다. 기한이 달력으로 고정돼 목록의 접수일만으로 판정하므로 원문이 필요 없고, ' +
      '**기한이 지났는데 접수분이 없으면 그 자체가 미제출 신호**입니다. 다만 **내용의 정확성은 보지 않습니다.**\n\n' +
      '- 기한별로 on_time / late_candidates / not_filed_candidates 를 회사 단위로 돌려줍니다\n' +
      '- 기한이 아직 오지 않은 항목(due:false)은 미제출 판정을 하지 않습니다\n' +
      '- 하도급대금(J009)은 원사업자·거래가 있을 때만의 의무라 **미제출을 신호로 쓰지 않습니다** ' +
      '(non_filing_is_signal:false)\n' +
      `- 집단 점검은 **EGROUP_API_KEY 필요**. 회사당 1회 조회라 한 번에 **${SPLIT_ADVICE_COMPANIES}개사**까지입니다\n` +
      "- '연1회공시및1/4분기용' 서식 1건은 연1회와 1분기 의무를 **동시에 이행**합니다\n" +
      '- 기간 배정은 접수일 창 추정이라 모호한 자리에는 ambiguous_assignment·possibly_filed_late 가 붙습니다\n' +
      '- 대표회사 제출은 개별회사 의무를 대체하지 않습니다 (고시 제3조제5항 항목만 대표회사 책임)\n\n' +
      '⚠️ 미제출 후보는 확정이 아닙니다 — 고시 제2조제1항 단서(자산 100억원 미만 + 청산·휴업)로 공시대상회사가 ' +
      '아닐 수 있고, 포털 스냅샷이 연 1회라 분기별 소속 상태를 판정하지 못합니다. 판정 밖의 것은 ' +
      '**scope_caveats** 에 전부 나열됩니다.',
    inputSchema: auditPeriodicDisclosuresInput.shape,
  },
  wrap('audit_periodic_disclosures', auditPeriodicDisclosures),
);

server.registerTool(
  'assess_correction_risk',
  {
    title: '정정공시 리스크 진단',
    description:
      '"정정하면 과태료 나온다"는 속설을 과태료 고시 원문으로 진단합니다 (키 불요). 정정 자체는 ' +
      '위반행위가 아니고(고시 Ⅱ 위반 열거에 없음), 문제는 원 공시의 상태(누락·거짓·지연)입니다.\n\n' +
      '- errorType 별로 원 공시의 위반 성립 여부, 면제 경로, 권고를 근거 조문과 함께 돌려줍니다\n' +
      '- originalDeadline 을 주면 골든타임(기한 만료 후 **10영업일**) 상태를 계산합니다\n' +
      '- 누락·거짓 정정은 별표 9 **보완 칸**(과태료 처분 사전통지서 발송일 전날까지 보완)을 조건부로 안내합니다 — ' +
      '원 공시가 기한 내였는지(originalFiledOnTime)·§26 계열은 의결을 거쳤는지(boardResolution)가 칸을 가릅니다. ' +
      '경과일이 길면 가산 한도에 닿아 보완 전과 금액이 같아질 수 있으니 "정정하면 감액"으로 단정하지 마세요\n' +
      '- 보완 사건에 공시지연 일수 감경(75/50/30/20%)을 적용하는지는 원문 미확인이라 시나리오로만 줍니다\n' +
      '- 거래 내용 자체가 변경된 경우(transaction_changed)는 정정이 아니라 새 공시의무입니다 — 재의결·재공시 경로를 안내합니다\n' +
      '- 면제·감경은 모두 공정위 재량이라 확정이 아닌 판단 재료입니다',
    inputSchema: assessCorrectionRiskInput.shape,
  },
  wrap('assess_correction_risk', assessCorrectionRisk),
);

server.registerTool(
  'check_j004_consistency',
  {
    title: '기업집단현황공시(J004) 정합성 자가점검',
    description:
      '기업집단현황공시(J004) 원문에서 기계적으로 재검산 가능한 항목을 전부 다시 계산해 불일치를 찾습니다.\n' +
      '- ⚠️ **이미 DART 에 접수된 공시의 접수번호(rcept_no)** 로만 점검합니다 — 아직 제출하지 않은 ' +
      '초안 파일(엑셀·HWP 등)은 읽지 못합니다. 제출본을 점검해 정정할 곳을 찾는 용도입니다\n\n' +
      '- 재무현황: 유동+비유동=총계(자산·부채), 자산=부채+자본 항등식, 부채비율 재계산, 금융/비금융 소계·합계 재합산\n' +
      '- 차이가 약 1,000배면 단위(원/천원/백만원) 오기 힌트를 답니다\n' +
      '- **문서 내적 정합성만** 봅니다 — 원천 회계 데이터와의 일치(진실성)는 판정하지 않습니다\n' +
      '- 재무표를 찾지 못하면 "정합"이 아니라 not_checkable 을 돌려줍니다',
    inputSchema: checkJ004ConsistencyInput.shape,
  },
  wrap('check_j004_consistency', checkJ004Consistency),
);

server.registerTool(
  'detect_undisclosed_transactions',
  {
    title: '미공시 내부거래 교차탐지 (J004↔J001)',
    description:
      '기업집단현황공시(J004) 대표회사 연1회 서식의 **실제 거래내역**을 대규모내부거래(J001) 공시와 ' +
      '대조해 "거래는 했는데 공시가 없는" **미공시 후보**를 찾습니다. 후보는 확정이 아닙니다.\n' +
      '- ★ **응답은 요약입니다.** 상세(22만자~1MB)는 `detail_access.result_id` 로 `read_detection_result` 에서 ' +
      '이어 읽습니다. `required_warnings`·`summary_incomplete`·`details_required` 는 **그대로 전달**하고, ' +
      '**읽지 않은 상세를 "확인했다"고 말하지 마세요**\n' +
      '- ★ **`action_items_preview` 부터 읽으세요** — 조치가 필요한 판정을 배열을 가로질러 모은 목록입니다. ' +
      '매입회사 자본 기준 후보(`perspective:"거래상대방"`)는 "기준 미달" 배열 안에 묻혀 있습니다. ' +
      '⚠️ 이 목록이 비어도 "이상 없음"이 아닙니다 — 판정 못 한 범위는 not_judged·coverage 에 있습니다\n' +
      '- 자금 차입은 건별 차입일 −90~+30일 근접 대조(가장 강한 신호). 기준금액은 같은 문서 자본으로 계산한 ' +
      `**근사치**이고 ${CAP_100 / 억}억원 이상만 확실합니다\n` +
      '- 상품·용역은 상대방 지분 요건(법 제26조제1항제4호)을 확인할 수 없어 전부 **candidate_if_counterparty_qualified**(조건부), ' +
      '유가증권 총액만 있는 건은 **candidate_aggregate_only**(확인 대상)입니다\n' +
      '- **"공시 존재"는 공시 원문의 거래상대방까지 일치할 때만** 냅니다. 같은 유형 공시가 있어도 원문 상대방이 ' +
      '다르거나 원문을 못 열면 **not_judged** — "공시 있음"도 "공시 없음"도 아닙니다. ' +
      'matching_filings_not_examined_total 은 열어 보지 않은 수입니다\n' +
      '- 조인 실패·예산 초과·수집 불완전은 **not_judged** — "후보 아님"이 아니라 확인하지 못한 것\n' +
      `- 약 60초 끊김을 피해 **${detectBudgetSeconds()}초 안에 스스로 멈추고** 부분 결과를 냅니다. ` +
      '★ `continuation.complete` 가 false 면 **같은 인자에 `continuation_token` 을 넣어 complete:true 까지 다시 호출**하고, ' +
      `**마지막 호출의 결과만** 최종으로 제시하세요 (호출당 ${MAX_COMPANIES_TO_SEARCH}개사). ` +
      '`continuation.stalled` 면 남은 회사를 개별 조회하세요\n\n' +
      '⚠️ 한도성 의결·약관 금융거래 특례·보고서명 분류 오차로 실제로는 공시된 거래일 수 있고, 금액·거래기간까지 ' +
      '대조한 것은 아닙니다 — **scope_caveats** 참조. 미공시 과태료 기본금액 5,000만~7,000만원은 지연보다 무거워 ' +
      '오판의 대가가 큽니다.',
    inputSchema: detectUndisclosedTransactionsInput.shape,
  },
  // ★ MCP 등록은 **요약 어댑터**를 통한다 (엔진 함수는 그대로 — 직접 호출 테스트·내부 소비자
  //   는 종전 전체 출력을 받는다). 완전한 결과는 실물에서 222,709자~1MB라 그대로 내보내면
  //   호스트가 전달하지 못해 판정이 하나도 도달하지 않는다.
  wrapWithContext('detect_undisclosed_transactions', detectReview),
);

server.registerTool(
  'read_detection_result',
  {
    title: '탐지 결과 상세 이어 읽기',
    description:
      'detect_undisclosed_transactions 요약이 준 result_id 로 **판정 근거·caveat 전문**을 읽습니다 ' +
      '(키 불요, 탐지 엔진을 다시 돌리지 않습니다).\n\n' +
      '- `section` 에 요약의 available_sections 중 하나를 넣으세요 (예: goods_services_signals · coverage · ' +
      'scope_caveats · notes · action_items). 생략하면 결과 전체를 읽습니다\n' +
      `- 한 번에 최대 ${MAX_READ_CHARS}자이고 응답 크기 예산에 맞춰 더 짧게 올 수도 있습니다. ` +
      '`next_offset` 을 그대로 다시 넣으면 이어집니다 — 조각을 순서대로 이어붙이면 **원본과 정확히 ' +
      '같습니다**. 중간 조각은 그 자체로 유효한 JSON 이 아닙니다\n' +
      '- `offset`·`total_chars` 는 **UTF-16 코드 단위**입니다 (바이트가 아닙니다 — 한글 1자 = 1 단위)\n' +
      `- ⚠️ 상세는 **서버 프로세스 메모리에만 ${SNAPSHOT_TTL_MS / 60_000}분** 보관됩니다. 만료·회수·서버 재시작 뒤에는 ` +
      'result_unavailable 로 거절하고 다시 탐지해야 합니다 — 다른 결과를 대신 돌려주지 않습니다\n' +
      '- ⚠️ **읽지 않은 상세를 "확인했다"고 말하지 마세요.** 요약의 details_required 는 아직 안 읽은 ' +
      '근거가 있다는 뜻입니다',
    inputSchema: readDetectionResultInput.shape,
  },
  wrap('read_detection_result', readDetectionResult),
);

server.registerTool(
  'server_info',
  {
    title: '서버 상태·설정 진단',
    description:
      '서버 버전, 인증키 설정 여부(값은 노출하지 않음), 오늘 사용한 API 호출 수와 잔여 예산, ' +
      '캐시 규모(법인 인덱스·원문 캐시), 공휴일 데이터 검증 연도, Q&A 지식베이스 건수를 돌려줍니다 ' +
      '(로컬 조회, 키·API 호출 불요).\n\n' +
      '"키를 넣었는데 인식이 안 된다", "한도가 얼마 남았냐", "공휴일 데이터가 몇 년도까지 있냐" ' +
      '같은 질문의 진단 창구입니다.',
    inputSchema: serverInfoInput.shape,
  },
  wrap('server_info', serverInfo),
);

async function main(): Promise<void> {
  const cfg = getConfig();

  // 참고 MCP는 config와 코드의 변수명이 달라 설정 3개가 조용히 무시되고 있었다.
  const unknown = unknownEnvVars();
  if (unknown.length) {
    log.warn('인식하지 못한 환경변수가 있습니다 (오타를 확인하세요)', unknown);
  }
  if (!cfg.dartApiKey) {
    log.warn('DART_API_KEY 미설정 — 공시 조회 도구는 동작하지 않습니다 (룰 엔진 도구는 정상)');
  }
  if (!cfg.egroupApiKey) {
    log.warn('EGROUP_API_KEY 미설정 — 기업집단포털 도구는 동작하지 않습니다');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('gongsi-mcp 서버 시작 (stdio)');
}

main().catch((err) => {
  log.error('서버 기동 실패', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
