# 두서없는 질문 게이트 (2026-09-06)

기존 `eval/e2e` 골든셋이 **정제된 질문**을 보는 반면, 이쪽은 실무자가 맥락을 빠뜨리고
줄임말·오타를 섞어 던지는 질문에 답이 유용한지를 본다. 골든 답이 없고 **사람이 원문을 읽고
판정한다**.

- 문항: `messy-questions.json` (12개, 유형별 1개). 각 문항의 `watch` 가 볼 지점이다.
- 러너: `node run-messy.mjs [id1,id2] [동시성]` — 결과는 `messy-results/`.
  ⚠️ `mcp-eval.json`(캐시 DB 경로를 담은 MCP 설정)은 개인 경로라 저장소에 넣지 않았다.
  `eval/e2e/mcp-config.json` 을 복사해 `env.GONGSI_CACHE_DB` 를 자기 캐시로 지정해 쓸 것.
- ⚠️ 문항은 **설계된 것**이지 수집된 실제 발화가 아니다. `RESEARCH/공시담당자_니즈_20260730/`
  의 질문 코퍼스 1,102건은 대부분 금감원 자본시장법 Q&A 문어체라 이 목적에 맞지 않았다.
  실제 실무자 발화를 얻으면 이 문항들을 교체할 것.

## 도구 호출 기록 (2026-09-07 추가)

레코드에 **답변만이 아니라 도구 사용 흔적**이 함께 남는다. 2026-09-06 실행은 `result`
문자열만 저장해, 한 문항(m06)이 "법제처 원문으로 확인했다"고 답했을 때 **어느 도구로 그랬는지
확정할 수 없었다.** 근거 위조와 정상 조회를 사후에 가르려면 호출 목록이 있어야 한다.

`messy-results/<id>.json` 에 추가된 필드:

| 필드 | 내용 |
|---|---|
| `tool_names` | 이 문항이 부른 도구 이름 (중복 제거, 호출 순서) |
| `tool_calls` | `{name, input}` — 입력은 JSON 300자로 자름 |
| `tool_results` | `{name, is_error, head}` — 결과 앞 200자 |
| `tools_available` | init 이벤트가 알린 **실제로 붙은 도구 전체** |
| `mcp_servers` | 붙은 MCP 서버와 연결 상태 |
| `permission_denials` | 차단된 도구를 시도했는지 |
| `duration_ms` | CLI 가 보고한 소요 |

기존 필드(`id`/`type`/`question`/`watch`/`elapsed_s`/`is_error`/`num_turns`/`answer`/
`raw_head`)는 이름·의미가 그대로다. 원본 스트림은 `messy-results/<id>.stream.jsonl` 에
따로 남으므로, 파서를 고친 뒤 과거 실행을 다시 읽을 수 있다.

파서는 `parse-stream.mjs` 에 따로 있다 — 러너는 import 하는 순간 12문항을 실제로 돌리므로
(비용·세션 한도) 파싱만 검증하려면 부작용 없는 모듈이어야 한다.

## ⚠️ auto 모드에서는 `--allowedTools` 가 허용 목록이 아니다

사용자 설정이 `defaultMode: auto` 라 `--allowedTools mcp__gongsi` 를 줘도 **내장 도구가
그대로 살아 있다.** 2026-09-07 stream-json 으로 확인한 결과 init 이벤트의 `tools` 45개에
WebFetch·WebSearch·Bash·Task 가 전부 들어 있었다. 그러면 이 평가가 재는 것이 "우리 MCP 가
유용한가"가 아니라 "모델이 웹을 잘 뒤지는가"가 된다 — 게다가 이 프로젝트의 작업 원칙은
**웹 검색 결과를 근거로 쓰지 않는 것**이다.

→ 러너가 `--disallowedTools "WebFetch,WebSearch,Bash,PowerShell,Read,Glob,Grep,Edit,Write,Task,Agent"`
로 막는다. `tools_available` 로 매 실행마다 실제로 무엇이 붙었는지 확인할 것.

★ **`ToolSearch` 는 일부러 남겼다.** MCP 도구가 지연 로드라 모델이 ToolSearch 로 스키마를
먼저 가져온다 (실측: m06 의 첫 호출이 `ToolSearch{select:mcp__gongsi__search_ftc_qna}`).
이걸 막으면 MCP 도구를 아예 부를 수 없다.

## m06 재현 기록 (2026-09-07)

2026-09-06 의 m06(`m06-out-of-scope.json`)은 **격리가 깨진 실행**이라 게이트 결과로 세지 않는다.
같은 문항을 stream-json 으로 5회 재현한 결과:

- 격리 전 4회 중 **1회가 WebFetch 실패 → Bash curl 로 법제처 DRF API**(`law.go.kr/DRF/lawService.do`)
  를 직접 불러 실제 법령 XML 을 받았다 — 어제 답의 "법제처 원문 확인"은 이 경로다. 근거 위조가
  아니라 격리 실패. 호출 목록은 `messy-results/m06-out-of-scope.leak-20260907-r2.json`.
- 나머지 3회와 **차단 후 1회**(`m06-out-of-scope.isolated-20260907.json` + `.stream.jsonl`)는
  `search_ftc_qna` 1회만 부르고 "범위 밖 · 공정위 문답 430건에 없음 · 법제처 도구 미연결이라 원문
  확인 불가"로 답했다. 기억 정보는 "원문 미검증, 근거로 쓰지 말 것" 딱지를 붙여 분리했다.
  차단 후 `tools_available` 은 45 → 35 (WebFetch·Bash 없음), `permission_denials` 0건.
- 판정: **격리된 실행 기준 m06 합격.** 나머지 11문항은 격리 전 실행이라 도구 호출 기록이 없다 —
  다음 전체 재실행 때 `tool_names` 로 각 문항이 실제로 우리 도구만 썼는지 확인할 것.
