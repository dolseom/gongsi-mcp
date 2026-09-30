/**
 * action_items(조치 필요 판정을 바구니 가로질러 앞으로) · 닫힌 판정 배열 압축
 */

/**
 * 사람이 **지금 확인해야 하는** 판정 상태. 이 목록에 있으면 `action_items` 로 앞에 끌어낸다.
 *
 * ★ 왜 필요한가 (실물 5문서 실측, 2026-09-08): 결과는 상태별 바구니로 나뉘어 있고 그 이름은
 * **매출(매도)회사 관점**이다. 그런데 거래 한 건에는 의무자가 둘이라(매뉴얼 lit26-001),
 * 매출회사 기준으로 미달인 건이 **매입회사 자본 기준으로는 후보**일 수 있다. 실제로
 * `goods_services_matrix_below_threshold`(케이티 421건·카카오 337건) **안에**
 * `buyer_side` 조건부 후보 8건·확인 대상 21건이 들어 있었다 —
 * 실무자가 "기준 미달" 바구니를 열어볼 이유가 없으니 그대로 묻힌다.
 *
 * 바구니는 그대로 두고(근거·검증 가능성 유지) **가로질러 모아 앞에 놓는다.**
 */
const ACTION_STATUS_PRIORITY: Record<string, number> = {
  // 미공시 후보 — 이 도구가 낼 수 있는 가장 강한 신호
  undisclosed_candidate: 1,
  // 상대방 지분 요건만 확인하면 후보가 확정된다
  candidate_if_counterparty_qualified: 2,
  // 연간 총액만 기준 이상 — 후보가 아니라 확인 대상
  candidate_aggregate_only: 3,
};

/**
 * **닫힌 판정** 배열을 압축한다 — 모든 항목에서 값이 **완전히 같은** 필드만 배열 밖으로 올린다.
 *
 * ★ 왜 (실물 측정, 2026-09-08): 케이티 detect 응답 1,015KB 중 554KB(55%)가
 * `goods_services_matrix_below_threshold` 421건이었다. 1건 1,347바이트인데 고유 정보는
 * 60바이트뿐이고 나머지는 **전건 동일한 문구**다 (caveat 378B · reason 109B).
 * 같은 문장을 421번 읽히는 것은 답을 조립하는 시간만 늘린다 (m07 은 도구 대기 58초에
 * 모델 생성 302초였다).
 *
 * ⚠️ **정보를 버리지 않는다.** 값이 하나라도 다르면 올리지 않고 각 항목에 그대로 둔다.
 * 올린 값은 `shared` 로 같은 자리에 실어, 사람이 근거를 잃지 않게 한다.
 */
function hoistSharedFields<T extends Record<string, unknown>>(
  items: T[],
  fields: string[],
): { items: Array<Record<string, unknown>>; shared: Record<string, unknown> } {
  const shared: Record<string, unknown> = {};
  if (items.length < 2) return { items: items as Array<Record<string, unknown>>, shared };
  for (const f of fields) {
    const first = items[0]?.[f];
    if (first === undefined) continue;
    const enc = JSON.stringify(first);
    if (items.every((it) => JSON.stringify(it[f]) === enc)) shared[f] = first;
  }
  const keys = Object.keys(shared);
  if (keys.length === 0) return { items: items as Array<Record<string, unknown>>, shared };
  return {
    items: items.map((it) => {
      const copy: Record<string, unknown> = { ...it };
      for (const k of keys) delete copy[k];
      return copy;
    }),
    shared,
  };
}

/**
 * 닫힌 판정 배열 하나를 payload 조각으로 만든다 — 공통 문구는 `<이름>_shared` 로 한 번만 낸다.
 *
 * `status` 는 **올리지 않는다.** action_items 수집과 외부 소비자가 항목별로 읽는 값이라,
 * 배열 이름이 같은 뜻을 담고 있어도 각 항목에 남겨 두는 편이 안전하다.
 */
const CLOSED_SHARED_FIELDS = ['caveat', 'reason', 'source', 'quarterly_logic', 'counterparty_qualification'];

