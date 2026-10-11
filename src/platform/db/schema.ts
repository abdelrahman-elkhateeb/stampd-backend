import { randomBytes, randomUUID } from "node:crypto"
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

/**
 * A time-ordered UUID (version 7): the first 48 bits are the creation time in
 * milliseconds, then a counter, so ids created in the same millisecond still
 * sort in creation order (within a server). For append-only records listed
 * by time, e.g. history, where two entries can share a timestamp.
 */
let lastMs = 0
let counter = 0
export function uuidV7(now = Date.now()): string {
  if (now <= lastMs) {
    counter += 1
    now = lastMs
  } else {
    lastMs = now
    counter = 0
  }
  const bytes = randomBytes(16)
  bytes.writeUIntBE(now, 0, 6)
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f) // version 7 + counter (high)
  bytes[7] = counter & 0xff // counter (low)
  bytes[8] = 0x80 | (bytes[8]! & 0x3f) // variant
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** A MongoDB duplicate-key error (E11000), on `field` when given. */
export function isDuplicateKey(error: unknown, field?: string): boolean {
  const e = error as { code?: number; keyPattern?: Record<string, unknown> }
  return e?.code === 11000 && (!field || Boolean(e.keyPattern?.[field]))
}

/** Text as a literal inside a MongoDB $regex. */
export const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

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
