import { withTransaction } from "../../platform/db/connection.ts"
import { withoutTenantScope } from "../../platform/db/tenant.ts"
import { apiErrors } from "../../platform/http/errors.ts"
import type { Clock } from "../../platform/time/clock.ts"
import type { PlainDate } from "../../platform/time/time.ts"
import { recordHistory } from "../history/history.service.ts"
import { loadCompanyToday } from "../organization/calendar.ts"
import { revokeUserSessions } from "./sessions.ts"
import {
  normalizeEmail,
  UserModel,
  type Locale,
  type Role,
  type UserStatus,
} from "./user.model.ts"

/**
 * Login accounts as the employee module (organization, BE-06) sees them:
 * email, role, status and offboarding. These functions only write; the
 * caller wraps them in a transaction and records history.
 */
export function isDuplicateEmail(error: unknown): boolean {
  const e = error as { code?: number; keyPattern?: Record<string, unknown> }
  return e?.code === 11000 && Boolean(e.keyPattern?.email)
}

export const emailTaken = () =>
  apiErrors.fieldError("email", "ALREADY_EXISTS", "email is already registered")

export type Account = {
  id: string
  email: string
  role: Role
  status: UserStatus
  locale: Locale
  lastWorkingDay: PlainDate | null
  /** false for invited accounts that never set a password */
  hasPassword: boolean
}

type AccountDoc = {
  _id: string
  email: string
  role: string
  status: string
  locale?: string | null
  lastWorkingDay?: string | null
  passwordHash?: string | null
}

const toAccount = (user: AccountDoc): Account => ({
  id: user._id,
  email: user.email,
  role: user.role as Role,
  status: user.status as UserStatus,
  locale: (user.locale ?? "en") as Locale,
  lastWorkingDay: user.lastWorkingDay ?? null,
  hasPassword: Boolean(user.passwordHash),
})

export async function getAccounts(input: {
  companyId: string
  ids: string[]
}): Promise<Map<string, Account>> {
  const users = await UserModel.find({
    companyId: input.companyId,
    _id: { $in: input.ids },
  })
    .select("+passwordHash")
    .lean()
  return new Map(users.map((user) => [user._id, toAccount(user)]))
}

export async function getAccount(input: {
  companyId: string
  id: string
}): Promise<Account | undefined> {
  return (
    await getAccounts({ companyId: input.companyId, ids: [input.id] })
  ).get(input.id)
}

/** Ids of accounts matching a role/status filter (for the employee list). */
export async function findAccountIds(input: {
  companyId: string
  roles?: Role[]
  statuses?: UserStatus[]
  emailContains?: string
}): Promise<string[]> {
  const escaped = input.emailContains?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const users = await UserModel.find(
    {
      companyId: input.companyId,
      ...(input.roles ? { role: { $in: input.roles } } : {}),
      ...(input.statuses ? { status: { $in: input.statuses } } : {}),
      ...(escaped ? { email: { $regex: escaped, $options: "i" } } : {}),
    },
    { _id: 1 }
  ).lean()
  return users.map((user) => user._id)
}

export async function countActiveAdmins(companyId: string): Promise<number> {
  return UserModel.countDocuments({
    companyId,
    role: "ADMIN",
    status: { $ne: "DEACTIVATED" },
  })
}

/** A new INVITED account (no password). 422 email ALREADY_EXISTS when taken. */
export async function createInvitedAccount(input: {
  id: string
  companyId: string
  email: string
  role: Role
  locale: Locale
}): Promise<void> {
  try {
    await UserModel.create([
      {
        _id: input.id,
        companyId: input.companyId,
        email: normalizeEmail(input.email),
        role: input.role,
        status: "INVITED",
        locale: input.locale,
      },
    ])
  } catch (error) {
    if (isDuplicateEmail(error)) throw emailTaken()
    throw error
  }
}

