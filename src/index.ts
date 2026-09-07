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
  detectUndisclosedTransactions,
  detectUndisclosedTransactionsInput,
  TIME_BUDGET_MS,
} from './tools/detect-undisclosed-transactions.js';
import { calcBusinessDays, calcBusinessDaysInput } from './tools/calc-business-days.js';
import {
  disclosureCalendar,
  disclosureCalendarInput,
} from './tools/disclosure-calendar.js';
import { serverInfo, serverInfoInput } from './tools/server-info.js';

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

/**
 * 서버 수준 안내문 (initialize 응답의 instructions).
 *
 * 도구 설명마다 흩어져 있던 ① 다른 도구로 보내는 라우팅 문장 ② "…를 사용자에게 전달하세요"
 * 반복 ③ 인증키 문장을 여기 한 곳으로 모은다. 도구 설명에는 그 도구 고유의 일·입력·출력 어휘·
 * 법령 수치만 남긴다 (tools/list 페이로드는 도구 수만큼 곱해지지만 이 안내문은 1회다).
 */
const INSTRUCTIONS = `공정거래위원회 기업집단 공시(J공시) 실무 도구입니다. 답변에는 도구가 준 근거 조문·계산식을 함께 제시하세요.

[질문 → 도구]
- 공시 대상인가 / 기한 언제까지 / 지연 과태료 얼마 → check_disclosure_duty
- 그날이 영업일인가, 공휴일 언제, N영업일 뒤는 며칠 → calc_business_days
- 올해 정기공시를 언제 무엇을 내야 하나 → disclosure_calendar
- 회사·기업집단 특정(사명·종목코드·법인코드·법인등록번호·집단명) → resolve_entity
- 공시 원문 읽기 → read_disclosure / 공시 찾기·기간 전수 수집 → search_disclosures
- 다른 회사는 이 항목을 어떻게 썼나(문안 참고) → find_precedents
- 집단 소속회사 전수·계열 재무 → get_group_structure / 단일회사 재무제표 → get_financials
- 규칙만으로 안 풀리는 경계사례에 공정위 공식 답변 → search_ftc_qna
- 정정하면 과태료가 나오나 → assess_correction_risk
- J004 제출 전후 수치 자가점검(항등식·소계·단위) → check_j004_consistency
- 키가 인식되나 / 호출 한도·캐시·공휴일 데이터 범위 → server_info
- 점검 3종은 보는 것이 다릅니다:
  audit_group_disclosures = J001 접수분의 의결일↔접수일 기한 지연 (접수된 것만 봄)
  audit_periodic_disclosures = J004·J009 정기공시를 냈는지·기한을 지켰는지 (미제출도 탐지)
  detect_undisclosed_transactions = J004 거래내역↔J001 대조로 미공시 후보 (미공시를 보는 유일한 경로)

[결과 전달 규칙]
- caveats·scope_caveats·coverage·not_judged·warnings·diagnostics·isUpperBound 는 요약하지 말고 그대로 전달하세요.
- "0건"·"후보 없음"을 "문제 없음"·"이행 완료"로 바꾸지 마세요. 도구가 보지 못한 범위는 도구가 스스로 밝힙니다.
- 후보(candidate)는 확정이 아닙니다. 단정 표현 금지.
- 날짜·영업일·공휴일은 모델이 직접 계산하지 말고 calc_business_days 결과만 쓰세요.
- 법령 수치·조문은 도구 출력만 인용하고 기억으로 보충하지 마세요.

[자주 틀리는 전제]
- 대규모내부거래 기준금액 = min(100억원, max(5억원, max(자본총계, 자본금) × 5%)). 널리 퍼진 "50억"은 폐지된 옛 기준입니다.
- 공시기한 = 상장 3영업일 / 비상장·공익법인 7영업일(의결일 다음 날 기산). "1일 이내"는 오정보입니다.
- 지연 판정은 정정 이전 원본 접수분 기준입니다. 최종본만 보면 지연이 사라집니다.
- 기업집단포털 소속회사·재무는 매년 5월 1일 기준 연 1회 스냅샷입니다.`;

