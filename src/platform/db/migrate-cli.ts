/**
 * pnpm db:migrate — sync indexes and apply pending data migrations, then exit.
 *
 * With --production-only (the Vercel build, "vercel-build"), it runs only for
 * production deployments: preview builds share the database and must not
 * change its indexes.
 */
import mongoose from "mongoose"

import { loadConfig, vercelEnvironment } from "../../config/env.ts"
import { connectDatabase, disconnectDatabase } from "./connection.ts"
import { runMigrations } from "./migrations.ts"

const productionOnly = process.argv.includes("--production-only")
const deployment = vercelEnvironment()
if (productionOnly && deployment !== "production") {
  console.log(
    `Migrations skipped: not a production deployment (VERCEL_ENV=${deployment ?? "unset"}).`
  )
  process.exit(0)
}
const config = loadConfig()
try {
  await connectDatabase(config.mongodbUri)
  const report = await runMigrations(mongoose.connection)
  console.log(
    `Indexes synced for ${report.indexedModels.join(", ") || "no models"}; ` +
      `${report.applied.length} migration(s) applied (APP_ENV=${config.appEnv}).`
  )
} catch (error) {
  console.error(
    "Migration failed:",
    error instanceof Error ? error.message : error
  )
  process.exitCode = 1
} finally {
  await disconnectDatabase()
}
