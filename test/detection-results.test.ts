/**
 * 탐지 결과 임시 보관 + 상세 이어 읽기 회귀.
 *
 * ★ 이 파일의 대형 결과는 **합성 fixture** 다 — 프로세스 안에서 보관소·읽기 도구·공용
 *   직렬화 함수를 통과시킨다. 실제 stdio 에 이 fixture 를 넣은 것이 **아니다**
 *   (DART 베이스 URL 은 상수이고 J001 목록은 캐시하지 않으므로 stdio 로 대형 결과를
 *   결정적으로 재현할 방법이 없다 — 설치본 검증은 키 없이 되는 것만 본다).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  storeDetectionResult,
  getDetectionResult,
  clearDetectionResults,
  detectionResultStats,
  MAX_SNAPSHOTS,
  MAX_SNAPSHOT_BYTES,
  SNAPSHOT_TTL_MS,
} from '../src/lib/detection-results.js';
import {
  readDetectionResult,
  readDetectionResultInput,
  MAX_READ_CHARS,
} from '../src/tools/read-detection-result.js';
import { serializeToolResult, TOOL_RESULT_BYTE_BUDGET } from '../src/lib/tool-output.js';
import { ToolError, toErrorResponse } from '../src/lib/errors.js';

/** 한글·따옴표·역슬래시·개행이 섞인 문자열 — JSON escape 로 부풀어 바이트 예산을 실제로 압박한다 */
function messyKorean(n: number, seed: string): string {
  const unit = `${seed} "인용" \\역슬래시\\ 줄바꿈\n계열회사 거래상대방 기준금액 5억원 · caveat `;
  let out = '';
  while (out.length < n) out += unit;
  return out.slice(0, n);
}

/** 순수 한글 문자열 — UTF-8 3바이트/자라 8,000자면 24,000바이트다 (예산 압박 확인용) */
function pureKorean(n: number): string {
  const unit = '계열회사거래상대방기준금액자본총계미공시후보판정불가범위한계';
  let out = '';
  while (out.length < n) out += unit;
  return out.slice(0, n);
}

/** 실물 크기(222,709자 이상)의 합성 탐지 결과 */
function bigPayload(): Record<string, unknown> {
  return {
    scope: { source_rcept_no: '20260819000341', judged_at: '20260913' },
    summary: { complete: true, undisclosed_candidates: 2, not_judged: 7 },
    action_items: {
      total: 3,
      items: [1, 2, 3].map((i) => ({
        priority: 1,
        status: 'undisclosed_candidate',
        company: `회사${i}`,
        counterparty: `상대방${i}`,
      })),
    },
    scope_caveats: [messyKorean(1_200, '범위 한계'), messyKorean(900, '두 번째 한계')],
    notes: [messyKorean(400, '노트')],
    // 큰 덩어리 — 실물의 판정 배열 자리
    securities_signals: Array.from({ length: 400 }, (_, i) => ({
      company: `계열회사 ${i}`,
      counterparty: `거래상대방 ${i}`,
      reason: messyKorean(500, `근거 ${i}`),
    })),
  };
}

describe('보관소 기본 계약', () => {
  beforeEach(() => clearDetectionResults());

  it('result_id 는 32자리 16진수이고 매 호출 다르다', () => {
    const a = storeDetectionResult({ x: 1 });
    const b = storeDetectionResult({ x: 1 });
    expect(a.result_id).toMatch(/^[0-9a-f]{32}$/);
    expect(b.result_id).not.toBe(a.result_id);
    // 같은 내용이어도 새 snapshot 이다 — 앞 토큰의 내용을 덮어쓰지 않는다
    expect(getDetectionResult(a.result_id).text).toBe(serializeToolResult({ x: 1 }));
  });

  it('보관한 텍스트는 wrap 이 내보낼 문자열과 같은 함수로 만든다', () => {
    const payload = bigPayload();
    const s = storeDetectionResult(payload);
    expect(getDetectionResult(s.result_id).text).toBe(serializeToolResult(payload));
    expect(s.total_chars).toBeGreaterThan(222_709);
  });

  it('sections 는 최상위 key 목록이다', () => {
    const s = storeDetectionResult(bigPayload());
    expect(s.sections).toEqual([
      'scope',
      'summary',
      'action_items',
      'scope_caveats',
      'notes',
      'securities_signals',
    ]);
  });

  it(`${MAX_SNAPSHOTS + 1}번째를 넣으면 가장 오래된 것이 회수된다`, () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_SNAPSHOTS + 1; i += 1) {
      ids.push(storeDetectionResult({ i }).result_id);
    }
    expect(detectionResultStats().count).toBe(MAX_SNAPSHOTS);
    // 회수된 첫 id 는 읽을 수 없고, **다른 snapshot 을 대신 주지 않는다**
    try {
      getDetectionResult(ids[0]!);
      throw new Error('회수된 id 가 읽혔다');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe('result_unavailable');
    }
    expect(getDetectionResult(ids[MAX_SNAPSHOTS]!).text).toBe(serializeToolResult({ i: MAX_SNAPSHOTS }));
  });

  it('TTL 30분 + 1ms 이면 만료다 (주입 시계 — 실제 sleep 없음)', () => {
    let now = 1_000_000;
    const clock = () => now;
    const s = storeDetectionResult({ a: 1 }, { clock });
    expect(getDetectionResult(s.result_id, { clock }).text).toBe(serializeToolResult({ a: 1 }));
    now += SNAPSHOT_TTL_MS + 1;
    expect(() => getDetectionResult(s.result_id, { clock })).toThrowError(/보관된 탐지 결과가 없습니다/);
  });

  it('단일 snapshot 한도를 넘으면 usable id 없이 resource_limit 이다', () => {
    // 16MiB 를 넘기는 문자열 하나 (한글이라 문자당 3바이트)
    const huge = { blob: messyKorean(Math.ceil(MAX_SNAPSHOT_BYTES / 2), '초대형') };
    let thrown: unknown;
    try {
      storeDetectionResult(huge);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToolError);
    expect((thrown as ToolError).code).toBe('resource_limit');
    // 보관이 실패했으면 **아무 id 도 만들지 않는다**
    expect(detectionResultStats().count).toBe(0);
  });
});

