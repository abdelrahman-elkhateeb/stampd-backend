import { randomUUID } from "node:crypto"

import type { Config } from "../../config/env.ts"
import { withTransaction } from "../../platform/db/connection.ts"
import { withoutTenantScope } from "../../platform/db/tenant.ts"
import { apiErrors } from "../../platform/http/errors.ts"
import type { Logger } from "../../platform/logging/logger.ts"
import type { Clock } from "../../platform/time/clock.ts"
import { recordHistory } from "../history/history.service.ts"
import {
  createCompany,
  createEmployee,
  getCompanyBasics,
  getEmployeeName,
  renameEmployee,
  type CompanyBasics,
} from "../organization/organization.service.ts"
import {
  OneTimeTokenModel,
  type OneTimeTokenKind,
} from "./one-time-token.model.ts"
import {
  burnPasswordCheck,
  hashPassword,
  passwordProblem,
  verifyPassword,
} from "./passwords.ts"
import {
  blockedForSeconds,
  clearAttempts,
  clearLoginAttemptsForEmail,
  loginKey,
  LOGIN_LIMIT,
  recordAttempt,
  RESET_REQUEST_LIMIT,
} from "./rate-limit.ts"
import {
  refreshSession,
  revokeUserSessions,
  startSession,
  type AuthTokens,
} from "./sessions.ts"
import {
  emailTaken,
  isDuplicateEmail,
  settleAccountStatus,
} from "./accounts.ts"
import { hashToken, randomToken } from "./tokens.ts"
import {
  normalizeEmail,
  UserModel,
  type Locale,
  type Role,
  type UserStatus,
} from "./user.model.ts"

export type AuthDeps = { config: Config; logger: Logger; clock: Clock }

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000
const KEEP_EXPIRED_TOKENS_MS = 30 * 24 * 60 * 60 * 1000

const sessionDeps = (deps: AuthDeps) => ({
  secret: deps.config.authTokenSecret,
  clock: deps.clock,
})

function assertPassword(
  password: string,
  person: { name?: string; email?: string },
  field = "password"
) {
  const problem = passwordProblem(password, person)
  if (problem) {
    throw apiErrors.fieldError(
      field,
      problem,
      `${field} does not meet the password rules`
    )
  }
}

/** Duplicate key on users.email (a parallel signup won the race). */
// ─────────────────────────── signup ───────────────────────────

export async function signup(
  input: {
    companyName: string
    name: string
    email: string
    password: string
    timezone: string
    termsVersion: string
    locale: Locale
  },
  deps: AuthDeps
): Promise<AuthTokens> {
  const email = normalizeEmail(input.email)
  assertPassword(input.password, { name: input.name, email })

  // Email is unique platform-wide; checking before the transaction gives a
  // clean field error, and the unique index catches a parallel signup.
  // Cross-tenant on purpose: no company exists yet.
  if (await withoutTenantScope(UserModel.exists({ email }))) throw emailTaken()

  const passwordHash = await hashPassword(input.password)
  const companyId = randomUUID()
  const userId = randomUUID()
  try {
    // All or nothing: a failure leaves no half-created company.
    return await withTransaction(async () => {
      await createCompany({
        id: companyId,
        name: input.companyName,
        timezone: input.timezone,
        termsVersion: input.termsVersion,
        termsAcceptedAt: deps.clock.now(),
        termsAcceptedBy: userId,
      })
      await UserModel.create([
        {
          _id: userId,
          companyId,
          email,
          passwordHash,
          role: "ADMIN",
          status: "ACTIVE",
          locale: input.locale,
          passwordChangedAt: deps.clock.now(),
        },
      ])
      // One account per person: the Admin is also an employee (same id).
      await createEmployee({ id: userId, companyId, name: input.name })
      return startSession({ userId, companyId }, sessionDeps(deps))
    })
  } catch (error) {
    if (isDuplicateEmail(error)) throw emailTaken()
    throw error
  }
}

// ─────────────────────────── login / refresh ───────────────────────────

