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
  extractMajorGoodsServices,
  parseLooseDate,
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
