/** pnpm db:seed — demo company and accounts (idempotent). Refused in production. */
import { loadConfig } from "../../config/env.ts"
import { createLogger } from "../logging/logger.ts"
import { systemClock } from "../time/clock.ts"
import { connectDatabase, disconnectDatabase } from "./connection.ts"
import {
  DEMO_ACCOUNTS,
  DEMO_COMPANY,
  DEMO_PASSWORD,
  seedDemoData,
} from "./seed.ts"

const config = loadConfig()
if (config.appEnv === "production") {
  console.error("Refusing to seed demo data with APP_ENV=production.")
  process.exit(1)
}

const logger = createLogger({ level: "info", base: { service: "stampd-seed" } })
try {
  await connectDatabase(config.mongodbUri)
  await seedDemoData({ auth: { config, logger, clock: systemClock } })
  console.log(
    `Seeded "${DEMO_COMPANY.name}" (${DEMO_COMPANY._id}) with demo accounts:`
  )
  for (const a of DEMO_ACCOUNTS) {
    console.log(`  ${a.email.padEnd(30)} ${a.role.padEnd(9)} ${a.status}`)
  }
  console.log(
    `Password for active accounts: ${DEMO_PASSWORD} (the invite link is in the log line above)`
  )
} catch (error) {
  console.error("Seed failed:", error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await disconnectDatabase()
}