export async function login(
  input: { email: string; password: string },
  deps: AuthDeps,
  /** The caller's IP: failed attempts are counted per email + IP. */
  ip: string
): Promise<AuthTokens> {
  const email = normalizeEmail(input.email)
  const limitKey = loginKey(email, ip)
  const wait = await blockedForSeconds(limitKey, LOGIN_LIMIT, deps.clock)
  if (wait > 0) throw apiErrors.tooManyAttempts(wait)

  // Cross-tenant on purpose: the email identifies the company.
  const user = await withoutTenantScope(
    UserModel.findOne({ email }).select("+passwordHash")
  )
  let passwordOk = false
  if (user?.passwordHash) {
    passwordOk = await verifyPassword(input.password, user.passwordHash)
  } else {
    await burnPasswordCheck(input.password) // same timing as a real check
  }

  if (!user || !passwordOk || user.status === "INVITED") {
    await recordAttempt(limitKey, LOGIN_LIMIT, deps.clock)
    throw apiErrors.invalidCredentials()
  }
  // Only revealed after a correct password, so it can't be used to probe emails.
  const status = await settleAccountStatus(user, deps)
  if (status === "DEACTIVATED") throw apiErrors.accountDeactivated()

  await clearAttempts(limitKey)
  return startSession(
    { userId: user._id, companyId: user.companyId },
    sessionDeps(deps)
  )
}

export async function refresh(
  refreshToken: string,
  deps: AuthDeps
): Promise<AuthTokens> {
  return refreshSession(refreshToken, sessionDeps(deps), async (owner) => {
    const user = await UserModel.findOne(
      { _id: owner.userId, companyId: owner.companyId },
      { status: 1, lastWorkingDay: 1, companyId: 1 }
    ).lean()
    const status = user ? await settleAccountStatus(user, deps) : undefined
    if (status === "ACTIVE") return
    if (status === "DEACTIVATED") {
      await revokeUserSessions(owner.userId, "ACCOUNT_DEACTIVATED")
      throw apiErrors.accountDeactivated()
    }
    throw apiErrors.sessionExpired()
  })
}

// ─────────────────────────── one-time links ───────────────────────────

async function issueOneTimeToken(
  kind: OneTimeTokenKind,
  user: { id: string; companyId: string },
  ttlMs: number,
  clock: Clock
): Promise<string> {
  const now = clock.now()
  // A new link replaces any earlier unused link of the same kind.
  await OneTimeTokenModel.updateMany(
    { kind, userId: user.id, usedAt: null },
    { $set: { usedAt: now } }
  )
  const token = randomToken()
  const expiresAt = new Date(now.getTime() + ttlMs)
  await OneTimeTokenModel.create([
    {
      kind,
      userId: user.id,
      companyId: user.companyId,
      tokenHash: hashToken(token),
      expiresAt,
      deleteAfter: new Date(expiresAt.getTime() + KEEP_EXPIRED_TOKENS_MS),
    },
  ])
  return token
}

/** Finds a usable link: 404 TOKEN_INVALID when unknown or used, 410 TOKEN_EXPIRED when expired. */
async function findOneTimeToken(
  kind: OneTimeTokenKind,
  token: string,
  clock: Clock
) {
  const doc = await OneTimeTokenModel.findOne({
    kind,
    tokenHash: hashToken(token),
  })
  if (!doc || doc.usedAt) throw apiErrors.tokenInvalid()
  if (doc.expiresAt.getTime() <= clock.now().getTime())
    throw apiErrors.tokenExpired()
  return doc
}

function linkFor(
  deps: AuthDeps,
  locale: string,
  path: string,
  token: string
): string {
  return `${deps.config.webAppUrl}/${locale}/${path}/${encodeURIComponent(token)}`
}

/** Until BE-15 sends emails, links are written to the log outside production. */
function deliverLink(
  deps: AuthDeps,
  kind: "invite" | "password reset",
  to: string,
  link: string
) {
  if (deps.config.appEnv === "production") {
    deps.logger.warn(`${kind} link created; email sending arrives with BE-15`, {
      to,
    })
  } else {
    deps.logger.info(`${kind} link (logged until BE-15 sends emails)`, {
      to,
      link,
    })
  }
}

// ─────────────────────────── invitations ───────────────────────────

