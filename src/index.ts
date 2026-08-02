#!/usr/bin/env node
/**
 * dart-ftc-mcp — 공정거래위원회 기업집단 공시 특화 MCP 서버
 *
 * ⚠️ stdout 은 MCP 프로토콜 전용이다. 어떤 로그도 stdout 으로 내보내지 않는다.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadDotEnv, getConfig, unknownEnvVars } from './lib/config.js';
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
  assessCorrectionRisk,
  assessCorrectionRiskInput,
} from './tools/assess-correction-risk.js';
import {
  checkJ004Consistency,
  checkJ004ConsistencyInput,
} from './tools/check-j004-consistency.js';

loadDotEnv();
const log = getLogger('server');

const server = new McpServer({ name: 'dart-ftc-mcp', version: '0.1.0' });

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
  'resolve_entity',
  {
    title: '회사·기업집단 식별',
    description:
      '회사명, 종목코드(6자리), 법인코드(8자리), 법인등록번호(13자리), 기업집단명을 받아 ' +
      'corp_code·stock_code·법인등록번호·소속 기업집단으로 풀어줍니다. ' +
      '다른 도구를 쓰기 전 회사를 특정할 때 먼저 호출하세요.\n\n' +
      '동명 법인이 여럿이면 임의로 고르지 않고 status="ambiguous" 와 후보 목록을 돌려줍니다 — ' +
      '상호가 같아도 별개 법인일 수 있습니다(합병 전후 법인이 대표적). ' +
      '이때는 후보의 corp_code 로 다시 호출하세요.\n\n' +
      '기업집단포털과 대사하려면 fetchJurirNo=true 로 법인등록번호를 먼저 채워야 합니다 (DART 호출 1회). ' +
      'includeGroup=true 는 EGROUP_API_KEY 가 필요하며, 최초 1회는 전 기업집단을 순회하므로 ' +
      '포털 호출 ~103회를 소비합니다 (이후 1년간 캐시).',
    inputSchema: resolveEntityInput.shape,
  },
  wrap('resolve_entity', resolveEntity),
);

server.registerTool(
  'read_disclosure',
  {
    title: '공시 원문 읽기',
    description:
      '공시 원문을 표 구조를 보존한 마크다운으로 돌려줍니다. ' +
      '다른 회사의 기재 사례·문안을 참고하거나 공시 내용을 분석할 때 사용하세요.\n\n' +
      '- 표가 그대로 마크다운 표로 나오므로 항목별 기재 내용을 바로 비교할 수 있습니다\n' +
      '- board_date(이사회 의결일)가 추출되면 check_disclosure_duty 의 boardDate 로 그대로 쓸 수 있습니다\n' +
      '- 원문은 영구 캐시됩니다 (접수된 공시는 불변, 정정은 새 접수번호)\n' +
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
      '공시를 검색합니다. 공정위 기업집단 공시 프리셋이 내장되어 있습니다 ' +
      '(ftc_all=공정위 전체, internal_transaction=대규모내부거래, group_status=기업집단현황, ' +
      'unlisted_material=비상장사 중요사항, public_interest_corp=공익법인, subcontract=하도급 결제조건).\n\n' +
      '- mode:"page"(기본) = 한 페이지씩 조회. mode:"batch" = 기간 전체 전수 수집 (중복 제거·건수 집계 포함)\n' +
      '- batch 가 한 번에 처리하기 큰 범위면 range_too_large 에러와 함께 분할 구간을 안내합니다 — ' +
      '안내된 구간대로 나눠 다시 호출하세요\n' +
      '- report_name_contains 로 보고서명을 거를 수 있습니다 (선례 검색: preset+["자금차입" 등])\n' +
      '- 응답의 diagnostics 를 반드시 확인하세요 — truncated/partial_results 가 true 면 결과가 불완전합니다\n' +
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
      '"다른 회사는 이 항목을 어떻게 썼나"에 답합니다. 키워드로 같은 유형의 최근 공시를 찾아 ' +
      '회사당 1건씩 골라 원문(표 구조 보존 마크다운)을 함께 돌려줍니다.\n\n' +
      '- 키워드는 보고서명 부분일치입니다: "자금차입", "담보제공", "수익증권", "부동산임차" 등\n' +
      '- 기본은 대규모내부거래(J001)에서 찾습니다. preset 으로 다른 공정위 공시로 바꿀 수 있습니다\n' +
      '- corp_cls 로 자사와 같은 상장구분의 문안만 볼 수 있고, exclude_corp 로 자사를 뺄 수 있습니다\n' +
      '- 이 도구는 정정이 반영된 최종본 기준입니다 (문안 참고 목적 — 지연 판정에는 search_disclosures 사용)\n' +
      '- 선례 1건당 원문 다운로드 1회를 소비합니다 (이미 읽은 공시는 캐시)',
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
      '소속회사 목록이 곧 공정위 공시의무의 모집단입니다. EGROUP_API_KEY 가 필요합니다.\n\n' +
      '- include_financials=true 면 계열사별 자산·자본총액·자본금·부채·매출·당기순이익(단위: 원)을 함께 줍니다 — ' +
      '자본총액·자본금은 check_disclosure_duty 의 기준금액 입력으로 그대로 쓸 수 있습니다\n' +
      '- DART corp_code 조인은 법인등록번호 기준입니다 (이름 매칭은 표기 체계가 달라 불가능). ' +
      '미조인 회사는 resolve_entity(fetchJurirNo=true) 로 채워집니다\n' +
      '- 포털 데이터는 연 1회(매년 5/1) 갱신되며 연단위로 캐시됩니다\n' +
      '- 집단명은 공정위 표기를 씁니다: "SK" 가 아니라 "에스케이", "삼성" 등',
    inputSchema: getGroupStructureInput.shape,
  },
  wrap('get_group_structure', getGroupStructure),
);

server.registerTool(
  'get_financials',
  {
    title: '재무제표 조회',
    description:
      '단일회사 재무제표를 조회합니다 (기본: 직전 연도 사업보고서의 재무상태표, 연결 없으면 별도로 자동 폴백).\n\n' +
      '- key_metrics 의 total_equity(자본총계)·paid_in_capital(자본금)은 check_disclosure_duty 의 ' +
      'totalEquity/paidInCapital 입력으로 그대로 쓸 수 있습니다 (단위: 원)\n' +
      '- 금액은 raw(원문)/value(정수 원)/display(표시 단위 환산) 세 값을 함께 줍니다\n' +
      '- change 는 전기 대비 증감입니다 (손익·현금흐름은 누적 필드가 있을 때만 누적 기준)\n' +
      '- 외부감사 대상이 아닌 회사는 DART 에 재무제표가 없을 수 있습니다 — ' +
      '기업집단 소속사는 get_group_structure(include_financials=true)로 포털 재무를 확인하세요',
    inputSchema: getFinancialsInput.shape,
  },
  wrap('get_financials', getFinancials),
);

server.registerTool(
  'search_ftc_qna',
  {
    title: '공정위 공식 Q&A 검색',
    description:
      '공정위가 배포한 해설서·FAQ에서 추출한 공식 질의응답 351건(전문 330 + 폐지 게시판 복원 제목 21)을 검색합니다. ' +
      '"이런 거래도 공시 대상인가?" 같은 경계사례에서 규칙만으로 판정할 수 없을 때, ' +
      '유사한 공정위 공식 답변을 근거로 제시하는 용도입니다. 로컬 데이터라 인증키 없이 동작합니다.\n\n' +
      '- 검색어는 핵심 명사 위주가 잘 맞습니다: "발행어음 자동연장", "자회사 설립 출자", "퇴직연금 거래금액"\n' +
      '- category 로 공시유형(대규모내부거래/비상장사 중요사항/기업집단현황/하도급)을 좁힐 수 있습니다\n' +
      '- ⚠️ 원본 문서 상당수가 2008~2015년 자료입니다 — 각 결과의 caveats(폐지된 기준금액 50억·기한 1일 등)를 ' +
      '반드시 함께 읽으세요. 현행 수치 판정은 check_disclosure_duty 가 담당합니다\n' +
      '- check_disclosure_duty 의 situation 입력으로도 같은 지식베이스가 검색됩니다',
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
      '- 지연 후보에는 지연일수·예상 과태료·자진시정 골든타임 상태·근거가 동봉됩니다 — "후보"이며 확정이 아닙니다\n' +
      '- 약관 금융거래 특례 서식(분기 일괄, 의결일 없음)은 별도 분류로 나옵니다\n' +
      '- 정정 제출분은 판정에서 제외하고 원본만 봅니다 (지연 판정의 성립 조건)\n' +
      '- 범위가 크면 range_too_large 와 분할 구간을 안내합니다 — 원문 캐시는 영구라 재감사는 훨씬 빠릅니다\n' +
      '- 집단 감사는 EGROUP_API_KEY 필요. coverage 의 미조인 회사는 감사에서 빠진 것이니 반드시 확인하세요',
    inputSchema: auditGroupDisclosuresInput.shape,
  },
  wrap('audit_group_disclosures', auditGroupDisclosures),
);

server.registerTool(
  'assess_correction_risk',
  {
    title: '정정공시 리스크 진단',
    description:
      '"정정하면 과태료 나온다"는 속설을 과태료 고시 원문으로 진단합니다. 정정공시 자체는 위반행위가 아니며 ' +
      '(고시 Ⅱ의 위반 열거에 없음), 문제는 원 공시의 상태(누락·거짓·지연)입니다. 로컬 룰이라 인증키 없이 동작합니다.\n\n' +
      '- errorType 별로 원 공시의 위반 성립 여부, 면제 경로(자진시정 골든타임·단순오류·불가항력), 권고를 근거 조문과 함께 돌려줍니다\n' +
      '- originalDeadline 을 주면 골든타임(기한 만료 후 10영업일) 상태와 지연 감경 축소 일정(75%→50%→30%→20%)을 계산합니다\n' +
      '- 거래 내용 자체가 변경된 경우(transaction_changed)는 정정이 아니라 새 공시의무입니다 — 재의결·재공시 경로를 안내합니다\n' +
      '- 면제·감경은 모두 공정위 재량이므로 확정이 아닌 판단 재료입니다',
    inputSchema: assessCorrectionRiskInput.shape,
  },
  wrap('assess_correction_risk', assessCorrectionRisk),
);

server.registerTool(
  'check_j004_consistency',
  {
    title: '기업집단현황공시(J004) 정합성 자가점검',
    description:
      '기업집단현황공시 원문에서 기계적으로 재검산 가능한 항목을 전부 다시 계산해 불일치를 찾습니다. ' +
      '공시의무 위반 건수의 84%가 J004입니다 — 제출 전 자가점검 또는 제출본 사후 점검용입니다.\n\n' +
      '- 재무현황: 유동+비유동=총계(자산·부채), 자산=부채+자본 항등식, 부채비율 재계산, 금융/비금융 소계·합계 재합산\n' +
      '- 차이가 약 1,000배면 단위(원/천원/백만원) 오기 힌트를 답니다\n' +
      '- include_generic_totals=true 면 그 외 표의 합계 행도 실험적으로 재합산합니다 (기본 꺼짐 — 병합 셀 표 오탐 가능)\n' +
      '- compare_rcept_nos 로 개별회사 공시들을 주면 대표회사 취합분과 회사별 수치를 대사합니다\n' +
      '- 문서 내적 정합성만 봅니다 — 원천 회계 데이터와의 일치(진실성)는 판정하지 않습니다\n' +
      '- 불일치 발견 시 정정 판단은 assess_correction_risk 와 함께 쓰세요',
    inputSchema: checkJ004ConsistencyInput.shape,
  },
  wrap('check_j004_consistency', checkJ004Consistency),
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
  log.info('dart-ftc-mcp 서버 시작 (stdio)');
}

main().catch((err) => {
  log.error('서버 기동 실패', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
