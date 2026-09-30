/**
 * 테스트마다 새 인메모리 저장소를 전역 싱글턴으로 끼우고, 끝나면 해제·닫는다.
 *
 * 부른 범위(파일 최상위 또는 describe 안)에 beforeEach/afterEach 를 등록하고
 * **현재 테스트의 저장소를 돌려주는 getter** 를 반환한다 — 테스트마다 인스턴스가 바뀌므로 값이 아니라 함수다.
 *
 * 시딩이 필요하면 이 호출 **뒤에** beforeEach 를 등록할 것 (beforeEach 는 등록 순서대로 돈다).
 *
 * @example
 *   const store = useMemoryStore();
 *   beforeEach(() => store().upsertCorps([...]));
 *   it('...', () => expect(store().get('k')).toBeNull());
 */
import { afterEach, beforeEach } from 'vitest';
import { Store, __setStore } from '../../src/lib/store.js';

export function useMemoryStore(): () => Store {
  let current: Store | null = null;
  beforeEach(() => {
    current = new Store(':memory:');
    __setStore(current);
  });
  afterEach(() => {
    __setStore(null);
    current?.close();
    current = null;
  });
  return () => {
    if (!current) throw new Error('useMemoryStore: 테스트(beforeEach 이후) 밖에서 저장소를 읽었습니다');
    return current;
  };
}