export function closedBucket(name: string, items: readonly object[]): Record<string, unknown> {
  if (items.length === 0) return {};
  const h = hoistSharedFields(items as Array<Record<string, unknown>>, CLOSED_SHARED_FIELDS);
  return {
    [name]: h.items,
    ...(Object.keys(h.shared).length
      ? {
          [`${name}_shared`]: {
            note:
              `아래 ${name} 의 **모든 항목에 공통인 값**입니다 — 같은 문장을 항목마다 반복하지 ` +
              '않으려고 한 번만 실었습니다. 각 항목을 읽을 때 이 값이 함께 붙어 있다고 보세요.',
            ...h.shared,
          },
        }
      : {}),
  };
}

/** `action_items` 한 줄 — 어느 바구니에서 왔는지(source)를 반드시 남겨 원문 근거로 되돌아갈 수 있게 한다 */
interface ActionItem {
  priority: number;
  status: string;
  /** '본인' = 배열의 주체 회사 관점, '거래상대방' = buyer_side/seller_side/lender_side 관점 */
  perspective: '본인' | '거래상대방';
  /** 공시의무를 지는 회사 */
  company: string;
  counterparty: string;
  amount_display?: string;
  threshold_display?: string;
  /** 이 항목이 실린 원래 배열 이름 — 근거·caveat 전문이 거기 있다 */
  source: string;
}

/** 신호 객체에서 금액 표시를 꺼낸다 (배열마다 필드 이름이 다르다) */
function signalAmountDisplay(s: Record<string, unknown>): string | undefined {
  for (const k of ['annual_amount_display', 'annual_amount_total_display', 'amount_display']) {
    const v = s[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/** 같은 우선순위로 숫자 금액을 꺼낸다 — 정렬용. 표시 문자열 길이로 정렬하면 150억이 99.5억 뒤로 간다 */
function signalAmountValue(s: Record<string, unknown>): number {
  for (const k of ['annual_amount', 'annual_amount_total', 'amount']) {
    const v = s[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return 0;
}

function thresholdDisplay(o: unknown): string | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const th = (o as { threshold?: { value_display?: unknown } }).threshold;
  return typeof th?.value_display === 'string' ? th.value_display : undefined;
}

/**
 * 결과 전체를 가로질러 **조치가 필요한 판정**만 모은다.
 *
 * 최종 payload 를 그대로 훑으므로 배열이 새로 생겨도 자동으로 포함된다 — 바구니 이름을
 * 하드코딩하면 새 유형이 생겼을 때 조용히 빠진다.
 */
export function collectActionItems(payload: Record<string, unknown>): ActionItem[] {
  const out: Array<{ item: ActionItem; value: number }> = [];
  const push = (
    status: unknown,
    perspective: ActionItem['perspective'],
    company: unknown,
    counterparty: unknown,
    amount: string | undefined,
    value: number,
    threshold: string | undefined,
    source: string,
  ): void => {
    if (typeof status !== 'string') return;
    const priority = ACTION_STATUS_PRIORITY[status];
    if (priority === undefined) return;
    out.push({
      item: {
        priority,
        status,
        perspective,
        company: typeof company === 'string' ? company : '(미상)',
        counterparty: typeof counterparty === 'string' ? counterparty : '(미상)',
        ...(amount ? { amount_display: amount } : {}),
        ...(threshold ? { threshold_display: threshold } : {}),
        source,
      },
      value,
    });
  };

  for (const [name, arr] of Object.entries(payload)) {
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object') continue;
      const s = raw as Record<string, unknown>;
      const amount = signalAmountDisplay(s);
      const value = signalAmountValue(s);
      push(s['status'], '본인', s['company'], s['counterparty'], amount, value, thresholdDisplay(s), name);
      // 거래상대방 관점 — 같은 거래를 **상대방 자기 자본**으로 다시 잰 판정이다
      for (const key of ['buyer_side', 'seller_side', 'lender_side']) {
        const side = s[key];
        if (!side || typeof side !== 'object') continue;
        const sv = side as Record<string, unknown>;
        push(sv['status'], '거래상대방', sv['company'], s['company'], amount, value, thresholdDisplay(sv), name);
      }
    }
  }

  // 우선순위 → 금액 큰 순 (숫자 금액 기준, 같으면 수집 순서 유지)
  return out
    .sort((a, b) => a.item.priority - b.item.priority || b.value - a.value)
    .map((e) => e.item);
}
