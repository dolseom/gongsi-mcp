/**
 * OpenDART 송신 제어(src/clients/dart.ts 의 전역 gate)는 프로세스 전역 상태다 — 한 테스트가 연 차단기가
 * 다음 테스트의 호출을 막지 않도록 매 테스트 전에 비운다. 송신 간격은 vitest.config 의 env 로 0 (가짜 fetch).
 */
import { beforeEach } from 'vitest';
import { __resetDartGate } from '../../src/clients/dart.js';

beforeEach(() => {
  __resetDartGate();
});
