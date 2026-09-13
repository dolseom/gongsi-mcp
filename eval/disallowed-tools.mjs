// 헤드리스 평가의 도구 격리 목록 — e2e 러너(scripts/eval-e2e.mjs)와 messy 러너(eval/messy/run-messy.mjs)가
// **이 하나를** import 한다. 목록이 둘이면 한쪽만 고쳐져 격리가 조용히 갈라진다.
//
// ⚠️ auto 모드에서는 `--allowedTools` 가 허용 목록으로 동작하지 않는다(2026-09-07 실측: init 이벤트
//   tools 에 WebFetch·WebSearch·Bash 가 전부 있었다). 이 차단 목록이 유일한 격리 수단이다.
// ⚠️ 2026-09-08 m07 은 Monitor·TaskOutput 을 호출했고, 그 init 에는 DesignSync·EnterWorktree·
//   ExitWorktree·PushNotification·RemoteTrigger·ReportFindings 가 차단 목록 밖으로 남아 있었다.
//   PushNotification·RemoteTrigger 는 **평가 밖으로 부작용**을 낼 수 있다.
// ★ `ToolSearch` 는 남긴다 — MCP 도구가 지연 로드라 막으면 우리 도구를 아예 부를 수 없다.
// ★ 호스트가 새 내장 도구를 추가하면 채점기(eval/e2e/grade.mjs environmentProblem)가 init 목록에서
//   찾아 **격리 실패로 거절**한다 — 그때 여기에 추가하면 된다.

/** 차단하지 않는 우리 MCP 밖 도구 (스키마 지연 로드 전용) */
export const ALLOWED_NON_MCP_TOOLS = ['ToolSearch'];

export const DISALLOWED_TOOLS = [
  // 외부 근거·파일·셸 우회
  'WebFetch', 'WebSearch', 'Bash', 'PowerShell', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit',
  // 하위 에이전트·백그라운드 작업
  'Task', 'Agent', 'Monitor', 'TaskOutput', 'TaskStop', 'Workflow', 'Skill',
  'CronCreate', 'CronList', 'CronDelete', 'ScheduleWakeup', 'RemoteTrigger',
  // 사람·외부로 나가는 부작용
  'SendMessage', 'ListAgents', 'AskUserQuestion', 'SendUserFile', 'PushNotification', 'SendFeedback',
  'Artifact', 'DesignSync', 'ReportFindings', 'EndConversation',
  // 작업 트리·모드 전환
  'EnterWorktree', 'ExitWorktree', 'EnterPlanMode', 'ExitPlanMode', 'TodoWrite',
  // MCP 리소스 직접 읽기 (우리 서버는 리소스를 내지 않는다)
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool',
].join(',');
