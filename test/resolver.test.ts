import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import {
  listEntries,
  readEntry,
  readFirstEntry,
  pickLargestText,
  looksLikeZip,
  ZipError,
} from '../src/lib/zip.js';
import {
  parseCorpCodeXml,
  detectIdentifier,
  normalizeName,
  resolveCorp,
} from '../src/resolver/corp-index.js';
import { Store, __setStore } from '../src/lib/store.js';
import { AmbiguousCorpError, CorpNotFoundError, ToolError } from '../src/lib/errors.js';
import type { DartClient } from '../src/clients/dart.js';

// ---- 테스트용 ZIP 생성기 (로컬 헤더 + 중앙 디렉터리 + EOCD 를 직접 조립) ----

interface ZipFileSpec {
  name: string;
  data: Uint8Array;
  /** 0 = 무압축, 8 = deflate (기본) */
  method?: 0 | 8;
}

function makeZip(files: ZipFileSpec[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
  const u32 = (n: number) =>
    new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);

  for (const f of files) {
    const method = f.method ?? 8;
    const nameBytes = enc.encode(f.name);
    const comp = method === 0 ? f.data : new Uint8Array(deflateRawSync(f.data));

    // 로컬 헤더 (CRC 는 0 — 우리 파서는 CRC 를 검증하지 않는다)
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(0), u32(comp.length), u32(f.data.length),
      u16(nameBytes.length), u16(0), nameBytes, comp,
    ]);
    // 중앙 디렉터리 항목
    central.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(0), u32(comp.length), u32(f.data.length),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), nameBytes,
    ]));
    chunks.push(local);
    offset += local.length;
  }

  const centralBlob = concat(central);
  const eocd = concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralBlob.length), u32(offset), u16(0),
  ]);
  return concat([...chunks, centralBlob, eocd]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

describe('ZIP 파서', () => {
  it('deflate·무압축 항목을 왕복한다 (한글 포함)', () => {
    const zip = makeZip([
      { name: 'doc.xml', data: enc.encode('<XML>이사회 의결일 2026.07.22</XML>') },
      { name: 'raw.txt', data: enc.encode('무압축 항목'), method: 0 },
    ]);
    expect(looksLikeZip(zip)).toBe(true);

    const entries = listEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(['doc.xml', 'raw.txt']);
    expect(dec.decode(readEntry(zip, entries[0]!))).toContain('이사회 의결일');
    expect(dec.decode(readEntry(zip, entries[1]!))).toBe('무압축 항목');
  });

  it('readFirstEntry 는 조건에 맞는 첫 항목을 준다', () => {
    const zip = makeZip([
      { name: 'a.txt', data: enc.encode('A') },
      { name: 'b.xml', data: enc.encode('<b/>') },
    ]);
    const found = readFirstEntry(zip, (n) => n.endsWith('.xml'));
    expect(found?.name).toBe('b.xml');
  });

  it('pickLargestText 는 가장 큰 텍스트를 본문으로, 나머지 확장자를 첨부로 분류한다', () => {
    const zip = makeZip([
      { name: 'small.xml', data: enc.encode('<a/>') },
      { name: 'big.xml', data: enc.encode('<XML>' + '본문'.repeat(500) + '</XML>') },
      { name: 'attach.hwp', data: new Uint8Array(100) },
    ]);
    const picked = pickLargestText(zip);
    expect(picked.name).toBe('big.xml');
    expect(picked.attachments).toEqual(['hwp']);
  });

  it('경로 탈출 항목은 거부한다', () => {
    const zip = makeZip([{ name: '../evil.xml', data: enc.encode('<x/>') }]);
    expect(() => listEntries(zip)).toThrow(ZipError);
  });

  it('ZIP 이 아니거나 손상된 입력은 ZipError 를 던진다', () => {
    expect(() => listEntries(new TextEncoder().encode('{"status":"013"}'))).toThrow(ZipError);
    expect(() => listEntries(new Uint8Array([0x50, 0x4b, 0, 0]))).toThrow(ZipError);
  });
});

describe('corpCode.xml 파싱', () => {
  it('법인 목록을 뽑고 XML 엔티티·빈 종목코드를 처리한다', () => {
    const xml = `<?xml version="1.0"?><result>
      <list><corp_code>00126380</corp_code><corp_name>삼성전자</corp_name><stock_code>005930</stock_code><modify_date>20260101</modify_date></list>
      <list><corp_code>00434003</corp_code><corp_name>삼성E&amp;A</corp_name><stock_code> </stock_code><modify_date>20260102</modify_date></list>
    </result>`;
    const records = parseCorpCodeXml(xml);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ corpCode: '00126380', stockCode: '005930' });
    // &amp; 디코딩 + 빈 종목코드 → null
    expect(records[1]).toMatchObject({ corpName: '삼성E&A', stockCode: null, jurirNo: null });
  });
});

