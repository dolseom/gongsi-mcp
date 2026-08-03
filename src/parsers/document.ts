/**
 * DART 공시 원문 XML → 마크다운
 *
 * 축 1(선례·문안 참고)의 심장이다. 설계 원칙:
 *
 * **표를 구조 보존해서 넘기고, 해석은 LLM 에 맡긴다.**
 * "라벨 다음 칸이 값"식 추출은 병합 셀 때문에 부정확하다는 것을 실물로 확인했다
 * (거래상대방 자리에 숫자가 들어오는 오류). 우리가 정밀 추출하는 것은
 * 판정에 쓰는 극소수 필드(이사회 의결일 등)뿐이고, 나머지는 표 그대로 보여준다.
 *
 * DART 원문은 dart4.xsd 기반 XML 로, 대문자 태그(TABLE/TR/TD/TITLE/P …)를 쓴다.
 * J공시는 UTF-8 정형이지만 축 1은 범용이므로 EUC-KR 폴백을 둔다.
 */

export interface ParsedDocument {
  /** 표 구조를 보존한 마크다운 본문 */
  markdown: string;
  /** 검색 인덱싱용 평문 (태그·파이프 제거, 공백 정규화) */
  plainText: string;
  /** 서식 코드 — 파서·판정의 키 (예: 80718 자금차입) */
  acode: string | null;
  /** 제출자 corp_code */
  aregcik: string | null;
  formulaVersion: string | null;
}

/** 바이트 → 문자열. UTF-8 을 엄격 모드로 먼저 시도하고 실패하면 EUC-KR. */
export function decodeDocument(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'euc-kr' } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('euc-kr').decode(bytes), encoding: 'euc-kr' };
  }
}

const ENTITY_MAP: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
  '&middot;': '·',
};

export function decodeEntities(s: string): string {
  let out = s;
  for (const [from, to] of Object.entries(ENTITY_MAP)) out = out.split(from).join(to);
  out = out.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
  // &amp; 는 마지막에 — 이중 이스케이프(&amp;lt;)를 먼저 풀면 안 된다
  return out.split('&amp;').join('&');
}

