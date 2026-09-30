import { configDefaults, defineConfig } from 'vitest/config';

/**
 * `node:sqlite` 로드는 src/lib/store.ts 가 `createRequire` 로 처리한다 (사유는 그 파일 주석 참조).
 * 여기서는 experimental 경고만 테스트 출력에서 걷어낸다.
 */
export default defineConfig({
  test: {
    // 에이전트 git worktree(.claude/worktrees)·로컬 증거(.omo)의 사본 테스트까지 수집하지 않는다
    exclude: [...configDefaults.exclude, '.claude/**', '.omo/**'],
    // OpenDART 송신 간격은 가짜 fetch 테스트를 느리게만 한다 — 간격 자체는 dart-gate 테스트가 env 를 바꿔 검증한다
    env: { GONGSI_DART_MIN_INTERVAL_MS: '0' },
    setupFiles: ['test/helpers/setup-dart-gate.ts'],
    onConsoleLog(logText) {
      if (logText.includes('ExperimentalWarning') && logText.includes('SQLite')) return false;
      return undefined;
    },
  },
});