/**
 * Issues (or re-issues) the invitation of an INVITED user, valid 7 days.
 * BE-06 calls this when an Admin creates an employee or clicks "resend".
 * Returns the link (also logged outside production until BE-15).
 */
export async function issueInvitation(
  user: { id: string; companyId: string },
  deps: AuthDeps
): Promise<{ link: string; expiresAt: Date }> {
  const account = await UserModel.findOne(
    { _id: user.id, companyId: user.companyId },
    { email: 1, status: 1, locale: 1 }
  ).lean()
  if (!account) throw apiErrors.notFound("User not found")
  if (account.status !== "INVITED") {
    throw apiErrors.conflict("Only invited users can receive an invitation")
  }
  const token = await issueOneTimeToken(
    "INVITE",
    user,
    INVITE_TTL_MS,
    deps.clock
  )
  const link = linkFor(deps, account.locale ?? "en", "invite", token)
  deliverLink(deps, "invite", account.email, link)
  return {
    link,
    expiresAt: new Date(deps.clock.now().getTime() + INVITE_TTL_MS),
  }
}

export async function verifyInvitation(
  token: string,
  deps: AuthDeps
): Promise<{
  companyName: string
  name: string
  email: string
  expiresAt: string
}> {
  const invite = await findOneTimeToken("INVITE", token, deps.clock)
  const [user, company, name] = await Promise.all([
    UserModel.findOne({
      _id: invite.userId,
      companyId: invite.companyId,
    }).lean(),
    getCompanyBasics(invite.companyId),
    getEmployeeName({ id: invite.userId, companyId: invite.companyId }),
  ])
  if (!user || !company || user.status !== "INVITED")
    throw apiErrors.tokenInvalid()
  return {
    companyName: company.name,
    name: name ?? "",
    email: user.email,
    expiresAt: invite.expiresAt.toISOString(),
  }
}

export async function acceptInvitation(
  input: { token: string; name: string; password: string },
  deps: AuthDeps
): Promise<AuthTokens> {
  const invite = await findOneTimeToken("INVITE", input.token, deps.clock)
  const user = await UserModel.findOne({
    _id: invite.userId,
    companyId: invite.companyId,
  })
  if (!user) throw apiErrors.tokenInvalid()
  if (user.status === "DEACTIVATED") throw apiErrors.accountDeactivated()
  if (user.status !== "INVITED") throw apiErrors.tokenInvalid()
  assertPassword(input.password, { name: input.name, email: user.email })

  const passwordHash = await hashPassword(input.password)
  return withTransaction(async () => {
    const used = await OneTimeTokenModel.updateOne(
      { _id: invite._id, usedAt: null },
      { $set: { usedAt: deps.clock.now() } }
    )
    if (used.modifiedCount === 0) throw apiErrors.tokenInvalid()
    user.passwordHash = passwordHash
    user.status = "ACTIVE"
    user.passwordChangedAt = deps.clock.now()
    await user.save()
    await recordHistory(
      {
        companyId: user.companyId,
        action: "employee.statusChanged",
        entityId: user._id,
        subjectEmployeeId: user._id,
        actor: { type: "USER", userId: user._id },
        before: { status: "INVITED" },
        after: { status: "ACTIVE" },
      },
      deps
    )
    await renameEmployee({
      id: user._id,
      companyId: user.companyId,
      name: input.name,
    })
    return startSession(
      { userId: user._id, companyId: user.companyId },
      sessionDeps(deps)
    )
  })
}

// ─────────────────────────── password reset ───────────────────────────

/** Always succeeds from the caller's point of view (no account enumeration). */
export async function requestPasswordReset(
  input: { email: string },
  deps: AuthDeps
): Promise<void> {
  const email = normalizeEmail(input.email)
  const limitKey = `reset:${email}`
  if ((await blockedForSeconds(limitKey, RESET_REQUEST_LIMIT, deps.clock)) > 0)
    return
  await recordAttempt(limitKey, RESET_REQUEST_LIMIT, deps.clock)

  // Cross-tenant on purpose: the email identifies the account.
  const user = await withoutTenantScope(
    UserModel.findOne({ email }, { status: 1, locale: 1, companyId: 1 })
  ).lean()
  if (!user || user.status !== "ACTIVE") return

  const token = await issueOneTimeToken(
    "PASSWORD_RESET",
    { id: user._id, companyId: user.companyId },
    PASSWORD_RESET_TTL_MS,
    deps.clock
  )
  deliverLink(
    deps,
    "password reset",
    email,
    linkFor(deps, user.locale ?? "en", "reset-password", token)
  )
}

