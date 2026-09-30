// e2e 평가 채점 — 부작용 없는 모듈.
//
// 왜 따로 있나: 러너(scripts/eval-e2e.mjs)는 실행하는 순간 claude 헤드리스를 띄운다(비용·세션 한도).
// 채점 규칙 자체를 테스트로 고정하려면 import 해도 아무것도 실행되지 않는 모듈이어야 한다
// (test/eval-e2e-grade.test.mjs).

import { ALLOWED_NON_MCP_TOOLS } from '../disallowed-tools.mjs';

/** eval/e2e/mcp-config.json 의 서버 이름 — 도구 이름 접두사가 된다 */
export const EVAL_SERVER = 'gongsi';
const MCP_PREFIX = `mcp__${EVAL_SERVER}__`;

/**
 * 호스트가 도구 결과를 **크기 때문에 버린** 흔적 (2026-09-08 m07 실측 형태).
 * ⚠️ 이 경우 tool_result 에 is_error 가 **붙지 않는다** — 문자열 content 로만 온다.
 * 이것을 놓치면 "응답이 통째로 사라진 실행" 이 정상 호출로 채점된다.
 */
const HOST_REJECTED = /exceeds maximum allowed tokens|^\s*Error: result \(/;

/**
 * 콤마·공백·마크다운 강조 기호 제거 정규화 (금액 표기 차이·서식 흡수).
 * ⚠️ 2026-09-13 1차 실행에서 "**5일 이내**에 보고" 가 금지 문구 "5일 이내에 보고" 를 빠져나갔다 —
 *   모델 답변은 마크다운이라 강조 기호가 문구 사이에 끼는 것이 정상이다. 양쪽을 같이 정규화한다.
 */
export function normalize(text) {
  return String(text).replace(/[\s,*_`~]/g, '');
}

/** 원문 포함 또는 정규화 포함이면 매치 */
export function contains(answer, needle) {
  if (answer.includes(needle)) return true;
  return normalize(answer).includes(normalize(needle));
}

/** 그룹(OR 후보 배열) 중 하나라도 답변에 있으면 true */
export function matchGroup(answer, group) {
  return group.some((alt) => contains(answer, alt));
}

/** 이 평가가 띄운 서버의 도구인가 — 다른 서버(mcp__gongsi-mcp__ 등)는 세지 않는다 */
export function isEvalServerTool(name) {
  return typeof name === 'string' && name.startsWith(MCP_PREFIX);
}

/** 짧은 이름(check_disclosure_duty)의 도구가 **실제로 호출**됐는가 */
export function calledTool(rec, shortName) {
  return (rec.tool_calls ?? []).some((c) => c.name === `${MCP_PREFIX}${shortName}`);
}

/**
 * 문항 1건 채점 — 결정적. 도구 사용은 **호출 기록**으로만 판정한다.
 *
 * `expect_tools` 항목은 문자열(그 도구 필수) 또는 문자열 배열(그중 하나면 된다 — OR)이다.
 */
export function grade(item, answer, rec) {
  const failures = [];
  let signalMisses = 0;

  for (const group of item.expect ?? []) {
    if (!matchGroup(answer, group)) {
      failures.push(`expect: ${group.join('|')}`);
    }
  }
  for (const group of item.signals ?? []) {
    if (!matchGroup(answer, group)) {
      failures.push(`signal: ${group.join('|')}`);
      signalMisses += 1;
    }
  }
  for (const banned of item.forbid ?? []) {
    if (contains(answer, banned)) {
      failures.push(`forbid: ${banned}`);
    }
  }

  const calls = rec.tool_calls ?? [];
  // ★ 기대 도구는 **호출 기록**으로 채점한다. num_turns 로는 "웹으로 채운 턴"도 통과했다.
  for (const spec of item.expect_tools ?? []) {
    const alts = Array.isArray(spec) ? spec : [spec];
    if (!alts.some((a) => calledTool(rec, a))) failures.push(`tool_not_called: ${alts.join('|')}`);
  }
  // 기본은 도구 사용 필수(자체 지식 답변 = #52 유형 실패). ToolSearch 는 스키마 로드일 뿐이라
  // 도구 사용으로 세지 않는다 — 우리 서버 도구를 한 번이라도 불러야 한다.
  if ((item.require_tool ?? true) && !calls.some((c) => isEvalServerTool(c.name))) {
    failures.push('tool_not_used');
  }
  // 우리 서버도 ToolSearch 도 아닌 도구가 **실제로 실행**됐다 = 격리가 샜다
  const leaked = new Set();
  for (const c of calls) {
    if (!isEvalServerTool(c.name) && !ALLOWED_NON_MCP_TOOLS.includes(c.name)) leaked.add(c.name);
  }
  for (const name of leaked) failures.push(`non_mcp_tool_called: ${name}`);

  // 도구가 오류를 돌려준 것을 "정상 결과"로 옮겨 적는 답을 통과시키지 않는다.
  // 호스트 크기 거절 · isError:true · **본문이 {"error":...} 인 정상 응답** 셋 다 실패다.
  for (const r of rec.tool_results ?? []) {
    const head = r.head ?? '';
    if (HOST_REJECTED.test(head)) failures.push(`tool_result_rejected_by_host: ${r.name ?? 'unknown'}`);
    else if (r.is_error) failures.push(`tool_error: ${r.name ?? 'unknown'}`);
    else if (/^\s*\{\s*"error"\s*:/.test(head)) {
      failures.push(`tool_returned_error_body: ${r.name ?? 'unknown'}`);
    }
  }
  // 차단한 도구를 권한 단계에서 거부당했는지 — 격리가 듣고 있는지의 증거다
  for (const denial of rec.permission_denials ?? []) {
    failures.push(`blocked_tool_attempted: ${denial}`);
  }
  return { failures, signalMisses };
}

/**
 * 제품 실패가 아니라 **평가 환경** 문제인가 — null 이면 문제 없음.
 *
 * 이런 실행은 통과로도 실패로도 세지 않는다: 서버가 안 떴거나 격리가 샜으면 답이 무엇이든
 * "우리 MCP 만으로 답이 되는가" 를 잰 것이 아니다.
 */
export function environmentProblem(rec) {
  if (!Array.isArray(rec.tools_available)) {
    return 'init 이벤트에 도구 목록이 없습니다 — 격리 여부를 확인할 수 없습니다';
  }
  const server = (rec.mcp_servers ?? []).find((s) => s && s.name === EVAL_SERVER);
  if (!server || server.status !== 'connected') {
    return (
      `평가 대상 MCP 서버 '${EVAL_SERVER}' 가 연결되지 않았습니다 (status: ${server?.status ?? '없음'}) — ` +
      'npm run build 와 eval/e2e/mcp-config.json 을 확인하세요'
    );
  }
  const leaks = rec.tools_available.filter(
    (t) => !isEvalServerTool(t) && !ALLOWED_NON_MCP_TOOLS.includes(t),
  );
  if (leaks.length > 0) {
    return `차단 목록 밖의 도구가 살아 있습니다 (격리 실패): ${leaks.join(', ')} — eval/disallowed-tools.mjs 에 추가하세요`;
  }
  // 도구 밖에서 맥락이 섞였는가 — 플러그인 훅·스킬, 프로젝트 기록. 이러면 "우리 MCP 만으로" 를 잰 것이 아니다.
  const ctx = rec.context;
  if (ctx && ctx.plugins.length > 0) {
    return (
      `사용자 플러그인이 로드됐습니다 (${ctx.plugins.join(', ')}) — 훅이 답변 맥락을 주입할 수 있어 평가가 무효입니다. ` +
      '--setting-sources project,local 로 실행하세요'
    );
  }
  if (ctx && ctx.hook_events > 0) {
    return `훅 이벤트 ${ctx.hook_events}건이 실행됐습니다 — 맥락 주입 가능성이 있어 평가가 무효입니다`;
  }
  return null;
}

/**
 * ToolSearch 로 우리 MCP 밖 도구를 불러오려 한 시도 (정보용 — 차단돼 있으면 실패가 아니다).
 * m07 은 크기 초과 뒤 `select:Bash,Read,Grep` 을 시도했다. 격리가 막았는지는 non_mcp_tool_called 로 본다.
 */
export function toolSearchProbes(rec) {
  const probes = [];
  for (const c of rec.tool_calls ?? []) {
    if (c.name !== 'ToolSearch') continue;
    const m = /select:([^"]*)/.exec(c.input ?? '');
    if (!m) continue;
    const outside = m[1].split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('mcp__'));
    if (outside.length > 0) probes.push(outside.join(','));
  }
  return probes;
}
