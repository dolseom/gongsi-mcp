/**
 * detect_undisclosed_transactions — 유형 미상 J001 — 판정 보류 · 원문 거래상대방 대조
 * (공용 헬퍼·픽스처 수치는 test/helpers/detect-deps.ts)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  detectUndisclosedTransactions,
  parseAmbiguousFilingDoc,
  parseFilingCounterparties,
  classifyAmbiguousSubject,
} from '../src/tools/detect-undisclosed-transactions.js';
import type { Disclosure } from '../src/clients/dart.js';
import {
  FIXTURE_MD,
  disc,
  makeDeps,
  YKD_CORPS,
  doc80708,
  doc80718,
  useMemoryStore,
} from './helpers/detect-deps.js';

const HERE = dirname(fileURLToPath(import.meta.url));
useMemoryStore();

/**
 * 보고서명만으로 유형을 알 수 없는 J001 이 창 안에 있으면 후보로 단정하지 않는다.
 *
 * ★ 실측 근거 (전체시장 2024-01~2026-09 J001 22,794건, test/j001-report-names.test.ts):
 *   '특수관계인과의내부거래' 740건 · '약관에의한금융거래시계열금융회사의거래상대방의공시' 447건.
 *   전자는 실물 20260903000201 에서 **벤처투자조합 출자**를, 후자는 실물 20260902000068 에서
 *   **차입금 415.2억**을 이 이름으로 공시했다 — 우리 유형 필터에 하나도 걸리지 않는다.
 */