const server = new McpServer(
  { name: 'gongsi-mcp', version: VERSION },
  { instructions: INSTRUCTIONS },
);

/**
 * 도구 핸들러 공통 래퍼.
 * **도구는 예외를 밖으로 던지지 않는다** — 규격 에러 응답으로 바꿔 돌려준다.
 */
function wrap<T>(name: string, fn: (input: T) => unknown | Promise<unknown>) {
  return async (input: T) => {
    try {
      const result = await fn(input);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      // 도메인 에러(회사 없음·한도 도달 등)는 예상된 흐름이다 — 스택 없이 짧게 남긴다.
      // 스택트레이스는 진짜 예상 밖 예외에만 쓴다.
      if (err instanceof ToolError) {
        log.warn(`${name}: ${err.code}`, err.message);
      } else {
        log.error(`${name} 실패`, err instanceof Error ? err.stack : String(err));
      }
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(toErrorResponse(err), null, 2) },
        ],
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
      '틀리면 판정이 뒤집힙니다.',
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
    title: '공정위 공식 Q&A 검색',
    description:
      '공정위가 배포한 해설서·FAQ·매뉴얼에서 추출한 공식 질의응답 430건 ' +
      '(2026. 4. 27. 공시 업무 매뉴얼 주요 사례 79건 포함)을 검색합니다 (키 불요). ' +
      '규칙만으로 판정할 수 없는 경계사례에 공식 답변을 근거로 대는 용도입니다.\n\n' +
      '- 검색어는 핵심 명사 위주가 잘 맞습니다. category 로 공시유형을 좁힐 수 있습니다\n' +
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
      '- 집단 점검은 **EGROUP_API_KEY 필요**. 회사당 1회 조회라 한 번에 **80개사**까지입니다\n' +
      "- '연1회공시및1/4분기용' 서식 1건은 연1회와 1분기 의무를 **동시에 이행**합니다\n" +
      '- 기간 배정은 접수일 창 추정이라 모호한 자리에는 ambiguous_assignment·possibly_filed_late 가 붙습니다\n' +
      '- 대표회사 제출은 개별회사 의무를 대체하지 않습니다 (고시 §3⑤ 항목만 대표회사 책임)\n\n' +
      '⚠️ 미제출 후보는 확정이 아닙니다 — 고시 §2① 단서(자산 100억원 미만 + 청산·휴업)로 공시대상회사가 ' +
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
      '- originalDeadline 을 주면 골든타임(기한 만료 후 **10영업일**) 상태와 지연 감경 축소 일정(**75%→50%→30%→20%**)을 계산합니다\n' +
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
      '기업집단현황공시(J004) 원문에서 기계적으로 재검산 가능한 항목을 전부 다시 계산해 불일치를 찾습니다 ' +
      '(제출 전 자가점검 또는 제출본 사후 점검).\n\n' +
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
      '대조해 "거래는 했는데 공시가 없는" **미공시 후보**를 찾습니다.\n' +
      '- **자금 차입 = 건별 차입일 근접 대조**(가장 강한 신호). 차입일 −90~+30일에 같은 유형 공시가 있으면 ' +
      'j001_filing_near_date, 검색창 안 어딘가에만 있으면 j001_filing_in_window_only(한도 의결 커버일 수도, ' +
      '**부분 공시 누락**일 수도 있음), 없으면 미공시 후보. 기준금액은 같은 문서의 자본으로 계산한 ' +
      '**근사치**이고, 거래금액 100억원 이상만 자본과 무관하게 확실합니다\n' +
      '- **상품·용역**은 연간 합계뿐이라 (판매회사, 거래상대방) 연간 합산 ≥ **4×기준금액**일 때만 ' +
      '(어느 분기 하나는 반드시 기준 이상) 신호로 씁니다. 의무 자체가 상대방이 총수일가 20% 이상 ' +
      '출자 계열사 등일 때만 성립하는데(법 §26①4호) 지분 확인이 불가능해 전부 ' +
      '**candidate_if_counterparty_qualified**(조건부 후보)입니다\n' +
      '- 개별 건이 기준 미달이어도 같은 상대방 연간 합산이 기준 이상이면 "기준 미달"로 단정하지 ' +
      '않습니다 (고시 §4③ 동일 거래상대방·동일 거래대상)\n' +
      '- **유가증권**은 매트릭스 표의 상대방별 연간 총액뿐이라 개별 거래로 분해되지 않습니다 — 총액이 ' +
      '기준 이상인데 공시가 없으면 **candidate_aggregate_only**(후보가 아니라 확인 대상). 총액이 기준 ' +
      '미만이면 개별 거래도 전부 미만이라 이 방향만 확실합니다\n' +
      '- 차입은 **대여회사 쪽 의무**(lender_side)도 각자 자본으로 따로 판정하고, 상품·용역은 (6)에 없는 ' +
      '쌍을 총괄표 (5)로 보완합니다(4×에 못 미치면 candidate_aggregate_only)\n' +
      '- 조인 실패·검색 예산 초과·수집 불완전 건은 **not_judged** — "후보 아님"이 아니라 확인하지 못한 것\n' +
      '- 미조인 계열사는 실행 중에 **법인등록번호를 자동으로 채워 조인**합니다(포털 jurirno ↔ DART ' +
      '기업개황이 **정확히 1건 일치**할 때만 확정 — 이름 유사도로 고르지 않습니다). 결과는 캐시에 ' +
      '남아 다음 실행부터는 조회 없이 조인되고, 조회 예산을 넘긴 회사는 다시 실행하면 이어서 ' +
      '채웁니다 — 결과·미조인 사유는 diagnostics.population.warming\n' +
      '- **"공시 존재"는 공시 원문의 거래상대방까지 이 거래 상대방과 일치할 때만** 냅니다 ' +
      '(counterparty_confirmed_by_document, 근거는 matching_filings 의 doc_counterparties). 같은 유형 ' +
      '공시가 창 안에 있어도 원문 상대방이 다르거나 원문을 못 열면 후보가 아니라 **not_judged** ' +
      '(type_filing_present_counterparty_unconfirmed) — 표기 차이일 수 있어 "공시 없음"으로도 ' +
      '내리지 않습니다. 원문은 **확인되는 즉시 멈추고** 열므로 matching_filings 는 근거 1건이고 ' +
      'matching_filings_total 이 창 안의 총수, matching_filings_not_examined_total 은 ' +
      '**열어 보지 않은** 수(상대방이 다르다는 뜻이 아닙니다)입니다. 원문 내려받기 예산을 넘긴 건은 ' +
      '캐시가 남아 **같은 문서로 한 번 더 실행하면 이어서 대조**됩니다\n' +
      `- MCP 클라이언트가 약 60초에 호출을 끊으므로 이 도구는 **${detectBudgetSeconds()}초 안에 스스로 멈추고 그때까지의 ` +
      '판정을 부분 결과로** 냅니다. 잘렸으면 summary.time_budget_truncated · ' +
      'coverage.not_examined_due_to_time_budget · scope_caveats 맨 앞 · diagnostics.budget 에 ' +
      '드러납니다 — **못 본 범위는 "후보 없음"이 아니라 not_judged(time_budget_exceeded)** 입니다. ' +
      '다시 실행하면 원문·법인등록번호·법인 인덱스 캐시 덕에 더 멀리 가지만, **J001 공시 목록은 ' +
      '캐시하지 않아** 검색은 매번 처음부터 합니다\n\n' +
      '⚠️ 한도성 이사회 의결, 계열 금융회사 약관특례(트랙 B), 보고서명 유형 분류 오차로 실제로는 공시된 ' +
      '거래일 수 있습니다. near_date/in_window_only 는 상대방까지 대조한 것이고 **금액·거래기간까지 ' +
      '대조한 것은 아닙니다** — **scope_caveats** 참조. 미공시 과태료 기본금액 ' +
      '5,000만~7,000만원은 지연보다 무거워 오판의 대가가 큽니다.',
    inputSchema: detectUndisclosedTransactionsInput.shape,
  },
  wrap('detect_undisclosed_transactions', detectUndisclosedTransactions),
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