describe('상세 읽기 — 조각을 이어붙이면 원본이다', () => {
  beforeEach(() => clearDetectionResults());

  /** 끝까지 읽어 이어붙인다. 모든 페이지의 최종 직렬화 바이트도 함께 검사한다 */
  function readAll(resultId: string, section?: string) {
    let offset = 0;
    let joined = '';
    const pages: number[] = [];
    for (let guard = 0; guard < 5_000; guard += 1) {
      const page = readDetectionResult({
        result_id: resultId,
        ...(section ? { section } : {}),
        offset,
      });
      pages.push(Buffer.byteLength(serializeToolResult(page), 'utf8'));
      expect(page.offset).toBe(offset);
      joined += page.text;
      if (page.complete) {
        expect(page.next_offset).toBeNull();
        return { joined, pages };
      }
      expect(page.next_offset).not.toBeNull();
      expect(page.next_offset!).toBeGreaterThan(offset);
      offset = page.next_offset!;
    }
    throw new Error('페이지가 끝나지 않았다 (next_offset 이 전진하지 않는다)');
  }

  it('전체를 순회해 이어붙이면 원본과 정확히 같고, 모든 페이지가 예산 안이다', () => {
    const payload = bigPayload();
    const s = storeDetectionResult(payload);
    const { joined, pages } = readAll(s.result_id);
    expect(joined).toBe(serializeToolResult(payload));
    expect(pages.length).toBeGreaterThan(30);
    expect(Math.max(...pages)).toBeLessThanOrEqual(TOOL_RESULT_BYTE_BUDGET);
  });

  it('지정 section 도 3페이지 이상을 합쳐 원본 구간과 같다 (QA happy)', () => {
    const payload = bigPayload();
    const s = storeDetectionResult(payload);
    const { joined, pages } = readAll(s.result_id, 'securities_signals');
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...pages)).toBeLessThanOrEqual(TOOL_RESULT_BYTE_BUDGET);
    // section 의 text 는 원본 JSON 문자열의 **연속 구간**이다
    expect(serializeToolResult(payload)).toContain(joined);
    // 이어붙인 뒤에는 파싱된다 (중간 조각은 아닐 수 있다)
    expect(Array.isArray(JSON.parse(joined))).toBe(true);
    expect(JSON.parse(joined)).toHaveLength(400);
  });

  it('한글 전용 section 도 바이트 예산을 지킨다 — escape 로 부풀어도', () => {
    const s = storeDetectionResult({ scope_caveats: [pureKorean(30_000)] });
    const { joined, pages } = readAll(s.result_id, 'scope_caveats');
    expect(Math.max(...pages)).toBeLessThanOrEqual(TOOL_RESULT_BYTE_BUDGET);
    // 한글은 3바이트라 8,000자를 다 못 싣는다 — 서버가 더 짧게 줄인 것이 정상이다
    const firstPage = readDetectionResult({ result_id: s.result_id, section: 'scope_caveats' });
    expect(firstPage.text.length).toBeLessThan(MAX_READ_CHARS);
    expect(firstPage.text.length).toBeGreaterThan(1_000);
    expect(JSON.parse(joined)[0]).toHaveLength(30_000);
  });

  it('limit 을 주면 그 이하로만 읽고 next_offset 이 이어진다', () => {
    const s = storeDetectionResult({ notes: [messyKorean(3_000, '노트')] });
    const p1 = readDetectionResult({ result_id: s.result_id, limit: 100 });
    expect(p1.text.length).toBeLessThanOrEqual(100);
    expect(p1.complete).toBe(false);
    const p2 = readDetectionResult({ result_id: s.result_id, offset: p1.next_offset!, limit: 100 });
    expect(p2.offset).toBe(p1.next_offset);
    expect((p1.text + p2.text).length).toBeGreaterThan(100);
  });

  it('surrogate pair 중간에서 자르지 않는다', () => {
    // 이모지는 UTF-16 2단위 — 경계에서 끊으면 이어붙여도 원본이 복원되지 않는다
    const emoji = '🙂'.repeat(4_000);
    const s = storeDetectionResult({ notes: [emoji] });
    let offset = 0;
    let joined = '';
    for (let i = 0; i < 500; i += 1) {
      const page = readDetectionResult({ result_id: s.result_id, section: 'notes', offset, limit: 101 });
      // 조각 경계가 쌍을 쪼개지 않았다 = 조각 끝이 high surrogate 가 아니다
      const last = page.text.charCodeAt(page.text.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      joined += page.text;
      if (page.complete) break;
      offset = page.next_offset!;
    }
    // section 은 원본 JSON 문자열의 연속 구간이다 (중첩 들여쓰기가 그대로 붙어 있다)
    expect(serializeToolResult({ notes: [emoji] })).toContain(joined);
    expect(joined).not.toContain('�');
    expect(JSON.parse(joined)[0]).toBe(emoji);
  });

  it('최상위 항목이 수천 개여도 모든 페이지가 예산 안이고 원본이 복원된다', () => {
    const payload: Record<string, unknown> = {};
    for (let i = 0; i < 4_000; i += 1) payload[`signal_bucket_${i}`] = [`근거 ${i}`];
    const s = storeDetectionResult(payload);
    const { joined, pages } = readAll(s.result_id);
    expect(Math.max(...pages)).toBeLessThanOrEqual(TOOL_RESULT_BYTE_BUDGET);
    expect(joined).toBe(serializeToolResult(payload));
    const first = readDetectionResult({ result_id: s.result_id });
    expect(first.available_sections_total).toBe(4_000);
  });

  it('마지막 페이지가 아니면 남은 분량과 "확인했다고 말하지 말라"를 남긴다', () => {
    const s = storeDetectionResult(bigPayload());
    const p = readDetectionResult({ result_id: s.result_id });
    expect(p.complete).toBe(false);
    expect(p.notes.join(' ')).toContain('확인했다');
    expect(p.notes.join(' ')).toContain('UTF-16');
  });
});

