/**
 * 마크다운 표 파서 — J004 정합성 점검용
 *
 * document.ts 가 생성한 마크다운(원문 XML → 표 보존 변환)을 다시 구조화한다.
 * 원문 XML 을 직접 파싱하지 않는 이유: 원문 로드·캐시 경로(loadDocument)가 마크다운 기준으로
 * 이미 검증돼 있고, 병합 셀 전개·rowspan 이월 처리도 그 층에서 끝나 있기 때문이다.
 *
 * ⚠️ 마크다운 표준과 달리 우리 변환기는 구분선(| --- |) 이후에도 헤더 성격의 행이
 * 이어질 수 있다 (다층 헤더의 병합 셀 전개). 헤더 판정은 호출자가 키워드로 한다.
 */

export interface MdTable {
  /** 구분선 이전의 행 (통상 1행) */
  headerRows: string[][];
  /** 구분선 이후의 행 전부 — 다층 헤더의 잔여 행이 섞여 있을 수 있다 */
  rows: string[][];
}

export interface DocSection {
  /** '## ' 제목 (없으면 문서 서두는 빈 문자열) */
  title: string;
  tables: MdTable[];
  /** 표 밖 텍스트 줄 (단위 표기 "단위 : 백만원" 등이 1셀 표로 오기도 해서 표도 함께 봐야 한다) */
  textLines: string[];
}

/** '| a | b |' → ['a','b'] */
function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((c) => c.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c) || c === '');
}

/** 마크다운을 '## ' 섹션 단위로 나누고 각 섹션의 표를 파싱한다 */
export function splitSections(markdown: string): DocSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: DocSection[] = [];
  let current: DocSection = { title: '', tables: [], textLines: [] };
  let tableBuf: string[][] = [];
  let sawSeparator = false;
  let headerBuf: string[][] = [];

  const flushTable = () => {
    if (headerBuf.length > 0 || tableBuf.length > 0) {
      current.tables.push({ headerRows: headerBuf, rows: tableBuf });
    }
    headerBuf = [];
    tableBuf = [];
    sawSeparator = false;
  };

  for (const line of lines) {
    if (/^#{1,4} /.test(line.trim())) {
      flushTable();
      sections.push(current);
      current = { title: line.trim().replace(/^#{1,4} /, ''), tables: [], textLines: [] };
      continue;
    }
    if (line.trim().startsWith('|')) {
      const cells = splitRow(line);
      if (isSeparatorRow(cells)) {
        sawSeparator = true;
        continue;
      }
      if (!sawSeparator) headerBuf.push(cells);
      else tableBuf.push(cells);
      continue;
    }
    // 표가 아닌 줄 — 진행 중이던 표를 마감
    flushTable();
    if (line.trim() !== '') current.textLines.push(line.trim());
  }
  flushTable();
  sections.push(current);
  return sections;
}

/**
 * 공시 표기 숫자 파싱.
 *  '1,903,956'→1903956 / '(9)'→-9 / '-72,980'→-72980 / '0'→0 / '1,248.46'→1248.46
 *  '-'·''·'해당없음'·'자본잠식' 등 비수치 → null
 */
export function parseDisclosureNumber(cell: string): number | null {
  let s = cell.replace(/\s+/g, '');
  if (s === '' || s === '-' || s === '–') return null;
  let negative = false;
  const paren = /^\((.+)\)$/.exec(s);
  if (paren && paren[1] !== undefined) {
    negative = true;
    s = paren[1];
  }
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  if (s.startsWith('△') || s.startsWith('▲')) {
    negative = true;
    s = s.slice(1);
  }
  if (!/^[\d,]+(\.\d+)?$/.test(s)) return null;
  const n = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** 셀 정규화 — 헤더 키워드 매칭용 (공백·개행 제거) */
export function normalizeCell(cell: string): string {
  return cell.replace(/[\s ]+/g, '');
}

/** 회사명 정규화 — 문서 간 대사용. (주)·주식회사·유한회사 등 법인격 표기와 공백을 제거 */
export function normalizeCompanyName(name: string): string {
  return name
    .replace(/[\s ]+/g, '')
    .replace(/\(주\)|\(유\)|㈜|주식회사|유한회사|유한책임회사|합자회사|합명회사/g, '')
    .replace(/[·ㆍ.,'"‘’]/g, '');
}
