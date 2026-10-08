import type { ErrorRequestHandler, RequestHandler } from "express"

import type { ErrorReporter } from "../monitoring/error-reporter.ts"
import { ApiError, apiErrors } from "./errors.ts"

/**
 * Turns anything thrown during a request into the standard error body.
 * Clients only ever see { code, message, fieldErrors? }: never stack traces,
 * database errors, file paths or library messages. 5xx errors are logged with
 * their stack and sent to the error reporter; 4xx are expected outcomes and
 * logged at info level.
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error

  // express.json() body errors carry a `type` and an HTTP status.
  const { type, status } = (error ?? {}) as { type?: string; status?: number }
  if (type === "entity.too.large") {
    return apiErrors.validationFailed([
      { field: "body", code: "OUT_OF_RANGE", message: "body is too large" },
    ])
  }
  if (
    type === "entity.parse.failed" ||
    type === "encoding.unsupported" ||
    status === 415
  ) {
    return apiErrors.validationFailed([
      {
        field: "body",
        code: "INVALID_FORMAT",
        message: "body must be valid JSON",
      },
    ])
  }
  return apiErrors.internal()
}

export function errorHandler(reporter: ErrorReporter): ErrorRequestHandler {
  // Express recognises error handlers by their four parameters.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (error, req, res, _next) => {
    const apiError = toApiError(error)
    if (apiError.status >= 500) {
      req.log.error("request failed", { error })
      reporter.captureException(error, {
        requestId: req.id,
        method: req.method,
        path: req.path,
      })
    } else {
      req.log.info("request rejected", {
        status: apiError.status,
        code: apiError.code,
      })
    }
    res.status(apiError.status).json(apiError.toBody())
  }
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res
    .status(404)
    .json(apiErrors.notFound(`No route for ${req.method} ${req.path}`).toBody())
}
