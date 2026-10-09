/**
 * The standard error body, agreed on Trello BE-00:
 *   { code, message, fieldErrors? }
 * `code` is stable and machine-readable; the frontend translates it.
 * `message` is for logs only. The request ID travels in the X-Request-Id
 * header (set on every response), not in the body.
 *
 * New codes are added here when a ticket defines them, and written on that
 * ticket's Trello card so the frontend can translate them.
 */
export type ErrorCode =
  | "VALIDATION_FAILED"
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_DEACTIVATED"
  | "TOO_MANY_ATTEMPTS"
  | "UNAUTHENTICATED"
  | "SESSION_EXPIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL_ERROR"
  // BE-02: invite and password-reset links
  | "TOKEN_INVALID"
  | "TOKEN_EXPIRED"
  // BE-03: nobody approves their own request
  | "SELF_APPROVAL"
  // BE-06: employee and department rules
  | "DEPARTMENT_NOT_EMPTY"
  | "HAS_DIRECT_REPORTS"
  | "LAST_ADMIN"
  // BE-07: attendance
  | "ATTENDANCE_NOT_TRACKED"
  | "NO_OPEN_SESSION"
  // BE-08: leave types and balances
  | "LEAVE_TYPE_IN_USE"
  | "LEAVE_TYPE_NOT_TRACKED"
  | "INSUFFICIENT_BALANCE"

export const FIELD_ERROR_CODES = [
  "REQUIRED",
  "INVALID_FORMAT",
  "TOO_SHORT",
  "TOO_LONG",
  "OUT_OF_RANGE",
  "ALREADY_EXISTS",
  // BE-02: password policy and change password
  "TOO_COMMON",
  "CONTAINS_PERSONAL_INFO",
  "INCORRECT",
  // BE-05: image uploads
  "FILE_TOO_LARGE",
  "UNSUPPORTED_FILE_TYPE",
  // BE-06: references to other records, and manager rules
  "UNKNOWN_REFERENCE",
  "SELF_MANAGER",
  "NOT_A_MANAGER",
  "MANAGER_LOOP",
] as const

export type FieldErrorCode = (typeof FIELD_ERROR_CODES)[number]

export type FieldError = {
  field: string
  code: FieldErrorCode
  message: string
}

export type ErrorBody = {
  code: ErrorCode
  message: string
  fieldErrors?: FieldError[]
}

export class ApiError extends Error {
  override readonly name = "ApiError"
  readonly status: number
  readonly code: ErrorCode
  readonly fieldErrors: FieldError[]
  /** Extra response headers, e.g. Retry-After on 429 */
  readonly headers: Record<string, string>

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    fieldErrors: FieldError[] = [],
    headers: Record<string, string> = {}
  ) {
    super(message)
    this.status = status
    this.code = code
    this.fieldErrors = fieldErrors
    this.headers = headers
  }

  toBody(): ErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.fieldErrors.length ? { fieldErrors: this.fieldErrors } : {}),
    }
  }
}

/** One helper per standard response, so status and code always match. */
export const apiErrors = {
  validationFailed: (fieldErrors: FieldError[]) =>
    new ApiError(
      422,
      "VALIDATION_FAILED",
      "Request validation failed",
      fieldErrors
    ),
  /** A single field error, e.g. fieldError("email", "ALREADY_EXISTS", "email is already registered") */
  fieldError: (field: string, code: FieldErrorCode, message: string) =>
    new ApiError(422, "VALIDATION_FAILED", "Request validation failed", [
      { field, code, message },
    ]),
  unauthenticated: (message = "Missing or expired access token") =>
    new ApiError(401, "UNAUTHENTICATED", message),
  invalidCredentials: () =>
    new ApiError(401, "INVALID_CREDENTIALS", "Invalid credentials"),
  sessionExpired: (message = "Refresh token invalid") =>
    new ApiError(401, "SESSION_EXPIRED", message),
  accountDeactivated: () =>
    new ApiError(403, "ACCOUNT_DEACTIVATED", "Account deactivated"),
  tooManyAttempts: (retryAfterSeconds: number) =>
    new ApiError(429, "TOO_MANY_ATTEMPTS", "Too many attempts", [], {
      "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))),
    }),
  tokenInvalid: () =>
    new ApiError(404, "TOKEN_INVALID", "Token not found or already used"),
  tokenExpired: () => new ApiError(410, "TOKEN_EXPIRED", "Token expired"),
  forbidden: (message = "Not allowed for this role") =>
    new ApiError(403, "FORBIDDEN", message),
  selfApproval: () =>
    new ApiError(403, "SELF_APPROVAL", "You can't approve your own request"),
  /** 409 with a specific code (DEPARTMENT_NOT_EMPTY, HAS_DIRECT_REPORTS, LAST_ADMIN …) */
  conflictWith: (code: ErrorCode, message: string) =>
    new ApiError(409, code, message),
  notFound: (message = "Not found") => new ApiError(404, "NOT_FOUND", message),
  conflict: (message = "Conflict") => new ApiError(409, "CONFLICT", message),
  internal: () => new ApiError(500, "INTERNAL_ERROR", "Internal error"),
}
