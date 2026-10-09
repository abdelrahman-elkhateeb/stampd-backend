/**
 * Process entry point: config → logger → app → listen → connect to MongoDB.
 *
 * The HTTP server starts even when MongoDB is unreachable, and keeps retrying
 * the connection in the background, so GET /health can report DEGRADED
 * instead of the process crash-looping.
 */
import { createApp } from "./app.ts"
import { ConfigError, loadConfig, type Config } from "./config/env.ts"
import {
  connectDatabase,
  disconnectDatabase,
  pingDatabase,
} from "./platform/db/connection.ts"
import { startJobs } from "./platform/jobs.ts"
import { createLogger } from "./platform/logging/logger.ts"
import { MODULES } from "./modules/index.ts"
import { systemClock } from "./platform/time/clock.ts"

let config: Config
try {
  config = loadConfig()
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message)
    process.exit(1)
  }
  throw error
}

const logger = createLogger({
  level: config.logLevel,
  base: { service: "stampd-api", env: config.appEnv },
})

const app = createApp({ config, logger, checkDatabase: () => pingDatabase() })
const server = app.listen(config.port, config.host, () => {
  logger.info("server listening", { host: config.host, port: config.port })
})

let stopping = false
let stopJobs = () => {}
async function connectWithRetry(): Promise<void> {
  while (!stopping) {
    try {
      await connectDatabase(config.mongodbUri)
      logger.info("database connected")
      const deps = {
        config,
        logger,
        checkDatabase: () => pingDatabase(),
        clock: systemClock,
      }
      stopJobs = startJobs(
        MODULES.flatMap((module) => module.jobs?.(deps) ?? []),
        logger
      )
      return
    } catch (error) {
      logger.error("database connection failed; retrying in 5 s", { error })
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    }
  }
}
void connectWithRetry()

async function shutdown(signal: string) {
  stopping = true
  stopJobs()
  logger.info("shutting down", { signal })
  server.close()
  await disconnectDatabase()
  process.exit(0)
}
process.once("SIGINT", () => void shutdown("SIGINT"))
process.once("SIGTERM", () => void shutdown("SIGTERM"))
