#!/usr/bin/env node
// 저장된 스트림을 다시 채점한다 — 헤드리스를 다시 띄우지 않는다(비용·세션 한도 0).
// 채점 규칙·문항 키워드를 고친 뒤 같은 답변으로 재확인할 때 쓴다.
//   node eval/b2a/regrade.mjs <results/eval-YYYYMMDD-HHMMSS 폴더> [--suite eval/b2a]
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseStream } from '../messy/parse-stream.mjs';
import { grade, environmentProblem } from '../e2e/grade.mjs';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
if (!dir) throw new Error('스트림 폴더 경로가 필요합니다.');
const si = args.indexOf('--suite');
const suiteDir = si >= 0 ? args[si + 1] : 'eval/b2a';
const suite = JSON.parse(readFileSync(join(suiteDir, 'questions.json'), 'utf8'));

let pass = 0;
let total = 0;
for (const item of suite.items) {
  const file = join(resolve(dir), `${item.id}.stream.jsonl`);
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  total += 1;
  const rec = parseStream(text);
  const env = environmentProblem(rec);
  const { failures } = grade(item, rec.answer ?? '', rec);
  const ok = !env && failures.length === 0;
  if (ok) pass += 1;
  const tools = (rec.tool_calls ?? []).map((c) => c.name.replace('mcp__gongsi__', '')).filter((n) => n !== 'ToolSearch');
  console.log(`${ok ? '✓' : '✗'} ${item.id} [${[...new Set(tools)].join(',')}]${env ? ' ENV: ' + env : ''}${failures.length ? ' ' + failures.join(' / ') : ''}`);
}
console.log(`\n통과 ${pass}/${total}`);
