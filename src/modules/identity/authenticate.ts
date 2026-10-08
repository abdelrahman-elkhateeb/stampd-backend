import type { Request, RequestHandler } from "express"

import { apiErrors } from "../../platform/http/errors.ts"
import type { Clock } from "../../platform/time/clock.ts"
import { isSessionActive } from "./sessions.ts"
import { verifyAccessToken } from "./tokens.ts"
import { UserModel, type Role } from "./user.model.ts"

/**
 * Who is calling. Set by requireAuth on every protected route, from the access
 * token and the database only; never from the request body, query or URL.
 * `companyId` is the tenant every query of the request must be scoped to.
 */
export type AuthContext = {
  userId: string
  companyId: string
  role: Role
  sessionId: string
}

/**
 * Protects a route: "Authorization: Bearer <access token>".
 *  - missing, malformed, expired or revoked-session token → 401 UNAUTHENTICATED
 *  - deactivated account → 403 ACCOUNT_DEACTIVATED
 * The role is read from the database on every request, so a role change by
 * an Admin applies on the next request.
 */
export function requireAuth(deps: {
  secret: string
  clock: Clock
}): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined
    const claims = token
      ? verifyAccessToken(token, deps.secret, deps.clock.now())
      : undefined
    if (!claims) throw apiErrors.unauthenticated()

    const [sessionActive, user] = await Promise.all([
      isSessionActive(claims.sid, claims.sub),
      UserModel.findOne(
        { _id: claims.sub, companyId: claims.cid },
        { role: 1, status: 1 }
      ).lean(),
    ])
    if (!sessionActive || !user) throw apiErrors.unauthenticated()
    if (user.status === "DEACTIVATED") throw apiErrors.accountDeactivated()
    if (user.status !== "ACTIVE") throw apiErrors.unauthenticated()

    req.auth = {
      userId: user._id,
      companyId: claims.cid,
      role: user.role as Role,
      sessionId: claims.sid,
    }
    req.log = req.log.child({ userId: user._id, companyId: claims.cid })
    next()
  }
}

/** The caller of a route behind requireAuth. */
export function getAuth(req: Request): AuthContext {
  if (!req.auth)
    throw new Error("getAuth() used on a route without requireAuth")
  return req.auth
}
