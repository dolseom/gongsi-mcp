/**
 * J001 원문 파서 — 거래상대방·거래대상·거래금액을 읽어 이 거래와 대조한다 (순수 함수)
 */

import { viewerUrl, type Disclosure } from '../../clients/dart.js';
import { splitRow } from '../../parsers/md-table.js';
import type { FilingRef } from './types.js';

/** J001 원문에서 읽어 낸 사실 — 상대방 대조에 쓴다 (금액은 단위가 섞여 **문자열 그대로**) */
export interface FilingDocFacts {
  /**
   * 현재 유효한 거래상대방. 세로형(80708·80718·80719·80706·80732)은 라벨 행의 **마지막** 비어
   * 있지 않은 셀(정정본은 `정정사유 | 정정전 | 정정후` 순이라 정정후) 1건, 가로형(80757·80702·
   * 80754 계열)은 표의 상대방 열 전부(중복 제거).
   */
  counterparties: string[];
  /** 정정본에서 밀려난 정정전 상대방 — 대조에는 쓰지 않고 표시만 한다 (Codex ②) */
  superseded_counterparties?: string[];
  /** '다. 거래대상' 또는 표의 거래목적물·채권종류(종목명) 열 — 유형 판단 참고용 */
  subjects: string[];
  /** '라. 거래금액' 원문 텍스트 — 80708 은 '217 억원'·'12,226'(백만원) 이 섞여 있어 숫자화하지 않는다 */
  amount_text?: string;
}

/**
 * 세로형 서식에서 '거래상대방' 자리를 가리키는 라벨인가.
 *
 * ★ **정확 일치만 본다.** `4. 거래상대방과의 차입총계`(80718)·`다. 거래상대방 총잔액`(80719)·
 *   `라. 출자상대방 총출자액`(80732)은 전부 **금액 라벨**이라 상대방 이름이 오지 않는다.
 *   부분 일치로 잡으면 금액을 상대방으로 읽어 대조가 통째로 틀어진다.
 */
function isVerticalCounterpartyLabel(cell: string): boolean {
  const c = cell.trim();
  return (
    /^(?:\d+\.\s*)?거래상대방$/.test(c) ||
    /차입처$/.test(c) ||
    /대여처$/.test(c) ||
    /출자상대방$/.test(c) ||
    /^상대방$/.test(c)
  );
}

/**
 * 세로형 라벨 행으로 인정할지 — 라벨 문자열만 보면 **가로형 표의 열 이름**을 값 행으로 오독한다.
 *
 * 실측 반례 2종: 80757 헤더 `| 거래상대방 | 거래예정기간 | 거래대상 | … |` (첫 칸이 라벨과 같다) /
 * 80754 1단 헤더 `| 발행자 |  | 거래일자 | 거래상대방 |  | 거래금액 | … |` (넷째 칸이 라벨과 같다).
 * 둘 다 그대로 읽으면 '거래목적'·'거래금액' 같은 **열 이름이 상대방으로** 올라간다.
 *
 * → 실측 세로형 6종(80708·80718·80719·80706·80732 + 정정본)은 예외 없이
 *   ① 같은 행에 `회사와의 관계` 칸이 있거나 ② 라벨에 항목번호(`1.`·`나.`)가 붙는다.
 *   둘 중 하나도 없으면 **읽지 않는다** — 미확인 서식은 no_counterparty_field 로 남기지
 *   "공시 존재"로 올리지 않는 쪽이 이 도구의 기본 방향이다.
 */
function isVerticalLabelRow(cells: string[], labelIdx: number): boolean {
  const hasRelation = cells.some((c) => /회사와의\s*관계/.test(c));
  const numbered = /^(?:\d+|[가-힣])\.\s*\S/.test(cells[labelIdx] ?? '');
  return hasRelation || numbered;
}

/** doc_subjects 로 실어 나르는 상한 — 80754 트랙 B 는 종목명이 수십 줄이라 표시가 터진다 */
const MAX_DOC_SUBJECTS = 20;

/** 셀 안의 `\|` 이스케이프를 지키는 공용 분리기 — 단순 split('|') 은 열을 밀어 상대방을 오독한다 */
const mdCells = splitRow;