export async function isEmailTaken(email: string): Promise<boolean> {
  // Cross-tenant on purpose: emails are unique platform-wide.
  return Boolean(
    await withoutTenantScope(
      UserModel.findOne({ email: normalizeEmail(email) }, { _id: 1 })
    ).lean()
  )
}

/** Changes email and/or role. 422 email ALREADY_EXISTS when taken. */
export async function updateAccount(input: {
  id: string
  companyId: string
  email?: string
  role?: Role
}): Promise<void> {
  try {
    await UserModel.updateOne(
      { _id: input.id, companyId: input.companyId },
      {
        $set: {
          ...(input.email ? { email: normalizeEmail(input.email) } : {}),
          ...(input.role ? { role: input.role } : {}),
        },
      },
      { runValidators: true }
    )
  } catch (error) {
    if (isDuplicateEmail(error)) throw emailTaken()
    throw error
  }
}

/**
 * Offboarding: sets the last working day. When that day is already over,
 * the account is deactivated now and its sessions end; otherwise it stays
 * usable until the day passes. Returns the resulting status.
 */
export async function setLastWorkingDay(input: {
  id: string
  companyId: string
  lastWorkingDay: PlainDate
  today: PlainDate
}): Promise<UserStatus> {
  const over = input.lastWorkingDay < input.today
  await UserModel.updateOne(
    { _id: input.id, companyId: input.companyId },
    {
      $set: {
        lastWorkingDay: input.lastWorkingDay,
        ...(over ? { status: "DEACTIVATED" } : {}),
      },
    }
  )
  if (over) await revokeUserSessions(input.id, "ACCOUNT_DEACTIVATED")
  const account = await getAccount(input)
  return account!.status
}

/** Reactivation: ACTIVE again (INVITED if they never set a password). */
export async function reactivateAccount(input: {
  id: string
  companyId: string
}): Promise<UserStatus> {
  const account = await getAccount(input)
  const status: UserStatus = account?.hasPassword ? "ACTIVE" : "INVITED"
  await UserModel.updateOne(
    { _id: input.id, companyId: input.companyId },
    { $set: { status, lastWorkingDay: null } }
  )
  return status
}

/**
 * Applies a scheduled deactivation whose last working day is over: the
 * account becomes DEACTIVATED, its sessions end, and history records it
 * (actor "system"). Login, refresh and every authenticated request call
 * this, so access ends right after the last working day. Returns the
 * up-to-date status.
 */
export async function settleAccountStatus(
  user: {
    _id: string
    companyId: string
    status: string
    lastWorkingDay?: string | null
  },
  deps: { clock: Clock }
): Promise<UserStatus> {
  const status = user.status as UserStatus
  if (status !== "ACTIVE" || !user.lastWorkingDay) return status
  const today = await loadCompanyToday(user.companyId, deps.clock.now())
  if (!today || today <= user.lastWorkingDay) return status

  await withTransaction(async () => {
    const changed = await UserModel.updateOne(
      { _id: user._id, companyId: user.companyId, status: "ACTIVE" },
      { $set: { status: "DEACTIVATED" } }
    )
    if (changed.modifiedCount === 0) return // another request did it
    await revokeUserSessions(user._id, "ACCOUNT_DEACTIVATED")
    await recordHistory(
      {
        companyId: user.companyId,
        action: "employee.statusChanged",
        entityId: user._id,
        subjectEmployeeId: user._id,
        actor: { type: "SYSTEM", job: "offboarding.lastWorkingDayPassed" },
        before: { status: "ACTIVE" },
        after: { status: "DEACTIVATED" },
      },
      deps
    )
  })
  return "DEACTIVATED"
}

/** The id of the company's account with this exact email, if any. */
export async function findAccountIdByEmail(input: {
  companyId: string
  email: string
}): Promise<string | undefined> {
  const user = await UserModel.findOne(
    { companyId: input.companyId, email: normalizeEmail(input.email) },
    { _id: 1 }
  ).lean()
  return user?._id
}
