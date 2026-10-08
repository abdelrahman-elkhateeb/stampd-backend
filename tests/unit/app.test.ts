import { Router } from "express"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import type { AppModule } from "../../src/modules/module.ts"
import { apiErrors, type ErrorBody } from "../../src/platform/http/errors.ts"
import { route } from "../../src/platform/http/validation.ts"
import { buildTestApp, captureLogs, withServer } from "../helpers.ts"

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** A module used only by these tests, to exercise the shared machinery. */
const probeModule = (build: (router: Router) => void): AppModule => ({
  name: "probe",
  routes: () => {
    const router = Router()
    build(router)
    return router
  },
})

const probeWithValidation = probeModule((router) => {
  router.post(
    "/probe/:id",
    route(
      {
        params: z.object({ id: z.uuid() }),
        query: z.object({ year: z.coerce.number().int().min(2000).max(2100) }),
        body: z.object({
          name: z.string().min(1).max(10),
          email: z.email(),
          days: z.number().min(0).max(30),
          tags: z.array(z.string()).max(2).optional(),
        }),
      },
      async ({ params, query, body }) => ({
        status: 201,
        body: { id: params.id, year: query.year, name: body.name },
      })
    )
  )
})

describe("request IDs", () => {
  it("generates a UUID when the client sends none", async () => {
    await withServer(buildTestApp(), async (url) => {
      const response = await fetch(`${url}/health`)
      expect(response.headers.get("x-request-id")).toMatch(UUID)
    })
  })

  it("echoes a safe client ID, on errors and 404s too", async () => {
    await withServer(buildTestApp(), async (url) => {
      for (const path of ["/health", "/no-such-route"]) {
        const response = await fetch(`${url}${path}`, {
          headers: { "x-request-id": "fe-123.abc" },
        })
        expect(response.headers.get("x-request-id")).toBe("fe-123.abc")
      }
    })
  })

  it("replaces an unsafe or oversized client ID", async () => {
    await withServer(buildTestApp(), async (url) => {
      for (const id of ["has space", "<script>", "x".repeat(129)]) {
        const response = await fetch(`${url}/health`, {
          headers: { "x-request-id": id },
        })
        expect(response.headers.get("x-request-id")).toMatch(UUID)
      }
    })
  })

  it("logs each request with its ID, path (no query string) and status, never the Authorization header", async () => {
    const { lines, logger } = captureLogs()
    await withServer(buildTestApp({ logger }), async (url) => {
      await fetch(`${url}/health?search=private`, {
        headers: {
          "x-request-id": "trace-1",
          authorization: "Bearer at_secret",
        },
      })
    })
    const line = lines.find((l) => l.requestId === "trace-1")
    expect(line).toMatchObject({
      level: "info",
      service: "stampd-api",
      msg: "request completed",
      method: "GET",
      path: "/health",
      statusCode: 200,
    })
    expect(typeof line?.durationMs).toBe("number")
    const all = JSON.stringify(lines)
    expect(all).not.toContain("at_secret")
    expect(all).not.toContain("private")
  })
})

describe("GET /health", () => {
  it("is 200 OK/UP when the database answers", async () => {
    await withServer(buildTestApp(), async (url) => {
      const response = await fetch(`${url}/health`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: "OK", database: "UP" })
    })
  })

  it("is 503 DEGRADED/DOWN when the API runs but the database does not answer", async () => {
    await withServer(
      buildTestApp({ checkDatabase: async () => false }),
      async (url) => {
        const response = await fetch(`${url}/health`)
        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({
          status: "DEGRADED",
          database: "DOWN",
        })
      }
    )
  })
})