export async function verifyPasswordReset(
  token: string,
  deps: AuthDeps
): Promise<void> {
  await findOneTimeToken("PASSWORD_RESET", token, deps.clock)
}

export async function resetPassword(
  input: { token: string; password: string },
  deps: AuthDeps
): Promise<AuthTokens> {
  const reset = await findOneTimeToken(
    "PASSWORD_RESET",
    input.token,
    deps.clock
  )
  const user = await UserModel.findOne({
    _id: reset.userId,
    companyId: reset.companyId,
  })
  if (!user) throw apiErrors.tokenInvalid()
  if (user.status === "DEACTIVATED") throw apiErrors.accountDeactivated()
  const name = await getEmployeeName({
    id: user._id,
    companyId: user.companyId,
  })
  assertPassword(input.password, { name, email: user.email })

  const passwordHash = await hashPassword(input.password)
  return withTransaction(async () => {
    const used = await OneTimeTokenModel.updateOne(
      { _id: reset._id, usedAt: null },
      { $set: { usedAt: deps.clock.now() } }
    )
    if (used.modifiedCount === 0) throw apiErrors.tokenInvalid()
    user.passwordHash = passwordHash
    user.passwordChangedAt = deps.clock.now()
    await user.save()
    // A reset signs the user out everywhere, then starts one new session.
    await revokeUserSessions(user._id, "PASSWORD_RESET")
    await clearLoginAttemptsForEmail(user.email)
    return startSession(
      { userId: user._id, companyId: user.companyId },
      sessionDeps(deps)
    )
  })
}

// ─────────────────────────── signed-in user ───────────────────────────

export async function changePassword(
  input: { currentPassword: string; newPassword: string },
  auth: { userId: string; companyId: string; sessionId: string },
  deps: AuthDeps,
  ip: string
): Promise<void> {
  const user = await UserModel.findOne({
    _id: auth.userId,
    companyId: auth.companyId,
  }).select("+passwordHash")
  if (!user?.passwordHash) throw apiErrors.unauthenticated()

  const limitKey = loginKey(user.email, ip)
  const wait = await blockedForSeconds(limitKey, LOGIN_LIMIT, deps.clock)
  if (wait > 0) throw apiErrors.tooManyAttempts(wait)
  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    await recordAttempt(limitKey, LOGIN_LIMIT, deps.clock)
    throw apiErrors.fieldError(
      "currentPassword",
      "INCORRECT",
      "current password is incorrect"
    )
  }

  const name = await getEmployeeName({
    id: user._id,
    companyId: user.companyId,
  })
  assertPassword(input.newPassword, { name, email: user.email }, "newPassword")
  user.passwordHash = await hashPassword(input.newPassword)
  user.passwordChangedAt = deps.clock.now()
  await user.save()
  // Other sessions end; the one that made the change stays signed in.
  await revokeUserSessions(user._id, "PASSWORD_CHANGED", auth.sessionId)
}

export type CurrentUser = {
  id: string
  name: string
  email: string
  role: Role
  status: UserStatus
  locale: Locale
  employee: { id: string; name: string }
  company: CompanyBasics
}

export async function currentUser(auth: {
  userId: string
  companyId: string
}): Promise<CurrentUser> {
  const [user, name, company] = await Promise.all([
    UserModel.findOne({ _id: auth.userId, companyId: auth.companyId }).lean(),
    getEmployeeName({ id: auth.userId, companyId: auth.companyId }),
    getCompanyBasics(auth.companyId),
  ])
  if (!user || !company) throw apiErrors.unauthenticated()
  return {
    id: user._id,
    name: name ?? "",
    email: user.email,
    role: user.role as Role,
    status: user.status as UserStatus,
    locale: (user.locale ?? "en") as Locale,
    employee: { id: user._id, name: name ?? "" },
    company,
  }
}
