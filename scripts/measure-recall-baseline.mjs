#!/usr/bin/env node
/**
 * 1년 recall 기준선 측정 (함정 8번 해소 — "recall 판단은 1년 이상 윈도우로만 확정")
 *
 * 실제 프로덕션 수집 파이프라인(collectAdaptive)을 그대로 사용해:
 *   [1] J 전수 수집 → DART 신고 total_count 합계와 대조 (수집 recall)
 *   [2] 전체시장(카테고리 미지정) 수집 → J ≡ rm"공" 등식의 1년 검증
 *       (종전 근거는 2주×2구간뿐이었다 — 이 등식이 audit 도구 diagnostics 의 전제다)
 *
 * 기간은 고정(2025-08-01~2026-07-31): rcept_dt 는 과거로 소급 추가되지 않으므로
 * 재실행 시 같은 수치가 나와야 한다 = 회귀 기준선으로 쓸 수 있다.
 *
 * 호출량: J ~350 + 전체 ~1,900 ≈ 2,300 콜 (일일 한도 20,000 의 12%)
 * 실행: node scripts/measure-recall-baseline.mjs > 결과.json (진행 로그는 stderr)
 */
import { writeFileSync } from 'node:fs';
import { loadDotEnv } from '../dist/src/lib/config.js';
import { DartClient } from '../dist/src/clients/dart.js';
import { collectAdaptive } from '../dist/src/search/batch.js';

loadDotEnv();
const client = new DartClient();

// 2개월 창 6개 = 1년. corp_code 없는 검색·측정은 3개월 초과 시 status 100 (함정 10번).
const WINDOWS = [
  ['20250801', '20250930'],
  ['20251001', '20251130'],
  ['20251201', '20260131'],
  ['20260201', '20260331'],
  ['20260401', '20260531'],
  ['20260601', '20260731'],
];

async function collectSet(base, label) {
  const byId = new Map();
  let reported = 0;
  const issues = [];
  const perWindow = [];
  let measureCalls = 0;
  let collectCalls = 0;
  for (const [from, to] of WINDOWS) {
    const t0 = Date.now();
    // MCP 60초 벽이 없는 오프라인 스크립트다 — 시간 예산을 사실상 해제해 부분 반환을 막는다.
    // threshold 500 + perChunkTimeoutMs 15분: 첫 실행에서 결산시즌 대형 청크 6개가
    // 기본 per-task 타임아웃(180초)에 걸려 partial 이 났다 — 더 잘게, 더 오래.
    const r = await collectAdaptive(client, base, from, to, {
      maxToolSeconds: 3600,
      measureBudget: 400,
      threshold: 500,
      perChunkTimeoutMs: 900_000,
    });
    const d = r.diagnostics;
    reported += d.total_count_reported;
    measureCalls += d.measure_calls;
    collectCalls += d.collect_calls;
    if (d.partial_results || d.truncated || d.chunks_failed > 0) {
      issues.push(
        `${label} ${from}~${to}: partial=${d.partial_results} truncated=${d.truncated} chunks_failed=${d.chunks_failed}`,
      );
    }
    let dupAcross = 0;
    for (const row of r.rows) {
      if (byId.has(row.rcept_no)) dupAcross++;
      else byId.set(row.rcept_no, row);
    }
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    perWindow.push({
      window: `${from}~${to}`,
      rows: r.rows.length,
      reported: d.total_count_reported,
      dup_across_windows: dupAcross,
      seconds: Number(sec),
    });
    console.error(
      `[${label}] ${from}~${to}: rows=${r.rows.length} reported=${d.total_count_reported} dup=${dupAcross} ${sec}s`,
    );
  }
  return { byId, reported, issues, perWindow, measureCalls, collectCalls };
}

const startedAt = new Date().toISOString();
console.error('=== [1/2] J 전수 수집 ===');
const J = await collectSet({ pblntfTy: 'J' }, 'J');
console.error('=== [2/2] 전체시장 수집 (rm 교차검증용) ===');
const ALL = await collectSet({}, 'ALL');

// rm "공" 마커 (복합 마커 '공정' 등이 있어 포함 검사 — dart.ts Disclosure 주석)
const hasGong = (row) => typeof row.rm === 'string' && row.rm.includes('공');

const gongIds = new Set();
for (const [id, row] of ALL.byId) if (hasGong(row)) gongIds.add(id);

const gongNotInJ = [...gongIds].filter((id) => !J.byId.has(id));
const jWithoutGong = [...J.byId.keys()].filter((id) => !hasGong(J.byId.get(id)));
const jNotInAll = [...J.byId.keys()].filter((id) => !ALL.byId.has(id));

const result = {
  measured_at: startedAt,
  period: '20250801~20260731',
  pipeline: 'collectAdaptive (프로덕션 배치 수집 경로 그대로)',
  j: {
    collected_unique: J.byId.size,
    reported_total: J.reported,
    recall_vs_reported: J.byId.size / J.reported,
    per_window: J.perWindow,
    calls: { measure: J.measureCalls, collect: J.collectCalls },
    issues: J.issues,
  },
  all_market: {
    collected_unique: ALL.byId.size,
    reported_total: ALL.reported,
    recall_vs_reported: ALL.byId.size / ALL.reported,
    per_window: ALL.perWindow,
    calls: { measure: ALL.measureCalls, collect: ALL.collectCalls },
    issues: ALL.issues,
  },
  equivalence: {
    gong_marked_in_all: gongIds.size,
    gong_not_in_J: gongNotInJ.length,
    gong_not_in_J_samples: gongNotInJ.slice(0, 10),
    j_without_gong: jWithoutGong.length,
    j_without_gong_samples: jWithoutGong.slice(0, 10),
    j_not_in_all: jNotInAll.length,
    j_not_in_all_samples: jNotInAll.slice(0, 10),
  },
};

console.log(JSON.stringify(result, null, 2));
console.error('=== 완료 ===');
console.error(
  `J: ${J.byId.size}/${J.reported} | ALL: ${ALL.byId.size}/${ALL.reported} | 공∉J: ${gongNotInJ.length} | J무공: ${jWithoutGong.length}`,
);
