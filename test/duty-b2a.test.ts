/**
 * B→A 평가(2026-09-24)·Codex 적대 검토에서 나온 check_disclosure_duty 결함 회귀.
 *
 * 테스트 설명에 원문을 인용한다 — 기대값의 근거가 코드가 아니라 원문이라는 것을 남기기 위해서다.
 * 원문: 공정위 공시 업무매뉴얼(2026-04-27) 대규모내부거래·비상장사 편, 공정위 문답(data/ftc-qna.json lit26-*),
 *       대규모내부거래 등에 대한 이사회 의결 및 공시에 관한 규정(고시).
 */

import { describe, it, expect } from 'vitest';
import { checkDisclosureDuty } from '../src/tools/check-disclosure-duty.js';
import { calcThreshold, incompleteCapitalFlipPoint } from '../src/rules/thresholds.js';

const 억 = 100_000_000;

function ok(r: ReturnType<typeof checkDisclosureDuty>) {
  if ('error' in r) throw new Error(`예상치 못한 에러 응답: ${r.error} ${r.message}`);
  return r;
}

describe('자본총계·자본금 한쪽 미입력 — 0 으로 계산하지 않는다 (P0-3)', () => {
  it('산식 문자열에 "자본금 0원" 대신 "미입력" 을 쓰고, 하한값임을 밝힌다', () => {
    const t = calcThreshold({ totalEquity: 400 * 억 })!;
    expect(t.formula).toContain('자본금 미입력');
    expect(t.formula).not.toContain('자본금 0원');
    expect(t.formula).toContain('하한값');
    expect(t.missingSide).toBe('paidInCapital');
    // 둘 다 있으면 표시 없음
    const full = calcThreshold({ totalEquity: 400 * 억, paidInCapital: 10 * 억 })!;
    expect(full.missingSide).toBeUndefined();
    expect(full.formula).not.toContain('미입력');
  });

  it('결론이 확정되는 경우(100억 이상 / 기준 미만)에는 뒤집힘 경계가 없다', () => {
    const t = calcThreshold({ totalEquity: 400 * 억 })!; // 20억
    expect(incompleteCapitalFlipPoint(100 * 억, t)).toBeNull(); // 100억 이상은 무조건 대상
    expect(incompleteCapitalFlipPoint(10 * 억, t)).toBeNull(); // 미입력 쪽은 기준을 올리기만 → 대상 아님 확정
    // 30억: 미입력 자본금 × 5% > 30억 (= 600억 초과) 이면 뒤집힌다
    expect(incompleteCapitalFlipPoint(30 * 억, t)).toBe(600 * 억);
  });

  it('자본총계만 주면 대상 판정은 유지하되 "자본금이 600억 넘으면 대상 아님" 전제를 밝힌다 (d06 유형)', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction',
        amount: 30 * 억,
        totalEquity: 400 * 억,
        amountBasis: 'actual',
      }),
    );
    expect(r.verdict).toBe('required');
    const premise = r.notes.find((n) => n.startsWith('[전제]') && n.includes('600억원'));
    expect(premise).toBeDefined();
    expect(r.review.assumptions).toContain(premise);
  });

  it('자본금만 주고 결론이 뒤집힐 수 있으면 "대상" 을 확정하지 않는다 — 자본총계는 보통 자본금보다 크다', () => {
    // 자본금 50억 → 하한 5억 → 10억 거래는 대상처럼 보이지만, 자본총계 200억 초과면 기준 10억 초과 → 대상 아님
    const r = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction',
        amount: 10 * 억,
        paidInCapital: 50 * 억,
        amountBasis: 'actual',
      }),
    );
    expect(r.verdict).toBe('insufficient_data');
    expect(r.summary).toContain('200억원');
    expect(r.missing_inputs.map((m) => m.field)).toContain('totalEquity');
    const label = r.missing_inputs.find((m) => m.field === 'totalEquity')!.label;
    expect(label).toContain('개별');
  });

  it('자본금만 줘도 결론이 확정되면(거래 < 계산된 기준) 추가 정보를 요구하지 않는다 — 거짓 안심 방향 없음', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction',
        amount: 4 * 억,
        paidInCapital: 50 * 억,
        amountBasis: 'actual',
      }),
    );
    expect(r.verdict).toBe('not_required');
    expect(r.missing_inputs.map((m) => m.field)).not.toContain('totalEquity');
  });

  it('자본이 없어도 결론이 확정되면 판정한다 — 시행령 제33조제1항: 기준금액은 100억원을 넘지 않고 5억원 밑으로 내려가지 않는다', () => {
    const big = ok(checkDisclosureDuty({ duty: 'large_internal_transaction', amount: 100 * 억, amountBasis: 'quarterly_sum' }));
    expect(big.verdict).toBe('required'); // c09: 분기 100억 용역
    expect(big.missing_inputs.map((m) => m.field)).not.toContain('totalEquity');
    const small = ok(checkDisclosureDuty({ duty: 'large_internal_transaction', amount: 4 * 억, amountBasis: 'actual' }));
    expect(small.verdict).toBe('not_required');
  });

  it('d06 "계열사한테 30억 빌려줬는데요": 결론을 가르는 값(자본 600억)과 사전 의결 확인을 알린다', () => {
    const r = ok(checkDisclosureDuty({ duty: 'large_internal_transaction', amount: 30 * 억, amountBasis: 'actual' }));
    expect(r.verdict).toBe('insufficient_data');
    expect(r.summary).toContain('600억원');
    expect(r.notes.some((n) => n.includes('거래 전에') && n.includes('의결 X'))).toBe(true);
    // 국외 계열사 등 제외 조건도 함께 (대상 미확정이라도 금액이 있으면)
    expect(r.notes.some((n) => n.startsWith('판정이 달라지는 경우') && n.includes('국외 계열회사'))).toBe(true);
  });

  it('자본총계 입력 설명에 "개별재무제표" 기준을 적는다 — 매뉴얼 "주주총회에서 승인된 최근 사업연도 말 개별재무제표에 표시된 자본총계"', async () => {
    const { checkDisclosureDutyInput } = await import('../src/tools/check-disclosure-duty.js');
    const d = checkDisclosureDutyInput.shape.totalEquity.description ?? '';
    expect(d).toContain('개별');
    expect(d).toContain('연결재무제표가 아닙니다');
    // 비상장 매뉴얼: "자기자본 = 자산총액 - 부채총액 ± 최근 사업연도말 경과 후 공시사유 발생일까지의 자본금 및 자본잉여금의 증감"
    expect(d).toContain('자본잉여금');
  });
});

