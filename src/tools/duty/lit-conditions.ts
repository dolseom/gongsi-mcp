/**
 * 대규모내부거래(법 제26조)·공익법인(법 제29조) 판정의 **제외 사유**와 **거래유형별 특례 안내**.
 *
 * 금액 판정만으로는 "대상"이 나와도 원문상 제외되는 거래가 있고(국외 계열회사 직접 거래·장내시장 주식거래·
 * 부수적 거래), 반대로 금액과 무관하게 대상인 거래가 있다(공익법인의 소속 국내회사 주식 취득·처분).
 * 사용자가 그 사실을 입력하면 verdict 에 반영하고, 입력이 없으면 "이 경우면 달라진다" 조건만 안내한다.
 *
 * 원문:
 *  - 법 제26조제1항 "특수관계인(국외 계열회사는 제외한다 …)을 상대방으로 하거나 특수관계인을 위하여"
 *  - 공정위 문답 lit26-020 — 국외 계열회사와의 대규모내부거래는 의결·공시의무 없음. 다만 국외 계열회사를 통하여
 *    간접적으로 특수관계인 발행 주식을 매입하는 등 특수관계인을 위한 거래는 의무 있음
 *  - 고시 제4조제6항 — ①부수적 거래로서 새로운 거래관계가 성립하지 않는 행위 ②거래조건을 결정할 수 없는 행위는
 *    대규모내부거래로 보지 않음. 다만 공익법인의 소속 국내회사 주식 취득·처분은 제외(=그래도 대상)
 *  - 매뉴얼(2026-04) 6절 — "주식을 계열증권사를 통해 장내시장에서 거래하는 경우 (다만, 장 종료 후 시간외거래는 공시대상임)"
 *  - 고시 제4조제2항제1호 — 공익법인의 소속 국내회사 주식 취득·처분은 거래상대방·금액과 관계없이 대상
 *  - 매뉴얼 6절 — "거래당사자 한쪽에게 상품ㆍ용역거래인 경우에는 양 당사자 모두 상품ㆍ용역거래 거래금액으로 봄"
 *  - 고시 제9조의2 — 상품·용역 1년 이내 일괄 의결·20% 감소 45일·예측 못 한 거래·계약체결방식
 */

export interface LitConditionInput {
  counterpartyForeignAffiliate?: boolean | undefined;
  forSpecialRelatedParty?: boolean | undefined;
  stockTradeVenue?: 'exchange_regular' | 'exchange_after_hours' | 'off_exchange' | undefined;
  incidentalTransaction?: boolean | undefined;
  picGroupShareTrade?: boolean | undefined;
  subsidiaryIncorporation?: boolean | undefined;
  /** 상황 서술 — 자회사 설립 신호("설립"·"신설") 감지에만 쓴다 */
  situation?: string | undefined;
}

/** 상황 서술에 자회사 설립 출자 신호가 있는가 — lit26-003 조건 안내용 (단정에는 쓰지 않는다) */
export function hasIncorporationSignal(situation: string | undefined): boolean {
  return situation !== undefined && /설립|신설/.test(situation);
}

/** 자회사 설립 출자 (lit26-003) 범위 경계 — 설립 이후 추가 출자는 이 문답이 다루지 않는다 */
export const SUBSIDIARY_AFTER_INCORPORATION_NOTE =
  '※ 문답 lit26-003 은 자회사를 **설립하기 위한** 출자에 관한 것입니다. 설립 이후 그 자회사(이미 계열회사 = 특수관계인)에 ' +
  '추가로 출자하거나 유상증자에 참여하는 거래가 같은 결론인지는 이 문답의 범위 밖입니다(원문 미확인) — 그 경우는 일반 ' +
  '대규모내부거래 기준(특수관계인 상대 거래·기준금액)으로 확인하세요.';

export interface LitConditionResult {
  /** 입력된 사실로 제외가 확정됨 → not_required */
  excluded?: { reason: string };
  /** 제외 여부가 아직 입력되지 않은 사실에 달림 → required 를 확정하지 않는다 */
  conditional?: { reason: string; field: string; label: string };
  /** 공익법인의 소속 국내회사 주식 취득·처분 — 금액 무관 대상 */
  picShareForced?: boolean;
  notes: string[];
}

