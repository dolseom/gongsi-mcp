/**
 * stdio MCP 서버 하나를 띄워 줄 단위 JSON-RPC 로 왕복하는 최소 클라이언트 — 스모크 스크립트 공용.
 *   (scripts/smoke-tarball.mjs · scripts/smoke-live-detect.mjs 에 따로 있던 것을 합쳤다)
 *
 * ⚠️ 요청 타이머는 응답 즉시 지운다. 종전 한 사본은 지우지 않아 "통과" 로그 뒤에도 30초씩 프로세스가
 *   살아 있었다 (2026-09-13 실측: 통과 13.2초 → 종료 44.4초). 바깥 도구가 45초에 끊으면 "통과 로그는
 *   있는데 종료 코드가 없는" 오해의 소지가 있는 기록이 남는다.
 * ⚠️ stdout 에 JSON 아닌 줄이 섞이면 프로토콜 오염이다 — onNonJson 으로 호출부가 실패 처리한다
 *   (호출부마다 메시지·종료 방식이 달라 콜백으로 둔다).
 */
import { spawn } from 'node:child_process';

/**
 * @param {object} o
 * @param {string} o.cli            실행할 서버 진입점 (node 로 실행)
 * @param {string} o.cwd
 * @param {NodeJS.ProcessEnv} o.env
 * @param {number} o.requestTimeoutMs
 * @param {(line: string) => void} o.onNonJson  JSON 아닌 stdout 줄 (보통 process.exit 하는 fail)
 * @param {number} [o.stderrTailInTimeout]  >0 이면 stderr 를 모아 두고 타임아웃 메시지에 끝 N자를 붙인다.
 *                                          0(기본)이면 stderr 는 읽어 버린다.
 * @param {number} [o.exitWaitMs]   stop() 이 종료를 기다리는 시간 (기본 5초)
 */
export function startStdioServer({ cli, cwd, env, requestTimeoutMs, onNonJson, stderrTailInTimeout = 0, exitWaitMs = 5_000 }) {
  const proc = spawn(process.execPath, [cli], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buf = '';
  let stderrBuf = '';
  let nextId = 1;

  proc.stderr.on('data', (d) => {
    if (stderrTailInTimeout > 0) stderrBuf += d;
  });
  proc.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        onNonJson(line);
        continue;
      }
      const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  });

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        const tail = stderrTailInTimeout > 0 ? `. stderr: ${stderrBuf.slice(-stderrTailInTimeout)}` : '';
        reject(new Error(`${method} ${requestTimeoutMs / 1000}초 응답 없음${tail}`));
      }, requestTimeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  function notify(method) {
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }

  /** initialize → notifications/initialized. initialize 결과를 돌려준다. */
  async function init(clientName) {
    const result = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: clientName, version: '0.0.0' },
    });
    notify('notifications/initialized');
    return result;
  }

  /**
   * 서버를 멈추고 **실제로 종료됐는지** 확인한다 (로그만으로는 종료를 증명하지 못한다).
   * @returns {Promise<{code: number|null, signal: string|null, already: boolean} | null>} 시간 안에 안 끝나면 null
   */
  async function stop() {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      return { code: proc.exitCode, signal: proc.signalCode, already: true };
    }
    const exited = new Promise((r) => proc.once('exit', (code, signal) => r({ code, signal, already: false })));
    proc.kill();
    let t;
    const timeout = new Promise((r) => {
      t = setTimeout(() => r(null), exitWaitMs);
    });
    const res = await Promise.race([exited, timeout]);
    clearTimeout(t);
    return res;
  }

  return {
    proc,
    request,
    notify,
    init,
    stop,
    callTool: (name, args) => request('tools/call', { name, arguments: args }),
    pendingCount: () => pending.size,
  };
}

/** tools/call 결과의 첫 텍스트 */
export const resultText = (res) => res?.content?.[0]?.text ?? '';

/** tools/call 결과 본문을 JSON 으로 — 파싱 실패면 null */
export function resultBody(res) {
  try {
    return JSON.parse(resultText(res));
  } catch {
    return null;
  }
}