/**
 * J001 원문(markdown)에서 **거래상대방·거래대상·거래금액**을 읽는다.
 *
 * 실측 서식 (2026-09-05, 미래에셋·농협양곡 실물 7건):
 *  - **세로형** — 라벨 행의 오른쪽에 상대방 이름이 온다. 라벨은 서식마다 다르다:
 *    `1. 거래상대방`(80708 내부거래 / 80719 자금대여 / 80706 수익증권 / 80732 출자) ·
 *    `나. 차입처`(80718 자금차입). 정정본은 `| 1. 거래상대방 | 정정사유 | 정정전 | 정정후 |
 *    회사와의 관계 … |` 형태라 라벨 뒤 ~ '회사와의 관계' 앞의 비어 있지 않은 셀 중
 *    **마지막**(= 정정후)만 현재 상대방으로 삼는다.
 *  - **가로형 A** — 상대방이 표의 **첫 칸**. 헤더가 `거래상대방`(80757 약관 상대방 공시) 또는
 *    `거래상대방(동일인 등 출자계열회사)`(80702 상품·용역 분기공시)이고, 후자는 다음 항목번호
 *    행(`5. 상품ㆍ용역 거래내역`)에서 끝난다.
 *  - **가로형 B** — 2단 헤더의 `상대방명` **열 번호**로 읽는다 (80754·80751·80752·80701 트랙 B
 *    분기 일괄). 같은 표의 `발행자명` 열은 상대방이 아니다. 소계·총계 행은 그 칸이 비어 있어
 *    자연히 빠진다.
 *
 * 어느 형식도 못 읽으면 counterparties 가 빈 배열 — 호출 쪽은 이를 **대조 불가**로 다뤄야 한다
 * (일치 없음과 다르다). 미확인 서식(담보 80734·80735, 유상증자참여 80733 등)이 여기 해당하고,
 * 그 건은 "공시 존재"로 올리지 않는다.
 */
export function parseFilingCounterparties(markdown: string): FilingDocFacts {
  const lines = markdown.split('\n');
  const counterparties: string[] = [];
  const superseded: string[] = [];
  const subjects: string[] = [];
  let amountText: string | undefined;
  const isSep = (c: string) => /^-+$/.test(c);
  const pushUnique = (arr: string[], v: string) => {
    if (v && v !== '-' && !arr.includes(v)) arr.push(v);
  };
  const pushSubject = (v: string) => {
    if (subjects.length < MAX_DOC_SUBJECTS) pushUnique(subjects, v);
  };

  // ── 세로형 ──
  for (const line of lines) {
    if (!line.trim().startsWith('|')) continue;
    const cells = mdCells(line);
    if (cells.length === 0 || cells.every(isSep)) continue;
    const label = cells.join(' ');
    const labelIdx = cells.findIndex(isVerticalCounterpartyLabel);
    if (labelIdx >= 0 && isVerticalLabelRow(cells, labelIdx)) {
      const rest = cells.slice(labelIdx + 1);
      const stop = rest.findIndex((c) => c.includes('회사와의 관계') || c.includes('회사와의관계'));
      const cand = (stop >= 0 ? rest.slice(0, stop) : rest).filter((c) => c !== '');
      // ★ 정정본은 `정정사유 | 정정전 | 정정후` — 정정전 상대방으로 "일치"를 만들면 안 된다.
      //   마지막 셀만 현재 상대방으로 삼고 나머지는 superseded 로 분리한다.
      if (cand.length > 0) {
        pushUnique(counterparties, cand[cand.length - 1]!);
        // 3칸 이상이면 첫 칸은 정정사유 — 상대방이 아니다
        for (const c of cand.length >= 3 ? cand.slice(1, -1) : cand.slice(0, -1)) {
          pushUnique(superseded, c);
        }
      }
      continue;
    }
    if (/다\.\s*거래대상/.test(label)) {
      const idx = cells.findIndex((c) => /거래대상/.test(c));
      const cand = cells.slice(idx + 1).filter((c) => c !== '');
      if (cand.length > 0) pushSubject(cand[cand.length - 1]!);
      continue;
    }
    if (/라\.\s*거래금액/.test(label) && amountText === undefined) {
      const idx = cells.findIndex((c) => /거래금액/.test(c));
      const cand = cells.slice(idx + 1).filter((c) => c !== '');
      if (cand.length > 0) amountText = cand[cand.length - 1];
    }
  }
  if (counterparties.length > 0) {
    return {
      counterparties,
      ...(superseded.length ? { superseded_counterparties: superseded } : {}),
      subjects,
      amount_text: amountText,
    };
  }

  // ── 가로형 A(첫 칸) / B(상대방명 열) ──
  // 헤더를 만나면 모드가 바뀌고, 표가 끝나거나 다음 항목번호 행을 만나면 모드가 풀린다.
  type HMode =
    | { kind: 'first_cell'; subjectCol: number }
    | { kind: 'named_column'; cpCol: number; subjectCol: number }
    | null;
  let mode: HMode = null;
  for (const line of lines) {
    if (!line.trim().startsWith('|')) {
      mode = null;
      continue;
    }
    const cells = mdCells(line);
    if (cells.every(isSep)) continue;
    // 헤더 B — 2단 헤더의 '상대방명' 열. '발행자명' 열보다 이 열이 상대방이다.
    const cpCol = cells.findIndex((c) => c === '상대방명');
    if (cpCol >= 0) {
      mode = {
        kind: 'named_column',
        cpCol,
        subjectCol: cells.findIndex((c) => /종목명|채권종류/.test(c)),
      };
      continue;
    }
    // 헤더 A — 첫 칸이 '거래상대방'(80757) 이거나 어느 칸이 '거래상대방(' 로 시작(80702)
    if (cells[0] === '거래상대방' || cells.some((c) => c.startsWith('거래상대방('))) {
      mode = {
        kind: 'first_cell',
        subjectCol: cells.findIndex((c) => c === '거래목적물' || c === '거래대상'),
      };
      continue;
    }
    if (!mode) continue;
    const first = cells[0] ?? '';
    // 다음 항목번호(`5. 상품ㆍ용역 거래내역`) 행 = 상대방 표의 끝 (80702)
    if (/^\d+\.\s*\S/.test(first)) {
      mode = null;
      continue;
    }
    if (/^(총\s*계|소\s*계|합\s*계|이사회\s*의결일)/.test(first)) continue;
    if (mode.kind === 'first_cell') {
      pushUnique(counterparties, first);
      if (mode.subjectCol >= 0) pushSubject(cells[mode.subjectCol] ?? '');
    } else {
      pushUnique(counterparties, cells[mode.cpCol] ?? '');
      if (mode.subjectCol >= 0) pushSubject(cells[mode.subjectCol] ?? '');
    }
  }
  return { counterparties, subjects, amount_text: amountText };
}

