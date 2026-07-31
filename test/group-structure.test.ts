/**
 * get_group_structure 순수 로직 테스트.
 * 포털 API 결합 경로는 실서버 스모크로 검증한다.
 */

import { describe, expect, it } from 'vitest';
import { isGroupCode, toWon } from '../src/tools/get-group-structure.js';
import { inferYearMonth } from '../src/tools/resolve-entity.js';
import { parsePortalXml } from '../src/clients/egroup.js';

describe('기업집단포털 XML 파싱 (실측 응답 형태)', () => {
  it('항목 태그는 서비스명에서 List 를 뗀 이름이다 — <item> 이 아니다', () => {
    // 2026-07-31 실응답 축약본
    const xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><appnGroupSttusList>' +
      '<numOfRows>200</numOfRows><pageNo>1</pageNo><resultCode>00</resultCode><resultMsg>SUCCESS</resultMsg>' +
      '<totalCount>102</totalCount>' +
      '<appnGroupSttus><unityGrupNm>삼성</unityGrupNm><unityGrupCode>K1000032</unityGrupCode>' +
      '<smerNm>이재용</smerNm><repreCmpny>삼성전자(주)</repreCmpny><sumCmpnyCo>67</sumCmpnyCo>' +
      '<invstmntLmtt>상호출자제한집단</invstmntLmtt></appnGroupSttus>' +
      '<appnGroupSttus><unityGrupNm>에스케이</unityGrupNm><unityGrupCode>K1000050</unityGrupCode>' +
      '<smerNm>최태원</smerNm><repreCmpny>에스케이(주)</repreCmpny><sumCmpnyCo>151</sumCmpnyCo>' +
      '<invstmntLmtt>상호출자제한집단</invstmntLmtt></appnGroupSttus></appnGroupSttusList>';
    const r = parsePortalXml<Record<string, string>>(xml, 'appnGroupSttusList');
    expect(r.resultCode).toBe('00');
    expect(r.totalCount).toBe(102);
    expect(r.items.length).toBe(2);
    expect(r.items[0]!['unityGrupNm']).toBe('삼성');
    expect(r.items[1]!['unityGrupCode']).toBe('K1000050');
  });

  it('오류 응답(resultCode 97)을 항목 없이 코드·메시지로 돌려준다', () => {
    // pageNo 를 빼면 실제로 이렇게 온다 — 빈 배열로 삼키면 "집단 없음"으로 오진한다
    const xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><appnGroupSttusList>' +
      '<resultCode>97</resultCode><resultMsg>pageNo :::  :::not current!!</resultMsg></appnGroupSttusList>';
    const r = parsePortalXml(xml, 'appnGroupSttusList');
    expect(r.resultCode).toBe('97');
    expect(r.resultMsg).toContain('pageNo');
    expect(r.items.length).toBe(0);
  });

  it('XML 엔티티를 되돌린다 (삼성E&amp;A 류)', () => {
    const xml =
      '<appnGroupAffiList><resultCode>00</resultCode><resultMsg>SUCCESS</resultMsg><totalCount>1</totalCount>' +
      '<appnGroupAffi><entrprsNm>삼성E&amp;A(주)</entrprsNm><jurirno>1101110012345</jurirno></appnGroupAffi>' +
      '</appnGroupAffiList>';
    const r = parsePortalXml<Record<string, string>>(xml, 'appnGroupAffiList');
    expect(r.items[0]!['entrprsNm']).toBe('삼성E&A(주)');
  });
});

describe('기업집단 구조 — 순수 로직', () => {
  it('집단코드 형식을 판정한다', () => {
    expect(isGroupCode('K1000032')).toBe(true); // 삼성
    expect(isGroupCode('K3000027')).toBe(true); // 현대차
    expect(isGroupCode('삼성')).toBe(false);
    expect(isGroupCode('K100003')).toBe(false); // 7자리 미달
    expect(isGroupCode('00126380')).toBe(false); // corp_code
  });

  it('포털 금액 문자열을 원 단위 숫자로 바꾼다', () => {
    expect(toWon('123456789')).toBe(123_456_789);
    expect(toWon('1,234,567')).toBe(1_234_567);
    expect(toWon('')).toBeNull();
    expect(toWon(undefined)).toBeNull();
    expect(toWon('비공개')).toBe('비공개'); // 파싱 불가는 원문 유지
  });

  it('공개년월 추정 — 5월 지정 발표 전이면 전년도 기준', () => {
    expect(inferYearMonth(new Date('2026-07-31'))).toBe('202605');
    expect(inferYearMonth(new Date('2026-03-01'))).toBe('202505');
    expect(inferYearMonth(new Date('2026-05-01'))).toBe('202605');
  });
});