describe('유형 미상 J001 이 있으면 판정을 보류한다', () => {
  it('자금차입 후보가 유형 미상 공시 때문에 not_judged 로 내려간다', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [
          disc({
            corp_code: '00222222',
            // 실물 서식명 — 차입을 이 이름으로 공시한 사례가 있다
            report_nm: '약관에의한금융거래시계열금융회사의거래상대방의공시',
            rcept_no: '20250220000111',
            rcept_dt: '20250220',
          }),
        ],
      }),
    )) as Record<string, any>;

    expect(res['summary'].undisclosed_candidates).toBe(0);
    expect(res['summary'].not_judged).toBe(2);
    const nj = (res['not_judged'] as Array<Record<string, any>>)[0]!;
    expect(String(nj['reason'])).toContain('type_ambiguous_filing_present');
    expect(String(nj['reason'])).toContain('공시 있음"으로 확인한 것이 아닙니다');
    expect(nj['type_ambiguous_filings']).toHaveLength(1);
    expect(nj['type_ambiguous_filings'][0].rcept_no).toBe('20250220000111');
  });

  it('유형이 이름에 드러나는 공시는 종전대로 filing 으로 처리한다', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인으로부터자금차입',
            rcept_no: '20250214000777',
            rcept_dt: '20250214',
          }),
        ],
        // 유형이 이름으로 확정돼도 **상대방까지** 원문으로 확인해야 "공시 존재"다 (Codex P0)
        docs: { '20250214000777': doc80718('미래에셋컨설팅(주)') },
      }),
    )) as Record<string, any>;
    expect(res['summary'].j001_filing_near_date).toBe(1);
    expect(res['summary'].not_judged).toBe(0);
  });

  it('유형이 이름에 드러나도 원문 상대방이 다르면 후보가 아니라 보류다 (Codex P0)', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인으로부터자금차입',
            rcept_no: '20250214000777',
            rcept_dt: '20250214',
          }),
        ],
        // 같은 회사·같은 유형·같은 창이지만 **다른 상대방**에게서 빌린 건의 공시다
        docs: { '20250214000777': doc80718('전혀다른계열사(주)') },
      }),
    )) as Record<string, any>;
    expect(res['summary'].j001_filing_near_date).toBe(0);
    // ★ 후보로 내리지 않는다 — 표기 차이일 수 있다 (제9호 ↔ 제구호)
    expect(res['summary'].undisclosed_candidates).toBe(0);
    expect(res['summary'].not_judged).toBe(2);
    const nj = (res['not_judged'] as Array<Record<string, any>>)[0]!;
    expect(String(nj['reason'])).toContain('type_filing_present_counterparty_unconfirmed');
    expect(String(nj['reason'])).toContain('전혀다른계열사(주)');
    expect(nj['counterparty_confirmed_by_document']).toBeUndefined();
    expect(nj['matching_filings_unconfirmed']).toHaveLength(1);
    expect(nj['matching_filings_unconfirmed'][0].covers_this_counterparty).toBe(false);
    expect(res['diagnostics'].filing_docs.typed_unconfirmed).toBeGreaterThanOrEqual(1);
    // 종전에는 이 건이 "공시 존재"로 나갔다 — 조용히 보류로 바뀌면 안 되므로 notes 로 드러낸다
    expect(
      (res['notes'] as string[]).some((n) => n.includes('원문 거래상대방이 이 거래 상대방과 확인되지')),
    ).toBe(true);
  });

  it('매칭 2건 중 1건만 상대방이 맞으면 그 1건만 근거로 삼는다', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인으로부터자금차입',
            rcept_no: '20250214000777',
            rcept_dt: '20250214',
          }),
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인으로부터자금차입',
            rcept_no: '20250217000888',
            rcept_dt: '20250217',
          }),
        ],
        docs: {
          '20250214000777': doc80718('미래에셋컨설팅(주)'),
          '20250217000888': doc80718('다른대여사(주)'),
        },
      }),
    )) as Record<string, any>;
    expect(res['summary'].j001_filing_near_date).toBe(1);
    const near = (res['j001_filing_near_date'] as Array<Record<string, any>>)[0]!;
    expect(near['counterparty_confirmed_by_document']).toBe(true);
    expect(near['matching_filings']).toHaveLength(1);
    expect(near['matching_filings'][0].rcept_no).toBe('20250214000777');
    expect(near['matching_filings_unconfirmed']).toHaveLength(1);
    expect(near['matching_filings_unconfirmed'][0].rcept_no).toBe('20250217000888');
    // ★ 근접 대조도 확인된 공시만으로 한다 — 02-17 이 더 가깝지만 그 공시는 다른 상대방 건이다
    expect(near['nearest_filing_gap_days']).toBe(-5);
  });

  it('매칭 3건 중 확인되는 즉시 멈춘다 — 나머지는 불일치가 아니라 "읽지 않음"이다', async () => {
    const docCalls: string[] = [];
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        // 차입일 2025-02-19 기준 근접순은 02-18(−1) → 02-14(−5) → 02-10(−9) 이다
        j001: [
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인으로부터자금차입',
            rcept_no: '20250210000111',
            rcept_dt: '20250210',
          }),
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인으로부터자금차입',
            rcept_no: '20250214000222',
            rcept_dt: '20250214',
          }),
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인으로부터자금차입',
            rcept_no: '20250218000333',
            rcept_dt: '20250218',
          }),
        ],
        // 가장 가까운 02-18 이 바로 일치 → 나머지 2건은 열 이유가 없다
        docs: {
          '20250210000111': doc80718('미래에셋컨설팅(주)'),
          '20250214000222': doc80718('미래에셋컨설팅(주)'),
          '20250218000333': doc80718('미래에셋컨설팅(주)'),
        },
        docCalls,
      }),
    )) as Record<string, any>;

    // ★ 실물에서 유가증권 유형은 한 회사에 76·95건씩 매칭된다 — 전부 여는 설계는 성립하지 않는다
    const opened = docCalls.filter((n) => n !== '20260601001646');
    expect(opened).toEqual(['20250218000333']);
    const near = (res['j001_filing_near_date'] as Array<Record<string, any>>)[0]!;
    expect(near['counterparty_confirmed_by_document']).toBe(true);
    expect(near['matching_filings']).toHaveLength(1);
    expect(near['matching_filings'][0].rcept_no).toBe('20250218000333');
    expect(near['nearest_filing_gap_days']).toBe(-1);
    // 창 안의 같은 유형 공시가 3건이라는 사실은 그대로 밝힌다
    expect(near['matching_filings_total']).toBe(3);
    expect(near['matching_filings_not_examined_total']).toBe(2);
    // 열지 않은 건은 "상대방이 다른 공시"가 아니므로 unconfirmed 에 넣지 않는다
    expect(near['matching_filings_unconfirmed']).toBeUndefined();
  });

  it('캐시에 있는 원문은 새로 내려받기 예산을 쓰지 않는다', async () => {
    const filings: Disclosure[] = [];
    const docs: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      const no = `202502${String(i + 10).padStart(2, '0')}000900`;
      filings.push(
        disc({
          corp_code: '00222222',
          report_nm: '특수관계인으로부터자금차입',
          rcept_no: no,
          rcept_dt: no.slice(0, 8),
        }),
      );
      docs[no] = doc80718('전혀다른계열사(주)'); // 전부 불일치 — 5건을 끝까지 연다
    }
    // 3건만 캐시에 있다 — 나머지 2건만 콜이 나간다
    const cachedDocs = new Set(['20250210000900', '20250211000900', '20250212000900']);
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ corps: YKD_CORPS, j001: filings, docs, cachedDocs }),
    )) as Record<string, any>;
    expect(res['diagnostics'].filing_docs).toMatchObject({
      filings_needed: 5,
      fetches: 2,
      cached_reads: 3,
      over_budget: 0,
    });
  });

  it('보고서명 매칭이 불일치여도 유형 미상 공시가 이 거래를 덮으면 "공시 존재"다 (폴스루)', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [
          // 같은 유형·같은 창이지만 **다른 상대방** 건 — 이것만 보면 보류로 끝났다
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인으로부터자금차입',
            rcept_no: '20250213000444',
            rcept_dt: '20250213',
          }),
          // 이 거래를 실제로 덮는 공시가 유형 미상 서식으로 나갔다
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인과의내부거래',
            rcept_no: '20250214000555',
            rcept_dt: '20250214',
          }),
        ],
        docs: {
          '20250213000444': doc80718('전혀다른계열사(주)'),
          '20250214000555': doc80708('미래에셋컨설팅(주)', '차입금'),
        },
      }),
    )) as Record<string, any>;

    expect(res['summary'].j001_filing_near_date).toBe(1);
    expect(res['summary'].undisclosed_candidates).toBe(0);
    const near = (res['j001_filing_near_date'] as Array<Record<string, any>>)[0]!;
    expect(near['type_ambiguous_resolved_by_document']).toBe(true);
    expect(near['matching_filings'][0].rcept_no).toBe('20250214000555');
    expect(near['nearest_filing_gap_days']).toBe(-5);
    expect(res['diagnostics'].filing_docs.ambiguous_resolved_to_exists).toBeGreaterThanOrEqual(1);
  });

  it('매칭 공시의 원문을 못 열면 "공시 존재"가 아니라 보류다 — 확인하지 못한 것이다', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인으로부터자금차입',
            rcept_no: '20250214000777',
            rcept_dt: '20250214',
          }),
        ],
        docs: { '20250214000777': new Error('DART 원문 다운로드 실패 (테스트 스텁)') },
      }),
    )) as Record<string, any>;
    expect(res['summary'].j001_filing_near_date).toBe(0);
    expect(res['summary'].undisclosed_candidates).toBe(0);
    expect(res['summary'].not_judged).toBe(2);
    const nj = (res['not_judged'] as Array<Record<string, any>>)[0]!;
    expect(String(nj['reason'])).toContain('type_filing_present_counterparty_unconfirmed');
    expect(String(nj['reason'])).toContain('doc_read: error');
    expect(nj['matching_filings'][0].doc_read).toBe('error');
    expect(res['diagnostics'].filing_docs.typed_unread).toBeGreaterThanOrEqual(1);
  });

  it('유형 미상 공시가 없으면 종전대로 후보가 나온다 (보류가 남발되지 않는다)', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [
          disc({
            corp_code: '00222222',
            report_nm: '특수관계인에대한담보제공', // 다른 유형 — 보류 대상이 아니다
            rcept_no: '20250220000112',
            rcept_dt: '20250220',
          }),
        ],
      }),
    )) as Record<string, any>;
    expect(res['summary'].undisclosed_candidates).toBe(2);
    expect(res['summary'].not_judged).toBe(0);
  });
});

