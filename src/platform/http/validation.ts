import type { Request, RequestHandler, Response } from "express"
import type { z } from "zod"

import {
  apiErrors,
  FIELD_ERROR_CODES,
  type FieldError,
  type FieldErrorCode,
} from "./errors.ts"

/**
 * The shared validation mechanism: every endpoint declares Zod schemas for
 * its path params, query and body, and gets typed, validated input.
 *
 *   router.get("/holidays", route(
 *     { query: z.object({ year: z.coerce.number().int().min(2000) }) },
 *     async ({ query }) => ({ status: 200, body: await listHolidays(query.year) })
 *   ))
 *
 * All three parts are checked before the handler runs; every problem becomes a
 * field error in one 422 VALIDATION_FAILED response. Query and path values
 * arrive as strings, so their schemas use z.coerce for numbers and booleans.
 */

/** Zod issue → the agreed field error code (same mapping the frontend uses). */
export function fieldCode(issue: z.core.$ZodIssue): FieldErrorCode {
  const input = (issue as { input?: unknown }).input
  if (input === undefined || input === "") {
    if (issue.code === "invalid_type" || issue.code === "too_small") {
      return "REQUIRED"
    }
  }
  switch (issue.code) {
    case "too_small":
      return issue.origin === "string" || issue.origin === "array"
        ? "TOO_SHORT"
        : "OUT_OF_RANGE"
    case "too_big":
      return issue.origin === "string" || issue.origin === "array"
        ? "TOO_LONG"
        : "OUT_OF_RANGE"
    case "custom": {
      // Refinements may name a code: ctx.addIssue({ code: "custom", params: { code: "ALREADY_EXISTS" } })
      const named = issue.params?.code as FieldErrorCode | undefined
      return named && FIELD_ERROR_CODES.includes(named)
        ? named
        : "INVALID_FORMAT"
    }
    default:
      return "INVALID_FORMAT"
  }
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let node = input
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined
    node = (node as Record<PropertyKey, unknown>)[key]
  }
  return node
}

/**
 * Zod issues → field errors, one per field (the first problem wins).
 * `raw` is the input before parsing: a field that was absent or empty there is
 * REQUIRED, whatever rule failed. This matters for query and path values,
 * where z.coerce turns a missing value into NaN before Zod sees it.
 */
export function toFieldErrors(
  issues: readonly z.core.$ZodIssue[],
  fallbackField: string,
  raw?: unknown
): FieldError[] {
  const byField = new Map<string, FieldError>()
  for (const issue of issues) {
    const field = issue.path.map(String).join(".") || fallbackField
    if (byField.has(field)) continue
    const original = raw === undefined ? undefined : valueAt(raw, issue.path)
    const missing =
      raw !== undefined && (original === undefined || original === "")
    byField.set(field, {
      field,
      code: missing ? "REQUIRED" : fieldCode(issue),
      message: issue.message,
    })
  }
  return [...byField.values()]
}

type Schemas = {
  params?: z.ZodType
  query?: z.ZodType
  body?: z.ZodType
}

type Infer<S, K extends keyof Schemas> =
  S extends Record<K, infer T>
    ? T extends z.ZodType
      ? z.output<T>
      : undefined
    : undefined

export type RouteInput<S extends Schemas> = {
  params: Infer<S, "params">
  query: Infer<S, "query">
  body: Infer<S, "body">
  req: Request
  res: Response
}

/** What a handler returns: a status and an optional JSON body. */
export type RouteResult = { status: number; body?: unknown }

/** Validates params, query and body, then runs the handler (async errors reach the error handler). */
export function route<S extends Schemas>(
  schemas: S,
  handler: (input: RouteInput<S>) => Promise<RouteResult>
): RequestHandler {
  return async (req, res) => {
    const fieldErrors: FieldError[] = []
    const parse = (
      schema: z.ZodType | undefined,
      value: unknown,
      part: string
    ) => {
      if (!schema) return undefined
      const result = schema.safeParse(value, { reportInput: true })
      if (result.success) return result.data
      fieldErrors.push(...toFieldErrors(result.error.issues, part, value))
      return undefined
    }

    const params = parse(schemas.params, req.params, "params")
    const query = parse(schemas.query, req.query, "query")
    const body = parse(schemas.body, req.body, "body")
    if (fieldErrors.length) throw apiErrors.validationFailed(fieldErrors)

    const result = await handler({
      params,
      query,
      body,
      req,
      res,
    } as RouteInput<S>)
    res.status(result.status)
    if (result.body === undefined) res.end()
    else res.json(result.body)
  }
}
