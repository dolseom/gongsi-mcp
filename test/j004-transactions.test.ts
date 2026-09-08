/**
 * J004 거래내역·자본 추출 파서 테스트
 *
 * 픽스처는 실물 대표회사 서식(미래에셋 20260601001646)의 표 구조를 그대로 옮기고
 * 행만 줄인 것이다 — 헤더 다층 구조·소계/합계 행·단위 캡션 위치가 실물과 같다.
 * 실물 전체 문서에 대한 측정값(자본 24개사 / 차입 3건 / 상품용역 12건)은 2026-08-27 확인.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  extractCapitals,
  extractFundBorrowings,
  extractGroupName,
  extractMajorGoodsServices,
  parseLooseDate,
  readLabeledTables,
  sliceSection,
  diagnose,
} from '../src/parsers/j004-transactions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const md = readFileSync(join(HERE, 'fixtures', 'j004-transactions.md'), 'utf-8');

describe('절 찾기', () => {
  it('절 번호가 아니라 제목으로 찾는다 (서식마다 번호가 다르다)', () => {
    // 대표회사 서식은 §7, 개별회사 서식은 §6 이다 — 번호로 앵커하면 한쪽이 깨진다
    const sec = sliceSection(md, '계열회사간 자금거래 현황');
    expect(sec).toBeTruthy();
    expect(sec!).toContain('일반 차입');
    expect(sec!).not.toContain('주요 상품ㆍ용역거래 내역');
  });

  it('없는 절은 null 을 돌려준다 (빈 배열로 뭉개지 않는다)', () => {
    expect(sliceSection(md, '존재하지 않는 절')).toBeNull();
  });
});

describe('단위 캡션 격리', () => {
  it('단위는 표마다 새로 읽는다 — 직전 표 단위를 계승하지 않는다 (교차검토 M-1)', () => {
    const md = [
      '## (1) 계열회사간 자금거래 현황',
      '가. 일반 차입',
      '| (단위 : 백만원) |',
      '| --- |',
      '| 차입회사 (소속회사) |  | 거래상대방 | 차입금액 | 차입일 |',
      '| --- | --- | --- | --- | --- |',
      '| 비금융회사 | 갑(주) | 을(주) | 1,000 | 2025-01-10 |',
      '',
      '나. 한도 약정에 따른 차입',
      '| 차입회사 (소속회사) |  | 거래상대방 | 차입금액 | 차입일 |',
      '| --- | --- | --- | --- | --- |',
      '| 비금융회사 | 병(주) | 정(주) | 2,000 | 2025-02-10 |',
    ].join('\n');
    // 두 번째 표는 캡션이 없다 — 백만원을 계승하면 20억이 조용히 만들어진다.
    // 단위를 모르는 표는 건너뛰는 것이 불변식이다.
    const rows = extractFundBorrowings(md);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.company).toBe('갑(주)');
    expect(diagnose(md).tables_without_unit).toBeGreaterThanOrEqual(1);
  });

  /**
   * ★ 실물(카카오 20260610000659)의 캡션은 **2열**이다:
   *   `| 표 | (직전 사업연도 개시일 ~ 종료일 기준, 단위 : 백만원) |`
   * 1열만 캡션으로 보면 이 줄이 표 헤더로 섞이고 단위는 null 이 되어, "단위를 모르면
   * 건너뛴다" 불변식에 걸려 표가 통째로 버려진다 — 그 문서에서 (5) 12표·(3) 2표·재무현황이
   * 전부 사라져 판정 가능한 것이 하나도 없었다.
   */
  it('2열 캡션도 단위로 읽는다 (실물 카카오 서식)', () => {
    const md = [
      '## (1) 계열회사간 자금거래 현황',
      '가. 일반 차입',
      '| 표 | (직전 사업연도 개시일 ~ 종료일 기준, 단위 : 백만원) |',
      '| --- | --- |',
      '| 차입회사 (소속회사) |  | 거래상대방 | 차입금액 | 차입일 |',
      '| --- | --- | --- | --- | --- |',
      '| 비금융회사 | 갑(주) | 을(주) | 1,000 | 2025-01-10 |',
    ].join('\n');
    const rows = extractFundBorrowings(md);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(1_000 * 1_000_000);
    expect(diagnose(md).tables_without_unit).toBe(0);
  });

  it('2열이어도 **단위가 없으면** 캡션으로 삼키지 않는다 — 데이터 표가 조용히 사라지면 안 된다', () => {
    const md = [
      '## (1) 계열회사간 자금거래 현황',
      '가. 일반 차입',
      '| (단위 : 백만원) |',
      '| --- |',
      '| 차입회사 (소속회사) | 거래상대방 |',
      '| --- | --- |',
      '| 갑(주) | 을(주) |',
    ].join('\n');
    // 2열 데이터 행이 캡션으로 삼켜지면 이 표는 행 0 이 된다
    const tables = readLabeledTables(md);
    const t = tables.find((x) => x.rows.length > 0);
    expect(t).toBeDefined();
    expect(t!.rows[0]).toEqual(['갑(주)', '을(주)']);
  });
});

