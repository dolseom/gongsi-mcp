import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { checkDisclosureDuty } from '../src/tools/check-disclosure-duty.js';
import { Store, __setStore, todayKst } from '../src/lib/store.js';
import { redact } from '../src/lib/logger.js';
import { __resetConfig } from '../src/lib/config.js';
import { 억 } from '../src/rules/thresholds.js';

describe('check_disclosure_duty', () => {
  it('소노스테이션 실사례 — 비상장 7영업일, 7/28 공시는 적법', () => {
    // 검증된 실제 사례: rcept_no 20260728000484
    // 이사회 의결 2026-07-22(수) → 비상장 7영업일 기한 = 2026-07-31
    const r = checkDisclosureDuty({
      duty: 'large_internal_transaction',
      listing: 'unlisted',
      boardDate: '20260722',
      actualDisclosureDate: '20260728',
      totalEquity: 1200 * 억,
      amount: 80 * 억,
      amountBasis: 'actual',
      today: '20260729',
    });
    expect('error' in r).toBe(false);
    if ('error' in r) return;

    expect(r.deadline?.deadline).toBe('20260731');
    expect(r.compliance?.onTime).toBe(true);
    expect(r.compliance?.delayDays).toBe(0);
    expect(r.penalty).toBeUndefined();
  });

  it('같은 건이 상장사였다면 3영업일이라 1일 지연이다', () => {
    const r = checkDisclosureDuty({
      duty: 'large_internal_transaction',
      listing: 'listed',
      boardDate: '20260722',
      actualDisclosureDate: '20260728',
      totalEquity: 1200 * 억,
      amount: 80 * 억,
      amountBasis: 'actual',
      today: '20260729',
    });
    if ('error' in r) throw new Error('예상치 못한 에러 응답');

    expect(r.deadline?.deadline).toBe('20260727');
    expect(r.compliance?.onTime).toBe(false);
    expect(r.compliance?.delayDays).toBe(1);
    // 지연이면 과태료를 함께 산정한다
    expect(r.penalty).toBeDefined();
  });

  it('기준금액 = min(100억, max(5억, 자본×5%)) — 60억', () => {
    const r = checkDisclosureDuty({
      duty: 'large_internal_transaction',
      listing: 'listed',
      boardDate: '20260722',
      totalEquity: 1200 * 억,
      amount: 80 * 억,
      amountBasis: 'actual',
    });
    if ('error' in r) throw new Error('예상치 못한 에러 응답');

    expect(r.threshold?.amount).toBe(60 * 억);
    expect(r.verdict).toBe('required'); // 80억 >= 60억
  });

  it('자본 정보가 없으면 추정하지 않고 insufficient_data 를 돌려준다', () => {
    const r = checkDisclosureDuty({
      duty: 'large_internal_transaction',
      listing: 'listed',
      boardDate: '20260722',
      amount: 80 * 억,
    });
    if ('error' in r) throw new Error('예상치 못한 에러 응답');

    expect(r.verdict).toBe('insufficient_data');
    // 폐지된 옛 기준을 쓰지 않도록 안내한다
    expect(r.notes.join(' ')).toContain('50억');
  });

  it('amountBasis 미지정이면 판정이 뒤집힐 수 있다고 경고한다', () => {
    const r = checkDisclosureDuty({
      duty: 'large_internal_transaction',
      listing: 'listed',
      boardDate: '20260722',
      totalEquity: 1200 * 억,
      amount: 80 * 억,
    });
    if ('error' in r) throw new Error('예상치 못한 에러 응답');
    expect(r.notes.join(' ')).toContain('amountBasis');
  });

  it('필수 인자가 없으면 규격 에러를 돌려준다 (예외를 던지지 않는다)', () => {
    const r = checkDisclosureDuty({ duty: 'large_internal_transaction' });
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error).toBe('invalid_argument');
  });

  it('약관 금융거래는 이사회 의결이 불요임을 알린다 — 고시 §9', () => {
    const r = checkDisclosureDuty({ duty: 'omnibus_financial', quarterEnd: '20260630' });
    if ('error' in r) throw new Error('예상치 못한 에러 응답');
    expect(r.notes.join(' ')).toContain('이사회 의결이 필요 없습니다');
  });

  it('기업집단현황 연1회 기한 5/31이 일요일이면 익영업일로 밀린다', () => {
    // 2026-05-31은 일요일. 만료일이 비영업일이면 다음 영업일이 기한이 된다.
    const r = checkDisclosureDuty({ duty: 'group_status', year: 2026 });
    if ('error' in r) throw new Error('예상치 못한 에러 응답');
    expect(r.deadline?.deadline).toBe('20260601');
    expect(r.deadline?.adjustedToNextBusinessDay).toBe(true);
  });

  it('기업집단현황 연1회 기한 5/31이 평일이면 그대로다', () => {
    // 2027-05-31은 월요일
    const r = checkDisclosureDuty({ duty: 'group_status', year: 2027 });
    if ('error' in r) throw new Error('예상치 못한 에러 응답');
    expect(r.deadline?.deadline).toBe('20270531');
    expect(r.deadline?.adjustedToNextBusinessDay).toBe(false);
  });

  it('비상장사 중요사항 증여는 자기자본의 1%가 임계다', () => {
    const r = checkDisclosureDuty({
      duty: 'unlisted_material',
      occurredDate: '20260722',
      materialItem: 'gift',
      totalEquity: 1000 * 억,
      paidInCapital: 100 * 억,
      amount: 11 * 억,
    });
    if ('error' in r) throw new Error('예상치 못한 에러 응답');
    expect(r.threshold?.amount).toBe(10 * 억);
    expect(r.verdict).toBe('required');
  });

  it('자기자본이 자본금에 미달하면 자본금을 자기자본으로 본다 — 고시 §5의2③', () => {
    const r = checkDisclosureDuty({
      duty: 'unlisted_material',
      occurredDate: '20260722',
      materialItem: 'gift',
      totalEquity: 50 * 억,
      paidInCapital: 200 * 억,
      amount: 1 * 억,
    });
    if ('error' in r) throw new Error('예상치 못한 에러 응답');
    // 자본금 200억의 1% = 2억이 임계 (자기자본 50억의 1%인 0.5억이 아니다)
    expect(r.threshold?.amount).toBe(2 * 억);
    expect(r.verdict).toBe('not_required');
  });
});

