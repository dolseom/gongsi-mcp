/**
 * .env 파일 읽기 — 스크립트 공용.
 *
 * ⚠️ 호출부마다 **종전 동작이 다르다**. 하나로 "엄격하게" 맞추면 한쪽의 결과가 조용히 바뀐다
 *   (예: 비밀값 스캔이 대조할 값을 덜 모으면 유출을 못 잡는다). 그래서 문법을 옵션으로 고른다.
 *
 *   syntax: 'loose'  — scripts/check-secrets.mjs 의 종전 규칙
 *     줄 앞뒤 공백·`=` 양옆 공백 허용, 이름은 [A-Z0-9_]+, **빈 값은 건너뜀**, 값 끝 공백 제거.
 *   syntax: 'strict' — eval/messy/run-messy.mjs 의 종전 규칙
 *     줄을 trim 한 뒤 `NAME=값` 만(= 양옆 공백 불허), 이름은 [A-Z_]+(숫자 불허), 빈 값 허용.
 *   stripQuotes — 값 맨 앞 따옴표 하나·맨 끝 따옴표 하나를 **각각** 지운다 (짝을 맞추지 않는다 —
 *     check-secrets 의 종전 `replace(/^["']|["']$/g, '')` 그대로). strict 기본값은 false(원문 그대로).
 *   주석(`#`)은 두 문법 모두 이름 패턴에 걸리지 않아 자연히 무시된다. 값 뒤 인라인 주석은 값에 포함된다(종전 동일).
 *
 * 반환은 등장 순서의 [이름, 값] 배열이다 — 중복 처리(첫 값 유지/마지막 값 우선)는 호출부 규칙이 달라 호출부가 정한다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LINE = {
  loose: { re: /^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/, trim: false },
  strict: { re: /^([A-Z_]+)=(.*)$/, trim: true },
};

/**
 * @param {string} text
 * @param {{ syntax?: 'loose' | 'strict', stripQuotes?: boolean }} [opts]
 * @returns {Array<[string, string]>}
 */
export function parseEnv(text, { syntax = 'strict', stripQuotes = false } = {}) {
  const rule = LINE[syntax];
  if (!rule) throw new Error(`알 수 없는 .env 문법: ${syntax}`);
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = rule.re.exec(rule.trim ? raw.trim() : raw);
    if (!m) continue;
    const value = stripQuotes ? m[2].replace(/^["']|["']$/g, '') : m[2];
    out.push([m[1], value]);
  }
  return out;
}

/**
 * @param {string} path
 * @param {{ syntax?: 'loose' | 'strict', stripQuotes?: boolean, optional?: boolean }} [opts]
 *   optional=true 면 파일이 없을 때 빈 배열(check-secrets 종전 동작).
 *   optional=false(기본)면 파일이 없을 때 readFileSync 의 ENOENT 를 그대로 던진다(run-messy 종전 동작).
 */
export function readEnvFile(path, { optional = false, ...parseOpts } = {}) {
  if (optional && !existsSync(path)) return [];
  return parseEnv(readFileSync(path, 'utf8'), parseOpts);
}

/**
 * 홈의 서버 설정 파일 경로 (~/.gongsi-mcp/.env).
 * @param {string} [home] 기본은 os.homedir(). run-messy 는 종전대로 USERPROFILE ?? HOME 을 넘긴다.
 */
export function gongsiEnvPath(home = homedir()) {
  return join(home, '.gongsi-mcp', '.env');
}