/**
 * 유형 미상 J001 의 **원문 거래상대방**으로 보류를 판정으로 바꾼다.
 *
 * ★ 실물 근거 (미래에셋 20260819000341, 2026-09-05): 보류 5건의 원문 11건은 전부 ACODE 80708
 *   (`특수관계인과의 내부거래`)이고 '1. 거래상대방'이 구조화돼 있었다. 상대방이 이 거래와 같은
 *   3건은 "공시 존재"로, 다른 2건(브랜드 사용료 ↔ 보험판매 / 제9호 ↔ 제구호)은 보류로 남았다.
 *   불일치를 "공시 없음"으로 내리지 않는 이유가 그 마지막 사례다 — 표기만 다른 같은 법인일 수 있다.
 */
describe('유형 미상 J001 — 원문 거래상대방 대조', () => {
  const DOC_80708 = readFileSync(join(HERE, 'fixtures', 'j001-ambiguous-80708.md'), 'utf8');
  const DOC_80708_CORR = readFileSync(
    join(HERE, 'fixtures', 'j001-ambiguous-80708-correction.md'),
    'utf8',
  );
  const DOC_80757 = readFileSync(join(HERE, 'fixtures', 'j001-ambiguous-80757.md'), 'utf8');

  describe('parseAmbiguousFilingDoc — 실물 서식 2종', () => {
    it('80708 세로형: 거래상대방·거래대상·거래금액(텍스트 그대로)', () => {
      const f = parseAmbiguousFilingDoc(DOC_80708);
      expect(f.counterparties).toEqual(['미래에셋네이버아시아그로쓰사모투자합자회사']);
      expect(f.subjects).toEqual(['미래에셋네이버아시아그로쓰사모투자합자회사의 지분']);
      // 억원 표기 — 숫자화하지 않는다 (같은 서식의 다른 실물은 백만원 단위 숫자만 적는다)
      expect(f.amount_text).toBe('217 억원');
    });

    it('80708 정정본: 정정사유·정정전·정정후 열이 있어도 상대방을 읽는다', () => {
      const f = parseAmbiguousFilingDoc(DOC_80708_CORR);
      expect(f.counterparties).toEqual(['미래에셋자산운용(주)']);
      expect(f.subjects).toContain('"미래에셋" 브랜드 사용');
      expect(f.amount_text).toBe('약 65.8억 원');
    });

    it('80757 가로형(약관 상대방 공시): 거래상대방 열·거래목적물 열을 읽고 합계 행은 뺀다', () => {
      const f = parseAmbiguousFilingDoc(DOC_80757);
      expect(f.counterparties).toEqual(['농협은행 주식회사']);
      expect(f.subjects).toEqual(['차입금']);
    });

    it('어느 서식도 아니면 빈 배열 — 대조 불가이지 불일치가 아니다', () => {
      const f = parseAmbiguousFilingDoc(FIXTURE_MD);
      expect(f.counterparties).toEqual([]);
    });

    it('셀 안의 이스케이프된 \\| 는 열 구분이 아니다 — 상대방 이름이 잘리지 않는다', () => {
      const f = parseFilingCounterparties(
        '| 1. 거래상대방 | 에이\\|비(주) | 회사와의 관계 | 계열회사 |\n',
      );
      expect(f.counterparties).toEqual(['에이|비(주)']);
    });

    it('parseAmbiguousFilingDoc 는 parseFilingCounterparties 의 별칭이다 (기존 호출부 호환)', () => {
      expect(parseAmbiguousFilingDoc).toBe(parseFilingCounterparties);
    });
  });

  /**
   * 보고서명으로 유형이 **확정된** 서식들의 거래상대방 위치 — 전부 실물 원문(2026, 미래에셋 계열)이다.
   * 이 파서가 틀리면 "공시 존재" 근거가 통째로 무너지므로 서식마다 고정한다.
   */
  describe('parseFilingCounterparties — 보고서명으로 유형이 확정된 실물 서식 6종', () => {
    const typed = (acode: string) =>
      readFileSync(join(HERE, 'fixtures', `j001-typed-${acode}.md`), 'utf8');

    it("80718 자금차입 세로형: 라벨이 '나. 차입처' 다 (금액 라벨 '4. 거래상대방과의 차입총계' 는 아니다)", () => {
      const f = parseFilingCounterparties(typed('80718'));
      expect(f.counterparties).toEqual(['미래에셋컨설팅(주)']);
    });

    it('80719 자금대여 정정본: 정정표의 금액 라벨이 아니라 본문 1. 거래상대방을 읽는다', () => {
      const f = parseFilingCounterparties(typed('80719'));
      // 정정표에 '다. 거래상대방 총 잔액'(금액) 행이 있지만 상대방으로 오르지 않는다
      expect(f.counterparties).toEqual(['와이케이디벨롭먼트(주)']);
    });

    it('80706 수익증권거래 세로형: 1. 거래상대방', () => {
      expect(parseFilingCounterparties(typed('80706')).counterparties).toEqual([
        '미래에셋벤처투자(주)',
      ]);
    });

    it("80732 출자 세로형: '라. 출자상대방 총출자액'(금액)이 아니라 1. 거래상대방", () => {
      expect(parseFilingCounterparties(typed('80732')).counterparties).toEqual(['미래에셋증권(주)']);
    });

    it('80702 상품·용역 분기공시 가로형: 헤더 다음 행부터 첫 칸, 다음 항목번호 행에서 끝난다', () => {
      const f = parseFilingCounterparties(typed('80702'));
      // '5. 상품ㆍ용역 거래내역' 이후의 계약명·거래대상 행이 상대방으로 새지 않는다
      expect(f.counterparties).toEqual(['미래에셋 컨설팅']);
    });

    it("80754 트랙 B 가로형: '상대방명' 열로 읽고 '발행자명' 열(비계열)은 상대방이 아니다", () => {
      const f = parseFilingCounterparties(typed('80754'));
      expect(f.counterparties).toEqual(['미래에셋자산운용']);
      expect(f.counterparties).not.toContain('기획재정부');
      // 소계·총계 행은 상대방 칸이 비어 자연히 빠진다
      expect(f.counterparties).not.toContain('총 계');
      expect(f.subjects).toEqual([
        '재정증권 2026-0090-0063',
        '국고채권 03250-3512(25-11)',
        '국고채권 03875-2612(23-10)',
      ]);
    });

    it('J004 원문에는 상대방 필드가 없다 — 미확인 서식은 no_counterparty_field 로 남는다', () => {
      // (J004 의 '거래상대방'·'거래상대방 선정방식' 은 **표의 열 이름**이지 값이 아니다)
      expect(parseFilingCounterparties(FIXTURE_MD).counterparties).toEqual([]);
      expect(
        parseFilingCounterparties(readFileSync(join(HERE, 'fixtures', 'j004-matrix.md'), 'utf8'))
          .counterparties,
      ).toEqual([]);
    });
  });

  const AMBIG = disc({
    corp_code: '00222222',
    report_nm: '특수관계인과의내부거래',
    rcept_no: '20250220000111',
    rcept_dt: '20250220',
  });

  it('원문 상대방이 이 거래 상대방과 일치하면 "공시 존재"로 올리고 근접 대조까지 한다', async () => {
    const docCalls: string[] = [];
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [AMBIG],
        // 픽스처 차입 상대방은 '미래에셋컨설팅(주)' — 원문은 띄어쓰기·(주) 가 달라도 정규화로 잇는다
        docs: { '20250220000111': doc80708('미래에셋 컨설팅 주식회사', '차입금') },
        docCalls,
      }),
    )) as Record<string, any>;
    // 차입 2건(02-19·06-30) 모두 exists → 02-19 건은 접수 02-20 으로 근접, 06-30 건은 창 안에만
    expect(res['summary'].not_judged).toBe(0);
    expect(res['summary'].undisclosed_candidates).toBe(0);
    expect(res['summary'].j001_filing_near_date).toBe(1);
    expect(res['summary'].j001_filing_in_window_only).toBe(1);
    const near = (res['j001_filing_near_date'] as Array<Record<string, any>>)[0]!;
    expect(near['type_ambiguous_resolved_by_document']).toBe(true);
    expect(near['matching_filings'][0].rcept_no).toBe('20250220000111');
    const ref = near['type_ambiguous_filings'][0];
    expect(ref.doc_read).toBe('ok');
    expect(ref.covers_this_counterparty).toBe(true);
    expect(ref.doc_counterparties).toEqual(['미래에셋 컨설팅 주식회사']);
    expect(ref.doc_subjects).toEqual(['차입금']);
    expect(ref.doc_subject_class).toBe('funds');
    expect(ref.covers_this_transaction).toBe(true);
    expect(ref.doc_amount_text).toBe('1,600');
    // 같은 원문은 한 번만 연다 (차입 2건 + 대여회사 관점이 같은 접수번호를 본다)
    expect(docCalls.filter((n) => n === '20250220000111')).toHaveLength(1);
    // makeDeps 기본 스텁은 docs 에 있는 원문을 **캐시된 것**으로 본다 — 콜 예산을 쓰지 않는다
    expect(res['diagnostics'].filing_docs).toMatchObject({
      filings_needed: 1,
      fetches: 0,
      cached_reads: 1,
      over_budget: 0,
      read_errors: 0,
    });
    expect(res['diagnostics'].filing_docs.ambiguous_resolved_to_exists).toBeGreaterThanOrEqual(1);
  });

  it('상대방은 맞아도 거래대상이 다른 유형이면 올리지 않는다 — 같은 쌍의 다른 유형 공시 (Codex ①)', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [AMBIG],
        // 차입 판정인데 원문 거래대상은 출자증권 — 상대방만 같다
        docs: { '20250220000111': doc80708('미래에셋컨설팅(주)', '출자증권') },
      }),
    )) as Record<string, any>;
    expect(res['summary'].undisclosed_candidates).toBe(0);
    expect(res['summary'].not_judged).toBe(2);
    const nj = (res['not_judged'] as Array<Record<string, any>>)[0]!;
    expect(String(nj['reason'])).toContain('거래대상이 이 유형(자금차입, funds)으로 분류되지 않았습니다');
    expect(nj['type_ambiguous_resolved_by_document']).toBeUndefined();
    const ref = nj['type_ambiguous_filings'][0];
    expect(ref.covers_this_counterparty).toBe(true);
    expect(ref.doc_subject_class).toBe('securities');
    expect(ref.covers_this_transaction).toBe(false);
  });

  it('정정본은 정정후 상대방만 대조한다 — 정정전 상대방으로 "일치"를 만들지 않는다 (Codex ②)', () => {
    const corrected = [
      '특수관계인과의내부거래',
      '## 특수관계인과의 내부거래',
      '',
      '| 1. 거래상대방 | 상대방 정정 | 미래에셋컨설팅(주) | 미래에셋자산운용(주) | 회사와의 관계 | 계열회사 |',
      '| --- | --- | --- | --- | --- | --- |',
      '| 2. 거래내용 다. 거래대상 | 정정 | 차입금 | 대여금 |',
    ].join('\n');
    const f = parseAmbiguousFilingDoc(corrected);
    expect(f.counterparties).toEqual(['미래에셋자산운용(주)']);
    expect(f.superseded_counterparties).toEqual(['미래에셋컨설팅(주)']);
    expect(f.subjects).toEqual(['대여금']);
  });

  it('classifyAmbiguousSubject — 한 유형만 걸릴 때만 분류하고 복합·공백은 unknown', () => {
    expect(classifyAmbiguousSubject(['"미래에셋" 브랜드 사용'])).toBe('goods');
    expect(classifyAmbiguousSubject(['미래에셋네이버아시아그로쓰사모투자합자회사의 지분'])).toBe('securities');
    expect(classifyAmbiguousSubject(['출자증권'])).toBe('securities');
    expect(classifyAmbiguousSubject(['차입금'])).toBe('funds');
    expect(classifyAmbiguousSubject(['출자증권 매입 용역'])).toBe('unknown'); // securities + goods
    expect(classifyAmbiguousSubject([])).toBe('unknown');
    expect(classifyAmbiguousSubject(['기타'])).toBe('unknown');
  });

  it('원문 상대방이 다르면 "공시 없음"으로 내리지 않고 보류를 유지하되 원문 값을 보여 준다', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [AMBIG],
        docs: { '20250220000111': doc80708('미래에셋자산운용(주)', '"미래에셋" 브랜드 사용') },
      }),
    )) as Record<string, any>;
    expect(res['summary'].undisclosed_candidates).toBe(0);
    expect(res['summary'].not_judged).toBe(2);
    const nj = (res['not_judged'] as Array<Record<string, any>>)[0]!;
    expect(String(nj['reason'])).toContain('type_ambiguous_filing_present');
    expect(String(nj['reason'])).toContain('정규화 일치하는 공시는 없었습니다');
    expect(String(nj['reason'])).toContain('미래에셋자산운용(주)');
    expect(nj['type_ambiguous_resolved_by_document']).toBeUndefined();
    const ref = nj['type_ambiguous_filings'][0];
    expect(ref.doc_read).toBe('ok');
    expect(ref.covers_this_counterparty).toBe(false);
    expect(ref.doc_counterparties).toEqual(['미래에셋자산운용(주)']);
    expect(ref.doc_subjects).toEqual(['"미래에셋" 브랜드 사용']);
  });

  it('원문을 못 열면(오류) 보류를 유지하고 doc_read: error 를 남긴다', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        corps: YKD_CORPS,
        j001: [AMBIG],
        docs: { '20250220000111': new Error('DART 원문 다운로드 실패 (테스트 스텁)') },
      }),
    )) as Record<string, any>;
    expect(res['summary'].undisclosed_candidates).toBe(0);
    expect(res['summary'].not_judged).toBe(2);
    const nj = (res['not_judged'] as Array<Record<string, any>>)[0]!;
    expect(String(nj['reason'])).toContain('원문 0/1건에서 거래상대방을 읽었고');
    const ref = nj['type_ambiguous_filings'][0];
    expect(ref.doc_read).toBe('error');
    expect(ref.doc_error).toContain('테스트 스텁');
    expect(res['diagnostics'].filing_docs.read_errors).toBe(1);
  });

  it('상대방 필드가 없는 원문은 no_counterparty_field — 불일치와 구분한다', async () => {
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({ corps: YKD_CORPS, j001: [AMBIG] }), // loadDoc 이 J004 픽스처를 돌려준다
    )) as Record<string, any>;
    expect(res['summary'].not_judged).toBe(2);
    const nj = (res['not_judged'] as Array<Record<string, any>>)[0]!;
    expect(nj['type_ambiguous_filings'][0].doc_read).toBe('no_counterparty_field');
    expect(nj['type_ambiguous_filings'][0].covers_this_counterparty).toBe(false);
  });

  it('새로 내려받기 예산(40건)을 넘으면 최신 접수분부터 열고 나머지는 budget_exceeded 로 보류한다', async () => {
    const docs: Record<string, string> = {};
    const filings: Disclosure[] = [];
    for (let i = 0; i < 41; i++) {
      const no = `202502${String(i + 1).padStart(2, '0')}000200`;
      filings.push(
        disc({
          corp_code: '00222222',
          report_nm: '특수관계인과의내부거래',
          rcept_no: no,
          rcept_dt: no.slice(0, 8),
        }),
      );
      docs[no] = doc80708('미래에셋자산운용(주)'); // 전부 불일치 — 예산 경로만 본다
    }
    const docCalls: string[] = [];
    const res = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      // 전부 콜드(캐시 없음) — 그래야 새로 내려받기 예산을 쓴다
      makeDeps({ corps: YKD_CORPS, j001: filings, docs, docCalls, cachedDocs: new Set() }),
    )) as Record<string, any>;
    const ambiguousReads = docCalls.filter((n) => n !== '20260601001646'); // 원천 문서 로드 제외
    expect(ambiguousReads).toHaveLength(40);
    // 가장 오래된 접수분(02-01)이 잘린다
    expect(ambiguousReads).not.toContain('20250201000200');
    expect(res['diagnostics'].filing_docs).toMatchObject({
      filings_needed: 41,
      fetches: 40,
      cached_reads: 0,
      fetch_budget: 40,
      over_budget: 1,
    });
    expect(res['summary'].not_judged).toBe(2);
    // ★ 예산 안내는 이제 참이다 — 받아 둔 원문이 캐시에 남아 재실행이 이어서 대조한다
    expect(
      (res['notes'] as string[]).some((n) => n.includes('다시 실행하면 그만큼은 예산을 쓰지 않고')),
    ).toBe(true);
    const nj = (res['not_judged'] as Array<Record<string, any>>)[0]!;
    expect(String(nj['reason'])).toContain('원문 40/41건에서 거래상대방을 읽었고');
    expect(String(nj['reason'])).toContain('다시 실행하면 나머지를 이어서 대조합니다');
  });

  it('대여회사 관점도 같은 규칙으로 풀린다 — 차입회사가 대조 상대방이다', async () => {
    const md = [
      '| 기업집단명 : | 테스트집단 |',
      '| --- | --- |',
      '## (2) 회사 재무현황',
      '| (단위 : 백만원, %) |',
      '| --- |',
      '| 계열회사명 |  | 자본금 | 자본총계 |',
      '| --- | --- | --- | --- |',
      '| 비금융회사 | 차입회사(주) | 5,000 | 20,000 |',
      '| 비금융회사 | 대여계열사(주) | 1,000 | 4,000 |',
      '## (1) 계열회사간 자금거래 현황',
      '가. 일반 차입',
      '| (단위 : 백만원) |',
      '| --- |',
      '| 차입회사 (소속회사) |  | 거래상대방 | 차입금액 | 차입일 |',
      '| --- | --- | --- | --- | --- |',
      '| 비금융회사 | 차입회사(주) | 대여계열사(주) | 16,000 | 2025-02-19 |',
    ].join('\n');
    const corps = {
      차입회사: [{ corpCode: '00222222', corpName: '차입회사' }],
      대여계열사: [{ corpCode: '00333333', corpName: '대여계열사' }],
    };
    const r = (await detectUndisclosedTransactions(
      { rcept_no: '20260601001646', today: '20260827' },
      makeDeps({
        markdown: md,
        corps,
        j001: (corpCode) =>
          corpCode === '00333333'
            ? [
                disc({
                  corp_code: '00333333',
                  report_nm: '특수관계인과의내부거래', // 대여회사가 유형 미상 서식으로 냈다
                  rcept_no: '20250214000777',
                  rcept_dt: '20250214',
                }),
              ]
            : [],
        // 원문 상대방 = 차입회사 → 대여회사 관점에서 "공시 존재", 접수 02-14 는 차입일 02-19 의 5일 전
        docs: { '20250214000777': doc80708('차입회사 주식회사', '대여금') },
      }),
    )) as Record<string, any>;
    const side = r['undisclosed_candidates'][0].lender_side;
    expect(side.status).toBe('j001_filing_near_date');
    expect(side.nearest_filing_gap_days).toBe(-5);
    expect(side.type_ambiguous_resolved_by_document).toBe(true);
    expect(side.type_ambiguous_filings[0].covers_this_counterparty).toBe(true);
    expect(side.type_ambiguous_filings[0].doc_subjects).toEqual(['대여금']);
    // 차입회사 쪽은 자금차입 공시가 없어 여전히 후보 — 두 판정은 독립이다
    expect(r['summary'].undisclosed_candidates).toBe(1);
    expect(r['summary'].lender_side.j001_filing_near_date).toBe(1);
  });
});