describe('저장소 (node:sqlite 어댑터)', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
    __setStore(store);
  });

  afterEach(() => {
    __setStore(null);
    store.close();
  });

  it('FTS5 trigram 을 쓸 수 있다 (한글 부분일치)', () => {
    expect(store.ftsAvailable).toBe(true);
  });

  it('일일 호출 카운터는 KST 일자 버킷으로 누적된다', () => {
    expect(store.todayCallCount('dart')).toBe(0);
    store.incrementCall('dart', 1);
    store.incrementCall('dart', 2);
    expect(store.todayCallCount('dart')).toBe(3);
    // API 별로 분리된다
    expect(store.todayCallCount('egroup')).toBe(0);
    expect(todayKst()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('법인 인덱스는 상호 완전일치로 동명 법인을 모두 돌려준다', () => {
    store.upsertCorps([
      { corpCode: '00126229', corpName: '삼성물산', stockCode: null, jurirNo: '1101110015762', modifyDate: '20260101' },
      { corpCode: '00149655', corpName: '삼성물산', stockCode: null, jurirNo: '1101110002975', modifyDate: '20260101' },
    ]);
    expect(store.findCorpsByName('삼성물산')).toHaveLength(2);
    // 법인등록번호로 유일하게 특정된다 — 기업집단포털 조인 키
    expect(store.findCorpsByJurirNo('1101110002975')).toHaveLength(1);
  });

  it('jurir_no 는 새 값이 없으면 기존 값을 지킨다', () => {
    store.upsertCorps([
      { corpCode: '00126380', corpName: '삼성전자', stockCode: '005930', jurirNo: '1301110006246', modifyDate: '20260101' },
    ]);
    // CORPCODE.xml 재적재 — jurir_no 가 없는 소스
    store.upsertCorps([
      { corpCode: '00126380', corpName: '삼성전자', stockCode: '005930', jurirNo: null, modifyDate: '20260201' },
    ]);
    expect(store.getCorpByCode('00126380')?.jurirNo).toBe('1301110006246');
    expect(store.getCorpByCode('00126380')?.modifyDate).toBe('20260201');
  });

  it('원문은 3글자 이상이면 FTS, 2글자 이하면 LIKE 로 찾는다', () => {
    store.storeBody('20260728000484', '이 건은 대규모내부거래에 해당하며 이사회 의결일은 2026-07-22이다', '공');
    expect(store.searchBodies('내부거래')).toHaveLength(1);
    expect(store.searchBodies('의결')).toHaveLength(1); // 2글자 → LIKE 폴백
    expect(store.searchBodies('없는말')).toHaveLength(0);
  });

  it('FTS 문법 문자가 섞인 키워드도 구문 오류 없이 처리한다 (Codex 지적)', () => {
    store.storeBody('20260101000002', '따옴표 "포함" 본문과 OR 조건', '');
    // 이전 구현: MATCH 문법으로 해석돼 SQLITE_ERROR 로 검색 전체가 죽었다
    expect(() => store.searchBodies('foo OR')).not.toThrow();
    expect(() => store.searchBodies('키워드"')).not.toThrow();
    expect(store.searchBodies('"포함"')).toHaveLength(1); // 리터럴로 매칭
  });

  it('파싱 실패한 원문도 빈 값으로 캐시해 재다운로드를 막는다', () => {
    store.storeBody('20260101000001', '');
    expect(store.hasBody('20260101000001')).toBe(true);
    expect(store.getBody('20260101000001')?.content).toBe('');
  });
});

describe('로그 — API 키 노출 방지 (회귀 고정)', () => {
  beforeEach(() => {
    __resetConfig();
    process.env['DART_API_KEY'] = '0000000000000000000000000000000000000000';
  });
  afterEach(() => {
    delete process.env['DART_API_KEY'];
    __resetConfig();
  });

  it('설정된 인증키는 로그에서 가려진다', () => {
    const out = redact('요청 실패 crtfc_key=0000000000000000000000000000000000000000 path=/list.json');
    expect(out).not.toContain('0000000000000000000000000000000000000000');
    expect(out).toContain('REDACTED');
  });

  it('설정에 없는 키 형태도 가려진다', () => {
    const out = redact('serviceKey=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789');
    expect(out).not.toContain('abcdef0123456789abcdef0123456789');
  });
});