/** 셀 내부 텍스트: 하위 태그 제거 + 엔티티 해제 + 공백 정규화 */
function cellText(inner: string): string {
  return decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

interface Cell {
  text: string;
  colspan: number;
  rowspan: number;
}

/** <TABLE> 블록 하나를 행렬로 복원한다. 병합 셀은 그리드에 펼친다. */
function parseTable(tableXml: string): string[][] {
  const rows: Cell[][] = [];
  const trRe = /<TR[^>]*>([\s\S]*?)<\/TR>/gi;
  let tr: RegExpExecArray | null;
  while ((tr = trRe.exec(tableXml)) !== null) {
    const src = tr[1] ?? '';
    const cells: Cell[] = [];
    // 속성(COLSPAN/ROWSPAN)이 필요하므로 여는 태그 기준으로 순회한다
    const openRe = /<(T[DHE])([^>]*?)(\/?)>/gi;
    let open: RegExpExecArray | null;
    while ((open = openRe.exec(src)) !== null) {
      const tag = open[1] ?? 'TD';
      const attrs = open[2] ?? '';
      const colspan = Math.max(1, Number(/COLSPAN\s*=\s*"?(\d+)/i.exec(attrs)?.[1] ?? 1));
      const rowspan = Math.max(1, Number(/ROWSPAN\s*=\s*"?(\d+)/i.exec(attrs)?.[1] ?? 1));
      let text = '';
      if (open[3] !== '/') {
        const start = open.index + open[0].length;
        const close = src.indexOf(`</${tag}`, start);
        // 닫는 태그를 못 찾으면 끝까지로 본다 (손상 원문 관대 처리)
        text = cellText(src.slice(start, close >= 0 ? close : src.length));
      }
      cells.push({ text, colspan, rowspan });
    }
    if (cells.length) rows.push(cells);
  }

  // 병합 셀을 그리드에 펼친다.
  // ⚠️ "현재 열에 이월분이 있는가"만 보면, 이월분이 더 뒤 열에만 남았을 때 루프가
  // 조기 종료되어 열이 통째로 어긋난다(Codex 지적). 셀 배치 전마다 점유 열을 소비하고,
  // 행이 끝나면 남은 이월분까지 빈 칸으로 메워 소비한다.
  const grid: string[][] = [];
  /** rowspan 이월분: carry[colIndex] = { text, remaining } */
  const carry = new Map<number, { text: string; remaining: number }>();

  for (const cells of rows) {
    const row: string[] = [];
    let col = 0;

    const consumeCarryAt = () => {
      while (carry.has(col)) {
        const c = carry.get(col)!;
        row.push(c.text);
        c.remaining--;
        if (c.remaining <= 0) carry.delete(col);
        col++;
      }
    };

    for (const cell of cells) {
      consumeCarryAt(); // 새 셀은 점유되지 않은 첫 열부터 시작한다 (HTML 표 규칙)
      for (let i = 0; i < cell.colspan; i++) {
        // 병합 첫 칸에만 값, 나머지는 빈 칸 — 표 폭을 유지한다
        row.push(i === 0 ? cell.text : '');
        if (cell.rowspan > 1) {
          carry.set(col, { text: i === 0 ? cell.text : '', remaining: cell.rowspan - 1 });
        }
        col++;
      }
    }
    consumeCarryAt();

    // 뒤 열에만 남은 이월분: 사이를 빈 칸으로 메우고 마저 소비한다
    if (carry.size) {
      const maxCol = Math.max(...carry.keys());
      while (col <= maxCol) {
        const c = carry.get(col);
        if (c) {
          row.push(c.text);
          c.remaining--;
          if (c.remaining <= 0) carry.delete(col);
        } else {
          row.push('');
        }
        col++;
      }
    }
    grid.push(row);
  }
  return grid;
}

/** 행렬 → 마크다운 표. 열 수를 최댓값으로 맞춘다. */
function renderTable(grid: string[][]): string {
  if (!grid.length) return '';
  const width = Math.max(...grid.map((r) => r.length));
  const pad = (r: string[]) => {
    const out = [...r];
    while (out.length < width) out.push('');
    return out;
  };
  const esc = (s: string) => s.replace(/\|/g, '\\|');
  const lines: string[] = [];
  lines.push(`| ${pad(grid[0]!).map(esc).join(' | ')} |`);
  lines.push(`|${' --- |'.repeat(width)}`);
  for (const r of grid.slice(1)) {
    lines.push(`| ${pad(r).map(esc).join(' | ')} |`);
  }
  return lines.join('\n');
}

/** XML 주석·CDATA 를 정리한다 — 주석 안의 <TABLE> 이 가짜 표로 파싱되는 것을 막는다 */
function stripCommentsAndCdata(xml: string): string {
  return xml
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/** 본문 XML → 마크다운 + 평문 */
export function parseDocument(rawXml: string): ParsedDocument {
  const xml = stripCommentsAndCdata(rawXml);
  const acode = /ACODE\s*=\s*"([^"]+)"/.exec(xml)?.[1] ?? null;
  const aregcik = /AREGCIK\s*=\s*"([^"]+)"/.exec(xml)?.[1] ?? null;
  const formulaVersion = /FORMULA-VERSION\s*=\s*"([^"]+)"/.exec(xml)?.[1] ?? null;

  const parts: string[] = [];
  // TABLE 을 경계로 나누어, 표는 구조 보존하고 나머지는 텍스트로 흘린다
  const segments = xml.split(/(<TABLE[^>]*>[\s\S]*?<\/TABLE>)/gi);
  for (const seg of segments) {
    if (/^<TABLE/i.test(seg)) {
      const md = renderTable(parseTable(seg));
      if (md) parts.push(md);
      continue;
    }
    // 표 밖 텍스트: TITLE 은 제목으로, 나머지는 문단으로
    const withTitles = seg.replace(
      /<TITLE[^>]*>([\s\S]*?)<\/TITLE>/gi,
      (_, inner: string) => `\n## ${cellText(inner)}\n`,
    );
    const text = decodeEntities(withTitles.replace(/<(?!\/?##)[^>]+>/g, ' '))
      .split('\n')
      .map((l) => l.replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
    if (text) parts.push(text);
  }

  const markdown = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  const plainText = decodeEntities(xml.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

  return { markdown, plainText, acode, aregcik, formulaVersion };
}

/**
 * 정밀 추출 — 판정에 쓰는 필드만.
 * 서식마다 "이사회 의결일"/"이사회의결일" 표기가 섞여 있으므로 글자 사이 공백을 허용해 매칭한다.
 */
export function extractBoardDate(rawXml: string): string | null {
  const plain = stripCommentsAndCdata(rawXml).replace(/<[^>]+>/g, ' ');
  const m = /이\s*사\s*회\s*의\s*결\s*일/.exec(plain);
  if (!m) return null;

  let after = plain.slice(m.index + m[0].length, m.index + m[0].length + 400);
  // 다음 항목 번호("4. 동일인…" 등)에서 창을 끊는다 — 의결일이 "-" 인 서식(약관 특례)에서
  // 뒤따르는 "7. 관련공시일" 같은 다른 날짜를 의결일로 오인하지 않게 (실물 80703 에서 확인).
  // 항목 번호는 뒤에 한글이 온다 — "2026. 7. 22" 처럼 띄어 쓴 날짜의 " 7. " 과 구분된다.
  const nextSection = after.search(/\s\d{1,2}\.\s*[가-힣]/);
  if (nextSection >= 0) after = after.slice(0, nextSection);

  const valid = (y: string, mo: string, d: string): string | null => {
    const moN = Number(mo);
    const dN = Number(d);
    // 달력 유효성 round-trip — "2026.2.31" 은 Date.UTC 가 3월로 롤오버시키므로
    // 재직렬화가 원본과 달라지는 것으로 실존하지 않는 날짜를 걸러낸다
    const dt = new Date(Date.UTC(Number(y), moN - 1, dN));
    if (
      dt.getUTCFullYear() !== Number(y) ||
      dt.getUTCMonth() !== moN - 1 ||
      dt.getUTCDate() !== dN
    ) {
      return null;
    }
    return `${y}${String(moN).padStart(2, '0')}${String(dN).padStart(2, '0')}`;
  };

  const date = /(\d{4})\s*[.\-년]\s*(\d{1,2})\s*[.\-월]\s*(\d{1,2})/.exec(after);
  if (date) return valid(date[1]!, date[2]!, date[3]!);
  // 아포스트로피 2자리 연도 — "'26. 7.23" (삼성생명 등에서 실측). 오인 방지를 위해 ' 필수
  const short = /'(\d{2})\s*[.\-]\s*(\d{1,2})\s*[.\-]\s*(\d{1,2})/.exec(after);
  if (short) return valid(`20${short[1]!}`, short[2]!, short[3]!);
  return null;
}