export function evaluateLitConditions(
  i: LitConditionInput,
  entity: 'company' | 'public_interest_corp',
): LitConditionResult {
  const notes: string[] = [];
  const isPic = entity === 'public_interest_corp';
  const picShare = isPic && i.picGroupShareTrade === true;

  if (picShare) {
    notes.push(
      '공익법인의 소속 국내회사 주식 취득·처분은 거래상대방·거래금액과 관계없이 사전 이사회 의결·공시 대상입니다 ' +
        '(법 제29조제1항제1호, 고시 제4조제2항제1호). 부수적 거래·장내시장 거래 제외(고시 제4조제6항)도 적용되지 않습니다 ' +
        '(같은 항 단서, 문답 lit26-010).',
    );
    return { picShareForced: true, notes };
  }

  // ① 국외 계열회사
  if (i.counterpartyForeignAffiliate === true) {
    if (i.forSpecialRelatedParty === true) {
      notes.push(
        '상대방이 국외 계열회사이지만 특수관계인을 **위한** 거래(예: 국외 계열회사를 통해 간접적으로 특수관계인 발행 주식 매입)로 ' +
          '입력하셨습니다 — 국외 계열회사 제외가 적용되지 않습니다 (공정위 문답 lit26-020 단서).',
      );
    } else if (i.forSpecialRelatedParty === false) {
      return {
        excluded: {
          reason:
            '국외 계열회사와의 직접 거래입니다 — 법 제26조제1항은 상대방 특수관계인에서 국외 계열회사를 제외합니다 ' +
            '(고시 제2조제3항제2호 같은 문언, 공정위 문답 lit26-020 "이사회 의결 및 공시의무 없음")',
        },
        notes,
      };
    } else {
      return {
        conditional: {
          reason:
            '상대방이 국외 계열회사라면 직접 거래는 공시대상이 아닙니다(법 제26조제1항 괄호, lit26-020). 다만 국외 계열회사를 ' +
            '통하여 간접적으로 특수관계인 발행 주식을 매입하는 등 특수관계인을 **위한** 거래라면 금액 기준대로 대상입니다',
          field: 'forSpecialRelatedParty',
          label:
            '국외 계열회사를 통해 간접적으로 특수관계인(동일인·계열사 등) 발행 주식을 매입하는 등 특수관계인을 위한 거래인지 — ' +
            '아니면(직접 거래) 공시대상이 아닙니다 (lit26-020)',
        },
        notes,
      };
    }
  }

  // 공익법인은 소속 국내회사 주식 취득·처분이면 제4조제6항 제외가 적용되지 않는다(단서) — 그 여부를 모르면
  // 제외를 확정하지 않는다 (확정하면 "대상 아님" 거짓 안심).
  const picUnknown = isPic && i.picGroupShareTrade === undefined;
  const picConditional = (reason: string): LitConditionResult => ({
    conditional: {
      reason:
        `${reason}. 다만 공익법인의 소속 국내회사 주식 취득·처분이면 이 제외가 적용되지 않고 금액과 무관하게 대상입니다 ` +
        '(고시 제4조제6항 단서·제4조제2항제1호)',
      field: 'picGroupShareTrade',
      label: '공익법인이 해당 기업집단 소속 국내회사 주식을 취득·처분하는 거래인지 — 그렇다면 금액·제외 사유와 무관하게 대상',
    },
    notes,
  });

  // ② 장내시장 주식거래
  if (i.stockTradeVenue === 'exchange_regular') {
    const reason =
      '계열증권사 등을 통한 장내시장(정규 매매) 주식 거래는 거래당사자가 거래조건을 결정할 수 없는 행위라 ' +
      '대규모내부거래로 보지 않습니다 (고시 제4조제6항제2호, 매뉴얼 6절 "주식을 계열증권사를 통해 장내시장에서 거래하는 경우", 문답 lit26-010)';
    if (picUnknown) return picConditional(reason);
    return { excluded: { reason }, notes };
  } else if (i.stockTradeVenue === 'exchange_after_hours') {
    notes.push(
      '장 종료 후 시간외거래는 장내시장 제외를 적용하지 않습니다 (매뉴얼 6절 "다만, 장 종료 후 시간외거래는 공시대상임") — ' +
        '제외가 안 될 뿐이고 대상 여부는 상대방·금액 등 나머지 요건으로 판정합니다.',
    );
  }

  // ③ 부수적 거래
  if (i.incidentalTransaction === true) {
    const reason =
      '이미 공시대상인 거래의 권리 행사·의무 이행에 따라 발생하는 부수적 거래로서 새로운 거래관계가 성립하지 않는 행위 ' +
      '(예: 채권·CP 매입 또는 차입 후 만기 상환, 상품·용역·금융거래에 수반한 할부금융·카드결제)는 대규모내부거래로 보지 ' +
      '않습니다 (고시 제4조제6항제1호, 매뉴얼 6절)';
    if (picUnknown) return picConditional(reason);
    return { excluded: { reason }, notes };
  }

  // ④ 자회사 설립 출자 — lit26-003 "자회사를 설립하기 위하여 출자하는 경우에는 특수관계인을 상대방으로 하거나
  //    특수관계인을 위한 거래가 아니므로 출자금액이 100억 원 이상(…)이더라도 이사회 의결 및 공시의무가 없음"
  if (i.subsidiaryIncorporation === true) {
    notes.push(SUBSIDIARY_AFTER_INCORPORATION_NOTE);
    return {
      excluded: {
        reason:
          '자회사를 설립하기 위한 출자는 특수관계인을 상대방으로 하거나 특수관계인을 위한 거래가 아니므로 금액과 무관하게 ' +
          '이사회 의결·공시의무가 없습니다 (공정위 문답 lit26-003)',
      },
      notes,
    };
  }
  if (i.subsidiaryIncorporation === undefined && hasIncorporationSignal(i.situation)) {
    notes.push(SUBSIDIARY_AFTER_INCORPORATION_NOTE);
    return {
      conditional: {
        reason:
          '상황 서술에 "설립·신설"이 있습니다 — 자회사를 **설립하기 위한** 출자라면 특수관계인을 상대방으로 하거나 특수관계인을 ' +
          '위한 거래가 아니어서 금액과 무관하게 이사회 의결·공시의무가 없습니다(공정위 문답 lit26-003). 이미 있는 계열회사에 ' +
          '출자하는 것이면 금액 기준대로입니다',
        field: 'subsidiaryIncorporation',
        label:
          '자회사를 설립하기 위한 출자인지 — true 면 대상 아님 (lit26-003). 이미 설립된 계열회사에 대한 출자면 false',
      },
      notes,
    };
  }

  return { notes };
}

