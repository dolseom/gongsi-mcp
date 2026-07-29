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
import { toErrorResponse } from './lib/errors.js';
import {
  checkDisclosureDuty,
  checkDisclosureDutyInput,
} from './tools/check-disclosure-duty.js';

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
      log.error(`${name} 실패`, err instanceof Error ? err.stack : String(err));
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
