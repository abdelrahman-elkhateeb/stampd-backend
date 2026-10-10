/**
 * Serverless entry point (Vercel): the same Express app as server.ts, as one
 * request handler. api/index.js exports createServerlessHandler() and
 * vercel.json sends every path to it.
 *
 * Differences from server.ts:
 *  - no listen(): the platform calls the handler for each request;
 *  - MongoDB connects on the first request of an instance and stays open
 *    for the next ones (ensureDatabase), with a small pool per instance;
 *  - no in-process timers: Vercel Cron calls GET /jobs/{name} instead
 *    (needs CRON_SECRET; see vercel.json).
 *
 * When MongoDB can't be reached the request still runs: GET /health answers
 * 503 DEGRADED, and routes that need the database fail with 500.
 */
import type { IncomingMessage, ServerResponse } from "node:http"

import { createApp } from "./app.ts"
import { loadConfig } from "./config/env.ts"
import { ensureDatabase, pingDatabase } from "./platform/db/connection.ts"
import { createLogger } from "./platform/logging/logger.ts"

/** Connections per function instance; many instances can run at once. */
export const SERVERLESS_POOL_SIZE = 5

export type ServerlessHandler = (
  req: IncomingMessage,
  res: ServerResponse
) => Promise<void>

export function createServerlessHandler(
  env?: Record<string, string | undefined>
): ServerlessHandler {
  const config = loadConfig(env)
  const logger = createLogger({
    level: config.logLevel,
    base: { service: "stampd-api", env: config.appEnv },
  })
  const app = createApp({ config, logger, checkDatabase: () => pingDatabase() })
  return async (req, res) => {
    try {
      await ensureDatabase(config.mongodbUri, {
        maxPoolSize: SERVERLESS_POOL_SIZE,
      })
    } catch (error) {
      logger.error("database connection failed", { error })
    }
    // Resolve once the response is sent (or the client went away).
    await new Promise<void>((resolve) => {
      res.once("finish", resolve)
      res.once("close", resolve)
      app(req, res)
    })
  }
}
