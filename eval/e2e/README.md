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
node scripts/eval-e2e.mjs                        # 전체 31문항
node scripts/eval-e2e.mjs --only deadline-chuseok,myth-1day
node scripts/eval-e2e.mjs --concurrency 3        # 기본 2
# 2026-09-13 추가 5문항
node scripts/eval-e2e.mjs --only anonymous-duty-no-date,deadline-without-capital,missing-amount-unit,out-of-scope,detect-detail-delivery --concurrency 1
```
결과는 `eval/e2e/results/eval-<YYYYMMDD-HHmmss>.json`(문항별 답변·도구 흔적·실패 사유)과
`eval/e2e/results/eval-<YYYYMMDD-HHmmss>/<id>.stream.jsonl`(claude stream-json 원본)에 저장된다
(이 디렉터리는 gitignore). 하나라도 `pass` 가 아니면 종료 코드 1.

## 채점 규칙 (`eval/e2e/grade.mjs` — `test/eval-e2e-grade.test.mjs` 로 고정)
러너는 `--output-format stream-json --verbose` 로 실행해 **실제 도구 호출 기록**을 받는다
(파서는 messy 게이트와 같은 `eval/messy/parse-stream.mjs`). 턴 수로 도구 사용을 추정하지 않는다.

- `expect` — AND-of-OR. 각 그룹에서 최소 1개가 답변에 있어야 한다(콤마·공백·마크다운 강조 기호 제거 정규화
  매칭 포함 — 1차 실행에서 "**5일 이내**에 보고" 가 금지 문구 "5일 이내에 보고" 를 빠져나갔다).
- `signals` — 같은 구조. 누락 시 실패이되 요약에서 "신호누락"으로 따로 센다.
- `forbid` — 하나라도 나타나면 실패.
- `expect_tools` — 항목마다 문자열(그 도구 필수) 또는 문자열 배열(그중 하나 — OR). **호출 기록**에
  `mcp__gongsi__<이름>` 이 있어야 한다. 다른 서버 접두사(`mcp__gongsi-mcp__` 등)는 세지 않는다.
- `tool_not_used` — `require_tool` 이 false 가 아닌데 우리 서버 도구 호출이 0건. `ToolSearch`(스키마 로드)는
  도구 사용으로 세지 않는다.
- `non_mcp_tool_called` — 우리 서버도 `ToolSearch` 도 아닌 도구가 실제로 실행됐다(격리 누출).
- `tool_error` — 도구 결과가 `is_error:true`.
- `tool_returned_error_body` — `is_error` 없이 본문이 `{"error": …}` 인 응답(check_disclosure_duty 의 입력 오류가
  이 형태다). 오류를 판정 결과처럼 옮기는 답을 통과시키지 않는다.
- `tool_result_rejected_by_host` — 호스트가 결과를 크기 때문에 버렸다(`Error: result (… characters …) exceeds
  maximum allowed tokens`). ⚠️ 이 경우 `is_error` 가 붙지 않는다(2026-09-08 m07 실측).
- `blocked_tool_attempted` — 권한 단계에서 거부된 시도(`permission_denials`).

## 상태 — `pass` 만 통과다
| 상태 | 뜻 | 제품 실패인가 |
|---|---|---|
| `pass` | 위 규칙을 전부 통과 | — |
| `fail` | 위 규칙 중 하나라도 걸림 | 예 |
| `timeout` | 문항 타임아웃(기본 240초, 문항 `timeout_ms` 우선). 우리가 띄운 PID 트리만 종료하고 `kill_confirmed` 기록 | 조사 필요 |
| `env_error` | 평가 서버 `gongsi` 미연결 또는 init 도구 목록에 차단 목록 밖 도구가 있음(격리 실패) | 아니오 — 평가 무효 |
| `host_error` | claude 결과가 `is_error`(세션 한도·API 오류 등) | 아니오 — 호스트 가용성 |
| `runner_error` | 실행 실패·result 이벤트 없음 | 아니오 — 러너 |

## 맥락 격리 — 도구 밖에서 섞이는 것
- ⚠️ 2026-09-13 1차 실행은 저장소를 cwd 로 띄워 **프로젝트 CLAUDE.local.md(법령 수치·개발 기록)와 사용자
  플러그인 7개·SessionStart 훅**이 세션에 섞였다. 답변 두 건이 "프로젝트 기록에 따르면…" 이라고 적었다 —
  도구 근거와 개발자 메모를 가를 수 없어 그 실행은 게이트 결과로 세지 않는다
  (실행 기록은 로컬 증거로만 보관하고 저장소에는 넣지 않았다).
- 그래서 러너는 문항마다 **빈 임시 디렉터리**(`gongsi-eval-*`)를 cwd 로 쓰고, MCP 설정을 절대경로로 생성하며,
  `--setting-sources project,local` 로 사용자 설정(플러그인·훅·auto 권한 모드)을 읽지 않는다. 인증(OAuth)은
  설정 파일이 아니라 그대로 된다. 실행 뒤 임시 디렉터리를 지우고 `work_dir_removed` 로 남긴다.
- 결과의 `context`(cwd·권한 모드·모델·플러그인·훅 수·메모리 경로)에 플러그인이 있거나 훅 이벤트가 있으면
  그 실행은 `env_error` 다. 임시 디렉터리 조상에 CLAUDE.md 가 있으면 러너가 시작 전에 멈춘다.
- ⚠️ **이것은 "깨끗한 사용자 환경" 이 아니다 — 프로젝트·플러그인·훅 격리 + 전역 지시 잔존이다.**
  2026-09-13 탐침(로컬 증거, 저장소 미포함)으로 확인한 사실:
  - 빠지는 것: 프로젝트 CLAUDE.md·CLAUDE.local.md·프로젝트 메모리, 사용자 플러그인과 그 훅·스킬, 사용자
    전역 스킬 디렉터리(debug 로그 `0 skill dir commands, 0 plugin skills`), auto 권한 모드.
  - **남는 것: 사용자 전역 `~/.claude/CLAUDE.md` 는 여전히 모델에 닿는다.** 그 파일에만 있는 비기본 규칙을
    물으면 정확히 재현했고(음성 대조는 NONE), 경로 자기보고도 전역 파일 하나를 댔다. 번들 스킬 목록도 남지만
    `Skill` 도구가 차단돼 호출할 수 없다.
  - 전역 지시까지 끄는 방법은 이 환경에서 쓰지 않는다: `--bare` 는 `ANTHROPIC_API_KEY`/apiKeyHelper 인증만 받고
    (OAuth 미사용), HOME 을 바꾸면 인증 정보도 사라진다. 자격증명을 복사하거나 전역 설정을 고치지 않는다.
  - 그래서 격리 실행의 5/5 결과는 **법령 수치·도구 호출 기록**은 도구 근거로 볼 수 있지만, 말투·"추측하지
    않음" 같은 태도는 전역 지시의 영향을 받았을 수 있다. 제품 효과로만 귀속하지 말 것.
- messy 러너(`eval/messy/run-messy.mjs`)는 **아직 저장소 cwd 로 실행한다** — 과거 결과와의 비교를 위해
  이번에 바꾸지 않았다. 그 결과를 읽을 때 같은 오염 가능성을 감안할 것.

## 도구 격리
- 차단 목록은 **`eval/disallowed-tools.mjs` 하나**를 messy 러너와 공유한다. auto 모드에서는 `--allowedTools` 가
  허용 목록으로 동작하지 않아(2026-09-07 실측) 이 목록이 유일한 격리 수단이다.
- ★ `ToolSearch` 는 남긴다 — MCP 도구가 지연 로드라 막으면 우리 도구를 부를 수 없다. `ToolSearch` 로 우리 밖
  도구를 불러오려 한 시도는 `toolsearch_probes` 에 정보로 남긴다(차단돼 있으면 실패가 아니다).
- init 이벤트의 도구 목록에 차단 목록 밖 도구가 보이면 그 실행은 `env_error` 다 — 호스트가 새 내장 도구를
  추가했다는 뜻이니 목록에 추가할 것.
- Windows 에서 러너는 `shell:true` 로 claude 를 띄운다. 타임아웃 시 `child.kill()` 은 cmd.exe 만 죽이므로
  **그 PID 를 루트로 한 트리만** `taskkill /PID <pid> /T /F` 로 끊는다. 프로세스 이름으로 종료하지 않는다.

## 문항 구성 (31문항)
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
| `detect` | 2 | `detect_undisclosed_transactions` 판정 · 요약 뒤 `read_detection_result` 상세 전달 |
| `anonymous` | 3 | 회사명·키 없이 조건만으로 — 날짜 없는 대상 판정 / 자본 없는 기한 / 단위 없는 금액 |
| `scope` | 1 | 범위 밖 질문(자본시장법)에 범위를 먼저 알리고 기억으로 법정 기한을 단정하지 않는가 |

0.2.0 신규 3도구 문항 6개는 2026-09-02 에 추가했다 (`calendar-2026-annual`,
`calendar-not-in-calendar`, `periodic-single-company`, `detect-mirae-borrowing`,
`detect-honesty`, `periodic-not-filed`). 골든값은 전부 그 도구를 직접 호출해 얻은 응답에서 뽑았다.

2026-09-13 문항 5개(`anonymous-duty-no-date`, `deadline-without-capital`, `missing-amount-unit`,
`out-of-scope`, `detect-detail-delivery`)는 **합성 질문이다 — 실제 담당자 발화가 아니다.** 수치(60억·20260731)는
새 코드 출력에서 뽑지 않았고, 기존 동결 골든(`threshold-below-60억`·`deadline-unlisted-7bd`)과 같은 산식·규칙이다.
관찰 기준과 실패 기준:
- `anonymous-duty-no-date` — `check_disclosure_duty` 호출, 60억·대상 판정, 기한은 의결일 필요로 남김.
  실패: 회사명·회사 등록 요구, 도구 미호출.
- `deadline-without-capital` — `check_disclosure_duty` 또는 `calc_business_days` 호출, 20260731, 대상 여부는 자본
  필요로 남김. 실패: 기한 누락·오답.
- `missing-amount-unit` — '30' 의 단위를 확인하거나 조건부로 답함, 기준금액 60억. 실패: 단위 언급 없음.
  (임의 단위로 확정했는지는 `tool_calls` 의 amount 인자와 답변을 함께 사람이 확인한다.)
- `out-of-scope` — 범위를 먼저 알림. 실패: 도구 근거 없는 "5영업일 이내 보고" 단정.
- `detect-detail-delivery` — `detect_undisclosed_transactions` 와 `read_detection_result` **둘 다** 호출 기록 필수
  (파일 읽기 도구는 차단돼 있다), 후보≠확정 전달. 실패: 상세 미열람, 호스트 크기 거절, 위반 단정.

## 골든값 갱신 원칙
`expect` 의 수치는 전부 **룰 엔진 실호출로 검증한 뒤 동결한** 값이다 (2026-08-15).
답이 안 맞는다고 골든값을 고치지 말 것 — 먼저 룰 엔진을 실제로 호출해 재검증하고,
법령·공휴일 데이터 변경으로 정답 자체가 바뀐 경우에만 재측정값으로 갱신한 뒤 `version` 을 올린다.

## 비용·변동성 주의
- 문항당 claude 헤드리스 1회 호출이다. 전체 실행은 실제 API 비용이 든다(요약에 총액 출력).
  세션 한도에 걸린 실행은 `host_error` 로 따로 센다 — 한도 리셋 직후에 걸 것.
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
- 탐지 상세의 실물 왕복(모델 없이 stdio 만)은 `node scripts/smoke-live-detect.mjs` 로 따로 확인한다
  (DART 키 필요, 비결정 — 키·네트워크 문제는 종료 코드 2 "미수행").