describe('식별자 판정·상호 정규화', () => {
  it('숫자 길이로 식별자 종류를 가른다', () => {
    expect(detectIdentifier('00126380')).toBe('corp_code');
    expect(detectIdentifier('005930')).toBe('stock_code');
    expect(detectIdentifier('1301110006246')).toBe('jurir_no');
    expect(detectIdentifier('130111-0006246')).toBe('jurir_no');
    expect(detectIdentifier('삼성전자')).toBe('name');
  });

  it('법인격 표기·공백을 걷어낸다', () => {
    expect(normalizeName('(주)삼성전자')).toBe('삼성전자');
    expect(normalizeName('삼성전자 주식회사')).toBe('삼성전자');
    expect(normalizeName('㈜ 한화')).toBe('한화');
  });

  it('상호 중간의 법인격 문자열은 지우지 않는다 (Codex 지적)', () => {
    // 앞뒤에서만 제거 — 중간을 지우면 서로 다른 법인이 같은 이름으로 뭉개진다
    expect(normalizeName('한국주식회사연구소')).toBe('한국주식회사연구소');
  });
});

describe('resolveCorp (사전 적재된 인덱스)', () => {
  let store: Store;
  // 인덱스가 차 있으면 client 를 호출하지 않는다 — 더미로 충분
  const dummy = {} as DartClient;

  beforeEach(() => {
    store = new Store(':memory:');
    __setStore(store);
    store.upsertCorps([
      { corpCode: '00126380', corpName: '삼성전자', stockCode: '005930', jurirNo: null, modifyDate: null },
      { corpCode: '00126229', corpName: '삼성물산', stockCode: null, jurirNo: null, modifyDate: null },
      { corpCode: '00149655', corpName: '삼성물산', stockCode: null, jurirNo: null, modifyDate: null },
    ]);
  });

  afterEach(() => {
    __setStore(null);
    store.close();
  });

  it('상호 완전일치 단독이면 그대로 찾는다', async () => {
    const r = await resolveCorp('삼성전자', dummy);
    expect(r).toMatchObject({ corpCode: '00126380', matchedBy: 'name' });
  });

  it('법인격 표기만 다르면 정규화 일치로 찾고 표시한다', async () => {
    const r = await resolveCorp('(주)삼성전자', dummy);
    expect(r).toMatchObject({ corpCode: '00126380', normalizedMatch: true });
  });

  it('동명 법인은 임의로 고르지 않는다', async () => {
    await expect(resolveCorp('삼성물산', dummy)).rejects.toThrow(AmbiguousCorpError);
    const r = await resolveCorp('삼성물산', dummy, { allowAmbiguous: true });
    expect(r).toMatchObject({ ambiguous: true });
    if ('ambiguous' in r) expect(r.candidates).toHaveLength(2);
  });

  it('corp_code·stock_code 로도 찾는다', async () => {
    expect(await resolveCorp('00126380', dummy)).toMatchObject({ matchedBy: 'corp_code' });
    expect(await resolveCorp('005930', dummy)).toMatchObject({ matchedBy: 'stock_code' });
  });

  it('법인등록번호는 채워진 뒤에만 찾아지고, 없으면 이유를 설명한다', async () => {
    await expect(resolveCorp('1301110006246', dummy)).rejects.toThrow(ToolError);
    store.setJurirNo('00126380', '1301110006246');
    const r = await resolveCorp('130111-0006246', dummy);
    expect(r).toMatchObject({ corpCode: '00126380', matchedBy: 'jurir_no' });
  });

  it('매칭 없으면 후보 제안과 함께 CorpNotFoundError', async () => {
    await expect(resolveCorp('없는회사명', dummy)).rejects.toThrow(CorpNotFoundError);
  });

  it('숫자 형식은 추정일 뿐 — 코드 조회가 비면 이름으로 폴백한다 (Codex 지적)', async () => {
    // 상호가 6자리 숫자인 회사: 종목코드로 오분류되지만 이름 폴백으로 찾아진다
    store.upsertCorps([
      { corpCode: '99999901', corpName: '123456', stockCode: null, jurirNo: null, modifyDate: null },
    ]);
    const r = await resolveCorp('123456', dummy);
    expect(r).toMatchObject({ corpCode: '99999901' });
  });
});
