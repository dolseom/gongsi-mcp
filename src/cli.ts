#!/usr/bin/env node
/**
 * bin 진입점 — 인자 없이 실행하면 MCP 서버(stdio), `setup` 이면 설치 마법사.
 *
 * ⚠️ 서버 경로에서는 stdout 이 MCP 프로토콜 전용이므로 여기서도 stdout 출력 금지.
 *    usage 안내는 stderr 로 낸다.
 */

const cmd = process.argv[2];

if (cmd === 'setup') {
  const { runSetup } = await import('./setup.js');
  // process.exit() 는 Windows 에서 잔여 fetch 타이머 핸들과 겹치면 libuv 단언 실패로 죽는다
  // (실측: "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"). 자연 종료를 쓴다.
  process.exitCode = await runSetup(process.argv.slice(3));
} else if (cmd === undefined || cmd === 'serve') {
  await import('./index.js');
} else {
  console.error(
    [
      `알 수 없는 명령입니다: ${cmd}`,
      '',
      '사용법:',
      '  dart-ftc-mcp          MCP 서버 시작 (stdio)',
      '  dart-ftc-mcp setup    설치 마법사 (API 키 검증·.env 생성)',
    ].join('\n'),
  );
  process.exitCode = 1;
}
