import mongoose from "mongoose"

// A filter on a field the schema doesn't have is an error, not a silent no-op
// that matches everything (a classic tenant-leak bug).
mongoose.set("strictQuery", "throw")

/**
 * The one MongoDB connection (Mongoose's default connection, where every
 * model in src/modules registers). Opened by server.ts and the CLI scripts.
 */
export async function connectDatabase(uri: string): Promise<typeof mongoose> {
  return mongoose.connect(uri, { serverSelectionTimeoutMS: 5_000 })
}

export async function disconnectDatabase(): Promise<void> {
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
