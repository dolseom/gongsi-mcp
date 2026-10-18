#!/usr/bin/env node
// e2e 근거 대조 리포트 — 저장된 스트림 원본(eval/e2e/results/<run>/)을 다시 읽어 센다. API 호출 없음.
//
//   node scripts/eval-grounding.mjs [eval/e2e/results/<run-id>]   (생략하면 가장 최근 실행)
//
// 판정이 아니라 측정이다 — "근거 없음"은 이 실행의 도구 출력에서 못 찾았다는 뜻일 뿐이다
// (계산 결과·질문에 있던 숫자일 수 있다). 사람이 목록을 보고 판단한다. 규칙: eval/e2e/grounding.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGrounding, extractRun } from '../eval/e2e/grounding.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = join(ROOT, 'eval', 'e2e', 'results');

function latestRunDir() {
  const dirs = readdirSync(RESULTS)
    .map((n) => join(RESULTS, n))
    .filter((p) => statSync(p).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!dirs.length) throw new Error(`실행 기록 폴더가 없습니다: ${RESULTS}`);
  return dirs[0];
}

const runDir = process.argv[2] ? resolve(process.argv[2]) : latestRunDir();
const files = readdirSync(runDir).filter((f) => f.endsWith('.stream.jsonl')).sort();
if (!files.length) throw new Error(`스트림 원본(*.stream.jsonl)이 없습니다: ${runDir}`);

let claims = 0;
let grounded = 0;
const byKind = {};
console.log(`근거 대조: ${runDir} (${files.length}문항)\n`);
for (const f of files) {
  const { answer, toolText } = extractRun(readFileSync(join(runDir, f), 'utf8'));
  const r = checkGrounding(answer, toolText);
  claims += r.claims;
  grounded += r.grounded;
  for (const u of r.ungrounded) byKind[u.kind] = (byKind[u.kind] ?? 0) + 1;
  const id = f.replace(/\.stream\.jsonl$/, '');
  if (!toolText) console.log(`- ${id}: 도구 출력 없음 (주장 ${r.claims}건 대조 불가)`);
  else if (r.ungrounded.length) {
    console.log(`- ${id}: ${r.grounded}/${r.claims}`);
    for (const u of r.ungrounded.slice(0, 6)) console.log(`    [${u.kind}] ${u.text.slice(0, 80)}`);
  }
}
const pct = claims ? ((grounded / claims) * 100).toFixed(1) : '-';
console.log(`\n합계: 주장 ${claims}건 중 근거 확인 ${grounded}건 (${pct}%) · 근거 없음 유형 ${JSON.stringify(byKind)}`);
