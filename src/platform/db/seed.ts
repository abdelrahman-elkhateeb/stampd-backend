import { CompanyModel } from "../../modules/organization/company.model.ts"

/**
 * Demo data for local, test and staging; never production (seed-cli refuses).
 * The demo company has the same id, name and timezone as the frontend's mock
 * data (apps/web/mocks/data.ts), so demos look the same against either API.
 * Later tickets extend this seed (BE-02 users, BE-05 settings, BE-06 employees).
 */
export const DEMO_COMPANY = {
  _id: "6f1c1d1e-3c55-4f0a-9b8e-6a2f6c7d8e90",
  name: "Demo Trading Co.",
  timezone: "Asia/Riyadh",
} as const

/** Idempotent: running it twice leaves one demo company. */
export async function seedDemoData(): Promise<void> {
  await CompanyModel.updateOne(
    { _id: DEMO_COMPANY._id },
    { $set: { name: DEMO_COMPANY.name, timezone: DEMO_COMPANY.timezone } },
    { upsert: true, runValidators: true }
  )
}
