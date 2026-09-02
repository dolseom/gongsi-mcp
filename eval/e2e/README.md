# LLM 종단 평가셋 (e2e)

## 목적
단위 테스트(`test/`)는 룰 엔진과 도구 핸들러의 입출력만 본다. 실사용에서 틀리는 구간은 그 바깥이다 —
**모델이 어떤 도구를 고르는가 · 파라미터를 어떻게 구성하는가 · 도구가 준 caveat 를 사용자에게 전달하는가.**
이 평가셋은 그 종단 구간의 회귀를 잡는다. 특히 이 제품에서 가장 위험한 실패는
"확인하지 못했는데 안심시키는 답"이므로, 정답 수치(`expect`)와 별개로
caveat 전달성(`signals`)·금지 문구(`forbid`)를 함께 채점한다.

## 실행법
```bash
npm run build                      # dist/src/cli.js 필요 (mcp-config.json 이 상대경로로 참조)
node scripts/eval-e2e.mjs                        # 전체 26문항
node scripts/eval-e2e.mjs --only deadline-chuseok,myth-1day
node scripts/eval-e2e.mjs --concurrency 3        # 기본 2
```
결과는 `eval/e2e/results/eval-<YYYYMMDD-HHmmss>.json` 에 문항별 전문·실패 사유와 함께 저장된다
(이 디렉터리는 gitignore). 하나라도 실패하면 종료 코드 1.

## 채점 규칙
- `expect` — AND-of-OR. 각 그룹에서 최소 1개가 답변에 있어야 한다(콤마·공백 제거 정규화 매칭 포함).
- `signals` — 같은 구조. 누락 시 실패이되 요약에서 "신호누락"으로 따로 센다.
- `forbid` — 하나라도 나타나면 실패.
- `num_turns < 2` — `tool_not_used`. 도구를 안 쓰고 모델 자체 지식으로 답한 것이라 실패로 본다.

## 문항 구성 (26문항)
| 카테고리 | 수 | 보는 것 |
|---|---|---|
| `deadline` | 5 | 영업일·공휴일·대체공휴일 기한 계산 |
| `penalty` | 3 | 과태료 산정과 상한선 caveat |
| `threshold` | 2 | 기준금액 판정 |
| `trap` | 3 | 흔한 오정보(50억·1일·분기말) 교정 |
| `qna` | 2 | 공정위 매뉴얼 문답 |
| `correction` | 1 | 정정 리스크 |
| `dart` | 2 | DART 검색·원문 읽기 |
| `honesty` | 4 | 확인 못 한 것을 안심시키지 않는가 |
| `calendar` | 1 | `disclosure_calendar` — 정기공시 마감일 |
| `periodic` | 2 | `audit_periodic_disclosures` — J004 제출·기한 점검 |
| `detect` | 1 | `detect_undisclosed_transactions` — J004 거래내역 ↔ J001 대조 |

0.2.0 신규 3도구 문항 6개는 2026-09-02 에 추가했다 (`calendar-2026-annual`,
`calendar-not-in-calendar`, `periodic-single-company`, `detect-mirae-borrowing`,
`detect-honesty`, `periodic-not-filed`). 골든값은 전부 그 도구를 직접 호출해 얻은 응답에서 뽑았다.

## 골든값 갱신 원칙
`expect` 의 수치는 전부 **룰 엔진 실호출로 검증한 뒤 동결한** 값이다 (2026-08-15).
답이 안 맞는다고 골든값을 고치지 말 것 — 먼저 룰 엔진을 실제로 호출해 재검증하고,
법령·공휴일 데이터 변경으로 정답 자체가 바뀐 경우에만 재측정값으로 갱신한 뒤 `version` 을 올린다.

## 비용·변동성 주의
- 문항당 claude 헤드리스 1회 호출이다. 전체 실행은 실제 API 비용이 든다(요약에 총액 출력).
- 16·17번은 DART 실호출을 탄다. 원문·목록이 캐시돼 있으면 저렴하지만, 첫 실행은 느릴 수 있다.
- **16번(`dart-search-sono`)은 "최근 한 달"이라 실행 시점에 따라 결과가 달라진다.** 실패 시
  골든값을 고치기 전에 해당 기간 실제 공시 목록을 먼저 확인할 것. 나머지 날짜 의존 문항은
  질문 안에 기준일을 명시해 시점 독립으로 만들어 두었다.
- **`detect-*`·`periodic-*` 문항은 실물 접수번호·회사를 고정해 두었다** (미래에셋 J004
  `20260819000341` / 미래에셋캐피탈 `00251738`, 점검 연도 2025) — 따라서 DART 실호출을 탄다.
  이 두 도구는 J001 검색창의 상한이 "오늘"이라, 그 회사·유형의 J001 공시가 **새로 접수되면**
  판정이 바뀔 수 있다(조건부 후보 → `j001_filing_near_date` 등). 실패하면 골든값을 고치기 전에
  해당 도구를 직접 호출해 현재 판정을 먼저 확인할 것. `disclosure_calendar` 문항은 로컬 법령·
  공휴일 데이터만 쓰므로 네트워크와 무관하다.
