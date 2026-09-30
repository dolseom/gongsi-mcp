/**
 * 검색 프리셋 — 공정위 공시가 1급 시민이다 (PRD §5.5)
 *
 * `ftc_all`(pblntf_ty=J)과 J001~J009 detail 코드의 동치성은 2주 × 2구간 전수 대조로
 * 실측 검증됐다 (docs/absorbed-from-dart-mcp.md §3). 일반 프리셋(사업보고서 등)은
 * 코드 검증 후 축 3에서 추가한다 — 미검증 코드를 추측으로 넣지 않는다.
 */

export interface PresetSpec {
  pblntfTy?: string;
  pblntfDetailTy?: string;
  label: string;
}

export const PRESETS = {
  /** 공정위 공시 전체 — J002·J003·J006·J007은 실제 제출 0건이라 J 하나로 전수다 */
  ftc_all: { pblntfTy: 'J', label: '공정위 공시 전체 (J코드)' },
  internal_transaction: { pblntfDetailTy: 'J001', label: '대규모내부거래 (J001)' },
  group_status: { pblntfDetailTy: 'J004', label: '기업집단현황 (J004)' },
  unlisted_material: { pblntfDetailTy: 'J005', label: '비상장사 중요사항 (J005)' },
  public_interest_corp: { pblntfDetailTy: 'J008', label: '공익법인 (J008)' },
  subcontract: { pblntfDetailTy: 'J009', label: '하도급대금 결제조건 (J009)' },
} as const satisfies Record<string, PresetSpec>;

export type PresetName = keyof typeof PRESETS;

export const PRESET_NAMES = Object.keys(PRESETS) as [PresetName, ...PresetName[]];