describe('자본 수치 추출 (기준금액 계산용)', () => {
  const caps = extractCapitals(md);

  it('계열사별 자본금·자본총계를 원 단위로 돌려준다', () => {
    const mirae = caps.find((c) => c.company === '미래에셋캐피탈(주)')!;
    // 백만원 단위 캡션을 읽어 환산한다 — 가정하면 1,000배가 틀어진다
    expect(mirae.paidInCapital).toBe(126_937 * 1_000_000);
    expect(mirae.totalEquity).toBe(1_471_955 * 1_000_000);
  });

  it('합계 행은 계열사로 세지 않는다', () => {
    expect(caps.some((c) => c.company.includes('합계'))).toBe(false);
  });

  it("'자본잠식' 같은 비수치는 null 로 두고 0 으로 뭉개지 않는다", () => {
    const broke = caps.find((c) => c.company === '자본잠식회사(주)')!;
    expect(broke.totalEquity).toBeNull();
    expect(broke.paidInCapital).toBe(1_000 * 1_000_000);
  });

  it('부채비율 열이 자본총계로 오인되지 않는다', () => {
    // 헤더에 '부채비율 (부채총계/ 자본총계)' 가 있어 키워드만 보면 걸린다
    const yk = caps.find((c) => c.company === '와이케이디벨롭먼트(주)')!;
    expect(yk.totalEquity).toBe(20_000 * 1_000_000);
  });
});

/**
 * ★ 실물 40문서(2026-05~06 J004) 실측으로 잡은 결함 — 재무현황 절의 회사명 열 이름이
 * 문서마다 다르다: **`소속회사명` 39표 vs `계열회사명` 1표**(미래에셋, 우리 개발 표본).
 * 파서가 '계열회사명' 하나만 찾고 있어 **40문서 중 39문서에서 재무현황이 0행**이었다.
 *
 * 재무현황이 없으면 기준금액(령 §33① = min(100억, max(5억, max(자본총계, 자본금) × 5%)))을
 * 계산하지 못해 판정이 전부 `threshold_unknown` 으로 떨어진다 — 실제로 케이티 문서에서
 * 상대방 관점 판정 불가가 432건이었고, 이 수정 뒤 52건이 됐다.
 */
