import mongoose from "mongoose"
import { afterAll, beforeAll, inject } from "vitest"

import {
  connectDatabase,
  disconnectDatabase,
} from "../../src/platform/db/connection.ts"
import { runMigrations } from "../../src/platform/db/migrations.ts"
import { seedDemoData } from "../../src/platform/db/seed.ts"

/**
 * Gives a test file a fresh, real database built the way every environment
 * builds it: drop → migrations (indexes) → demo seed. Deterministic: each file
 * starts from the same state.
 */
export function useTestDatabase() {
  beforeAll(async () => {
    await connectDatabase(inject("mongoUri"))
    await mongoose.connection.dropDatabase()
    await runMigrations(mongoose.connection)
    await seedDemoData()
  })
  afterAll(async () => {
    await disconnectDatabase()
  })
}
