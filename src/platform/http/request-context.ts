import { randomUUID } from "node:crypto"
import type { RequestHandler } from "express"

import type { Logger } from "../logging/logger.ts"

export const REQUEST_ID_HEADER = "x-request-id"

/** Letters, digits and - _ . : only, at most 128 characters. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * Reuses the caller's X-Request-Id (the frontend BFF sends one and forwards it
 * to Sentry) when it is safe to log; otherwise generates a UUID. Unsafe values
 * are replaced rather than rejected, so a bad header never breaks a request
 * and nothing attacker-controlled lands in the logs.
 */
export function resolveRequestId(
  header: string | string[] | undefined
): string {
  const value = Array.isArray(header) ? header[0] : header
  return value && SAFE_REQUEST_ID.test(value) ? value : randomUUID()
}

/**
 * First middleware of every request:
 *  - req.id: the request ID, also returned in X-Request-Id on every response
 *    (set before anything else, so errors and 404s carry it too);
 *  - req.log: a logger whose lines all carry the requestId;
 *  - one "request completed" line per request: method, path (no query
 *    string: it can carry search terms), status and duration.
 */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint()
    req.id = resolveRequestId(req.headers[REQUEST_ID_HEADER])
    req.log = logger.child({ requestId: req.id })
    res.setHeader(REQUEST_ID_HEADER, req.id)

    res.on("finish", () => {
      req.log.info("request completed", {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
      })
    })
    next()
  }
}
