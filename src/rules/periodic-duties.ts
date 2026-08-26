/**
 * 정기(주기) 공시 의무 정의 로더
 *
 * 항목 구분(연1회 / 분기별)과 각 항목의 기준일은 고시 원문이 조문 단위로 명시한 값이다.
 * 판정 로직이 아니라 법령 데이터이므로 코드가 아닌 JSON 으로 분리해 둔다
 * (penalty-ratios.ts / holidays.json 과 같은 패턴).
 *
 * ⚠️ 법령 데이터는 조용히 망가지면 안 된다. `as DutyFile` 로 믿고 넘기면 필드가 비거나
 * 형태가 바뀌어도 "정상 결과"처럼 나간다 — 근거 없는 기한을 자신 있게 말하는 셈이다.
 * 그래서 파일 전체를 zod 로 파싱해 어긋나면 즉시 던진다.
 *
 * 근거 전문과 검증 절차: `data/periodic-disclosures.json` 의 `_meta.verification`
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';

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

const legalRefSchema = z.object({
  source: z.string().min(1),
  summary: z.string().min(1),
});

const itemSchema = z.object({
  /** 조문 위치 (예: "§4①4호 하목") */
  code: z.string().min(1),
  /** 그 항목이 무엇인지 */
  name: z.string().min(1),
  /** ★ 기준일·기준기간 — 담당자가 가장 자주 틀리는 지점 */
  asOf: z.string().min(1),
});

const dutySchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    dartType: z.string().min(1),
    frequency: z.enum(['annual', 'quarterly', 'semiannual']),
    obligation: z.enum(['unconditional', 'conditional']),
    appliesTo: z.string().min(1).optional(),
    appliesWhen: z.string().min(1).optional(),
    /**
     * 다른 의무와 **한 서식으로 함께 제출**되는 경우 (DART 실측).
     * 법령상 별개 의무라 캘린더에는 두 줄로 나오는데, 그걸 "두 번 내야 한다"로
     * 읽으면 실무가 틀어진다 — 그래서 응답에 그대로 실어 보낸다.
     */
    filedTogetherWith: z
      .object({
        duty: z.string().min(1),
        quarter: z.number().int().min(1).max(4).optional(),
        note: z.string().min(1),
      })
      .optional(),
    items: z.array(itemSchema).min(1),
    legalBasis: z.array(legalRefSchema).min(1),
  })
  // 조건부 의무인데 조건이 없으면 "무조건 해야 하는 것"으로 오독된다
  .refine((d) => d.obligation !== 'conditional' || !!d.appliesWhen, {
    message: '조건부 의무에는 appliesWhen 이 반드시 있어야 합니다',
  });

/** 테스트에서 직접 검증할 수 있게 공개한다 — 법령 데이터가 조용히 망가지는 것이 최악이다 */
export const periodicDutyFileSchema = z.object({
  _meta: z.object({
    title: z.string().min(1),
    verified: z.literal(true),
    verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    scope: z.array(z.string().min(1)).min(1),
    verification: z.array(z.string().min(1)).min(1),
  }),
  duties: z.array(dutySchema).min(1),
});

export type PeriodicItem = z.infer<typeof itemSchema>;
export type PeriodicDuty = z.infer<typeof dutySchema>;
type DutyFile = z.infer<typeof periodicDutyFileSchema>;

let cached: DutyFile | null = null;

function load(): DutyFile {
  if (cached) return cached;
  const path = resolvePath();
  const parsed = periodicDutyFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf-8')));
  if (!parsed.success) {
    throw new Error(
      `정기공시 정의 파일이 스키마에 맞지 않습니다 (${path}): ` +
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' / '),
    );
  }
  const keys = new Set<string>();
  for (const d of parsed.data.duties) {
    if (keys.has(d.key)) throw new Error(`정기공시 key 가 중복입니다: ${d.key}`);
    keys.add(d.key);
  }
  // 통합 제출 상대가 실재하지 않으면 응답이 존재하지 않는 의무를 가리키게 된다
  for (const d of parsed.data.duties) {
    if (d.filedTogetherWith && !keys.has(d.filedTogetherWith.duty)) {
      throw new Error(
        `filedTogetherWith 가 없는 의무를 가리킵니다: ${d.key} → ${d.filedTogetherWith.duty}`,
      );
    }
  }
  cached = parsed.data;
  return parsed.data;
}

/**
 * 캐시된 정의는 프로세스 전역으로 공유된다 — 호출자가 배열·객체를 변이하면
 * 이후 모든 호출이 오염된다. 깊은 복사로 돌려준다 (정의 6개짜리라 비용은 무시할 수준).
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function loadPeriodicDuties(): PeriodicDuty[] {
  return clone(load().duties);
}

export function periodicDutiesMeta(): DutyFile['_meta'] {
  return clone(load()._meta);
}

/** 테스트 전용 — 파일을 바꿔 끼운 뒤 다시 읽게 한다 */
export function __resetPeriodicDutiesCache(): void {
  cached = null;
}