/** 분할 거래 합산 — 매뉴얼(2026-04) "공시대상 1건 거래행위 판단기준" */
export const SPLIT_AGGREGATION_NOTE =
  '※ 1건 판단: 동일 거래상대방과의 동일 거래대상에 대한 거래행위를 기준으로 판단하며, "동일 거래상대방과의 동일 거래대상에 ' +
  '대한 1건의 거래행위를 분할하여 거래하는 경우에는 이를 합산하여 1건의 거래행위로 봄" (공정위 대규모내부거래 매뉴얼 2026-04, ' +
  '고시 제4조제3항). 상품·용역거래는 동일 거래상대방과의 분기 합계액입니다. 나눠서 한 거래라면 합계액으로 다시 판정하세요.';

/** 주식 1일 합산 — lit26-043 */
export const STOCK_DAILY_SUM_REASON =
  '주식 거래는 "1회 거래라는 개념이 모호하므로 1일 매입 또는 매도 금액의 총합계를 1회 거래로 봄"(공정위 문답 lit26-043) — ' +
  '같은 거래상대방·같은 주식의 같은 날 매입(또는 매도) 합계가 기준금액 이상이면 건별 금액과 관계없이 대상입니다';

/** 고시 제10조 — 자본시장법 공시와 중복 (비상장사 제5조의2제6항 노트와 대칭) */
export const LIT_CAPITAL_MARKET_OVERLAP_NOTE =
  '이 공시사항이 자본시장법상 신고·공시사항과 중복되면 자본시장법에 따라 신고·공시해도 이 고시에 따른 공시의무를 이행한 ' +
  '것으로 봅니다. 다만 공정거래법상의 공시의무사항에도 해당되는 사항임을 표시해야 합니다 (대규모내부거래 고시 제10조). ' +
  '⚠️ 이것은 **공시**를 갈음할 뿐입니다 — 미리 이사회 의결을 거쳐야 하는 의무(법 제26조제1항)는 따로 지켜야 합니다.';

