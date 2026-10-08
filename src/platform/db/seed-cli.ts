/** pnpm db:seed — insert the demo company (idempotent). Refused in production. */
import { loadConfig } from "../../config/env.ts"
import { connectDatabase, disconnectDatabase } from "./connection.ts"
import { DEMO_COMPANY, seedDemoData } from "./seed.ts"

const config = loadConfig()
if (config.appEnv === "production") {
  console.error("Refusing to seed demo data with APP_ENV=production.")
  process.exit(1)
}

try {
  await connectDatabase(config.mongodbUri)
  await seedDemoData()
  console.log(
    `Seeded demo company "${DEMO_COMPANY.name}" (${DEMO_COMPANY._id}).`
  )
} catch (error) {
  console.error("Seed failed:", error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await disconnectDatabase()
}
