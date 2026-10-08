import { randomUUID } from "node:crypto"
import type { SchemaOptions } from "mongoose"

import { isPlainDate } from "../time/time.ts"

/**
 * Conventions every model uses, so the rules are the default path:
 *
 *  uuidId()          `_id` is a random UUID v4 string: non-sequential, and the
 *                    same ID format the frontend already uses (not ObjectId).
 *  plainDateField()  a calendar day stored as the "YYYY-MM-DD" string itself.
 *                    Strings in this format sort correctly, so range queries work.
 *  BSON Date fields  instants (timestamps). MongoDB stores them in UTC.
 *  baseSchemaOptions createdAt/updatedAt timestamps, no __v, and JSON output
 *                    with `id` instead of `_id`.
 */
export const uuidId = () => ({
  type: String,
  default: () => randomUUID(),
})

export const plainDateField = (options: { required?: boolean } = {}) => ({
  type: String,
  required: options.required ?? false,
  validate: {
    validator: (value: unknown) => value == null || isPlainDate(value),
    message: "must be a calendar day in YYYY-MM-DD format",
  },
})

export const baseSchemaOptions = {
  timestamps: true,
  versionKey: false,
  toJSON: {
    transform: (_doc: unknown, ret: Record<string, unknown>) => {
      ret.id = ret._id
      delete ret._id
      return ret
    },
  },
} satisfies SchemaOptions
