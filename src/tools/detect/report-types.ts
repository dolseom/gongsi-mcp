/**
 * J001 보고서명 → 거래유형 분류기 (순수 함수)
 */

/** 보고서명 정규화 — 공백·가운뎃점·괄호 표기 차이를 무시하고 유형 키워드를 찾는다 */
export function normalizeReportNm(nm: string): string {
  return nm.replace(/[\s·ㆍ・()[\],]/g, '');
}

/** 자금 차입 거래를 커버할 수 있는 J001 보고서명인가 */
export function isBorrowingReport(reportNm: string): boolean {
  return normalizeReportNm(reportNm).includes('자금차입');
}

/**
 * 자금 **대여** 거래를 커버할 수 있는 J001 보고서명인가 (대여회사 관점).
 *
 * 대규모내부거래 공시의무는 거래를 하는 계열회사 **각자에게** 있다 — 차입회사가
 * "특수관계인으로부터의 자금차입" 을 공시하는 것과 별개로, 자금을 대준 계열회사에는
 * "특수관계인에 대한 자금대여" 공시의무가 있다 (J001 ACODE 80719, 실측 보고서명
 * '특수관계인에대한자금대여'). 차입회사 쪽만 보면 대여회사의 미공시가 통째로 시야 밖이다.
 */
export function isLendingReport(reportNm: string): boolean {
  return normalizeReportNm(reportNm).includes('자금대여');
}

/** 상품·용역 거래를 커버할 수 있는 J001 보고서명인가 (변경 공시 포함) */
export function isGoodsServicesReport(reportNm: string): boolean {
  const n = normalizeReportNm(reportNm);
  return n.includes('상품') && n.includes('용역');
}

/**
 * 유가증권 거래를 커버할 수 있는 J001 보고서명인가.
 *
 * 넓게 잡는다 — 유가증권 거래는 서식이 여러 갈래이고(출자·유상증자참여·수익증권·채권·
 * 기타유가증권), 그중 상당수가 약관특례(고시 §9, 트랙 B)의 분기 일괄공시로 나간다.
 * 필터가 좁으면 정상 공시를 못 알아보고 **없는 미공시를 만들어낸다** — 이 신호는
 * 연간 총액 기반이라 애초에 약한 신호이므로, 오경보 억제 쪽으로 기울이고
 * 실제로 무엇에 걸렸는지는 `matching_filings` 로 그대로 보여준다.
 */
export function isSecuritiesReport(reportNm: string): boolean {
  const n = normalizeReportNm(reportNm);
  return [
    '유가증권',
    '수익증권',
    '출자',
    '유상증자',
    '채권',
    '사모사채',
    '단기금융상품',
    '주식',
  ].some((k) => n.includes(k));
}

/**
 * '[공시취소]' 접수분인가 — 취소 접수는 공시를 없앤 기록이지 공시가 존재한다는 근거가
 * 아니다 (교차검토 S-5). 취소된 원본 접수분은 목록에 별도 행으로 남으므로, 취소 행만
 * 근거에서 빼면 "원본은 있고 취소만 있는" 경우를 잘못 후보로 만들지 않는다.
 */
/**
 * ⚠️ **실측: J001 에 '공시취소' 보고서명은 존재하지 않는다.**
 * 전체시장 2024-01-01~2026-09-04 J001 **22,794건 / 서로 다른 보고서명 94종**을 전수 수집해
 * `취소·철회·무효·해제` 를 찾았더니 **0건**이었다 (픽스처 `j001-report-names-2024-2026.json`).
 * 고시 §8①단서의 "거래 취소"는 별도 서식이 아니라 **정정([기재정정], 1,496건)·변경 공시**로
 * 표현된다. 이 함수는 그래도 남겨 둔다 — 서식이 생기면 그 즉시 판정을 보류시키는 방어선이고,
 * 비용이 0 이다. 다만 **이 경로에 의존하는 판정은 없다**고 알고 읽어야 한다.
 */
export function isCancellationReport(reportNm: string): boolean {
  return normalizeReportNm(reportNm).includes('공시취소');
}

/**
 * 보고서명만으로 **거래유형을 알 수 없는** J001 서식인가 — 유형 필터를 빠져나가는 실측 사례다.
 *
 * ★ 왜 필요한가 (실측 2026-09-05, 전체시장 2.7년 22,794건):
 *  - `특수관계인과의내부거래` **740건** — 유형이 이름에 없다. 실물 20260903000201(플랜에이치
 *    벤처스)은 **벤처투자조합 출자**(유가증권 유형)를 이 이름으로 공시했다.
 *  - `약관에의한금융거래시계열금융회사의거래상대방의공시` **433건** — 고시 §9② 약관특례의
 *    거래상대방 쪽 공시다. 실물 20260902000068(농협양곡)은 **차입금 415.2억**을 이 이름으로
 *    공시했다 — 우리 '자금차입' 필터에 걸리지 않는다.
 *
 * 이 이름들이 창 안에 있는데 유형 필터에는 안 걸리면, "공시 없음 → 미공시 후보"가 **오탐**일
 * 수 있다. 그렇다고 "공시 존재"로 삼으면 거짓 안심이므로, 후보를 만들지 않고 **판정을 보류**한다.
 */
export function isTypeAmbiguousReport(reportNm: string): boolean {
  const n = normalizeReportNm(reportNm);
  return (
    n.includes('특수관계인과의내부거래') ||
    n.includes('약관에의한금융거래시계열금융회사의거래상대방')
  );
}
