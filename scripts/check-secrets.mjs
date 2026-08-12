#!/usr/bin/env node
/**
 * 실키 유출 스캔 — 커밋·배포 대상에 실제 비밀값이 들어 있으면 차단한다.
 *
 * ★ 패턴 grep 이 아니라 **로컬 .env 의 실값과 직접 대조**한다.
 *   2026-08-12 사고의 교훈: 테스트 픽스처에 복붙된 실키는 "키 패턴 0건" 검사를
 *   두 번 통과했다 — 픽스처는 키처럼 생긴 게 정상이라 패턴 검사로는 못 잡는다.
 *
 * 사용:
 *   node scripts/check-secrets.mjs           # git 추적 파일 전체 스캔 (prepublishOnly)
 *   node scripts/check-secrets.mjs --staged  # 스테이징된 내용만 스캔 (pre-commit)
 *
 * 비밀값 출처: 프로젝트 ./.env + ~/.gongsi-mcp/.env + ~/.dart-ftc-mcp/.env 의
 * *_KEY / *_TOKEN / *_SECRET 변수 (12자 이상). 값은 어떤 경우에도 출력하지 않는다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

/** .env 파일들에서 비밀값 수집. 값 → 「파일의 변수명」 라벨 (값 자체는 절대 노출 금지) */
function collectSecrets() {
  const envPaths = [
    join(ROOT, '.env'),
    join(homedir(), '.gongsi-mcp', '.env'),
    join(homedir(), '.dart-ftc-mcp', '.env'),
  ];
  const secrets = new Map();
  for (const p of envPaths) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]*(?:KEY|TOKEN|SECRET)[A-Z0-9_]*)\s*=\s*(.+?)\s*$/.exec(line);
      if (!m) continue;
      const value = m[2].replace(/^["']|["']$/g, '');
      if (value.length >= 12 && !secrets.has(value)) secrets.set(value, m[1]);
    }
  }
  return secrets;
}

/** 스캔 대상: [표시경로, 내용 로더] 목록 */
function targets(staged) {
  if (staged) {
    const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z']).split('\0').filter(Boolean);
    return files.map((f) => [f, () => git(['show', `:${f}`])]);
  }
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
  return files.map((f) => [f, () => readFileSync(join(ROOT, f), 'utf8')]);
}

const staged = process.argv.includes('--staged');
const secrets = collectSecrets();
if (secrets.size === 0) {
  console.log('check-secrets: 대조할 비밀값이 없습니다 (.env 미존재) — 스캔 생략');
  process.exit(0);
}

const hits = [];
let scanned = 0;
for (const [file, load] of targets(staged)) {
  let content;
  try {
    content = load();
  } catch {
    continue; // 삭제 직전 파일 등 — 읽기 실패는 건너뛴다
  }
  scanned++;
  for (const [value, label] of secrets) {
    if (content.includes(value)) hits.push({ file, label });
  }
}

if (hits.length > 0) {
  console.error(`\n🚨 실제 비밀값이 ${staged ? '커밋 대상' : '추적 파일'}에서 발견됐습니다 — 차단합니다.\n`);
  for (const h of hits) console.error(`   ${h.file}  ←  .env 의 ${h.label} 실값과 일치`);
  console.error('\n   픽스처가 필요하면 합성 더미를 쓰세요 (예: 0123456789abcdef... 40자).');
  console.error('   이미 커밋된 이력이 있다면 filter-repo --replace-text 로 소거해야 합니다.\n');
  process.exit(1);
}
console.log(`check-secrets: 통과 — ${scanned}개 파일 × 비밀값 ${secrets.size}종 대조, 일치 0건`);
