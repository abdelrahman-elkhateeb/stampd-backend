/**
 * The standard error body, agreed on Trello BE-00:
 *   { code, message, fieldErrors? }
 * `code` is stable and machine-readable; the frontend translates it.
 * `message` is for logs only. The request ID travels in the X-Request-Id
 * header (set on every response), not in the body.
 *
 * New codes are added here when a ticket defines them, and the frontend adds
 * their translations.
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

export type FieldErrorCode =
  | "REQUIRED"
  | "INVALID_FORMAT"
  | "TOO_SHORT"
  | "TOO_LONG"
  | "OUT_OF_RANGE"
  | "ALREADY_EXISTS"

export const FIELD_ERROR_CODES: readonly FieldErrorCode[] = [
  "REQUIRED",
  "INVALID_FORMAT",
  "TOO_SHORT",
  "TOO_LONG",
  "OUT_OF_RANGE",
  "ALREADY_EXISTS",
]

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

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    fieldErrors: FieldError[] = []
  ) {
    super(message)
    this.status = status
    this.code = code
    this.fieldErrors = fieldErrors
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
  unauthenticated: (message = "Missing or expired access token") =>
    new ApiError(401, "UNAUTHENTICATED", message),
  forbidden: (message = "Not allowed for this role") =>
    new ApiError(403, "FORBIDDEN", message),
  notFound: (message = "Not found") => new ApiError(404, "NOT_FOUND", message),
  conflict: (message = "Conflict") => new ApiError(409, "CONFLICT", message),
  internal: () => new ApiError(500, "INTERNAL_ERROR", "Internal error"),
}
