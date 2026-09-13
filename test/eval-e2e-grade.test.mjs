/**
 * e2e 평가 채점 규칙 회귀 — 러너가 "성공"이라고 말할 조건을 고정한다.
 *
 * ★ 이 파일은 claude 를 띄우지 않는다. 채점·파서 모듈만 import 한다(부작용 없음).
 *   근거가 된 실물 이벤트 형태는 eval/messy/messy-results/*.stream.jsonl (2026-09-07~08) 에서 가져왔다.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { grade, environmentProblem, calledTool } from '../eval/e2e/grade.mjs';
import { parseStream } from '../eval/messy/parse-stream.mjs';
import { DISALLOWED_TOOLS } from '../eval/disallowed-tools.mjs';

/** stream-json 한 줄씩 조립 */
function jsonl(...events) {
  return events.map((e) => JSON.stringify(e)).join('\n');
}
const INIT_OK = {
  type: 'system',
  subtype: 'init',
  tools: ['ToolSearch', 'mcp__gongsi__check_disclosure_duty', 'mcp__gongsi__read_detection_result'],
  mcp_servers: [{ name: 'gongsi', status: 'connected' }],
};
function use(id, name, input = {}) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } };
}
function result(id, content, isError) {
  return {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError === undefined ? {} : { is_error: isError }) }],
    },
  };
}
const RESULT_OK = {
  type: 'result',
  subtype: 'success',
  result: '답변',
  num_turns: 3,
  is_error: false,
  total_cost_usd: 0.42,
  permission_denials: [],
};
const item = { id: 't', expect: [], signals: [], forbid: [] };

describe('도구 결과 오류 채점', () => {
  it('호스트가 크기 초과로 결과를 버린 경우(is_error 없음)도 실패다 — m07 실물 형태', () => {
    // 실측(m07-company-only.stream.jsonl): is_error 필드 없이 문자열 content 로 온다
    const rec = parseStream(
      jsonl(
        INIT_OK,
        use('a', 'mcp__gongsi__detect_undisclosed_transactions', { group: '미래에셋' }),
        result('a', 'Error: result (222,709 characters across 5,721 lines) exceeds maximum allowed tokens.'),
        RESULT_OK,
      ),
    );
    const { failures } = grade(item, '답변', rec);
    expect(failures.some((f) => f.startsWith('tool_result_rejected_by_host'))).toBe(true);
  });

  it('MCP isError:true 는 실패다', () => {
    const rec = parseStream(
      jsonl(INIT_OK, use('a', 'mcp__gongsi__read_detection_result'), result('a', '{\n  "error": "result_unavailable"\n}', true), RESULT_OK),
    );
    expect(grade(item, '답변', rec).failures).toContain('tool_error: mcp__gongsi__read_detection_result');
  });

  it('isError 없이 본문이 {"error":…} 인 정상 응답도 실패다 (text 블록 배열 형태)', () => {
    const rec = parseStream(
      jsonl(
        INIT_OK,
        use('a', 'mcp__gongsi__check_disclosure_duty'),
        result('a', [{ type: 'text', text: '{\n  "error": "invalid_argument",\n  "message": "분기말이 아닙니다"\n}' }]),
        RESULT_OK,
      ),
    );
    expect(grade(item, '답변', rec).failures).toContain(
      'tool_returned_error_body: mcp__gongsi__check_disclosure_duty',
    );
  });
});

describe('답변 문구 매칭', () => {
  it('마크다운 강조가 끼어도 금지 문구를 잡는다 (1차 out-of-scope 실측: "**5일 이내**에 보고")', () => {
    const rec = parseStream(jsonl(INIT_OK, RESULT_OK));
    const forbidItem = { ...item, require_tool: false, forbid: ['5일 이내에 보고'] };
    const { failures } = grade(forbidItem, '- **원칙:** 5% 이상을 보유하게 된 날부터 **5일 이내**에 보고합니다', rec);
    expect(failures).toContain('forbid: 5일 이내에 보고');
  });

  it('마크다운 강조가 끼어도 기대 문구를 찾는다', () => {
    const rec = parseStream(jsonl(INIT_OK, RESULT_OK));
    const expectItem = { ...item, require_tool: false, expect: [['기준금액 60억']] };
    expect(grade(expectItem, '**기준금액** `60억`', rec).failures).toEqual([]);
  });
});

describe('도구 사용은 우리 MCP 호출 기록으로만 인정한다', () => {
  it('ToolSearch 만 부르고 끝났으면 tool_not_used 다 (스키마 로드는 도구 사용이 아니다)', () => {
    const rec = parseStream(
      jsonl(INIT_OK, use('a', 'ToolSearch', { query: 'select:mcp__gongsi__check_disclosure_duty' }), result('a', [{ type: 'tool_reference', tool_name: 'mcp__gongsi__check_disclosure_duty' }]), RESULT_OK),
    );
    expect(grade(item, '답변', rec).failures).toContain('tool_not_used');
  });

  it('우리 MCP 가 아닌 도구가 실제로 호출됐으면 실패다 (ToolSearch 제외)', () => {
    const rec = parseStream(
      jsonl(INIT_OK, use('a', 'WebFetch', { url: 'https://example.invalid' }), result('a', 'ok'), use('b', 'mcp__gongsi__check_disclosure_duty'), result('b', [{ type: 'text', text: '{}' }]), RESULT_OK),
    );
    expect(grade(item, '답변', rec).failures).toContain('non_mcp_tool_called: WebFetch');
  });

  it('expect_tools 는 OR 그룹을 받는다 — 기한 질문은 두 도구 중 하나면 된다', () => {
    const rec = parseStream(
      jsonl(INIT_OK, use('a', 'mcp__gongsi__calc_business_days'), result('a', [{ type: 'text', text: '{}' }]), RESULT_OK),
    );
    const orItem = { ...item, expect_tools: [['check_disclosure_duty', 'calc_business_days']] };
    expect(grade(orItem, '답변', rec).failures).toEqual([]);
  });

  it('다른 서버 접두사(mcp__gongsi-mcp__)는 이 평가 대상 서버 호출로 세지 않는다', () => {
    const rec = { tool_calls: [{ name: 'mcp__gongsi-mcp__check_disclosure_duty' }] };
    expect(calledTool(rec, 'check_disclosure_duty')).toBe(false);
    expect(calledTool({ tool_calls: [{ name: 'mcp__gongsi__check_disclosure_duty' }] }, 'check_disclosure_duty')).toBe(true);
  });
});

