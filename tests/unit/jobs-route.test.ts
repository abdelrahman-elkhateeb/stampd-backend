import { Router } from "express"
import { describe, expect, it } from "vitest"

import type { AppModule } from "../../src/modules/module.ts"
import { buildTestApp, testConfig, withServer } from "../helpers.ts"

/** Scheduled jobs over HTTP, for serverless hosts (Vercel Cron). */
const SECRET = "cron-secret-0123456789abcdefghijklmnop"

function appWithJob(cronSecret: string | null) {
  const runs: string[] = []
  const module: AppModule = {
    name: "fake",
    routes: () => Router(),
    jobs: () => [
      {
        name: "demo.job",
        everyMs: 60_000,
        run: async () => {
          runs.push("ran")
          return { closed: 2 }
        },
      },
    ],
  }
  return {
    runs,
    app: buildTestApp({
      config: testConfig({ cronSecret }),
      modules: [module],
    }),
  }
}

const get = (base: string, path: string, authorization?: string) =>
  fetch(`${base}${path}`, {
    headers: authorization ? { authorization } : {},
  })

describe("GET /jobs/{name}", () => {
  it("runs the job with the right secret and returns its result", async () => {
    const { app, runs } = appWithJob(SECRET)
    await withServer(app, async (base) => {
      const response = await get(base, "/jobs/demo.job", `Bearer ${SECRET}`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        job: "demo.job",
        result: { closed: 2 },
      })
    })
    expect(runs).toEqual(["ran"])
  })

  it("refuses a missing or wrong secret without running anything", async () => {
    const { app, runs } = appWithJob(SECRET)
    await withServer(app, async (base) => {
      for (const auth of [
        undefined,
        "Bearer wrong",
        SECRET,
        `Bearer ${SECRET}x`,
      ]) {
        const response = await get(base, "/jobs/demo.job", auth)
        expect(response.status, String(auth)).toBe(401)
        expect(await response.json()).toMatchObject({ code: "UNAUTHENTICATED" })
      }
    })
    expect(runs).toEqual([])
  })

  it("answers 404 for an unknown job", async () => {
    const { app } = appWithJob(SECRET)
    await withServer(app, async (base) => {
      const response = await get(base, "/jobs/nope", `Bearer ${SECRET}`)
      expect(response.status).toBe(404)
    })
  })

  it("doesn't exist without CRON_SECRET (jobs then run in-process)", async () => {
    const { app, runs } = appWithJob(null)
    await withServer(app, async (base) => {
      const response = await get(base, "/jobs/demo.job", "Bearer anything")
      expect(response.status).toBe(404)
    })
    expect(runs).toEqual([])
  })
})
