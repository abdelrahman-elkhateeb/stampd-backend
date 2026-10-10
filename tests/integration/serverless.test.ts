import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import mongoose from "mongoose"
import { afterAll, afterEach, describe, expect, inject, it } from "vitest"

import { disconnectDatabase } from "../../src/platform/db/connection.ts"
import { runMigrations } from "../../src/platform/db/migrations.ts"
import {
  createServerlessHandler,
  type ServerlessHandler,
} from "../../src/serverless.ts"
import { signupBody } from "./api.ts"

/**
 * The Vercel entry point: the same app as one request handler that connects
 * to MongoDB itself (no useTestDatabase here: the handler must connect).
 */
const CRON_SECRET = "cron-secret-0123456789abcdefghijklmnop"
const env = (overrides: Record<string, string> = {}) => ({
  APP_ENV: "test",
  MONGODB_URI: inject("mongoUri"),
  AUTH_TOKEN_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
  LOG_LEVEL: "silent",
  CRON_SECRET,
  ...overrides,
})

let server: Server | undefined
async function serve(handler: ServerlessHandler) {
  server = createServer((req, res) => void handler(req, res))
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = undefined
})
afterAll(async () => {
  await disconnectDatabase()
})

describe("serverless handler", () => {
  it("still answers when MongoDB is unreachable: /health is 503", async () => {
    const base = await serve(
      createServerlessHandler(
        env({
          MONGODB_URI:
            "mongodb://127.0.0.1:1/stampd?serverSelectionTimeoutMS=500",
        })
      )
    )
    const health = await fetch(`${base}/health`)
    expect(health.status).toBe(503)
    expect(await health.json()).toEqual({
      status: "DEGRADED",
      database: "DOWN",
    })
    await disconnectDatabase()
  })

  it("connects on the first request, reuses the connection, and serves every route", async () => {
    expect(mongoose.connection.readyState).toBe(0)
    const base = await serve(createServerlessHandler(env()))

    const health = await fetch(`${base}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: "OK", database: "UP" })
    const connection = mongoose.connection.getClient()

    // Indexes as a deployment's migration step leaves them.
    await mongoose.connection.dropDatabase()
    await runMigrations(mongoose.connection)

    // A full write path (JSON body, transaction) through the handler.
    const signup = await fetch(`${base}/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signupBody({ timezone: "Asia/Riyadh" })),
    })
    expect(signup.status).toBe(201)
    const { accessToken } = (await signup.json()) as { accessToken: string }
    const me = await fetch(`${base}/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    expect(me.status).toBe(200)
    // Still the same client: no new connection per request.
    expect(mongoose.connection.getClient()).toBe(connection)
  })

  it("runs the real jobs through the cron route, with the secret only", async () => {
    const base = await serve(createServerlessHandler(env()))
    const call = (path: string, auth?: string) =>
      fetch(`${base}${path}`, {
        headers: auth ? { authorization: auth } : {},
      })

    expect((await call("/jobs/attendance.close")).status).toBe(401)
    expect(
      (await call("/jobs/attendance.close", "Bearer wrong-secret")).status
    ).toBe(401)
    for (const job of ["attendance.close", "leave.rollover"]) {
      const response = await call(`/jobs/${job}`, `Bearer ${CRON_SECRET}`)
      expect(response.status, job).toBe(200)
      expect(await response.json()).toMatchObject({ job })
    }
    // Idempotent: running again is safe.
    expect(
      (await call("/jobs/attendance.close", `Bearer ${CRON_SECRET}`)).status
    ).toBe(200)
    expect((await call("/jobs/unknown", `Bearer ${CRON_SECRET}`)).status).toBe(
      404
    )
  })
})
