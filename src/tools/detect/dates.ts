/** YYYYMMDD 달력 계산 (UTC 기준 — 시간대와 무관) */

export function addDaysYmd(ymd: string, days: number): string {
  const t =
    Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) + days * 86_400_000;
  const d = new Date(t);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** a − b 를 달력일 수로 (a 가 뒤면 양수) */
export function daysBetween(a: string, b: string): number {
  const t = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.round((t(a) - t(b)) / 86_400_000);
}

/**
 * 접수일 최신순 비교 — 같은 날이면 접수번호 역순. **동률에도 0 이 아닌 결정적 순서**를 준다.
 * 종전 `(a < b ? 1 : -1)` 는 같은 날 접수분에 0 을 돌려주지 않아 여는 순서가 입력 순서에 따랐고,
 * 원문 예산에 걸리면 결과가 달라질 수 있었다 (2026-09-24 점검 지적).
 */
export function compareNewestFirst(
  a: { rcept_dt: string; rcept_no: string },
  b: { rcept_dt: string; rcept_no: string },
): number {
  if (a.rcept_dt !== b.rcept_dt) return a.rcept_dt < b.rcept_dt ? 1 : -1;
  if (a.rcept_no !== b.rcept_no) return a.rcept_no < b.rcept_no ? 1 : -1;
  return 0;
}