describe('환경 문제는 제품 실패와 구분한다', () => {
  it('MCP 서버가 연결되지 않았으면 환경 문제다', () => {
    const rec = parseStream(
      jsonl({ ...INIT_OK, mcp_servers: [{ name: 'gongsi', status: 'failed' }] }, RESULT_OK),
    );
    expect(environmentProblem(rec)).toMatch(/gongsi/);
  });

  it('차단 목록 밖의 내장 도구가 살아 있으면 격리 실패(환경 문제)다', () => {
    const rec = parseStream(
      jsonl({ ...INIT_OK, tools: [...INIT_OK.tools, 'Bash', 'PushNotification'] }, RESULT_OK),
    );
    const problem = environmentProblem(rec);
    expect(problem).toContain('Bash');
    expect(problem).toContain('PushNotification');
  });

  it('정상 격리(ToolSearch + 우리 MCP 만)는 환경 문제가 없다', () => {
    expect(environmentProblem(parseStream(jsonl(INIT_OK, RESULT_OK)))).toBeNull();
  });
});

describe('맥락 오염도 환경 문제다 (2026-09-13 1차 실행: 저장소 cwd 라 프로젝트 기록·플러그인 훅이 섞였다)', () => {
  it('사용자 플러그인이 로드됐으면 환경 문제다 — 훅이 답변 맥락을 주입한다', () => {
    const rec = parseStream(jsonl({ ...INIT_OK, plugins: [{ name: 'fablize' }, { name: 'codex' }] }, RESULT_OK));
    const problem = environmentProblem(rec);
    expect(problem).toContain('fablize');
  });

  it('init 전에 훅 이벤트가 있으면 환경 문제다', () => {
    const rec = parseStream(
      jsonl({ type: 'system', subtype: 'hook_response', hook_event: 'SessionStart' }, INIT_OK, RESULT_OK),
    );
    expect(environmentProblem(rec)).toMatch(/훅/);
  });

  it('파서가 init 의 cwd·권한 모드·모델·플러그인·훅 수를 남긴다', () => {
    const rec = parseStream(
      jsonl({ ...INIT_OK, cwd: 'C:\\tmp\\x', permissionMode: 'default', model: 'm', plugins: [], memory_paths: { auto: 'a' } }, RESULT_OK),
    );
    expect(rec.context).toEqual({
      cwd: 'C:\\tmp\\x',
      permission_mode: 'default',
      model: 'm',
      plugins: [],
      hook_events: 0,
      memory_paths: { auto: 'a' },
    });
  });

  it('e2e 러너는 빈 임시 cwd 와 사용자 설정 제외로 실행한다', () => {
    const e2e = readFileSync(new URL('../scripts/eval-e2e.mjs', import.meta.url), 'utf8');
    expect(e2e).toContain("'--setting-sources', 'project,local'");
    expect(e2e).toContain('mkdtempSync');
  });
});

describe('파서가 기록하는 증거', () => {
  it('결과 전체 길이·비용·tool_use_id 를 남긴다 (head 200자는 크기 증거가 아니다)', () => {
    const big = 'x'.repeat(5_000);
    const rec = parseStream(jsonl(INIT_OK, use('a', 'mcp__gongsi__check_disclosure_duty'), result('a', [{ type: 'text', text: big }]), RESULT_OK));
    expect(rec.tool_results[0].chars).toBe(5_000);
    expect(rec.tool_results[0].tool_use_id).toBe('a');
    expect(rec.cost_usd).toBe(0.42);
  });
});

describe('차단 목록은 두 러너가 하나를 공유한다', () => {
  it('실물 init 에서 살아 있던 내장 도구를 전부 막고 ToolSearch 는 남긴다', () => {
    const list = DISALLOWED_TOOLS.split(',');
    // m07(2026-09-08) init 이벤트에 차단 목록 밖으로 남아 있던 것들
    for (const t of ['DesignSync', 'EnterWorktree', 'ExitWorktree', 'PushNotification', 'RemoteTrigger', 'ReportFindings']) {
      expect(list).toContain(t);
    }
    for (const t of ['WebFetch', 'WebSearch', 'Bash', 'Read', 'Monitor', 'TaskOutput']) expect(list).toContain(t);
    expect(list).not.toContain('ToolSearch');
  });

  it('e2e 러너와 messy 러너가 같은 모듈을 import 한다', () => {
    const e2e = readFileSync(new URL('../scripts/eval-e2e.mjs', import.meta.url), 'utf8');
    const messy = readFileSync(new URL('../eval/messy/run-messy.mjs', import.meta.url), 'utf8');
    expect(e2e).toContain('disallowed-tools.mjs');
    expect(messy).toContain('disallowed-tools.mjs');
  });
});
