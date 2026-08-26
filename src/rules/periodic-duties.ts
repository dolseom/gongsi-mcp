/**
 * 정기(주기) 공시 의무 정의 로더
 *
 * 항목 구분(연1회 / 분기별)과 각 항목의 기준일은 고시 원문이 조문 단위로 명시한 값이다.
 * 판정 로직이 아니라 법령 데이터이므로 코드가 아닌 JSON 으로 분리해 둔다
 * (penalty-ratios.ts / holidays.json 과 같은 패턴).
 *
 * 근거 전문과 검증 절차: `data/periodic-disclosures.json` 의 `_meta.verification`
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { LegalRef } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 개발 시 `src/rules/`, 빌드 후 `dist/src/rules/` 양쪽에서 동작하도록 상위 탐색 */
function resolvePath(): string {
  let dir = HERE;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'data', 'periodic-disclosures.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(HERE, '..', '..', 'data', 'periodic-disclosures.json');
}

export interface PeriodicItem {
  /** 조문 위치 (예: "§4①4호 하목") */
  code: string;
  /** 그 항목이 무엇인지 */
  name: string;
  /** ★ 기준일·기준기간 — 담당자가 가장 자주 틀리는 지점 */
  asOf: string;
}

export interface PeriodicDuty {
  key: string;
  label: string;
  dartType: string;
  frequency: 'annual' | 'quarterly' | 'semiannual';
  obligation: 'unconditional' | 'conditional';
  appliesTo?: string;
  appliesWhen?: string;
  items: PeriodicItem[];
  legalBasis: LegalRef[];
}

interface DutyFile {
  _meta: { verified: boolean; verifiedAt: string; verification: string[] };
  duties: PeriodicDuty[];
}

let cached: DutyFile | null = null;

function load(): DutyFile {
  if (cached) return cached;
  const path = resolvePath();
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as DutyFile;

  // 법률 데이터는 조용히 망가지면 안 된다 — 구조를 검증하고 어긋나면 즉시 던진다
  // (penalty-ratios 로더가 구간 연속성을 검증하는 것과 같은 이유).
  if (!Array.isArray(parsed.duties) || parsed.duties.length === 0) {
    throw new Error('정기공시 정의가 비어 있습니다: ' + path);
  }
  const seen = new Set<string>();
  for (const d of parsed.duties) {
    if (!d.key || seen.has(d.key)) throw new Error(`정기공시 key 가 없거나 중복입니다: ${d.key}`);
    seen.add(d.key);
    if (!['annual', 'quarterly', 'semiannual'].includes(d.frequency)) {
      throw new Error(`정기공시 frequency 가 잘못됐습니다: ${d.key}=${d.frequency}`);
    }
    if (!['unconditional', 'conditional'].includes(d.obligation)) {
      throw new Error(`정기공시 obligation 이 잘못됐습니다: ${d.key}=${d.obligation}`);
    }
    // 근거 없는 기한은 이 프로젝트에서 성립하지 않는다
    if (!Array.isArray(d.legalBasis) || d.legalBasis.length === 0) {
      throw new Error(`정기공시 근거 조문이 없습니다: ${d.key}`);
    }
    if (!Array.isArray(d.items) || d.items.length === 0) {
      throw new Error(`정기공시 항목이 없습니다: ${d.key}`);
    }
    // conditional 인데 조건이 없으면 "무조건 의무"로 오독된다
    if (d.obligation === 'conditional' && !d.appliesWhen) {
      throw new Error(`조건부 의무인데 appliesWhen 이 없습니다: ${d.key}`);
    }
  }
  cached = parsed;
  return parsed;
}

export function loadPeriodicDuties(): PeriodicDuty[] {
  return load().duties;
}

export function periodicDutiesMeta(): DutyFile['_meta'] {
  return load()._meta;
}
