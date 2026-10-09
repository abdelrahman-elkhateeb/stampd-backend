import { model, Schema, type InferSchemaType } from "mongoose"

import {
  baseSchemaOptions,
  plainDateField,
  uuidId,
} from "../../platform/db/schema.ts"
import { tenantIdField, tenantScoped } from "../../platform/db/tenant.ts"

export const ROLES = ["EMPLOYEE", "MANAGER", "ADMIN"] as const
export type Role = (typeof ROLES)[number]

/** INVITED: no password yet. ACTIVE: can log in. DEACTIVATED: blocked (BE-06 offboarding). */
export const USER_STATUSES = ["INVITED", "ACTIVE", "DEACTIVATED"] as const
export type UserStatus = (typeof USER_STATUSES)[number]

export const LOCALES = ["en", "ar"] as const
export type Locale = (typeof LOCALES)[number]

/**
 * A login account. It shares its id with the person's Employee record
 * (organization module): one account per person, every user is an employee.
 * Email is unique across the whole platform (one user = one company in the MVP).
 * The password hash is never loaded unless a query asks for "+passwordHash".
 */
const userSchema = new Schema(
  {
    _id: uuidId(),
    companyId: tenantIdField(),
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      unique: true,
    },
    passwordHash: { type: String, select: false },
    role: { type: String, enum: ROLES, required: true },
    status: { type: String, enum: USER_STATUSES, required: true },
    locale: { type: String, enum: LOCALES, default: "en" },
    passwordChangedAt: { type: Date },
    /**
     * Offboarding (BE-06): the last day the person may sign in, in the
     * company calendar. After it the account becomes DEACTIVATED (see
     * settleAccountStatus in accounts.ts). Null when no offboarding is set.
     */
    lastWorkingDay: plainDateField(),
  },
  baseSchemaOptions
)
userSchema.plugin(tenantScoped)

export type User = InferSchemaType<typeof userSchema>

export const UserModel = model("User", userSchema)

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
