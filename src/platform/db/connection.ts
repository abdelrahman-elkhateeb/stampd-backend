import mongoose from "mongoose"

// A filter on a field the schema doesn't have is an error, not a silent no-op
// that matches everything (a classic tenant-leak bug).
mongoose.set("strictQuery", "throw")
// Inside connection.transaction(fn), every query uses the transaction's
// session automatically, so services don't pass { session } around.
mongoose.set("transactionAsyncLocalStorage", true)

/**
 * Runs fn in a MongoDB transaction (needs a replica set: compose, Atlas,
 * tests). Inside another withTransaction it joins the outer transaction, so
 * services can use it without knowing whether their caller already did.
 *
 * Inside a transaction, never start with queries in parallel
 * (Promise.all): the first operation starts the transaction, and MongoDB
 * refuses two operations starting it at once. After one awaited query,
 * parallel reads are fine.
 */
export function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (inTransaction()) return fn()
  return mongoose.connection.transaction(fn)
}

/** true inside withTransaction(): queries here commit or roll back together. */
export function inTransaction(): boolean {
  const store = (
    mongoose as unknown as {
      transactionAsyncLocalStorage?: {
        getStore(): { session?: { inTransaction(): boolean } } | undefined
      }
    }
  ).transactionAsyncLocalStorage?.getStore()
  return store?.session?.inTransaction() ?? false
}

/**
 * The one MongoDB connection (Mongoose's default connection, where every
 * model in src/modules registers). Opened by server.ts and the CLI scripts.
 */
export async function connectDatabase(uri: string): Promise<typeof mongoose> {
  return mongoose.connect(uri, { serverSelectionTimeoutMS: 5_000 })
}

/**
 * For serverless functions (src/serverless.ts): every invocation calls this,
 * the first one connects and the following ones reuse the open connection
 * (a warm instance keeps it between requests). Concurrent first calls share
 * one attempt; a failed attempt is retried on the next call.
 */
let connecting: Promise<unknown> | null = null
export async function ensureDatabase(uri: string): Promise<void> {
  if (mongoose.connection.readyState === 1) return
  connecting ??= connectDatabase(uri).catch((error: unknown) => {
    connecting = null
    throw error
  })
  await connecting
}

export async function disconnectDatabase(): Promise<void> {
  connecting = null
  await mongoose.disconnect()
}

/**
 * For the health check: true when the database answers a ping within the
 * timeout. Never throws.
 */
export async function pingDatabase(timeoutMs = 2_000): Promise<boolean> {
  const db = mongoose.connection.db
  if (mongoose.connection.readyState !== 1 || !db) return false
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), timeoutMs)
    })
    await Promise.race([db.admin().command({ ping: 1 }), timeout])
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
