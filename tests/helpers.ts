import type { AddressInfo } from "node:net"
import type { Express } from "express"

import { createApp, type CreateAppOptions } from "../src/app.ts"
import type { Config } from "../src/config/env.ts"
import { createLogger, type LogFields } from "../src/platform/logging/logger.ts"

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    appEnv: "test",
    port: 0,
    host: "127.0.0.1",
    mongodbUri: "mongodb://127.0.0.1:27017/stampd_test",
    logLevel: "silent",
    ...overrides,
  }
}

/** A logger that keeps its JSON lines in memory. */
export function captureLogs() {
  const lines: LogFields[] = []
  const logger = createLogger({
    level: "debug",
    base: { service: "stampd-api", env: "test" },
    write: (line) => lines.push(JSON.parse(line) as LogFields),
  })
  return { lines, logger }
}

export function buildTestApp(options: Partial<CreateAppOptions> = {}): Express {
  return createApp({
    config: testConfig(),
    logger: createLogger({ level: "silent" }),
    checkDatabase: async () => true,
    ...options,
  })
}

/** Starts the app on a random local port for the duration of `run`. */
export async function withServer<T>(
  app: Express,
  run: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server = app.listen(0, "127.0.0.1")
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const { port } = server.address() as AddressInfo
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
