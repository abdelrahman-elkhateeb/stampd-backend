import type { Router } from "express"

import type { Config } from "../config/env.ts"
import type { Logger } from "../platform/logging/logger.ts"
import type { Clock } from "../platform/time/clock.ts"

/** What every module can use. Later tickets add services here (BE-02 adds the caller). */
export type AppDeps = {
  config: Config
  logger: Logger
  /** true when the database answers (platform/db/connection.ts pingDatabase) */
  checkDatabase: () => Promise<boolean>
  /** "now" for anything time-sensitive (token expiry, rate limits); tests move it */
  clock: Clock
}

/**
 * A domain module: one folder in src/modules that owns its routes, models and
 * services. app.ts mounts each module's router; modules never reach into each
 * other's models directly (they call exported functions instead).
 */
export type AppModule = {
  name: string
  /** Express router with this module's endpoints, or undefined while it has none */
  routes(deps: AppDeps): Router | undefined
}
