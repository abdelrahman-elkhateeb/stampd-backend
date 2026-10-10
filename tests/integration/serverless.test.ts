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
import { vercelFunctionFor } from "../helpers.ts"
import { signupBody } from "./api.ts"

/**
 * The Vercel entry point: one request handler per module, each connecting to
 * MongoDB itself (no useTestDatabase here: the handler must connect).
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
/** Like Vercel: each request goes to the function vercel.json rewrites its path to. */
async function serve(env: Record<string, string>) {
  const functions = new Map<string, ServerlessHandler>()
  server = createServer((req, res) => {
    const name = vercelFunctionFor(req.url!.split("?")[0]!)
    if (!functions.has(name)) {
      functions.set(name, createServerlessHandler(name, env))
    }
    void functions.get(name)!(req, res)
  })
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

describe("serverless handlers", () => {
  it("a function serves only its own module", async () => {
    const identity = createServerlessHandler("identity", env())
    server = createServer((req, res) => void identity(req, res))
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve)
    )
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    expect((await fetch(`${base}/me`)).status).toBe(401)
    const health = await fetch(`${base}/health`)
    expect(health.status).toBe(404)
    expect(await health.json()).toMatchObject({ code: "NOT_FOUND" })
    expect(() => createServerlessHandler("nope", env())).toThrow()
    await disconnectDatabase()
  })

  it("still answers when MongoDB is unreachable: /health is 503", async () => {
    const base = await serve(
      env({
        MONGODB_URI:
          "mongodb://127.0.0.1:1/stampd?serverSelectionTimeoutMS=500",
      })
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
    const base = await serve(env())

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

  it("runs the real jobs through the cron route", async () => {
    const base = await serve(env())
    for (const job of ["attendance.close", "leave.rollover"]) {
      const response = await fetch(`${base}/jobs/${job}`, {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      })
      expect(response.status, job).toBe(200)
      expect(await response.json()).toMatchObject({ job })
    }
  })
})
