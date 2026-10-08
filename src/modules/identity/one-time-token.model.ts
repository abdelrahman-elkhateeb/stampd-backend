import { model, Schema } from "mongoose"

import { baseSchemaOptions, uuidId } from "../../platform/db/schema.ts"

/**
 * Single-use links: invitations (7 days) and password resets (1 hour).
 * Only the SHA-256 of the token is stored. A link becomes useless once used,
 * once it expires, or once a newer link of the same kind is issued for the
 * same person (re-issue).
 *
 * Expired documents are kept for 30 more days so an old link answers
 * "expired" (410) rather than "not found" (404); then MongoDB deletes them.
 */
export const ONE_TIME_TOKEN_KINDS = ["INVITE", "PASSWORD_RESET"] as const
export type OneTimeTokenKind = (typeof ONE_TIME_TOKEN_KINDS)[number]

const oneTimeTokenSchema = new Schema(
  {
    _id: uuidId(),
    kind: { type: String, enum: ONE_TIME_TOKEN_KINDS, required: true },
    userId: { type: String, required: true, index: true },
    companyId: { type: String, required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    deleteAfter: { type: Date, required: true },
  },
  baseSchemaOptions
)
oneTimeTokenSchema.index({ deleteAfter: 1 }, { expireAfterSeconds: 0 })

export const OneTimeTokenModel = model("OneTimeToken", oneTimeTokenSchema)
