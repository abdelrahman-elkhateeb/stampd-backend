import type { Migration } from "../migrations.ts"

/**
 * Data migrations, applied in this order, each once. None yet: BE-01 only
 * creates indexes (from the models). Add a file per migration and list it here:
 *
 *   // 2026-10-20-backfill-department-ids.ts
 *   export const backfillDepartmentIds: Migration = {
 *     id: "2026-10-20-backfill-department-ids",
 *     async up(connection) { await connection.collection("employees").updateMany(…) },
 *   }
 *
 * Never edit or remove a migration that has run anywhere; add a new one.
 */
export const MIGRATIONS: readonly Migration[] = []
