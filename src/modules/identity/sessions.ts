import { randomUUID } from "node:crypto"

import { apiErrors } from "../../platform/http/errors.ts"
import type { Clock } from "../../platform/time/clock.ts"
import { RefreshTokenModel, SessionModel } from "./session.model.ts"
import {
  ACCESS_TOKEN_TTL_SECONDS,
  hashToken,
  randomToken,
  REFRESH_GRACE_MS,
  REFRESH_TOKEN_TTL_MS,
  rotatedRefreshToken,
  signAccessToken,
} from "./tokens.ts"

/** The body returned by login, signup, accept-invite, reset and refresh. */
export type AuthTokens = {
  accessToken: string
  refreshToken: string
  /** Access token lifetime in seconds (900) */
  expiresIn: number
}

export type SessionDeps = { secret: string; clock: Clock }

type Owner = { userId: string; companyId: string; sessionId: string }

function accessToken(owner: Owner, issuedAt: number, secret: string): string {
  return signAccessToken(
    {
      sub: owner.userId,
      cid: owner.companyId,
      sid: owner.sessionId,
      iat: issuedAt,
      exp: issuedAt + ACCESS_TOKEN_TTL_SECONDS,
    },
    secret
  )
}

const seconds = (date: Date) => Math.floor(date.getTime() / 1000)

/** Starts a new session (token family) and returns its first token pair. */
export async function startSession(
  user: { userId: string; companyId: string },
  deps: SessionDeps
): Promise<AuthTokens> {
  const now = deps.clock.now()
  const [session] = await SessionModel.create([
    { userId: user.userId, companyId: user.companyId },
  ])
  const refreshToken = randomToken()
  await RefreshTokenModel.create([
    {
      sessionId: session!._id,
      userId: user.userId,
      companyId: user.companyId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
    },
  ])
  return {
    accessToken: accessToken(
      { ...user, sessionId: session!._id },
      seconds(now),
      deps.secret
    ),
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  }
}

/**
 * Exchanges a refresh token for a new pair.
 *  - unknown, expired or revoked → 401 SESSION_EXPIRED
 *  - already rotated, within 20 s → the same new pair again (grace window)
 *  - already rotated, after 20 s → reuse: the whole session is revoked, 401
 * `ensureUserActive` runs before any pair is issued (deactivated users are
 * refused and their session revoked).
 */
export async function refreshSession(
  presented: string,
  deps: SessionDeps,
  ensureUserActive: (owner: {
    userId: string
    companyId: string
  }) => Promise<void>
): Promise<AuthTokens> {
  const now = deps.clock.now()
  const token = await RefreshTokenModel.findOne({
    tokenHash: hashToken(presented),
  })
  if (!token || token.expiresAt.getTime() <= now.getTime()) {
    throw apiErrors.sessionExpired()
  }
  const session = await SessionModel.findById(token.sessionId)
  if (!session || session.revokedAt) throw apiErrors.sessionExpired()

  const owner: Owner = {
    userId: token.userId,
    companyId: token.companyId,
    sessionId: token.sessionId,
  }
  await ensureUserActive(owner)

  const rebuild = (replacedById: string, issuedAt: number): AuthTokens => ({
    accessToken: accessToken(owner, issuedAt, deps.secret),
    refreshToken: rotatedRefreshToken(presented, replacedById, deps.secret),
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  })

  const fromRotation = async (
    rotatedAt: Date,
    replacedById: string,
    issuedAt: number
  ) => {
    if (now.getTime() - rotatedAt.getTime() <= REFRESH_GRACE_MS) {
      return rebuild(replacedById, issuedAt)
    }
    await revokeSession(owner.sessionId, "REFRESH_TOKEN_REUSE")
    throw apiErrors.sessionExpired("Refresh token reused")
  }

  if (token.rotatedAt) {
    return fromRotation(
      token.rotatedAt,
      token.replacedById!,
      token.replacementIssuedAt!
    )
  }

  // Store the replacement first, then claim the old token atomically. If
  // another server claimed it in the meantime, drop ours and answer with the
  // winner's pair (same as the grace window).
  const nextId = randomUUID()
  const issuedAt = seconds(now)
  await RefreshTokenModel.create([
    {
      _id: nextId,
      sessionId: owner.sessionId,
      userId: owner.userId,
      companyId: owner.companyId,
      tokenHash: hashToken(rotatedRefreshToken(presented, nextId, deps.secret)),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
    },
  ])
  const claimed = await RefreshTokenModel.findOneAndUpdate(
    { _id: token._id, rotatedAt: null },
    {
      $set: {
        rotatedAt: now,
        replacedById: nextId,
        replacementIssuedAt: issuedAt,
      },
    }
  )
  if (claimed) return rebuild(nextId, issuedAt)

  await RefreshTokenModel.deleteOne({ _id: nextId })
  const winner = await RefreshTokenModel.findById(token._id)
  return fromRotation(
    winner!.rotatedAt!,
    winner!.replacedById!,
    winner!.replacementIssuedAt!
  )
}

/** Logout: ends the session the refresh token belongs to. Unknown tokens are ignored. */
export async function revokeByRefreshToken(presented: string): Promise<void> {
  const token = await RefreshTokenModel.findOne({
    tokenHash: hashToken(presented),
  })
  if (token) await revokeSession(token.sessionId, "LOGOUT")
}

export async function revokeSession(
  sessionId: string,
  reason: "LOGOUT" | "REFRESH_TOKEN_REUSE" | "ACCOUNT_DEACTIVATED"
): Promise<void> {
  await SessionModel.updateOne(
    { _id: sessionId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  )
}

/** Ends every session of a user, optionally keeping the current one. */
export async function revokeUserSessions(
  userId: string,
  reason: "PASSWORD_RESET" | "PASSWORD_CHANGED" | "ACCOUNT_DEACTIVATED",
  keepSessionId?: string
): Promise<void> {
  await SessionModel.updateMany(
    {
      userId,
      revokedAt: null,
      ...(keepSessionId ? { _id: { $ne: keepSessionId } } : {}),
    },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  )
}

export async function isSessionActive(
  sessionId: string,
  userId: string
): Promise<boolean> {
  const session = await SessionModel.findById(sessionId, {
    userId: 1,
    revokedAt: 1,
  }).lean()
  return Boolean(session && session.userId === userId && !session.revokedAt)
}
