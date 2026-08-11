import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { EgroupClient } from '../src/clients/egroup.js';
import { Store, __setStore } from '../src/lib/store.js';
import { findGroupByJurirNo } from '../src/tools/resolve-entity.js';

/**
 * P0-3 회귀 고정 — 계열사 캐시 오염 (함정 11번 재발 경로).
 *
 * 종전 동작: ① 빈 계열사 응답도 `egroup_affiliates:{ym}:{code}` 에 무조건 캐시 →
 * 같은 키를 쓰는 get_group_structure("삼성") 이 "계열사 0개"를 정상 응답으로 반환.
 * ② 집단 목록이 비어도 순회 0회 후 `jurir_group_miss` 기록 → "기업집단 미소속 = 공시의무 없음" 박제.
 * store 에는 TTL 이 없어 키의 연월이 바뀔 때까지 영구다.
 */

const YM = '202605';
const JURIR = '1101110000001';

function groupsXml(items: string, total: number): string {
  return (
    `<appnGroupSttusList><resultCode>00</resultCode><resultMsg>OK</resultMsg>` +
    `<totalCount>${total}</totalCount>${items}</appnGroupSttusList>`
  );
}

function affXml(items: string, total: number): string {
  return (
    `<appnGroupAffiList><resultCode>00</resultCode><resultMsg>OK</resultMsg>` +
    `<totalCount>${total}</totalCount>${items}</appnGroupAffiList>`
  );
}

const GROUP_ITEM =
  '<appnGroupSttus><unityGrupNm>삼성</unityGrupNm><unityGrupCode>K1000032</unityGrupCode>' +
  '<smerNm>동일인</smerNm><repreCmpny>삼성전자(주)</repreCmpny><sumCmpnyCo>67</sumCmpnyCo>' +
  '<invstmntLmtt>Y</invstmntLmtt></appnGroupSttus>';

function affItem(jurirno: string, name = '삼성전자(주)'): string {
  return (
    `<appnGroupAffi><entrprsNm>${name}</entrprsNm><jurirno>${jurirno}</jurirno>` +
    `<bizrno>1248100998</bizrno><rprsntvNm>대표</rprsntvNm><fondDe>19690113</fondDe>` +
    `<grinil>19870401</grinil></appnGroupAffi>`
  );
}

function stubPortal(groupsBody: string, affBody: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('appnGroupSttusList')) return new Response(groupsBody, { status: 200 });
      if (u.includes('appnGroupAffiList')) return new Response(affBody, { status: 200 });
      throw new Error(`예상치 못한 호출: ${u}`);
    }),
  );
}

describe('resolve_entity — 계열사 캐시 오염 방지 (P0-3)', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
    __setStore(store);
  });

  afterEach(() => {
    __setStore(null);
    store.close();
    vi.unstubAllGlobals();
  });

  it('집단 목록이 비면 미소속으로 단정하지 않고 group_not_found 를 던진다 (miss 캐시 금지)', async () => {
    stubPortal(groupsXml('', 0), affXml('', 0));
    const client = new EgroupClient('test-key');
    await expect(findGroupByJurirNo(client, JURIR, YM)).rejects.toMatchObject({
      code: 'group_not_found',
    });
    expect(store.get(`jurir_group_miss:${YM}:${JURIR}`)).toBeNull();
  });

  it('계열사 목록이 빈 응답이면 캐시하지 않고 미소속도 단정하지 않는다', async () => {
    stubPortal(groupsXml(GROUP_ITEM, 1), affXml('', 0));
    const client = new EgroupClient('test-key');
    await expect(findGroupByJurirNo(client, JURIR, YM)).rejects.toMatchObject({
      code: 'egroup_api_error',
    });
    // 빈 배열이 캐시에 박제되면 get_group_structure 가 "계열사 0개"를 정상 응답으로 낸다
    expect(store.get(`egroup_affiliates:${YM}:K1000032`)).toBeNull();
    expect(store.get(`jurir_group_miss:${YM}:${JURIR}`)).toBeNull();
  });

  it('정상 전수 순회 후 진짜 미소속이면 miss 를 기록하고 계열사 목록은 캐시한다 (기존 동작 유지)', async () => {
    stubPortal(groupsXml(GROUP_ITEM, 1), affXml(affItem('9999999999999', '다른회사(주)'), 1));
    const client = new EgroupClient('test-key');
    const r = await findGroupByJurirNo(client, JURIR, YM);
    expect(r).toBeNull();
    expect(store.get(`jurir_group_miss:${YM}:${JURIR}`)).toBe('1');
    const cached = store.get(`egroup_affiliates:${YM}:K1000032`);
    expect(cached).not.toBeNull();
    expect((JSON.parse(cached!) as unknown[]).length).toBe(1);
  });

  it('과거에 오염된 빈 캐시([])는 무시하고 다시 받아 자가 치유한다', async () => {
    store.set(`egroup_affiliates:${YM}:K1000032`, '[]');
    stubPortal(groupsXml(GROUP_ITEM, 1), affXml(affItem('110111-0000001'), 1));
    const client = new EgroupClient('test-key');
    const r = await findGroupByJurirNo(client, JURIR, YM);
    expect(r).not.toBeNull();
    expect(r!['name']).toBe('삼성');
    // 캐시가 실제 목록으로 교체됐다
    const cached = store.get(`egroup_affiliates:${YM}:K1000032`);
    expect((JSON.parse(cached!) as unknown[]).length).toBe(1);
  });
});
