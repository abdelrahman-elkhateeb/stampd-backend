/** pnpm db:migrate — sync indexes and apply pending data migrations, then exit. */
import mongoose from "mongoose"

import { loadConfig } from "../../config/env.ts"
import { connectDatabase, disconnectDatabase } from "./connection.ts"
import { runMigrations } from "./migrations.ts"

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
