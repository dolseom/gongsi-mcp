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
export function parseStream(text) {
  const out = {
    tools_available: null,
    mcp_servers: null,
    tool_calls: [],
    tool_results: [],
    permission_denials: [],
    num_turns: null,
    duration_ms: null,
    is_error: true,
    answer: null,
    result_seen: false,
    events_parsed: 0,
    lines_unparsed: 0,
  };
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
      continue;
    }

    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const b of ev.message.content) {
        if (!b || b.type !== 'tool_use') continue;
        nameById.set(b.id, b.name);
        out.tool_calls.push({
          name: b.name,
          input: JSON.stringify(b.input ?? null).slice(0, 300),
        });
      }
      continue;
    }

    if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
      for (const b of ev.message.content) {
        if (!b || b.type !== 'tool_result') continue;
        out.tool_results.push({
          name: nameById.get(b.tool_use_id) ?? null,
          is_error: b.is_error === true,
          head: resultHead(b.content).slice(0, 200),
        });
      }
      continue;
    }

    if (ev.type === 'result') {
      out.result_seen = true;
      out.answer = typeof ev.result === 'string' ? ev.result : null;
      out.num_turns = ev.num_turns ?? null;
      out.duration_ms = ev.duration_ms ?? null;
      out.is_error = ev.is_error ?? true;
      // 차단한 도구를 실제로 시도했는지 — disallowedTools 가 듣고 있는지의 증거다
      if (Array.isArray(ev.permission_denials)) {
        out.permission_denials = ev.permission_denials.map((d) =>
          typeof d === 'string' ? d : (d?.tool_name ?? JSON.stringify(d).slice(0, 120)),
        );
      }
    }
  }

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
