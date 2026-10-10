import express, { type Express } from "express"

import type { Config } from "./config/env.ts"
import { MODULES } from "./modules/index.ts"
import type { AppModule } from "./modules/module.ts"
import { errorHandler, notFoundHandler } from "./platform/http/error-handler.ts"
import { requestContext } from "./platform/http/request-context.ts"
import { jobsRouter } from "./platform/jobs.ts"
import type { Logger } from "./platform/logging/logger.ts"
import { systemClock, type Clock } from "./platform/time/clock.ts"

export type CreateAppOptions = {
  config: Config
  logger: Logger
  /** Health check for the database; server.ts passes pingDatabase. */
  checkDatabase: () => Promise<boolean>
  /** Defaults to every domain module (src/modules/index.ts). */
  modules?: readonly AppModule[]
  /** Defaults to the system clock; tests pass a clock they can move. */
  clock?: Clock
}

/**
 * Builds the Express app without listening, so tests run the same app.
 * Order matters:
 *   request ID + logging → JSON body parsing → module routes
 *   → scheduled-job routes (when CRON_SECRET is set)
 *   → 404 for anything else → error handler (last).
 */
export function createApp(options: CreateAppOptions): Express {
  const { config, logger } = options
  const app = express()

  app.disable("x-powered-by")
  // Behind the hosting platform's proxy in staging/production: trust it for req.ip.
  app.set(
    "trust proxy",
    config.appEnv === "staging" || config.appEnv === "production"
  )

  app.use(requestContext(logger))
  app.use(express.json({ limit: "1mb" }))

  const deps = {
    config,
    logger,
    checkDatabase: options.checkDatabase,
    clock: options.clock ?? systemClock,
  }
  const modules = options.modules ?? MODULES
  for (const module of modules) {
    const router = module.routes(deps)
    if (router) app.use(router)
  }
  // Serverless hosts run the background jobs through HTTP (Vercel Cron).
  if (config.cronSecret) {
    app.use(
      jobsRouter({
        jobs: modules.flatMap((module) => module.jobs?.(deps) ?? []),
        secret: config.cronSecret,
        logger,
      })
    )
  }

  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
