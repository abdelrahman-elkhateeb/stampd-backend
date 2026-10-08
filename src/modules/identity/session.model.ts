import { model, Schema } from "mongoose"

import { baseSchemaOptions, uuidId } from "../../platform/db/schema.ts"

/**
 * A session is one refresh-token family: it starts at login (or signup,
 * accept-invite, reset) and every rotation adds a token to it. Revoking the
 * session ends all of its tokens at once (logout, reuse detected, password
 * reset/change, deactivation). Access tokens carry the session id and stop
 * working as soon as the session is revoked.
 *
 * These collections are looked up by token, before a tenant is known, so they
 * are not tenant-scoped; they still record companyId for audits.
 */
const sessionSchema = new Schema(
  {
    _id: uuidId(),
    userId: { type: String, required: true, index: true },
    companyId: { type: String, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: {
      type: String,
      enum: [
        "LOGOUT",
        "REFRESH_TOKEN_REUSE",
        "PASSWORD_RESET",
        "PASSWORD_CHANGED",
        "ACCOUNT_DEACTIVATED",
      ],
    },
  },
  baseSchemaOptions
)

export const SessionModel = model("Session", sessionSchema)

const refreshTokenSchema = new Schema(
  {
    _id: uuidId(),
    sessionId: { type: String, required: true, index: true },
    userId: { type: String, required: true },
    companyId: { type: String, required: true },
    /** SHA-256 of the token; the token itself is never stored. */
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    /** Set when this token was exchanged for a new pair. */
    rotatedAt: { type: Date, default: null },
    /** The token that replaced this one (used to rebuild the same pair in the grace window). */
    replacedById: { type: String, default: null },
    /** When the replacement pair was issued, in seconds (rebuilds the identical access token). */
    replacementIssuedAt: { type: Number, default: null },
  },
  baseSchemaOptions
)
// MongoDB deletes expired refresh tokens by itself.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const RefreshTokenModel = model("RefreshToken", refreshTokenSchema)
