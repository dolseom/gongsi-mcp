/**
 * find_precedents 후보 선정 로직 테스트 (순수 함수 부분)
 * 검색·원문 수집 경로는 실서버 스모크로 검증한다.
 */

import { describe, expect, it } from 'vitest';
import { selectCandidates } from '../src/tools/find-precedents.js';
import type { Disclosure } from '../src/clients/dart.js';

function row(over: Partial<Disclosure>): Disclosure {
  return {
    corp_code: '00000001',
    corp_name: '테스트',
    corp_cls: 'E',
    report_nm: '특수관계인으로부터자금차입',
    rcept_no: '20260701000001',
    flr_nm: '테스트',
    rcept_dt: '20260701',
    rm: '공',
    ...over,
  };
}

describe('선례 후보 선정', () => {
  it('최신순으로 정렬한다 (같은 날은 rcept_no 역순)', () => {
    const out = selectCandidates(
      [
        row({ rcept_no: '20260701000001', rcept_dt: '20260701', corp_code: 'A' }),
        row({ rcept_no: '20260715000002', rcept_dt: '20260715', corp_code: 'B' }),
        row({ rcept_no: '20260715000009', rcept_dt: '20260715', corp_code: 'C' }),
      ],
      { onePerCompany: true },
    );
    expect(out.map((r) => r.rcept_no)).toEqual([
      '20260715000009',
      '20260715000002',
      '20260701000001',
    ]);
  });

  it('회사당 1건만 남긴다 — 같은 회사의 최신 건이 이긴다', () => {
    const out = selectCandidates(
      [
        row({ rcept_no: '20260701000001', rcept_dt: '20260701', corp_code: 'A' }),
        row({ rcept_no: '20260715000002', rcept_dt: '20260715', corp_code: 'A' }),
        row({ rcept_no: '20260710000003', rcept_dt: '20260710', corp_code: 'B' }),
      ],
      { onePerCompany: true },
    );
    expect(out.map((r) => r.rcept_no)).toEqual(['20260715000002', '20260710000003']);
  });

  it('one_per_company=false 면 전부 유지한다', () => {
    const out = selectCandidates(
      [
        row({ rcept_no: '20260701000001', corp_code: 'A' }),
        row({ rcept_no: '20260702000002', rcept_dt: '20260702', corp_code: 'A' }),
      ],
      { onePerCompany: false },
    );
    expect(out.length).toBe(2);
  });

  it('제외 회사를 뺀다', () => {
    const out = selectCandidates(
      [
        row({ rcept_no: '20260701000001', corp_code: 'A' }),
        row({ rcept_no: '20260702000002', rcept_dt: '20260702', corp_code: 'B' }),
      ],
      { excludeCorpCode: 'A', onePerCompany: true },
    );
    expect(out.map((r) => r.corp_code)).toEqual(['B']);
  });
});
