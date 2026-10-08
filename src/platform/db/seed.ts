import {
  issueInvitation,
  type AuthDeps,
} from "../../modules/identity/auth.service.ts"
import { hashPassword } from "../../modules/identity/passwords.ts"
import {
  UserModel,
  type Locale,
  type Role,
  type UserStatus,
} from "../../modules/identity/user.model.ts"
import {
  CompanyModel,
  DEFAULT_WORKING_DAYS,
} from "../../modules/organization/company.model.ts"
import { EmployeeModel } from "../../modules/organization/employee.model.ts"

/**
 * Demo data for local, test and staging; never production (seed-cli refuses).
 * The company and accounts match the frontend's mock data
 * (apps/web/mocks/data.ts: same ids, emails, roles and password), so the
 * frontend can switch from its mock to this API without new demo logins.
 */
export const DEMO_COMPANY = {
  _id: "6f1c1d1e-3c55-4f0a-9b8e-6a2f6c7d8e90",
  name: "Demo Trading Co.",
  timezone: "Asia/Riyadh",
  weekStart: "SUN",
  workingDays: [...DEFAULT_WORKING_DAYS],
}

export const DEMO_PASSWORD = "demo-password"

type DemoAccount = {
  id: string
  name: string
  email: string
  role: Role
  status: UserStatus
  locale: Locale
}

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    id: "0b6c2f0e-8d7a-4a51-9a0e-2a4f7b8c9d10",
    name: "Sara Al-Harbi",
    email: "admin@demo.stampd.app",
    role: "ADMIN",
    status: "ACTIVE",
    locale: "en",
  },
  {
    id: "5a0d7c4b-1e2f-4a3b-8c9d-0e1f2a3b4c5d",
    name: "Omar Khalid",
    email: "manager@demo.stampd.app",
    role: "MANAGER",
    status: "ACTIVE",
    locale: "ar",
  },
  {
    id: "9c8b7a6d-5e4f-4321-9abc-def012345678",
    name: "Lina Haddad",
    email: "employee@demo.stampd.app",
    role: "EMPLOYEE",
    status: "ACTIVE",
    locale: "en",
  },
  {
    id: "1d2c3b4a-5f6e-4d7c-8b9a-0f1e2d3c4b5a",
    name: "Former Employee",
    email: "deactivated@demo.stampd.app",
    role: "EMPLOYEE",
    status: "DEACTIVATED",
    locale: "en",
  },
  {
    id: "3b9f2c1d-7a6e-4f5d-9c8b-1a2b3c4d5e6f",
    name: "Noura Saleh",
    email: "invited@demo.stampd.app",
    role: "EMPLOYEE",
    status: "INVITED",
    locale: "en",
  },
]

/**
 * Idempotent: running it twice leaves the same company and accounts (demo
 * passwords are reset to DEMO_PASSWORD). With `auth`, it also issues a fresh
 * invitation for the invited account and logs its link (non-production).
 */
export async function seedDemoData(
  options: { auth?: AuthDeps } = {}
): Promise<void> {
  const { _id: companyId, ...company } = DEMO_COMPANY
  await CompanyModel.updateOne(
    { _id: companyId },
    { $set: company },
    { upsert: true, runValidators: true }
  )

  const passwordHash = await hashPassword(DEMO_PASSWORD)
  for (const account of DEMO_ACCOUNTS) {
    await EmployeeModel.updateOne(
      { _id: account.id, companyId },
      { $set: { name: account.name } },
      { upsert: true, runValidators: true }
    )
    await UserModel.updateOne(
      { _id: account.id, companyId },
      {
        $set: {
          email: account.email,
          role: account.role,
          status: account.status,
          locale: account.locale,
          ...(account.status === "INVITED" ? {} : { passwordHash }),
        },
        ...(account.status === "INVITED"
          ? { $unset: { passwordHash: 1 } }
          : {}),
      },
      { upsert: true, runValidators: true }
    )
  }

  const invited = DEMO_ACCOUNTS.find((a) => a.status === "INVITED")
  if (options.auth && invited) {
    await issueInvitation({ id: invited.id, companyId }, options.auth)
  }
}
