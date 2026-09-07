/**
 * 에러 규격
 *
 * 원칙 (docs/absorbed-from-dart-mcp.md §1-5):
 * - 모든 도구는 `{ error, message, details }` 형태로만 실패를 알린다.
 * - **도구는 예외를 밖으로 던지지 않는다.** MCP 클라이언트에 스택트레이스가 노출되면 안 된다.
 * - 메시지는 전부 한글이고, 조치 방법을 함께 담는다.
 * - 예외 메시지에 인증키가 절대 새지 않도록 재포장한다.
 */

/** 에러 코드 — 응답의 `error` 필드에 그대로 들어간다 */
export type ErrorCode =
  | 'invalid_argument'
  | 'missing_api_key'
  | 'rate_limit'
  | 'range_too_large'
  | 'corp_not_found'
  | 'ambiguous_corp'
  | 'group_not_found'
  | 'document_not_found'
  | 'body_unparsable'
  | 'dart_api_error'
  | 'egroup_api_error'
  | 'egroup_parse_error'
  | 'upstream_forbidden'
  /**
   * 도구의 시간 예산(60초 벽 대비)이 남지 않아 상류 호출을 시작하지 않았다.
   * detect_undisclosed_transactions 내부에서는 대부분 잡혀 **부분 결과 + 미판정**이 되고,
   * 이 코드가 응답으로 나가는 것은 원천 문서조차 못 받은 예외적 경우다.
   */
  | 'deadline_exceeded'
  /**
   * 이어보기 토큰(`continuation_token`)이 만료·부재이거나 앞 호출과 다른 인자로 들어왔다.
   * 이어보기 캐시는 **한 논리적 실행 안에서만** 유효하므로, 어긋나면 앞 호출의 목록을
   * 조용히 섞어 쓰지 않고 거절한다 — 토큰 없이 처음부터 다시 실행하면 된다.
   */
  | 'continuation_invalid'
  | 'internal_error';

export interface ErrorResponse {
  error: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export function errorResponse(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ErrorResponse {
  return details ? { error: code, message, details } : { error: code, message };
}

/** 도구가 잡아서 규격 응답으로 바꿀 수 있는 에러의 공통 조상 */
export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ToolError';
  }

  toResponse(): ErrorResponse {
    return errorResponse(this.code, this.message, this.details);
  }
}

export class MissingApiKeyError extends ToolError {
  constructor(which: 'DART_API_KEY' | 'EGROUP_API_KEY', purpose: string) {
    super(
      'missing_api_key',
      `${which} 가 설정되지 않았습니다. ${purpose}\n` +
        `.env 파일에 ${which}=... 를 추가하거나 환경변수로 지정하세요.`,
      { variable: which },
    );
  }
}

export class RateLimitError extends ToolError {
  constructor(todayCalls: number, limit: number, resetAtKst: string) {
    super(
      'rate_limit',
      `일일 호출 한도에 도달했습니다 (오늘 ${todayCalls.toLocaleString()}건 / 한도 ${limit.toLocaleString()}건). ` +
        `한국시간 자정 이후 리셋됩니다.`,
      { todayCalls, limit, resetAtKst },
    );
  }
}

/** DART API 가 비정상 status 를 반환한 경우 */
export class DartApiError extends ToolError {
  constructor(status: string, apiMessage: string, hint?: string) {
    super('dart_api_error', `DART API 오류 [${status}] ${apiMessage}${hint ? ` — ${hint}` : ''}`, {
      status,
      apiMessage,
    });
  }
}

/** 공공데이터포털이 403 을 준 경우 — 대개 키가 아니라 **활용신청 누락**이다 */
export class UpstreamForbiddenError extends ToolError {
  constructor(service: string) {
    super(
      'upstream_forbidden',
      `공공데이터포털이 접근을 거부했습니다 (HTTP 403 Forbidden) — 서비스: ${service}\n` +
        `인증키 문제가 아니라 **해당 서비스 활용신청이 안 된 경우**가 대부분입니다. ` +
        `data.go.kr 에서 해당 API 활용신청(자동승인)을 완료했는지 확인하세요.\n` +
        `※ 인증키는 계정당 1개를 공유하지만 활용신청은 API별로 따로 해야 합니다.`,
      { service },
    );
  }
}

export class CorpNotFoundError extends ToolError {
  constructor(query: string, suggestions: Array<{ corpCode: string; corpName: string }> = []) {
    super(
      'corp_not_found',
      `'${query}' 와 일치하는 회사를 찾지 못했습니다.` +
        (suggestions.length ? ` 비슷한 이름: ${suggestions.map((s) => s.corpName).join(', ')}` : ''),
      { query, suggestions },
    );
  }
}

export class AmbiguousCorpError extends ToolError {
  constructor(query: string, candidates: Array<Record<string, unknown>>) {
    super(
      'ambiguous_corp',
      `'${query}' 에 해당하는 회사가 ${candidates.length}건입니다. ` +
        `법인등록번호나 corp_code 로 다시 지정하세요. ` +
        `(상호가 같아도 별개 법인일 수 있습니다 — 합병 전후 법인이 대표적입니다)`,
      { query, candidates },
    );
  }
}

/**
 * 요청 범위가 커서 한 번에 처리할 수 없는 경우.
 * MCP 클라이언트는 약 60초에 호출을 끊으므로, 서버가 미리 판단해 분할 방법을 안내한다.
 * (docs/absorbed-from-dart-mcp.md §2-1)
 */
export class RangeTooLargeError extends ToolError {
  constructor(
    what: string,
    estimatedSeconds: number,
    suggestedSplits: Array<{ from: string; to: string }>,
  ) {
    super(
      'range_too_large',
      `${what} 은(는) 한 번에 처리할 수 없습니다 (예상 ${estimatedSeconds}초, 클라이언트 제한 약 60초). ` +
        `아래 구간으로 나누어 호출하세요.`,
      { estimatedSeconds, suggestedSplits },
    );
  }
}

/**
 * 알 수 없는 예외를 규격 응답으로 바꾼다.
 * 원문 메시지를 그대로 노출하지 않는다 — 인증키가 섞여 있을 수 있다.
 */
export function toErrorResponse(err: unknown): ErrorResponse {
  if (err instanceof ToolError) return err.toResponse();
  if (err instanceof Error) {
    return errorResponse('internal_error', `예기치 않은 오류가 발생했습니다: ${err.name}`, {
      // 메시지 본문은 담지 않는다 (키 유출 방지). 상세는 stderr 로그에서 본다.
      hint: '자세한 내용은 서버 로그(stderr)를 확인하세요.',
    });
  }
  return errorResponse('internal_error', '예기치 않은 오류가 발생했습니다.');
}
