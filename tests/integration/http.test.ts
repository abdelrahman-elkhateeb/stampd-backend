import { Router } from "express"
import mongoose from "mongoose"
import { describe, expect, inject, it } from "vitest"
import { z } from "zod"

import { MODULES } from "../../src/modules/index.ts"
import type { AppModule } from "../../src/modules/module.ts"
import { CompanyModel } from "../../src/modules/organization/company.model.ts"
import {
  connectDatabase,
  pingDatabase,
} from "../../src/platform/db/connection.ts"
import { DEMO_COMPANY } from "../../src/platform/db/seed.ts"
import { apiErrors, type ErrorBody } from "../../src/platform/http/errors.ts"
import { route } from "../../src/platform/http/validation.ts"
import { buildTestApp, withServer } from "../helpers.ts"
import { useTestDatabase } from "./database.ts"

useTestDatabase()

/**
 * Stands in for a future endpoint so the whole pipeline (request ID →
 * validation → handler → MongoDB → response) runs against the real database
 * before any business endpoint exists. Test-only.
 */
const probeModule: AppModule = {
  name: "probe",
  routes: () => {
    const router = Router()
    router.get(
      "/probe/companies/:companyId",
      route(
        { params: z.object({ companyId: z.uuid() }) },
        async ({ params }) => {
          const company = await CompanyModel.findById(params.companyId)
          if (!company) throw apiErrors.notFound("Company not found")
          return { status: 200, body: company.toJSON() }
        }
      )
    )
    return router
  },
}

const app = () =>
  buildTestApp({
    checkDatabase: () => pingDatabase(),
    modules: [...MODULES, probeModule],
  })

describe("a request that reaches the database", () => {
  it("validates, reads MongoDB and returns JSON with the request ID", async () => {
    await withServer(app(), async (url) => {
      const response = await fetch(
        `${url}/probe/companies/${DEMO_COMPANY._id}`,
        {
          headers: { "x-request-id": "it-1" },
        }
      )
      expect(response.status).toBe(200)
      expect(response.headers.get("x-request-id")).toBe("it-1")
      expect(await response.json()).toMatchObject({
        id: DEMO_COMPANY._id,
        name: DEMO_COMPANY.name,
        timezone: DEMO_COMPANY.timezone,
        createdAt: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
        ),
      })
    })
  })

  it("returns NOT_FOUND for a valid id that doesn't exist", async () => {
    await withServer(app(), async (url) => {
      const response = await fetch(
        `${url}/probe/companies/9c8b7a6d-5e4f-4321-9abc-def012345678`
      )
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        code: "NOT_FOUND",
        message: "Company not found",
      })
    })
  })

  it("rejects invalid input with the standard body before touching the database", async () => {
    await withServer(app(), async (url) => {
      const response = await fetch(`${url}/probe/companies/42`, {
        headers: { "x-request-id": "it-2" },
      })
      expect(response.status).toBe(422)
      expect(response.headers.get("x-request-id")).toBe("it-2")
      expect((await response.json()) as ErrorBody).toEqual({
        code: "VALIDATION_FAILED",
        message: "Request validation failed",
        fieldErrors: [
          {
            field: "companyId",
            code: "INVALID_FORMAT",
            message: expect.any(String),
          },
        ],
      })
    })
  })
})

describe("GET /health against the real database", () => {
  it("is 200 OK/UP while MongoDB answers", async () => {
    await withServer(app(), async (url) => {
      const response = await fetch(`${url}/health`)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: "OK", database: "UP" })
    })
  })

  it("is 503 DEGRADED/DOWN when the connection is gone, and recovers", async () => {
    await mongoose.disconnect()
    await withServer(app(), async (url) => {
      const response = await fetch(`${url}/health`)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        status: "DEGRADED",
        database: "DOWN",
      })
    })
    await connectDatabase(inject("mongoUri"))
    await withServer(app(), async (url) => {
      expect((await fetch(`${url}/health`)).status).toBe(200)
    })
  })
})