describe('재무현황 회사명 열 이름 변형 (실물 39/40 문서가 소속회사명)', () => {
  const 백만 = 1_000_000;
  const build = (companyHeader: string): string =>
    [
      '## (2) 회사 재무현황',
      '| : 개별 재무상태표 기준 재무현황 |',
      '| --- |',
      '| (직전 사업연도말 기준, 단위 : 백만원, %) |',
      '| --- |',
      `| ${companyHeader} |  | 자산 |  | 부채 |  | 자본 |  | 부채비율(부채총계/자본총계) |`,
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      `| ${companyHeader} |  | 유동자산(a) | 자산총계(a+b) | 유동부채(c) | 부채총계(c+d) | 자본금 | 자본총계 | 부채비율(부채총계/자본총계) |`,
      '| 비금융회사 | 갑회사(주) | 100 | 200 | 30 | 50 | 1,000 | 10,000 | 0.50 |',
    ].join('\n');

  it("실물 표준인 '소속회사명' 헤더를 읽는다", () => {
    const rows = extractCapitals(build('소속회사명'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.company).toBe('갑회사(주)');
    expect(rows[0]!.paidInCapital).toBe(1_000 * 백만);
    expect(rows[0]!.totalEquity).toBe(10_000 * 백만);
  });

  it("종전 표기 '계열회사명' 도 계속 읽는다 (회귀 방지)", () => {
    const rows = extractCapitals(build('계열회사명'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.totalEquity).toBe(10_000 * 백만);
  });

  it('부채비율 열이 자본총계로 오인되지 않는다 (소속회사명 변형에서도)', () => {
    const rows = extractCapitals(build('소속회사명'));
    // 부채비율 0.50 을 자본총계로 읽으면 값이 0.5백만원이 된다
    expect(rows[0]!.totalEquity).toBe(10_000 * 백만);
  });
});

describe('열 배치 변형 방어 (M-2)', () => {
  it('구분 열이 없는 변형에서 거래상대방을 차입회사로 오인하지 않는다', () => {
    // 실측 서식은 첫 열이 '금융/비금융 구분'이라 회사명이 cCompany+1 에 오지만,
    // 이 변형은 차입회사 바로 옆이 거래상대방이다 — 종전 로직은 대주를 차입회사로 읽었다
    // (대주의 공시가 실제 차입회사의 미공시를 은폐하는 거짓 안심 경로).
    const variant = [
      '## (1) 계열회사간 자금거래 현황',
      '가. 일반 차입',
      '| (단위 : 백만원) |',
      '| --- |',
      '| 차입회사 (소속회사) | 거래상대방 | 차입금액 | 차입일 |',
      '| --- | --- | --- | --- |',
      '| 갑(주) | 을(주) | 16,000 | 2025-02-19 |',
    ].join('\n');
    const rows = extractFundBorrowings(variant);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.company).toBe('갑(주)');
    expect(rows[0]!.counterparty).toBe('을(주)');
  });

  it('회사 = 거래상대방으로 읽힌 행은 쓰지 않고 진단으로 센다', () => {
    const suspicious = [
      '## (1) 계열회사간 자금거래 현황',
      '가. 일반 차입',
      '| (단위 : 백만원) |',
      '| --- |',
      '| 차입회사 (소속회사) |  | 거래상대방 | 차입금액 | 차입일 |',
      '| --- | --- | --- | --- | --- |',
      '| 비금융회사 | 을(주) | 을(주) | 16,000 | 2025-02-19 |',
    ].join('\n');
    expect(extractFundBorrowings(suspicious)).toHaveLength(0);
    expect(diagnose(suspicious).rows_company_equals_counterparty).toBe(1);
  });
});

describe('금액 파싱 실패 행의 진단 승격 (M-3)', () => {
  it("각주 붙은 금액('16,000 (주1)')은 추측하지 않되 소멸시키지 않고 센다", () => {
    const footnoted = [
      '## (1) 계열회사간 자금거래 현황',
      '가. 일반 차입',
      '| (단위 : 백만원) |',
      '| --- |',
      '| 차입회사 (소속회사) |  | 거래상대방 | 차입금액 | 차입일 |',
      '| --- | --- | --- | --- | --- |',
      '| 비금융회사 | 갑(주) | 을(주) | 16,000 (주1) | 2025-02-19 |',
      '| 비금융회사 | 갑(주) | 을(주) | 12,000 | 2025-06-30 |',
    ].join('\n');
    const rows = extractFundBorrowings(footnoted);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(12_000 * 1_000_000);
    // 다른 행이 추출됐어도 "못 읽은 행이 있다"는 사실이 진단에 남는다
    expect(diagnose(footnoted).rows_amount_unparsable).toBe(1);
  });
});

describe('자금 차입 추출', () => {
  const rows = extractFundBorrowings(md);

  it('개별 차입 건만 뽑고 소계·합계는 뺀다', () => {
    // 소계·합계를 세면 금액이 두 배가 된다
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.amount)).toEqual([16_000 * 1_000_000, 12_000 * 1_000_000]);
  });

  it('거래상대방과 차입일을 함께 준다 (J001 대조의 핵심)', () => {
    expect(rows[0]!.company).toBe('와이케이디벨롭먼트(주)');
    expect(rows[0]!.counterparty).toBe('미래에셋컨설팅(주)');
    expect(rows[0]!.date).toBe('20250219');
    expect(rows[0]!.label).toBe('가. 일반 차입');
  });

  it('리스부채 표는 차입금액 열이 없어 섞이지 않는다', () => {
    expect(rows.some((r) => r.counterparty === '미래에셋자산운용(주)')).toBe(false);
  });
});

