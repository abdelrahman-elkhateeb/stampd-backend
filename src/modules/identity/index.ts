import { Router, type Request } from "express"

import { route } from "../../platform/http/validation.ts"
import type { AppModule } from "../module.ts"
import {
  acceptInvitation,
  changePassword,
  currentUser,
  login,
  refresh,
  requestPasswordReset,
  resetPassword,
  signup,
  verifyInvitation,
  verifyPasswordReset,
} from "./auth.service.ts"
import { getAuth, requireAuth } from "./authenticate.ts"
import {
  acceptInvitationBody,
  changePasswordBody,
  forgotPasswordBody,
  loginBody,
  refreshTokenBody,
  resetPasswordBody,
  signupBody,
  tokenBody,
} from "./schemas.ts"
import { revokeByRefreshToken } from "./sessions.ts"

/**
 * The caller's IP address. Behind the hosting proxy (staging/production)
 * Express reads it from X-Forwarded-For ("trust proxy" in app.ts).
 */
const clientIp = (req: Request) =>
  req.ip ?? req.socket.remoteAddress ?? "unknown"

/**
 * Identity (BE-02): signup, login, sessions, invitations, password reset,
 * current user. The exact request/response of every endpoint is on the
 * Trello BE-02 card. Other modules protect their routes with
 * requireAuth(...) and read the caller with getAuth(req).
 */
export const identityModule: AppModule = {
  name: "identity",
  routes(deps) {
    const router = Router()
    const authDeps = {
      config: deps.config,
      logger: deps.logger,
      clock: deps.clock,
    }
    const auth = requireAuth({
      secret: deps.config.authTokenSecret,
      clock: deps.clock,
    })

    router.post(
      "/auth/signup",
      route({ body: signupBody }, async ({ body }) => ({
        status: 201,
        body: await signup(body, authDeps),
      }))
    )
    router.post(
      "/auth/login",
      route({ body: loginBody }, async ({ body, req }) => ({
        status: 200,
        body: await login(body, authDeps, clientIp(req)),
      }))
    )
    router.post(
      "/auth/refresh",
      route({ body: refreshTokenBody }, async ({ body }) => ({
        status: 200,
        body: await refresh(body.refreshToken, authDeps),
      }))
    )
    router.post(
      "/auth/logout",
      route({ body: refreshTokenBody }, async ({ body }) => {
        await revokeByRefreshToken(body.refreshToken)
        return { status: 204 }
      })
    )
    router.post(
      "/auth/invitations/verify",
      route({ body: tokenBody }, async ({ body }) => ({
        status: 200,
        body: await verifyInvitation(body.token, authDeps),
      }))
    )
    router.post(
      "/auth/invitations/accept",
      route({ body: acceptInvitationBody }, async ({ body }) => ({
        status: 200,
        body: await acceptInvitation(body, authDeps),
      }))
    )
    router.post(
      "/auth/password/forgot",
      route({ body: forgotPasswordBody }, async ({ body }) => {
        await requestPasswordReset(body, authDeps)
        return { status: 202 }
      })
    )
    router.post(
      "/auth/password/reset/verify",
      route({ body: tokenBody }, async ({ body }) => {
        await verifyPasswordReset(body.token, authDeps)
        return { status: 204 }
      })
    )
    router.post(
      "/auth/password/reset",
      route({ body: resetPasswordBody }, async ({ body }) => ({
        status: 200,
        body: await resetPassword(body, authDeps),
      }))
    )

    router.get(
      "/me",
      auth,
      route({}, async ({ req }) => ({
        status: 200,
        body: await currentUser(getAuth(req)),
      }))
    )
    router.post(
      "/me/password",
      auth,
      route({ body: changePasswordBody }, async ({ req, body }) => {
        await changePassword(body, getAuth(req), authDeps, clientIp(req))
        return { status: 204 }
      })
    )
    return router
  },
}
