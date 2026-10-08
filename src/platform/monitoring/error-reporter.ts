/**
 * Integration point for error monitoring (BE-16 picks the provider, e.g. Sentry).
 * The error handler calls captureException for every 5xx, with the request ID,
 * so a monitoring event can be matched to log lines and to the frontend's
 * Sentry event (which carries the same X-Request-Id).
 *
 * Until a provider is configured, nothing is sent anywhere: the error is
 * already in the structured logs. To connect a provider, implement
 * ErrorReporter and pass it to createApp({ errorReporter }) in src/server.ts.
 */
export type ErrorContext = {
  requestId: string
  method: string
  path: string
}

export interface ErrorReporter {
  captureException(error: unknown, context: ErrorContext): void
}

export const noopErrorReporter: ErrorReporter = {
  captureException() {},
}
