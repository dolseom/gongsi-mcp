/**
 * detect_undisclosed_transactions — action_items — 조치 필요 판정을 바구니를 가로질러 앞으로
 * (공용 헬퍼·픽스처 수치는 test/helpers/detect-deps.ts)
 */

import { describe, it, expect } from 'vitest';
import { detectUndisclosedTransactions } from '../src/tools/detect-undisclosed-transactions.js';
import { makeDeps, useMemoryStore } from './helpers/detect-deps.js';

useMemoryStore();

/**
 * ★ 상태별 바구니는 **매출(매도)회사 관점**으로 이름이 붙어 있다. 거래 한 건에는 의무자가 둘이라
 * (매뉴얼 lit26-001, 기준금액은 각자의 자본), 매출회사 기준 미달인 건이 **매입회사 기준으로는
 * 후보**일 수 있다. 실측(케이티 20260617000447): `goods_services_matrix_below_threshold` 421건
 * **안에** buyer_side 조건부 후보 8건·확인 대상 21건이 들어 있었다 — 실무자가 "기준 미달"
 * 바구니를 열어볼 이유가 없으니 그대로 묻힌다.
 */
describe('action_items — 조치가 필요한 판정을 바구니를 가로질러 앞으로 모은다', () => {
  const 백만 = 1_000_000;
  /**
   * 갑회사 기준금액 = min(100억, max(5억, max(자본총계 2000억, 자본금 10억) × 5%)) = 100억
   * 을회사 기준금액 = min(100억, max(5억, max(자본총계 100억, 자본금 10억) × 5%)) = 5억
   * → 연간 30억 거래는 갑(매출) 기준 미달이지만, 을(매입) 기준으로는 4×5억=20억 이상이다.
   */
  const MD = [
    '| 기업집단명 : | 테스트집단 |',
    '| --- | --- |',
    '## (2) 회사 재무현황',
    '| (단위 : 백만원, %) |',
    '| --- |',
    '| 소속회사명 |  | 자본금 | 자본총계 |',
    '| --- | --- | --- | --- |',
    '| 비금융회사 | 갑회사(주) | 1,000 | 200,000 |',
    '| 비금융회사 | 을회사(주) | 1,000 | 10,000 |',
    '## (6) 계열회사간 주요 상품ㆍ용역거래 내역',
    '나. 비상장회사와 그 계열회사간 주요 상품ㆍ용역거래 내역 (연1회)',
    '| (직전 사업연도 개시일 ~ 종료일 기준, 단위 : 백만원) |',
    '| --- |',
    '| 소속회사명 |  | 거래상대방 | 업종 | 품목 | 대금지급조건 | 거래상대방 선정방식 | 매출액 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| 비금융회사 | 갑회사(주) | 을회사(주) | C1000(제조업) | 부품 | 현금 | 수의계약 | 3,000 |',
  ].join('\n');
  const CORPS = {
    갑회사: [{ corpCode: '00000001', corpName: '갑회사' }],
    을회사: [{ corpCode: '00000002', corpName: '을회사' }],
  };

  async function run(): Promise<Record<string, any>> {
    return (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: MD, corps: CORPS, j001: [] }),
    )) as Record<string, any>;
  }

  it('매출회사 기준 미달이어도 **매입회사 기준 후보**를 앞으로 끌어낸다', async () => {
    const r = await run();
    const ai = r['action_items'];
    expect(ai).toBeDefined();
    // 본 신호(갑 관점)는 4×100억에 못 미쳐 판정 불가 바구니에 있다
    const g = (r['goods_services_not_judgeable'] as Array<Record<string, any>>)[0]!;
    expect(g['company']).toBe('갑회사(주)');
    expect(g['quarterly_logic']).toBe('annual_below_4x_threshold');
    // 그런데 매입회사(을) 기준으로는 조치 대상이고, action_items 가 그것을 잡아낸다
    const fromBuyer = (ai.items as Array<Record<string, any>>).filter(
      (i) => i['perspective'] === '거래상대방',
    );
    expect(fromBuyer.length).toBeGreaterThan(0);
    expect(fromBuyer[0]!['company']).toBe('을회사(주)');
    expect(fromBuyer[0]!['counterparty']).toBe('갑회사(주)');
    // 원래 배열 이름을 남겨 근거로 되돌아갈 수 있어야 한다
    expect(fromBuyer[0]!['source']).toBe('goods_services_not_judgeable');
    expect(fromBuyer[0]!['threshold_display']).toBe('5억원');
  });

  it('우선순위 순으로 정렬한다 (미공시 후보 → 조건부 후보 → 확인 대상)', async () => {
    const r = await run();
    const items = r['action_items'].items as Array<Record<string, any>>;
    const ps = items.map((i) => i['priority'] as number);
    expect([...ps]).toEqual([...ps].sort((a, b) => a - b));
  });

  it('같은 우선순위 안에서는 숫자 금액 큰 순이다 (표시 문자열 길이가 아니라)', async () => {
    // '150억원'(5자)이 '99.5억원'(6자)보다 뒤로 가던 결함의 회귀 고정
    const md = MD.replace(
      '| 비금융회사 | 을회사(주) | 1,000 | 10,000 |',
      '| 비금융회사 | 을회사(주) | 1,000 | 10,000 |\n| 비금융회사 | 병회사(주) | 1,000 | 10,000 |',
    ).replace(
      '| 비금융회사 | 갑회사(주) | 을회사(주) | C1000(제조업) | 부품 | 현금 | 수의계약 | 3,000 |',
      '| 비금융회사 | 갑회사(주) | 병회사(주) | C1000(제조업) | 부품 | 현금 | 수의계약 | 9,950 |\n' +
        '| 비금융회사 | 갑회사(주) | 을회사(주) | C1000(제조업) | 부품 | 현금 | 수의계약 | 15,000 |',
    );
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ markdown: md, corps: { ...CORPS, 병회사: [{ corpCode: '00000003', corpName: '병회사' }] }, j001: [] }),
    )) as Record<string, any>;
    const buyers = (r['action_items'].items as Array<Record<string, any>>).filter(
      (i) => i['perspective'] === '거래상대방',
    );
    expect(buyers.map((i) => i['amount_display'])).toEqual(['150억원', '99.5억원']);
    expect(buyers[0]!['priority']).toBe(buyers[1]!['priority']);
  });

  it('닫힌 판정(기준 미달·국외)은 목록에 넣지 않는다 — 조치할 것만 담는다', async () => {
    const r = await run();
    const items = r['action_items'].items as Array<Record<string, any>>;
    expect(items.some((i) => i['status'] === 'below_threshold')).toBe(false);
    expect(items.some((i) => i['status'] === 'not_applicable_foreign_affiliate')).toBe(false);
  });

  it('비어 있어도 "이상 없음"이 아님을 note 에 박아 둔다', async () => {
    const r = await run();
    expect(String(r['action_items'].note)).toContain('"이상 없음"이 아닙니다');
    expect(String(r['action_items'].note)).toContain('거래상대방');
  });
});
