import { describe, expect, it } from "vitest"

import { createLogger, redact } from "../../src/platform/logging/logger.ts"

function capture(level: "error" | "warn" | "info" | "debug" | "silent") {
  const lines: Record<string, unknown>[] = []
  const logger = createLogger({
    level,
    base: { service: "stampd-api" },
    write: (line) => lines.push(JSON.parse(line)),
  })
  return { lines, logger }
}

describe("logger", () => {
  it("writes one JSON object per line with time, level, base fields and msg", () => {
    const { lines, logger } = capture("info")
    logger.info("hello", { userId: "u1" })
    expect(lines).toEqual([
      {
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
        level: "info",
        service: "stampd-api",
        userId: "u1",
        msg: "hello",
      },
    ])
  })

  it("respects the level threshold", () => {
    const { lines, logger } = capture("warn")
    logger.debug("no")
    logger.info("no")
    logger.warn("yes")
    logger.error("yes")
    expect(lines.map((l) => l.level)).toEqual(["warn", "error"])
    const silent = capture("silent")
    silent.logger.error("never")
    expect(silent.lines).toEqual([])
  })

  it("child loggers add their fields to every line", () => {
    const { lines, logger } = capture("info")
    logger.child({ requestId: "r-1" }).info("in request")
    expect(lines[0]).toMatchObject({ requestId: "r-1", msg: "in request" })
  })

  it("redacts secrets at any depth", () => {
    const { lines, logger } = capture("info")
    logger.info("login", {
      email: "a@b.c",
      password: "hunter2",
      body: { refreshToken: "rt_1", nested: { Authorization: "Bearer x" } },
      config: { mongodbUri: "mongodb://u:p@h/db" },
    })
    const text = JSON.stringify(lines)
    for (const secret of ["hunter2", "rt_1", "Bearer x", "u:p@h"]) {
      expect(text).not.toContain(secret)
    }
    expect(lines[0]).toMatchObject({ email: "a@b.c", password: "[redacted]" })
  })

  it("serialises errors with name, message and stack", () => {
    const value = redact(new TypeError("boom")) as Record<string, string>
    expect(value.name).toBe("TypeError")
    expect(value.message).toBe("boom")
    expect(value.stack).toContain("TypeError: boom")
  })
})
