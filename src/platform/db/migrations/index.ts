import type { Migration } from "../migrations.ts"
import { defaultLeaveTypes } from "./2026-10-10-default-leave-types.ts"

/**
 * Data migrations, applied in this order, each once. Add a file per
 * migration and list it here:
 *
 *   // 2026-10-20-backfill-department-ids.ts
 *   export const backfillDepartmentIds: Migration = {
 *     id: "2026-10-20-backfill-department-ids",
 *     async up(connection) { await connection.collection("employees").updateMany(…) },
 *   }
 *
 * Never edit or remove a migration that has run anywhere; add a new one.
 */
export const MIGRATIONS: readonly Migration[] = [defaultLeaveTypes]
