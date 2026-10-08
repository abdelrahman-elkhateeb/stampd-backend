import { z } from "zod"

import { isTimeZone } from "../../platform/time/time.ts"
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./passwords.ts"
import { LOCALES } from "./user.model.ts"

/**
 * Request bodies of the identity endpoints (documented on Trello BE-02).
 * Length rules live here; the full password rule (common passwords, name and
 * email) runs in auth.service.ts because it needs the person's name/email.
 */
const email = z.email().max(254)
const password = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH)
const personName = z.string().trim().min(1).max(120)
const token = z.string().min(1).max(512)

export const signupBody = z.object({
  companyName: z.string().trim().min(1).max(120),
  name: personName,
  email,
  password,
  timezone: z.string().refine(isTimeZone, "must be an IANA timezone"),
  /** The terms checkbox: must be true (false or missing → REQUIRED). */
  acceptTerms: z.boolean().refine((accepted) => accepted, {
    params: { code: "REQUIRED" },
    message: "terms must be accepted",
  }),
  termsVersion: z.string().trim().min(1).max(40),
  locale: z.enum(LOCALES).default("en"),
})

export const loginBody = z.object({
  email,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
})

export const refreshTokenBody = z.object({ refreshToken: token })

export const tokenBody = z.object({ token })

export const acceptInvitationBody = z.object({
  token,
  name: personName,
  password,
})

export const forgotPasswordBody = z.object({ email })

export const resetPasswordBody = z.object({ token, password })

export const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: password,
})
