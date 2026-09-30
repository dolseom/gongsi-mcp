/**
 * DART 공시 목록 행(Disclosure) 부분 빌더.
 *
 * 파일마다 기본값(회사명·보고서명·접수일)만 다르고 나머지 규칙은 같아서 공통화했다:
 *   corp_code '00000001' · corp_cls 'E' · rm '공' · flr_nm = 기본 corp_name ·
 *   rcept_no = `${기본 rcept_dt}000001`
 * ⚠️ flr_nm·rcept_no 는 **기본값에서** 만든다 — override 로 corp_name 이나 rcept_dt 만 바꿔도
 *   flr_nm·rcept_no 는 따라 바뀌지 않는다 (종전 파일별 row() 와 같은 동작).
 */
import type { Disclosure } from '../../src/clients/dart.js';

export function disclosureBuilder(
  defaults: Pick<Disclosure, 'corp_name' | 'report_nm' | 'rcept_dt'> & Partial<Disclosure>,
): (over?: Partial<Disclosure>) => Disclosure {
  const base: Disclosure = {
    corp_code: '00000001',
    corp_cls: 'E',
    flr_nm: defaults.corp_name,
    rcept_no: `${defaults.rcept_dt}000001`,
    rm: '공',
    ...defaults,
  };
  return (over = {}) => ({ ...base, ...over });
}