describe('기한 준수 ≠ 적법 (P0-3)', () => {
  it('기한 내 공시는 "공시기한은 지켰다" 로만 말한다', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'large_internal_transaction',
        listing: 'listed',
        boardDate: '20260722',
        actualDisclosureDate: '20260723',
        totalEquity: 1200 * 억,
        paidInCapital: 100 * 억,
        amount: 80 * 억,
        amountBasis: 'actual',
        boardResolution: true,
      }),
    );
    expect(r.summary).not.toContain('적법합니다');
    expect(r.summary).toContain('누락·거짓');
  });
});

describe('조문 표기는 "제4조제3항" 식으로 풀어 쓴다 (P2 — 모델이 "고시§4③"을 "고시 §43"으로 옮겨 적은 사고, d02)', () => {
  it('입력 설명에 § 원문자 표기가 없다', async () => {
    const { checkDisclosureDutyInput } = await import('../src/tools/check-disclosure-duty.js');
    for (const [key, field] of Object.entries(checkDisclosureDutyInput.shape)) {
      const d = (field as { description?: string }).description ?? '';
      expect(d, key).not.toMatch(/§/);
    }
    expect(checkDisclosureDutyInput.shape.amountBasis.description).toContain('고시 제4조제3항');
  });

  it('대표 출력(요약·notes·검토 메모)에 § 표기가 없다', () => {
    const inputs: Parameters<typeof checkDisclosureDuty>[0][] = [
      { duty: 'large_internal_transaction', amount: 30 * 억, totalEquity: 400 * 억, amountBasis: 'quarterly_sum' },
      { duty: 'unlisted_material', materialItem: 'guarantee', amount: 30 * 억, totalEquity: 400 * 억, occurredDate: '20260701' },
      { duty: 'unlisted_material', materialItem: 'shareholding_change', shareChangePct: 2, shareholderType: 'major' },
      { duty: 'omnibus_financial', isFinancialCompany: false, listing: 'listed' },
      { duty: 'goods_services_reduced', quarterEnd: '20260630' },
    ];
    for (const inp of inputs) {
      const r = ok(checkDisclosureDuty(inp));
      const { penalty: _p, ...rest } = r; // 과태료 모듈 문자열은 이 범위 밖
      expect(JSON.stringify(rest), inp.duty).not.toMatch(/§/);
    }
  });
});

describe('비상장 중요사항 안내 보강 (P2, 비상장사 매뉴얼)', () => {
  it('내부거래공시 갈음 시 "기타 란에 비상장회사 등의 중요사항 공시사항에도 해당된다는 것을 표시" + 양식에 없는 부분 추가 기재', () => {
    const r = ok(checkDisclosureDuty({ duty: 'unlisted_material', materialItem: 'capital_change' }));
    const n = r.notes.join(' ');
    expect(n).toContain('기타란');
    expect(n).toContain('추가 기재');
  });

  it('채무보증 제외에 "건설업을 영위하는 법인이 건설사업을 위하여 발주처 또는 입주예정자 등에게 채무를 보증하는 경우"를 매뉴얼 기준(원문 미확인)으로 붙인다', () => {
    const r = ok(
      checkDisclosureDuty({
        duty: 'unlisted_material',
        materialItem: 'guarantee',
        amount: 30 * 억,
        totalEquity: 400 * 억,
      }),
    );
    const n = r.notes.find((x) => x.includes('건설업'))!;
    expect(n).toContain('건설사업을 위하여');
    expect(n).toContain('원문 미확인');
  });
});
