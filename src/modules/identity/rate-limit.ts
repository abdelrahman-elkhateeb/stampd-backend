import { model, Schema } from "mongoose"

import type { Clock } from "../../platform/time/clock.ts"

/**
 * Counters for "too many attempts", stored in MongoDB so the limit holds
 * across every API server. One document per key (e.g. "login:sara@x.com");
 * MongoDB deletes it when its window ends.
 */
const attemptSchema = new Schema(
  {
    _id: { type: String, required: true },
    count: { type: Number, required: true },
    windowEndsAt: { type: Date, required: true },
  },
  { versionKey: false }
)
attemptSchema.index({ windowEndsAt: 1 }, { expireAfterSeconds: 0 })

export const AttemptModel = model("Attempt", attemptSchema)

export type Limit = { max: number; windowMs: number }

/** Login: 10 failed attempts per email in 15 minutes (Trello BE-02 AC). */
export const LOGIN_LIMIT: Limit = { max: 10, windowMs: 15 * 60 * 1000 }
/** Forgot password: 5 emails per address per hour (prevents mail bombing). */
export const RESET_REQUEST_LIMIT: Limit = { max: 5, windowMs: 60 * 60 * 1000 }

/** Seconds until the key may try again, or 0 when it is not blocked. */
export async function blockedForSeconds(
  key: string,
  limit: Limit,
  clock: Clock
): Promise<number> {
  const doc = await AttemptModel.findById(key).lean()
  const now = clock.now().getTime()
  if (!doc || doc.windowEndsAt.getTime() <= now || doc.count < limit.max) {
    return 0
  }
  return (doc.windowEndsAt.getTime() - now) / 1000
}

export async function recordAttempt(
  key: string,
  limit: Limit,
  clock: Clock
): Promise<void> {
  const now = clock.now()
  const inWindow = await AttemptModel.updateOne(
    { _id: key, windowEndsAt: { $gt: now } },
    { $inc: { count: 1 } }
  )
  if (inWindow.matchedCount === 0) {
    await AttemptModel.replaceOne(
      { _id: key },
      {
        _id: key,
        count: 1,
        windowEndsAt: new Date(now.getTime() + limit.windowMs),
      },
      { upsert: true }
    )
  }
}

export async function clearAttempts(key: string): Promise<void> {
  await AttemptModel.deleteOne({ _id: key })
}
