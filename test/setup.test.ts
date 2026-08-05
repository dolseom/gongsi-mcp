import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { defaultEnvTarget, isSymlink, parseSetupArgs, upsertEnvContent } from '../src/setup.js';

describe('setup — .env 갱신', () => {
  it('빈 내용에 키를 추가한다', () => {
    expect(upsertEnvContent('', { DART_API_KEY: 'abc' })).toBe('DART_API_KEY=abc\n');
  });

  it('기존 키는 제자리에서 갱신하고 주석·다른 줄은 보존한다', () => {
    const existing = '# 주석\nDART_API_KEY=old\nGONGSI_LOG_LEVEL=DEBUG\n';
    const out = upsertEnvContent(existing, { DART_API_KEY: 'new', EGROUP_API_KEY: 'e1' });
    expect(out).toBe('# 주석\nDART_API_KEY=new\nGONGSI_LOG_LEVEL=DEBUG\nEGROUP_API_KEY=e1\n');
  });

  it('CRLF 파일도 처리한다', () => {
    const out = upsertEnvContent('DART_API_KEY=old\r\nX=1\r\n', { DART_API_KEY: 'new' });
    expect(out).toContain('DART_API_KEY=new');
    expect(out).toContain('X=1');
  });

  it('공백 있는 `KEY = value` 줄도 같은 키로 인식해 갱신한다', () => {
    const out = upsertEnvContent('DART_API_KEY = old\n', { DART_API_KEY: 'new' });
    expect(out).toBe('DART_API_KEY=new\n');
  });
});

describe('setup — 인자 파싱', () => {
  it('--키=값 과 --키 값 두 형태를 다 받는다', () => {
    const a = parseSetupArgs(['--dart-key=k1', '--egroup-key', 'k2', '--no-input']);
    expect(a.dartKey).toBe('k1');
    expect(a.egroupKey).toBe('k2');
    expect(a.noInput).toBe(true);
  });

  it('--help 를 인식한다', () => {
    expect(parseSetupArgs(['--help']).help).toBe(true);
  });
});

describe('setup — .env 위치 결정', () => {
  it('gongsi-mcp 클론 안에서는 프로젝트 .env 를 쓴다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gongsi-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'gongsi-mcp' }));
    const t = defaultEnvTarget(dir);
    expect(t.kind).toBe('project');
    expect(t.path).toBe(join(dir, '.env'));
  });

  it('다른 디렉터리에서는 홈 ~/.gongsi-mcp/.env 를 쓴다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gongsi-other-'));
    const t = defaultEnvTarget(dir);
    expect(t.kind).toBe('home');
    expect(t.path.endsWith(`.gongsi-mcp${sep}.env`)).toBe(true);
  });

  it('package.json 이 깨져 있으면 홈으로 폴백한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gongsi-broken-'));
    writeFileSync(join(dir, 'package.json'), '{not json');
    expect(defaultEnvTarget(dir).kind).toBe('home');
  });
});

describe('setup — symlink 방어 (Codex 3차 백로그)', () => {
  it('일반 파일·미존재 경로는 심볼릭 링크가 아니다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gongsi-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'DART_API_KEY=x\n');
    expect(isSymlink(file)).toBe(false);
    expect(isSymlink(join(dir, 'no-such-file'))).toBe(false);
  });
});
