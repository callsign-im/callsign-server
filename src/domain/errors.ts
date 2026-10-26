export type ErrorCode =
  | "invalid_input"
  | "unauthorized"
  | "forbidden"
  | "pending_approval"
  | "agent_frozen"
  | "step_up_required"
  | "not_found"
  | "conflict"
  | "rate_limited";

const STATUS: Record<ErrorCode, 400 | 401 | 403 | 404 | 409 | 429> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  pending_approval: 403,
  agent_frozen: 403,
  step_up_required: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }

  get status() {
    return STATUS[this.code];
  }
}

export function isUniqueViolation(error: unknown): boolean {
  const cause = error instanceof Error && "cause" in error ? error.cause : error;
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23505";
}
