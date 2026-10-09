import type { AddressInfo } from "node:net"
import type { Server } from "node:http"
import { afterAll, beforeAll } from "vitest"

import { createApp } from "../../src/app.ts"
import { MODULES } from "../../src/modules/index.ts"
import type { AppModule } from "../../src/modules/module.ts"
import { pingDatabase } from "../../src/platform/db/connection.ts"
import { fixedClock } from "../../src/platform/time/clock.ts"
import { captureLogs, testConfig } from "../helpers.ts"
import type { Config } from "../../src/config/env.ts"

export type ApiResponse<T = Record<string, unknown>> = {
  status: number
  body: T
  headers: Headers
}

/**
 * A real API server (real MongoDB from useTestDatabase) for one test file,
 * with a clock the tests can move and the log lines in memory.
 */
export function useApi(
  options: { modules?: AppModule[]; config?: Partial<Config> } = {}
) {
  const clock = fixedClock()
  const logs = captureLogs()
  const state: { server?: Server; url: string } = { url: "" }

  beforeAll(async () => {
    const app = createApp({
      config: testConfig(options.config),
      logger: logs.logger,
      checkDatabase: () => pingDatabase(),
      clock,
      modules: options.modules ?? MODULES,
    })
    state.server = app.listen(0, "127.0.0.1")
    await new Promise<void>((resolve) =>
      state.server!.once("listening", resolve)
    )
    state.url = `http://127.0.0.1:${(state.server!.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => state.server?.close(() => resolve()))
  })

  async function call<T = Record<string, unknown>>(
    method: string,
    path: string,
    options: { body?: unknown; token?: string } = {}
  ): Promise<ApiResponse<T>> {
    const response = await fetch(`${state.url}${path}`, {
      method,
      headers: {
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    const text = await response.text()
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : undefined) as T,
      headers: response.headers,
    }
  }

  return {
    clock,
    logs: logs.lines,
    /** The auth deps the services use, for calling them directly (e.g. issueInvitation). */
    authDeps: () => ({
      config: testConfig(options.config),
      logger: logs.logger,
      clock,
    }),
    /** Any method, e.g. request("DELETE", path, { token }) */
    request: call,
    get: <T = Record<string, unknown>>(path: string, token?: string) =>
      call<T>("GET", path, { token }),
    post: <T = Record<string, unknown>>(
      path: string,
      body?: unknown,
      token?: string
    ) => call<T>("POST", path, { body, token }),
  }
}

export type Tokens = {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

/** A fresh signup body; `overrides` change any field. */
let counter = 0
export function signupBody(overrides: Record<string, unknown> = {}) {
  counter += 1
  return {
    companyName: `Acme ${counter}`,
    name: "Hala Mansour",
    email: `owner${counter}.${Date.now()}@acme.example`,
    password: "blue-river-lantern",
    timezone: "Asia/Dubai",
    acceptTerms: true,
    termsVersion: "2026-10-01",
    locale: "en",
    ...overrides,
  }
}
