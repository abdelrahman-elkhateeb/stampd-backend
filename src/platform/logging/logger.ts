import type { LogLevel } from "../../config/env.ts"

/**
 * Structured JSON logs, one object per line, written to stdout:
 *   {"time":"2026-10-09T08:00:00.000Z","level":"info","service":"stampd-api",
 *    "env":"local","requestId":"…","msg":"request completed",…}
 *
 * A small in-house logger instead of a library (stack decision: express,
 * mongoose and zod only). Values under sensitive keys are replaced with
 * "[redacted]" at any depth, and errors are serialised with their stack
 * (logs only; clients never see stacks).
 */
export type LogFields = Record<string, unknown>

export type Logger = {
  error(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  debug(msg: string, fields?: LogFields): void
  /** A logger that adds these fields to every line (e.g. requestId). */
  child(fields: LogFields): Logger
}

const SEVERITY: Record<Exclude<LogLevel, "silent">, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
}

/** Keys whose values never reach a log line (passwords, tokens, secrets, URIs with credentials). */
const SENSITIVE_KEY =
  /password|passcode|token|secret|authorization|cookie|api[-_]?key|mongodb[-_]?uri/i

export function redact(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  if (depth > 6 || value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[redacted]" : redact(v, depth + 1),
    ])
  )
}

export function createLogger(options: {
  level: LogLevel
  base?: LogFields
  write?: (line: string) => void
}): Logger {
  const write =
    options.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  const threshold = options.level === "silent" ? -1 : SEVERITY[options.level]

  const make = (bindings: LogFields): Logger => {
    const log =
      (level: keyof typeof SEVERITY) => (msg: string, fields?: LogFields) => {
        if (SEVERITY[level] > threshold) return
        const line = {
          time: new Date().toISOString(),
          level,
          ...bindings,
          ...(fields ? (redact(fields) as LogFields) : {}),
          msg,
        }
        write(JSON.stringify(line))
      }
    return {
      error: log("error"),
      warn: log("warn"),
      info: log("info"),
      debug: log("debug"),
      child: (fields) =>
        make({ ...bindings, ...(redact(fields) as LogFields) }),
    }
  }
  return make(options.base ?? {})
}
