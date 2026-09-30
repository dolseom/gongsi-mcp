/**
 * 로깅
 *
 * ⚠️ stdout 은 MCP 프로토콜 전용이다. 로그는 **stderr 로만** 나간다.
 * stdout 에 한 줄이라도 새면 클라이언트가 JSON-RPC 파싱에 실패한다.
 *
 * API 키는 어떤 경로로도 로그에 남지 않아야 한다 (test/redaction.test.ts 가 고정).
 */

import { getConfig } from './config.js';

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 } as const;
type LevelName = keyof typeof LEVELS;

function threshold(): number {
  const name = getConfig().logLevel as LevelName;
  return LEVELS[name] ?? LEVELS.INFO;
}

/**
 * 인증키로 보이는 값을 가린다.
 * DART 인증키는 40자 hex, 공공데이터포털 키는 64자 hex 또는 URL 인코딩된 base64다.
 */
export function redact(text: string): string {
  const cfg = getConfig();
  let out = text;
  for (const key of [cfg.dartApiKey, cfg.egroupApiKey]) {
    if (key && key.length >= 8) out = out.split(key).join('***REDACTED***');
  }
  // 설정에 없는 키가 흘러들어와도 잡는다
  out = out.replace(/\b(crtfc_key|serviceKey|ServiceKey)=[^&\s"']+/g, '$1=***REDACTED***');
  out = out.replace(/\b[0-9a-f]{40,64}\b/gi, '***REDACTED***');
  return out;
}

function emit(level: LevelName, scope: string, message: string, extra?: unknown): void {
  if (LEVELS[level] < threshold()) return;
  const ts = new Date().toISOString();
  let line = `${ts} ${level} ${scope} ${message}`;
  if (extra !== undefined) {
    let rendered: string;
    try {
      rendered = typeof extra === 'string' ? extra : JSON.stringify(extra);
    } catch {
      rendered = String(extra);
    }
    line += ` ${rendered}`;
  }
  process.stderr.write(redact(line) + '\n');
}

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}

export function getLogger(scope: string): Logger {
  return {
    debug: (m, e) => emit('DEBUG', scope, m, e),
    info: (m, e) => emit('INFO', scope, m, e),
    warn: (m, e) => emit('WARN', scope, m, e),
    error: (m, e) => emit('ERROR', scope, m, e),
  };
}
