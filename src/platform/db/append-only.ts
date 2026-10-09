import type { Query, Schema } from "mongoose"

/**
 * Append-only collections (history, the leave ledger): documents are only
 * ever inserted. Every update, replace and delete throws, and so does saving
 * a loaded document again. Corrections are new entries, never edits.
 *
 * The one escape hatch is purgeAppendOnly(query), for deleting records that
 * never took effect (e.g. the allowance entries of a leave type deleted
 * before anyone used it). Every use must say why in a comment.
 */
export class AppendOnlyError extends Error {
  override readonly name = "AppendOnlyError"
  constructor(what: string) {
    super(`${what} are append-only: they can't be edited or deleted`)
  }
}

const PURGE = Symbol("purgeAppendOnly")

/** Explicitly allow one delete query on an append-only model. */
export function purgeAppendOnly<Q extends Query<unknown, unknown>>(
  query: Q
): Q {
  ;(query as unknown as Record<symbol, boolean>)[PURGE] = true
  return query
}

const UPDATES =
  /^(updateOne|updateMany|findOneAndUpdate|replaceOne|findOneAndReplace)$/
const DELETES = /^(deleteOne|deleteMany|findOneAndDelete)$/

export function appendOnly(
  schema: Schema,
  options: { what: string; error?: new () => Error }
): void {
  const fail = () => {
    throw options.error
      ? new options.error()
      : new AppendOnlyError(options.what)
  }
  schema.pre(UPDATES, { document: false, query: true }, fail)
  schema.pre<Query<unknown, unknown>>(
    DELETES,
    { document: false, query: true },
    function () {
      if (!(this as unknown as Record<symbol, boolean>)[PURGE]) fail()
    }
  )
  schema.pre(["updateOne", "deleteOne"], { document: true, query: false }, fail)
  schema.pre("save", function () {
    if (!this.isNew) fail()
  })
  schema.pre("bulkWrite", fail)
}