describe('상세 읽기 메타·오류의 바이트 상한 (Fable M1·M2 — 적대적 최상위 키)', () => {
  beforeEach(() => clearDetectionResults());

  const wireBytes = (v: unknown) => Buffer.byteLength(serializeToolResult(v), 'utf8');

  /** 200자 최상위 키 100개 — 한글(3바이트) / 따옴표·제어문자·이모지(escape 로 부푼다) */
  function adversarial(kind: 'korean' | 'escapes'): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    for (let i = 0; i < 100; i += 1) {
      const key =
        kind === 'korean'
          ? ('키' + String(i).padStart(3, '0')).padEnd(200, '한')
          : (`k${String(i).padStart(3, '0')}`).padEnd(200, '"\\🙂');
      payload[key] = [`값 ${i}`];
    }
    return payload;
  }

  for (const kind of ['korean', 'escapes'] as const) {
    it(`${kind}: 첫 페이지·limit=1 페이지가 예산 안이고, 실린 이름은 원본 키 그대로다`, () => {
      const payload = adversarial(kind);
      const s = storeDetectionResult(payload);
      const first = readDetectionResult({ result_id: s.result_id });
      expect(wireBytes(first)).toBeLessThanOrEqual(TOOL_RESULT_BYTE_BUDGET);
      const tiny = readDetectionResult({ result_id: s.result_id, limit: 1 });
      expect(wireBytes(tiny)).toBeLessThanOrEqual(TOOL_RESULT_BYTE_BUDGET);
      expect(tiny.next_offset).toBeGreaterThan(0);
      expect(first.available_sections_total).toBe(100);
      expect(first.available_sections.length).toBeLessThan(100);
      for (const name of first.available_sections) expect(Object.keys(payload)).toContain(name);
    });

    it(`${kind}: 전체를 끝까지 읽으면 원본이 복원되고 모든 페이지가 예산 안이다`, () => {
      const payload = adversarial(kind);
      const s = storeDetectionResult(payload);
      let offset = 0;
      let joined = '';
      let maxBytes = 0;
      for (let guard = 0; guard < 2_000; guard += 1) {
        const page = readDetectionResult({ result_id: s.result_id, offset });
        maxBytes = Math.max(maxBytes, wireBytes(page));
        joined += page.text;
        if (page.complete) break;
        offset = page.next_offset!;
      }
      expect(joined).toBe(serializeToolResult(payload));
      expect(maxBytes).toBeLessThanOrEqual(TOOL_RESULT_BYTE_BUDGET);
    });

    it(`${kind}: 없는 section 오류의 최종 문자열도 예산 안이고 목록을 중복하지 않는다`, () => {
      const s = storeDetectionResult(adversarial(kind));
      let thrown: unknown;
      try {
        readDetectionResult({ result_id: s.result_id, section: 'nope' });
      } catch (err) {
        thrown = err;
      }
      expect((thrown as ToolError).code).toBe('invalid_argument');
      expect(wireBytes(toErrorResponse(thrown))).toBeLessThanOrEqual(TOOL_RESULT_BYTE_BUDGET);
      expect((thrown as ToolError).details?.['available_sections_total']).toBe(100);
      expect((thrown as ToolError).message.length).toBeLessThan(1_000);
    });
  }

  it('section 설명의 예시는 실물 결과에 실제로 있는 최상위 항목이다 (not_judged 는 summary 카운터)', () => {
    const description = readDetectionResultInput.shape.section.description ?? '';
    expect(description).not.toContain('not_judged');
    expect(description).toContain('goods_services_signals');
    expect(description).toContain('coverage');
  });
});

