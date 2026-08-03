/**
 * 영업일 계산
 *
 * 고시상 "영업일" = 공휴일, 토요일, 「근로자의 날 제정에 관한 법률」에 따른 근로자의 날을 제외한 날
 * (대규모내부거래 고시 §2⑧ / 중요사항공시 고시 §2⑦)
 *
 * ⚠️ 일요일은 공휴일(관공서의 공휴일에 관한 규정)이므로 별도 제외 대상이다.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { YMD } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * `data/holidays.json` 을 찾는다.
 * 개발 시엔 `src/rules/` 에서, 빌드 후엔 `dist/src/rules/` 에서 실행되므로
 * 상위로 올라가며 탐색한다 (빌드에 data 복사 단계를 두지 않아도 되게).
 */
function resolveHolidayPath(): string {
  let dir = HERE;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'data', 'holidays.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 못 찾으면 개발 기준 경로를 돌려주고, 읽기 시점에 명확히 실패하게 둔다
  return join(HERE, '..', '..', 'data', 'holidays.json');
}

const HOLIDAY_PATH = resolveHolidayPath();

interface HolidayEntry {
  date: string;
  name: string;
  lunar?: boolean;
  substitute?: boolean;
  laborDay?: boolean;
}

interface HolidayYear {
  verified: boolean;
  holidays: HolidayEntry[];
}

let cache: Record<string, HolidayYear> | null = null;

function loadAll(): Record<string, HolidayYear> {
  if (cache) return cache;
  const raw = JSON.parse(readFileSync(HOLIDAY_PATH, 'utf-8')) as Record<string, unknown>;
  const out: Record<string, HolidayYear> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    out[k] = v as HolidayYear;
  }
  cache = out;
  return out;
}

/** 테스트용 — 공휴일 데이터를 직접 주입 */
export function __setHolidayData(data: Record<string, HolidayYear>): void {
  cache = data;
}

/** 테스트용 — 주입을 해제하고 파일 데이터로 되돌린다 */
export function __resetHolidayData(): void {
  cache = null;
}

export function toDate(ymd: YMD): Date {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  // UTC 기준으로 다뤄 타임존 영향을 제거한다
  return new Date(Date.UTC(y, m - 1, d));
}

export function toYMD(date: Date): YMD {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * 실존하는 달력 날짜인지 round-trip 으로 검증한다.
 * `Date.UTC` 는 20260231 같은 값을 조용히 3월로 롤오버시키므로,
 * 정규식만 통과한 입력이 기한 계산에 들어가면 판정이 하루 이상 어긋난다.
 */
export function isValidYMD(ymd: string): boolean {
  if (!/^\d{8}$/.test(ymd)) return false;
  return toYMD(toDate(ymd)) === ymd;
}

/** 0=일요일 … 6=토요일 */
export function dayOfWeek(ymd: YMD): number {
  return toDate(ymd).getUTCDay();
}

export function isWeekend(ymd: YMD): boolean {
  const dow = dayOfWeek(ymd);
  return dow === 0 || dow === 6;
}

export function isHoliday(ymd: YMD): boolean {
  const year = ymd.slice(0, 4);
  const entry = loadAll()[year];
  if (!entry) return false;
  return entry.holidays.some((h) => h.date === ymd);
}

/** 해당 연도 공휴일 데이터가 검증되었는지 */
export function isHolidayDataVerified(year: string): boolean {
  return loadAll()[year]?.verified ?? false;
}

/** 데이터가 아예 없는 연도인지 */
export function hasHolidayData(year: string): boolean {
  return loadAll()[year] !== undefined;
}

export function isBusinessDay(ymd: YMD): boolean {
  return !isWeekend(ymd) && !isHoliday(ymd);
}

/** 해당일이 영업일이 아니면 다음 영업일을 반환. 영업일이면 그대로 반환 */
export function nextBusinessDay(ymd: YMD): YMD {
  let cur = ymd;
  let guard = 0;
  while (!isBusinessDay(cur)) {
    cur = toYMD(new Date(toDate(cur).getTime() + 86_400_000));
    if (++guard > 60) throw new Error(`영업일을 찾지 못했습니다: ${ymd} 기준 60일 초과`);
  }
  return cur;
}

/**
 * 기준일로부터 n영업일 후를 계산한다.
 *
 * 기산점: 기준일 **다음 날**부터 세며, 기준일 당일은 포함하지 않는다.
 * ("이사회 의결 후 3영업일 이내" 의 통상 해석)
 *
 * @param from 기준일 (예: 이사회 의결일)
 * @param n 영업일 수
 */
export function addBusinessDays(from: YMD, n: number): YMD {
  if (n < 0) throw new Error('영업일 수는 0 이상이어야 합니다');
  let cur = from;
  let counted = 0;
  let guard = 0;
  while (counted < n) {
    cur = toYMD(new Date(toDate(cur).getTime() + 86_400_000));
    if (isBusinessDay(cur)) counted++;
    if (++guard > 400) throw new Error(`영업일 계산이 종료되지 않았습니다: ${from} + ${n}`);
  }
  return cur;
}

/**
 * 두 날짜 사이의 영업일 수. from 다음 날부터 to 까지 센다.
 * to 가 from 보다 이르면 음수를 반환한다.
 */
export function countBusinessDays(from: YMD, to: YMD): number {
  if (from === to) return 0;
  const reverse = toDate(to) < toDate(from);
  const [a, b] = reverse ? [to, from] : [from, to];
  let cur = a;
  let count = 0;
  let guard = 0;
  while (cur !== b) {
    cur = toYMD(new Date(toDate(cur).getTime() + 86_400_000));
    if (isBusinessDay(cur)) count++;
    if (++guard > 4000) throw new Error(`영업일 계산 범위를 초과했습니다: ${from} ~ ${to}`);
  }
  return reverse ? -count : count;
}

/** 달력일 기준 경과일수 (과태료 지연일수 산정용) */
export function countCalendarDays(from: YMD, to: YMD): number {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86_400_000);
}
