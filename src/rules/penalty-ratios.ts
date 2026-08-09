/**
 * 거래금액별 적용비율표 (기준금액 산정)
 *
 * 근거: 대규모내부거래 등에 대한 이사회 의결 및 공시의무 위반사건에 관한 과태료 부과기준 Ⅵ.2
 *       (법제처 행정규칙 2100000245364, 2024-08-07 시행)
 *
 * ⚠️ 이 표는 법 §26·§29(대규모내부거래) 전용이다. §27·§28(중요사항·기업집단현황) 고시는
 *    Ⅲ.2 기준금액 정의와 Ⅵ.2 를 모두 "삭제"로 두어 임의적 조정을 기본금액에 직접 적용한다.
 *
 * 고시 본문에 이미지로만 실려 있던 표라 프로젝트 내내 미적용 상태였고, 그 결과
 * 100억원 미만 거래의 과태료가 최대 2배까지 과대 산정됐다. 판독 근거와 교차검증은
 * `data/penalty-ratios.json` 의 `_meta.verification` 에 남겨 두었다.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 개발 시 `src/rules/`, 빌드 후 `dist/src/rules/` 양쪽에서 동작하도록 상위 탐색 */
function resolveRatioPath(): string {
  let dir = HERE;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'data', 'penalty-ratios.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(HERE, '..', '..', 'data', 'penalty-ratios.json');
}

export interface RatioTier {
  /** 구간 하한 (원, 이상) */
  minAmount: number;
  /** 구간 상한 (원, 미만). null = 상한 없음 */
  maxAmount: number | null;
  /** 기본금액에 곱할 비율 (1.0 = 100%) */
  rate: number;
  label: string;
}

interface RatioFile {
  _meta: { source: string; effectiveFrom: string; verified: boolean };
  tiers: RatioTier[];
}

let cached: RatioFile | undefined;

/**
 * 법령 산정표는 타입 단언만으로 신뢰하지 않는다. 구간이 0원부터 상한 없음까지
 * 빈틈·겹침 없이 이어지고 비율이 (0, 1] 안에 있는지 로딩 시 검증한다 —
 * 표가 조용히 깨지면 과태료가 조용히 틀린다.
 */
function validate(tiers: RatioTier[]): void {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new Error('penalty-ratios.json 의 tiers 가 비어 있습니다 — 데이터 파일이 손상됐습니다.');
  }
  for (const t of tiers) {
    if (!Number.isFinite(t.minAmount) || t.minAmount < 0) {
      throw new Error(`penalty-ratios.json: minAmount 가 올바르지 않습니다 (${t.label})`);
    }
    if (t.maxAmount !== null && !(Number.isFinite(t.maxAmount) && t.maxAmount > t.minAmount)) {
      throw new Error(`penalty-ratios.json: maxAmount 가 minAmount 보다 커야 합니다 (${t.label})`);
    }
    if (!(t.rate > 0 && t.rate <= 1)) {
      throw new Error(`penalty-ratios.json: rate 는 0 초과 1 이하여야 합니다 (${t.label}: ${t.rate})`);
    }
  }
  // 내림차순(상한 없는 구간이 맨 앞)으로 적혀 있으므로 오름차순으로 훑어 연속성을 본다
  const asc = [...tiers].sort((a, b) => a.minAmount - b.minAmount);
  if (asc[0]!.minAmount !== 0) {
    throw new Error('penalty-ratios.json: 구간이 0원부터 시작하지 않습니다.');
  }
  if (asc[asc.length - 1]!.maxAmount !== null) {
    throw new Error('penalty-ratios.json: 최상단 구간에 상한이 없어야 합니다(maxAmount: null).');
  }
  for (let i = 0; i < asc.length - 1; i++) {
    if (asc[i]!.maxAmount !== asc[i + 1]!.minAmount) {
      throw new Error(
        `penalty-ratios.json: 구간이 이어지지 않습니다 — "${asc[i]!.label}" 상한과 "${asc[i + 1]!.label}" 하한이 다릅니다.`,
      );
    }
  }
}

function load(): RatioFile {
  if (cached) return cached;
  const raw = readFileSync(resolveRatioPath(), 'utf-8');
  const parsed = JSON.parse(raw) as RatioFile;
  validate(parsed.tiers);
  cached = parsed;
  return parsed;
}

export function ratioTableSource(): string {
  return load()._meta.source;
}

/**
 * 거래금액이 속한 구간을 돌려준다.
 *
 * 표는 100억원 이상을 100%로 두고 그 아래를 20억원 단위로 90/80/70/60/50% 로 낮춘다.
 *
 * ⚠️ 음수·NaN 을 0원으로 보정하지 않는다. 보정하면 잘못된 입력이 "20억원 미만 50%" 라는
 *    정상 산정값으로 둔갑한다. 호출부(estimatePenalty)가 미리 걸러 caveat 으로 알린다.
 */
export function findRatioTier(transactionAmount: number): RatioTier {
  if (!Number.isFinite(transactionAmount) || transactionAmount < 0) {
    throw new Error(`거래금액은 0 이상의 유한한 금액(원)이어야 합니다: ${transactionAmount}`);
  }
  const amount = transactionAmount;
  const { tiers } = load();
  for (const t of tiers) {
    if (amount >= t.minAmount && (t.maxAmount === null || amount < t.maxAmount)) return t;
  }
  // tiers 가 0원부터 상한 없음까지 연속이므로 여기 도달하면 데이터가 깨진 것이다
  throw new Error(`거래금액 ${transactionAmount}원에 해당하는 적용비율 구간을 찾지 못했습니다.`);
}
