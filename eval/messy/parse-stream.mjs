// `claude -p --output-format stream-json --verbose` 출력 파서.
//
// 왜 따로 있나: 러너(run-messy.mjs)는 import 하는 순간 12문항을 실제로 돌린다(비용·세션 한도).
// 파싱만 따로 검증하려면 부작용 없는 모듈이어야 한다.
//
// 이벤트 형태(2026-09-07 실측):
//   {"type":"system","subtype":"init","tools":[...],"mcp_servers":[{name,status}], ...}
//   {"type":"assistant","message":{"content":[{type:"tool_use",id,name,input}, ...]}}
//   {"type":"user","message":{"content":[{type:"tool_result",tool_use_id,content,is_error}]}}
//   {"type":"result","subtype":"success","result":"...","num_turns":3,"duration_ms":40848,"is_error":false}

/** tool_result 의 content 는 문자열이거나 블록 배열이다 — 사람이 읽을 한 줄로 만든다 */
function resultHead(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  const parts = [];
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else parts.push(JSON.stringify(b));
  }
  return parts.join(' ');
}

/**
 * stream-json 본문(JSONL 문자열)에서 이 평가가 보고 싶은 것만 뽑는다.
 *
 * ★ 도구 호출 기록이 이 파서의 존재 이유다. 2026-09-06 실행은 `result` 문자열만 저장해,
 *   한 문항이 "법제처 원문으로 확인했다"고 답했을 때 **어느 도구로 그랬는지 확정할 수 없었다.**
 *   근거 위조와 정상 조회를 사후에 가르려면 호출 목록이 남아 있어야 한다.
 */
function pluginName(p) {
  return typeof p === 'string' ? p : (p?.name ?? JSON.stringify(p));
}

/** CLI 에 내장된 플러그인인가 — init 이벤트가 path:'builtin' · source:'<이름>@builtin' 으로 알린다 */
function isBuiltinPlugin(p) {
  return typeof p === 'object' && p !== null && (p.path === 'builtin' || String(p.source ?? '').endsWith('@builtin'));
}

export function parseStream(text) {
  const out = {
    tools_available: null,
    mcp_servers: null,
    tool_calls: [],
    tool_results: [],
    permission_denials: [],
    num_turns: null,
    duration_ms: null,
    cost_usd: null,
    subtype: null,
    api_error_status: null,
    is_error: true,
    answer: null,
    result_seen: false,
    events_parsed: 0,
    lines_unparsed: 0,
    /**
     * 실행 맥락 — 이 세션에 **도구 밖에서** 무엇이 섞였는가.
     * 2026-09-13 1차 e2e 실행은 저장소 cwd 라 프로젝트 기록(CLAUDE.local.md)과 사용자 플러그인 훅이
     * 답변에 섞였다("프로젝트 기록에서 가져왔다"). 그 사실을 사후에 가를 수 있게 init 에서 남긴다.
     */
    context: null,
  };
  let hookEvents = 0;
  /** tool_use_id → 도구 이름 (tool_result 에는 이름이 없다) */
  const nameById = new Map();

  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      out.lines_unparsed++;
      continue;
    }
    out.events_parsed++;

    if (ev.type === 'system' && ev.subtype === 'init') {
      out.tools_available = Array.isArray(ev.tools) ? ev.tools : null;
      out.mcp_servers = Array.isArray(ev.mcp_servers) ? ev.mcp_servers : null;
      out.context = {
        cwd: ev.cwd ?? null,
        permission_mode: ev.permissionMode ?? null,
        model: ev.model ?? null,
        // ★ CLI 내장 플러그인(path 'builtin' — 2.1.281 의 agents-md·telemetry)은 --setting-sources 로
        //   끌 수 없고 사용자 설정도 아니다. 사용자 플러그인과 섞으면 모든 실행이 환경 오류가 된다
        //   (2026-09-24 b2a 1차 20/20 무효). 따로 남겨 사후에 볼 수 있게만 한다.
        plugins: Array.isArray(ev.plugins)
          ? ev.plugins.filter((p) => !isBuiltinPlugin(p)).map(pluginName)
          : [],
        builtin_plugins: Array.isArray(ev.plugins)
          ? ev.plugins.filter(isBuiltinPlugin).map(pluginName)
          : [],
        hook_events: 0,
        memory_paths: ev.memory_paths ?? null,
      };
      continue;
    }
    // SessionStart 등 훅 실행 — 훅은 additionalContext 로 답변 맥락을 주입할 수 있다
    if (ev.type === 'system' && typeof ev.subtype === 'string' && ev.subtype.startsWith('hook_')) {
      hookEvents += 1;
      continue;
    }

    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const b of ev.message.content) {
        if (!b || b.type !== 'tool_use') continue;
        nameById.set(b.id, b.name);
        out.tool_calls.push({
          id: b.id ?? null,
          name: b.name,
          input: JSON.stringify(b.input ?? null).slice(0, 300),
        });
      }
      continue;
    }

    if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
      for (const b of ev.message.content) {
        if (!b || b.type !== 'tool_result') continue;
        const full = resultHead(b.content);
        out.tool_results.push({
          tool_use_id: b.tool_use_id ?? null,
          name: nameById.get(b.tool_use_id) ?? null,
          is_error: b.is_error === true,
          // head 는 200자로 자르므로 크기 증거가 아니다 — 전체 길이는 chars 로 따로 남긴다
          chars: full.length,
          head: full.slice(0, 200),
        });
      }
      continue;
    }

    if (ev.type === 'result') {
      out.result_seen = true;
      out.answer = typeof ev.result === 'string' ? ev.result : null;
      out.num_turns = ev.num_turns ?? null;
      out.duration_ms = ev.duration_ms ?? null;
      out.cost_usd = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null;
      out.subtype = ev.subtype ?? null;
      out.api_error_status = ev.api_error_status ?? null;
      out.is_error = ev.is_error ?? true;
      // 차단한 도구를 실제로 시도했는지 — disallowedTools 가 듣고 있는지의 증거다
      if (Array.isArray(ev.permission_denials)) {
        out.permission_denials = ev.permission_denials.map((d) =>
          typeof d === 'string' ? d : (d?.tool_name ?? JSON.stringify(d).slice(0, 120)),
        );
      }
    }
  }

  if (out.context) out.context.hook_events = hookEvents;
  return out;
}

/** 콘솔·요약용 도구 이름 목록 (중복 제거, 호출 순서 유지) */
export function toolNames(rec) {
  const seen = new Set();
  const names = [];
  for (const c of rec.tool_calls ?? []) {
    if (!c.name || seen.has(c.name)) continue;
    seen.add(c.name);
    names.push(c.name);
  }
  return names;
}