describe("validation → standard error body", () => {
  it("passes valid, coerced input to the handler", async () => {
    await withServer(
      buildTestApp({ modules: [probeWithValidation] }),
      async (url) => {
        const response = await fetch(
          `${url}/probe/9c8b7a6d-5e4f-4321-9abc-def012345678?year=2026`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: "Lina",
              email: "lina@demo.stampd.app",
              days: 3,
            }),
          }
        )
        expect(response.status).toBe(201)
        expect(await response.json()).toEqual({
          id: "9c8b7a6d-5e4f-4321-9abc-def012345678",
          year: 2026,
          name: "Lina",
        })
      }
    )
  })

  it("reports every problem in params, query and body as field errors", async () => {
    await withServer(
      buildTestApp({ modules: [probeWithValidation] }),
      async (url) => {
        const response = await fetch(`${url}/probe/42?year=1999`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-request-id": "v-1",
          },
          body: JSON.stringify({
            name: "",
            email: "nope",
            days: 31,
            tags: ["a", "b", "c"],
          }),
        })
        expect(response.status).toBe(422)
        expect(response.headers.get("x-request-id")).toBe("v-1")
        const body = (await response.json()) as ErrorBody
        expect(body.code).toBe("VALIDATION_FAILED")
        expect(body.message).toBe("Request validation failed")
        expect(body.fieldErrors?.map((e) => [e.field, e.code])).toEqual([
          ["id", "INVALID_FORMAT"],
          ["year", "OUT_OF_RANGE"],
          ["name", "REQUIRED"],
          ["email", "INVALID_FORMAT"],
          ["days", "OUT_OF_RANGE"],
          ["tags", "TOO_LONG"],
        ])
      }
    )
  })

  it("reports missing values as REQUIRED and wrong types as INVALID_FORMAT", async () => {
    await withServer(
      buildTestApp({ modules: [probeWithValidation] }),
      async (url) => {
        const response = await fetch(
          `${url}/probe/9c8b7a6d-5e4f-4321-9abc-def012345678`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: "x".repeat(11),
              email: "a@b.co",
              days: "3",
            }),
          }
        )
        const body = (await response.json()) as ErrorBody
        expect(body.fieldErrors?.map((e) => [e.field, e.code])).toEqual([
          ["year", "REQUIRED"],
          ["name", "TOO_LONG"],
          ["days", "INVALID_FORMAT"],
        ])
      }
    )
  })

  it("rejects a missing body as REQUIRED and malformed JSON as INVALID_FORMAT", async () => {
    await withServer(
      buildTestApp({ modules: [probeWithValidation] }),
      async (url) => {
        const path = `${url}/probe/9c8b7a6d-5e4f-4321-9abc-def012345678?year=2026`
        const missing = (await (
          await fetch(path, { method: "POST" })
        ).json()) as ErrorBody
        expect(missing.fieldErrors).toEqual([
          expect.objectContaining({ field: "body", code: "REQUIRED" }),
        ])

        const malformed = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        })
        expect(malformed.status).toBe(422)
        expect(((await malformed.json()) as ErrorBody).fieldErrors).toEqual([
          expect.objectContaining({ field: "body", code: "INVALID_FORMAT" }),
        ])
      }
    )
  })
})

describe("errors", () => {
  it("answers unknown routes with NOT_FOUND", async () => {
    await withServer(buildTestApp(), async (url) => {
      const response = await fetch(`${url}/nope`)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        code: "NOT_FOUND",
        message: "No route for GET /nope",
      })
    })
  })

  it("passes ApiErrors thrown by handlers through", async () => {
    const module = probeModule((router) =>
      router.get(
        "/probe",
        route({}, async () => {
          throw apiErrors.conflict("Request already decided")
        })
      )
    )
    await withServer(buildTestApp({ modules: [module] }), async (url) => {
      const response = await fetch(`${url}/probe`)
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({
        code: "CONFLICT",
        message: "Request already decided",
      })
    })
  })

  it("hides unexpected errors behind INTERNAL_ERROR, logs them and reports them with the request ID", async () => {
    const reporter = { captureException: vi.fn() }
    const { lines, logger } = captureLogs()
    const module = probeModule((router) =>
      router.get(
        "/probe",
        route({}, async () => {
          throw new Error(
            "E11000 duplicate key in stampd.secret_collection at /srv/app.ts:12"
          )
        })
      )
    )
    await withServer(
      buildTestApp({ modules: [module], errorReporter: reporter, logger }),
      async (url) => {
        const response = await fetch(`${url}/probe`, {
          headers: { "x-request-id": "boom-1" },
        })
        expect(response.status).toBe(500)
        const text = await response.text()
        expect(JSON.parse(text)).toEqual({
          code: "INTERNAL_ERROR",
          message: "Internal error",
        })
        expect(text).not.toMatch(/secret_collection|srv|E11000|stack/)
      }
    )
    expect(reporter.captureException).toHaveBeenCalledWith(expect.any(Error), {
      requestId: "boom-1",
      method: "GET",
      path: "/probe",
    })
    const logged = lines.find((l) => l.msg === "request failed")
    expect(logged).toMatchObject({ level: "error", requestId: "boom-1" })
    expect(JSON.stringify(logged)).toContain("secret_collection") // details stay in the logs
  })
})
