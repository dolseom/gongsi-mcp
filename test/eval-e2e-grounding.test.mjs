import { describe, it, expect } from 'vitest';
import { checkGrounding, extractRun, parseKoreanAmount } from '../eval/e2e/grounding.mjs';

describe('parseKoreanAmount', () => {
  it('한글 단위 금액을 원으로 바꾼다', () => {
    expect(parseKoreanAmount('5,000만원')).toBe(50_000_000);
    expect(parseKoreanAmount('1억 2,000만 원')).toBe(120_000_000);
    expect(parseKoreanAmount('60억원')).toBe(6_000_000_000);
    expect(parseKoreanAmount('2.5억')).toBe(250_000_000);
  });
});

describe('checkGrounding', () => {
  const tool = JSON.stringify({
    threshold: 6000000000,
    penalty: { amount: 50000000, note: '기본금액 5,000만원 × 거래금액 적용비율 70%' },
    legal: '독점규제 및 공정거래에 관한 법률 제26조',
    quote: '공시기한을 넘긴 날의 다음 날부터 보완을 마친 날까지 1일마다',
    rate: 0.75,
  });

  it('도구 출력의 원 단위 정수·한글 표기·소수 비율·조문·인용을 근거로 인정한다', () => {
    const answer =
      '기준금액은 60억원이고 과태료는 5,000만원입니다(적용비율 70%, 감경 75%). 근거는 제26조이며 ' +
      '고시는 "공시기한을 넘긴 날의 다음 날부터 보완을 마친 날까지 1일마다" 가산한다고 정합니다.';
    const r = checkGrounding(answer, tool);
    expect(r.ungrounded).toEqual([]);
    expect(r.claims).toBe(6);
  });

  it('도구 출력에 없는 금액·조문·인용은 근거 없음으로 센다', () => {
    const answer = '과태료는 7,000만원이고 제27조에 따라 "이사회 의결 없이도 공시만 하면 충분하다" 고 봅니다.';
    const r = checkGrounding(answer, tool);
    expect(r.ungrounded.map((u) => u.kind).sort()).toEqual(['amount', 'article', 'quote']);
  });

  it('같은 주장은 한 번만 센다, 15자 미만 따옴표는 인용으로 보지 않는다', () => {
    const r = checkGrounding('5,000만원, 다시 5,000만원. "짧은 말"', tool);
    expect(r.claims).toBe(1);
  });
});

describe('extractRun', () => {
  it('평가 서버 도구 결과 전문과 최종 답변만 뽑는다', () => {
    const lines = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__gongsi__check_disclosure_duty', input: {} }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'ToolSearch', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '기준금액 60억원' }] }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: '스키마 99억원' }] } },
      { type: 'result', result: '답: 60억원' },
    ].map((e) => JSON.stringify(e));
    const run = extractRun(lines.join('\n'));
    expect(run.answer).toBe('답: 60억원');
    expect(run.toolText).toContain('60억원');
    expect(run.toolText).not.toContain('99억원');
  });
});
