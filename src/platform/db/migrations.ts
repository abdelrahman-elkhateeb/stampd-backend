import type mongoose from "mongoose"

import "./models.ts"
import { MIGRATIONS } from "./migrations/index.ts"

/**
 * MongoDB has no schema migrations, but two things still need a controlled,
 * repeatable step before the app serves traffic:
 *
 *  1. Indexes: declared on the Mongoose models (unique emails, tenant scopes…)
 *     and created or updated here with syncIndexes() for every model.
 *  2. Data migrations: one-off changes to existing documents (backfills,
 *     renames). Each is a { id, up } in src/platform/db/migrations/, applied
 *     once, in order, and recorded in the `migrations` collection.
 *
 * Run by `pnpm db:migrate` and by the container before the API starts.
 */
export type Migration = {
  /** Unique and sortable, e.g. "2026-10-20-backfill-department-ids" */
  id: string
  up(connection: mongoose.Connection): Promise<void>
}

export type MigrationReport = { indexedModels: string[]; applied: string[] }

export async function runMigrations(
  connection: mongoose.Connection,
  migrations: readonly Migration[] = MIGRATIONS
): Promise<MigrationReport> {
  const indexedModels: string[] = []
  for (const model of Object.values(connection.models)) {
    await model.syncIndexes()
    indexedModels.push(model.modelName)
  }

  const ids = migrations.map((m) => m.id)
  if (new Set(ids).size !== ids.length) {
    throw new Error("Migration ids must be unique")
  }

  const log = connection.collection<{ _id: string; appliedAt: Date }>(
    "migrations"
  )
  const done = new Set((await log.find().toArray()).map((doc) => doc._id))
  const applied: string[] = []
  for (const migration of migrations) {
    if (done.has(migration.id)) continue
    await migration.up(connection)
    await log.insertOne({ _id: migration.id, appliedAt: new Date() })
    applied.push(migration.id)
  }
  return { indexedModels, applied }
}
