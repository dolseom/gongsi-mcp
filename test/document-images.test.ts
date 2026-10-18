/**
 * 원문 이미지 자리 표시 (2026-10-18)
 *
 * DART document.xml ZIP 에는 이미지 파일이 없다. 태그만 지우면 파일명·캡션이 평범한 문장처럼 남아
 * 그 자리의 표·그림 내용이 빠졌다는 사실이 사라진다. 실측: 정기·주요사항·증권신고서 24건 중 17건에
 * 136개, J공시 40건에는 0개 — 표시 후 136개 전부 표시, 파일명 잔여 0.
 */
import { describe, it, expect } from 'vitest';
import { parseDocument } from '../src/parsers/document.js';
import { readDisclosure } from '../src/tools/read-disclosure.js';
import { useMemoryStore } from './helpers/store.js';

const IMAGE = (file: string, caption: string) =>
  `<IMAGE>\n<IMG WIDTH="595" HEIGHT="840" ALIGN="CENTER" HSPACE="0">${file}</IMG>\n` +
  `<IMG-CAPTION ATOC="N">${caption}</IMG-CAPTION>\n</IMAGE>`;

describe('parseDocument — 이미지 표시', () => {
  it('IMAGE 블록을 캡션이 붙은 표시 문구로 바꾸고 파일명은 남기지 않는다', () => {
    const p = parseDocument(`<BODY><P>앞 문단</P>${IMAGE('261012_대표이사 등의 확인.jpg', '대표이사 등의 확인')}<P>뒤 문단</P></BODY>`);
    expect(p.imageCount).toBe(1);
    expect(p.markdown).toContain('[이미지 생략: 대표이사 등의 확인 — 텍스트로 제공되지 않음');
    expect(p.markdown).not.toContain('.jpg');
    expect(p.markdown).toContain('앞 문단');
    expect(p.markdown).toContain('뒤 문단');
  });

  it('표 셀 안의 이미지도 그 셀에 표시가 남는다', () => {
    const p = parseDocument(
      `<TABLE><TR><TD>구분</TD><TD>내용</TD></TR><TR><TD>조직도</TD><TD>${IMAGE('org.gif', '조직도')}</TD></TR></TABLE>`,
    );
    expect(p.imageCount).toBe(1);
    expect(p.markdown).toMatch(/\| 조직도 \| \[이미지 생략: 조직도 —/);
  });

  it('IMAGE 로 감싸지 않은 단독 IMG 도 센다, 이미지 없는 문서는 0', () => {
    expect(parseDocument('<P>x</P><IMG WIDTH="1">a.png</IMG>').imageCount).toBe(1);
    const none = parseDocument('<P>이미지 없음</P>');
    expect(none.imageCount).toBe(0);
    expect(none.markdown).toBe('이미지 없음');
  });
});

describe('read_disclosure — images_note', () => {
  const store = useMemoryStore();
  const seed = (rcept: string, body: string, meta: Record<string, unknown>) => {
    store().storeBody(rcept, body);
    store().set(
      `docmeta:${rcept}`,
      JSON.stringify({
        acode: null, aregcik: null, formulaVersion: null, encoding: 'utf-8', attachments: [],
        bodyParsable: true, boardDate: null, boardDateStatus: 'label_missing', pickedEntry: 'a.xml', ...meta,
      }),
    );
  };

  it('이미지가 있으면 개수와 "추측 금지" 안내를 싣는다', async () => {
    seed('20261012000468', '본문 [이미지 생략: 조직도 — …]', { imageCount: 2 });
    const r = (await readDisclosure({ rcept_no: '20261012000468' } as never)) as Record<string, unknown>;
    expect(r['images_omitted']).toBe(2);
    expect(String(r['images_note'])).toContain('추측하지 말고');
  });

  it('이미지 0개면 아무것도 붙이지 않는다', async () => {
    seed('20261012000469', '본문', { imageCount: 0 });
    const r = (await readDisclosure({ rcept_no: '20261012000469' } as never)) as Record<string, unknown>;
    expect(r['images_omitted']).toBeUndefined();
    expect(r['images_note']).toBeUndefined();
  });

  it('표시 도입 전 캐시: 파일명 흔적이 있을 때만 미확인임을 밝힌다', async () => {
    seed('20261012000470', '본문 261012_대표이사 등의 확인.jpg 대표이사 등의 확인', {});
    seed('20261012000471', '대규모내부거래 본문 (단위: 백만원)', {});
    const withTrace = (await readDisclosure({ rcept_no: '20261012000470' } as never)) as Record<string, unknown>;
    const plain = (await readDisclosure({ rcept_no: '20261012000471' } as never)) as Record<string, unknown>;
    expect(String(withTrace['images_note'])).toContain('force_refresh');
    expect(plain['images_note']).toBeUndefined();
  });
});