/** 금액 기준으로 "대상"일 때, 아직 입력되지 않은 제외 사유를 **조건**으로 알린다 (verdict 는 바꾸지 않는다) */
export function exclusionConditionsNote(
  i: LitConditionInput,
  entity: 'company' | 'public_interest_corp',
): string {
  const items: string[] = [];
  if (i.counterpartyForeignAffiliate === undefined) {
    items.push(
      '상대방이 국외 계열회사와의 직접 거래(counterpartyForeignAffiliate) — 대상 아님. 단 국외 계열회사를 통한 특수관계인 발행 ' +
        '주식 간접 매입 등 특수관계인을 위한 거래는 대상 (법 제26조제1항, lit26-020)',
    );
  }
  if (entity === 'company' && i.stockTradeVenue === undefined) {
    items.push(
      '계열증권사 등을 통한 장내시장 정규 매매 주식거래(stockTradeVenue:"exchange_regular") — 대상 아님. 장 종료 후 시간외거래는 ' +
        '이 제외가 없음 (고시 제4조제6항제2호, 매뉴얼 6절)',
    );
  }
  if (i.incidentalTransaction === undefined) {
    items.push(
      '기존 공시대상 거래의 권리 행사·의무 이행에 따른 부수적 거래(만기 상환 등, incidentalTransaction) — 대상 아님 (고시 제4조제6항제1호)',
    );
  }
  if (i.subsidiaryIncorporation === undefined) {
    items.push(
      '자회사를 설립하기 위한 출자(subsidiaryIncorporation)처럼 특수관계인을 상대방으로 하거나 특수관계인을 위한 거래가 아닌 경우 — ' +
        '대상 아님 (문답 lit26-003)',
    );
  }
  if (entity === 'public_interest_corp') {
    items.unshift(
      '공익법인의 소속 국내회사 주식 취득·처분(picGroupShareTrade) — 금액과 무관하게 대상이며 위 제외들도 적용 안 됨 ' +
        '(고시 제4조제2항제1호·제6항 단서)',
    );
  }
  return `판정이 달라지는 경우(입력하지 않은 사실): ${items.map((t, k) => `${k + 1}) ${t}`).join(' / ')}`;
}

/** 상품·용역 거래(분기 합계액) 판정에 붙이는 제9조의2 특례 안내 */
export const GOODS_SERVICES_SPECIAL_NOTE =
  '상품·용역 거래 특례 (고시 제9조의2, 매뉴얼 11-2절): ' +
  '① 거래금액은 **1년 이내의 거래기간을 정해 일괄하여** 이사회 의결·공시할 수 있습니다(제1항) — 1년짜리 계약이면 분기마다 ' +
  '따로 의결하지 않아도 됩니다. 일괄 특례는 거래금액에 관한 것이고, 계약체결방식(경쟁입찰·수의계약 등)은 원칙적으로 계약 ' +
  '건별로 의결·공시합니다(제4항 — 의결 시점에 계약내용이 미확정이면 계약체결방식 유형별 일괄 가능). ' +
  '② 실제 거래금액이 의결금액보다 20% 이상 **감소**하면 의결 없이 분기 종료 후 45일 이내에 실제 거래금액을 공시합니다' +
  '(제2항 — duty:"goods_services_reduced"). 20% 이상 **증가**가 예상되면 분기 중에 미리 이사회 의결을 거친 후 공시합니다(매뉴얼 11-2절). ' +
  '③ 분기 전에 예측하지 못한 사유로 분기 중 대규모내부거래가 될 것이 예상되면 미리 의결·공시합니다(제3항).';

/** 부동산 임대차(연간 환산) 판정에 붙이는 거래분류 전환 조건 */
export const LEASE_GOODS_SERVICES_NOTE =
  '⚠️ 거래분류 조건: 이 임대차가 거래당사자 **한쪽에게라도** 상품·용역거래(예: 임대업을 영위하는 쪽의 매출)라면 ' +
  '**양 당사자 모두** 상품·용역거래 거래금액(분기 합계액, amountBasis:"quarterly_sum")으로 봅니다 (매뉴얼 6절 ' +
  '"거래당사자 한쪽에게 상품ㆍ용역거래인 경우에는 양 당사자 모두 상품ㆍ용역거래 거래금액으로 봄"). 그 경우 관리비도 ' +
  '매출로 인식되면 거래금액에 포함하고(문답 lit26-046), 상대방이 동일인·친족 20% 이상 출자 계열회사(또는 그 자회사)여야 ' +
  '하는 요건이 붙습니다(법 제26조제1항제4호) — 대상/비대상 어느 쪽이든 결론이 달라질 수 있습니다.';
