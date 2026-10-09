import { seedDefaultLeaveTypes } from "../../../modules/leave/leave-types.service.ts"
import type { Migration } from "../migrations.ts"

/** BE-08: companies created before leave types existed get the four defaults. */
export const defaultLeaveTypes: Migration = {
  id: "2026-10-10-default-leave-types",
  async up(connection) {
    const companies = await connection
      .collection<{ _id: string }>("companies")
      .find({}, { projection: { _id: 1 } })
      .toArray()
    for (const company of companies) await seedDefaultLeaveTypes(company._id)
  },
}
