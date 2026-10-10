/**
 * Serverless entry point (Vercel): the same Express app as server.ts, split
 * into one function per domain module. api/<module>.js exports
 * createServerlessHandler("<module>"), which mounts only that module's routes,
 * and the rewrites in vercel.json send each path prefix to its function.
 * The "system" function also has the scheduled-job routes and receives every
 * other path, so unknown paths get the standard 404.
 *
 * Every function still loads all modules (they register request types and
 * hooks on each other when imported); only the mounted routes differ.
 *
 * Differences from server.ts:
 *  - no listen(): the platform calls the handler for each request;
 *  - MongoDB connects on the first request of an instance and stays open
 *    for the next ones (ensureDatabase); keep the pool small with
 *    maxPoolSize in MONGODB_URI, every function has its own instances and
 *    each instance its own pool;
 *  - no in-process timers: Vercel Cron calls GET /jobs/{name} instead
 *    (needs CRON_SECRET; see vercel.json).
 *
 * When MongoDB can't be reached the request still runs: GET /health answers
 * 503 DEGRADED, and routes that need the database fail with 500.
 */
import type { IncomingMessage, ServerResponse } from "node:http"

import { createApp } from "./app.ts"
import { loadConfig } from "./config/env.ts"
import { MODULES } from "./modules/index.ts"
import { ensureDatabase, pingDatabase } from "./platform/db/connection.ts"
import { createLogger } from "./platform/logging/logger.ts"

export type ServerlessHandler = (
  req: IncomingMessage,
  res: ServerResponse
) => Promise<void>

/** @param name the module this function serves (its name in src/modules) */
export function createServerlessHandler(
  name: string,
  env?: Record<string, string | undefined>
): ServerlessHandler {
  if (!MODULES.some((module) => module.name === name)) {
    throw new Error(`No module named "${name}"`)
  }
  const config = loadConfig(env)
  const logger = createLogger({
    level: config.logLevel,
    base: { service: "stampd-api", env: config.appEnv, function: name },
  })
  const app = createApp({
    config,
    logger,
    checkDatabase: () => pingDatabase(),
    only: name === "system" ? ["system", "jobs"] : [name],
  })
  return async (req, res) => {
    try {
      await ensureDatabase(config.mongodbUri)
    } catch (error) {
      logger.error("database connection failed", { error })
    }
    app(req, res)
  }
}
