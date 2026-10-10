import { readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { MODULES } from "../../src/modules/index.ts"
import { createLogger } from "../../src/platform/logging/logger.ts"
import { systemClock } from "../../src/platform/time/clock.ts"
import {
  buildTestApp,
  testConfig,
  vercelFunctionFor,
  withServer,
} from "../helpers.ts"

/** One Vercel function per module: vercel.json must send every route to its own. */
describe("vercel.json rewrites", () => {
  const deps = {
    config: testConfig(),
    logger: createLogger({ level: "silent" }),
    checkDatabase: async () => true,
    clock: systemClock,
  }

  it("send every route of every module to that module's function", () => {
    let routes = 0
    for (const module of MODULES) {
      for (const layer of module.routes(deps)?.stack ?? []) {
        const path = (layer.route?.path as string).replace(/:\w+/g, "x")
        expect(vercelFunctionFor(path), path).toBe(module.name)
        expect(vercelFunctionFor(`${path}/`), `${path}/`).toBe(module.name)
        routes++
      }
    }
    expect(routes).toBeGreaterThan(80)
  })

  it("send the job routes and unknown paths to the system function", () => {
    for (const path of ["/jobs/attendance.close", "/", "/nope", "/authx"]) {
      expect(vercelFunctionFor(path), path).toBe("system")
    }
  })

  it("has exactly one api/<module>.js per module", () => {
    expect(readdirSync(new URL("../../api", import.meta.url)).sort()).toEqual(
      MODULES.map((module) => `${module.name}.js`).sort()
    )
  })
})

describe("createApp({ only })", () => {
  it("mounts just the named modules; the rest is the standard 404", async () => {
    const app = buildTestApp({
      config: testConfig({
        cronSecret: "cron-secret-0123456789abcdefghijklmnop",
      }),
      only: ["system"],
    })
    await withServer(app, async (base) => {
      expect((await fetch(`${base}/health`)).status).toBe(200)
      for (const path of ["/me", "/jobs/attendance.close"]) {
        const response = await fetch(`${base}${path}`)
        expect(response.status, path).toBe(404)
        expect(await response.json()).toMatchObject({ code: "NOT_FOUND" })
      }
    })
  })
})