describe('주요 상품·용역거래 추출', () => {
  const rows = extractMajorGoodsServices(md);

  it('개별 품목 행만 뽑는다', () => {
    expect(rows).toHaveLength(2);
    expect(rows[0]!.item).toBe('골프장운영');
    expect(rows[0]!.annualAmount).toBe(5_890 * 1_000_000);
  });

  it("'소 계'(공백 포함)와 '비금융회사 소계' 도 집계 행으로 걸러낸다", () => {
    expect(rows.some((r) => r.annualAmount === 7_189 * 1_000_000)).toBe(false);
  });

  it("'소계(주1)' 같은 각주 접미 변형도 집계 행이다 (S-8)", () => {
    const variant = [
      '## (6) 계열회사간 주요 상품ㆍ용역거래 내역',
      '| (단위 : 백만원) |',
      '| --- |',
      '| 소속회사명 |  | 거래상대방 | 품목 | 매출액 |',
      '| --- | --- | --- | --- | --- |',
      '| 비금융회사 | 갑(주) | 을(주) | 경비용역 | 1,000 |',
      '| 비금융회사 | 갑(주) | 을(주) | 소계(주1) | 1,000 |',
    ].join('\n');
    const out = extractMajorGoodsServices(variant);
    expect(out).toHaveLength(1);
    expect(out[0]!.item).toBe('경비용역');
  });
});

describe('날짜 파싱', () => {
  it('실측 표기들을 처리한다', () => {
    expect(parseLooseDate('2025-02-19')).toBe('20250219');
    expect(parseLooseDate('2025.2.19')).toBe('20250219');
    expect(parseLooseDate('2025년 2월 19일')).toBe('20250219');
  });

  it('실존하지 않는 날짜는 round-trip 으로 거부한다', () => {
    // 원문 오기를 조용히 3월로 롤오버시키면 기한 판정이 통째로 틀어진다
    expect(parseLooseDate('2026-02-31')).toBeNull();
    expect(parseLooseDate('알 수 없음')).toBeNull();
  });
});

describe('진단', () => {
  it('찾은 절과 못 찾은 절을 밝힌다', () => {
    const d = diagnose(md);
    expect(d.sections_found).toEqual(['재무현황', '자금거래', '주요 상품·용역']);
    expect(d.sections_missing).toEqual([]);
    expect(d.capital_rows).toBe(3);
    expect(d.fund_borrowings).toBe(2);
    expect(d.goods_services).toBe(2);
    expect(d.tables_without_unit).toBe(0);
  });

  it('절이 아예 없는 문서면 없다고 말한다 (0건과 구분된다)', () => {
    const d = diagnose('# 다른 공시\n\n내용 없음');
    expect(d.sections_missing).toEqual(['재무현황', '자금거래', '주요 상품·용역']);
    expect(d.fund_borrowings).toBe(0);
  });
});

describe('기업집단명 추출 (rcept_no 경로 포털 조인용)', () => {
  it('표지의 "기업집단명" 행에서 집단명을 읽는다 (실물 20260819000341 과 같은 형태)', () => {
    expect(extractGroupName(md)).toBe('미래에셋');
  });

  it('콜론 위치·공백 변형을 흡수한다', () => {
    expect(extractGroupName('| 기업집단 명 | : 삼성 |')).toBe('삼성');
    expect(extractGroupName('| 기업집단명: | 에스케이 |')).toBe('에스케이');
  });

  it('행이 없거나 값이 비면 null — 추측하지 않는다', () => {
    expect(extractGroupName('# 다른 공시\n\n내용 없음')).toBeNull();
    expect(extractGroupName('| 기업집단명 : |  |')).toBeNull();
    expect(extractGroupName('| 기업집단명 : | - |')).toBeNull();
  });
});