describe('상세 읽기 — 거절해야 하는 입력 (QA failure)', () => {
  beforeEach(() => clearDetectionResults());

  it('없는 result_id 는 result_unavailable (다른 snapshot 을 주지 않는다)', () => {
    storeDetectionResult({ secret: '다른 결과의 내용' });
    const fake = 'a'.repeat(32);
    let thrown: unknown;
    try {
      readDetectionResult({ result_id: fake });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as ToolError).code).toBe('result_unavailable');
    expect((thrown as ToolError).message).not.toContain('다른 결과의 내용');
  });

  it('만료 뒤 읽기는 거절한다', () => {
    let now = 5_000_000;
    const clock = () => now;
    const s = storeDetectionResult(bigPayload(), { clock });
    now += SNAPSHOT_TTL_MS + 1;
    expect(() => readDetectionResult({ result_id: s.result_id }, { clock })).toThrowError(
      /보관된 탐지 결과가 없습니다/,
    );
  });

  it('음수 offset·초과 limit 은 스키마가 거절한다', async () => {
    const { readDetectionResultInput } = await import('../src/tools/read-detection-result.js');
    const id = 'b'.repeat(32);
    expect(readDetectionResultInput.safeParse({ result_id: id, offset: -1 }).success).toBe(false);
    expect(readDetectionResultInput.safeParse({ result_id: id, limit: 0 }).success).toBe(false);
    expect(
      readDetectionResultInput.safeParse({ result_id: id, limit: MAX_READ_CHARS + 1 }).success,
    ).toBe(false);
    expect(readDetectionResultInput.safeParse({ result_id: 'ZZZ' }).success).toBe(false);
    expect(readDetectionResultInput.safeParse({ result_id: id, offset: 0, limit: 10 }).success).toBe(
      true,
    );
  });

  it('경로형·중첩형 section 은 거절한다', () => {
    const s = storeDetectionResult(bigPayload());
    for (const bad of ['../../etc/passwd', 'summary.complete', 'a b', 'scope_caveats[0]']) {
      let thrown: unknown;
      try {
        readDetectionResult({ result_id: s.result_id, section: bad });
      } catch (err) {
        thrown = err;
      }
      expect((thrown as ToolError).code).toBe('invalid_argument');
    }
  });

  it('없는 section 은 사용 가능한 목록을 알려준다', () => {
    const s = storeDetectionResult(bigPayload());
    let thrown: unknown;
    try {
      readDetectionResult({ result_id: s.result_id, section: 'nope' });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as ToolError).code).toBe('invalid_argument');
    expect((thrown as ToolError).message).toContain('scope_caveats');
  });

  it('프로토타입 키는 section 이 아니다', () => {
    const s = storeDetectionResult(bigPayload());
    expect(() => readDetectionResult({ result_id: s.result_id, section: 'constructor' })).toThrowError(
      /없습니다/,
    );
  });

  it('총 길이를 넘는 offset 은 거절한다', () => {
    const s = storeDetectionResult({ a: 1 });
    expect(() => readDetectionResult({ result_id: s.result_id, offset: 10_000 })).toThrowError(
      /총 길이/,
    );
  });
});
