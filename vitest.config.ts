import { defineConfig } from 'vitest/config';

/**
 * `node:sqlite` 로드는 src/lib/store.ts 가 `createRequire` 로 처리한다 (사유는 그 파일 주석 참조).
 * 여기서는 experimental 경고만 테스트 출력에서 걷어낸다.
 */
export default defineConfig({
  test: {
    onConsoleLog(logText) {
      if (logText.includes('ExperimentalWarning') && logText.includes('SQLite')) return false;
      return undefined;
    },
  },
});