/** @deprecated 유형 미상 전용이던 시절의 이름 — 호환용 별칭이다 */
export const parseAmbiguousFilingDoc = parseFilingCounterparties;

/** 유형 미상 원문의 거래대상을 우리 판정 유형으로 거칠게 분류한 값 */
export type AmbiguousSubjectClass = 'funds' | 'securities' | 'goods' | 'unknown';

const SUBJECT_KEYWORDS: Record<Exclude<AmbiguousSubjectClass, 'unknown'>, RegExp> = {
  funds: /차입|대여|대여금|차입금|자금/,
  securities: /지분|주식|출자|증권|수익증권|채권|사채|펀드|조합|CP|기업어음/,
  goods: /용역|서비스|상품|사용료|브랜드|상표|임대|임차|판매|수수료|광고|공사|매입|매출|위탁|운영|관리|보험/,
};

/**
 * 거래대상 텍스트 → 판정 유형. **정확히 한 유형의 키워드만** 걸릴 때 그 유형, 아니면 unknown.
 *
 * ★ 왜 필요한가 (Codex 검토 ①, 2026-09-05): 상대방 이름만으로 "공시 존재"를 올리면 같은 회사 쌍의
 *   **다른 유형** 공시(예: 자산운용과의 브랜드 사용료 공시)가 그 쌍의 유가증권 거래를 확인 대상에서
 *   빼 버린다. 같은 집단 안에서 한 쌍이 여러 유형을 거래하는 것은 흔하다.
 * ★ 왜 키워드 하나로 단정하지 않는가: '출자증권 매입 용역' 같은 복합 표현은 두 유형에 걸린다 —
 *   그때는 unknown 으로 두고 사람이 보게 한다 (버리지 않고 보류).
 */
export function classifyAmbiguousSubject(subjects: string[]): AmbiguousSubjectClass {
  const text = subjects.join(' ');
  if (!text.trim()) return 'unknown';
  const hits = (Object.keys(SUBJECT_KEYWORDS) as Array<keyof typeof SUBJECT_KEYWORDS>).filter((k) =>
    SUBJECT_KEYWORDS[k].test(text),
  );
  return hits.length === 1 ? hits[0]! : 'unknown';
}

/** checkCompany 의 typeLabel → 원문 거래대상에서 기대하는 분류 */
export function expectedSubjectClass(typeLabel: string): Exclude<AmbiguousSubjectClass, 'unknown'> {
  if (typeLabel === '유가증권') return 'securities';
  if (typeLabel === '상품·용역') return 'goods';
  return 'funds'; // 자금차입 · 자금대여
}

/** 원문 대조 결과 — FilingRef 에 실어 사용자에게도 그대로 보여 준다 */
export type FilingDocRead =
  | { read: 'ok'; facts: FilingDocFacts; acode: string | null }
  | { read: 'error'; error: string }
  | { read: 'budget_exceeded' }
  /** **건수**가 아니라 **시간** 예산(60초 벽)이 모자라 열지 않았다 — 둘은 대응이 다르다 */
  | { read: 'deadline_exceeded' };

export function toFilingRef(d: Disclosure): FilingRef {
  return {
    rcept_no: d.rcept_no,
    rcept_dt: d.rcept_dt,
    report_nm: d.report_nm,
    viewer_url: viewerUrl(d.rcept_no),
  };
}
