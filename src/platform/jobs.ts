import type { Logger } from "./logging/logger.ts"

/**
 * Background jobs that run inside the API process on a fixed interval (e.g.
 * the attendance close every minute). A run never overlaps the previous one.
 * Every job must be safe to run on several servers at once (they are written
 * to be idempotent).
 */
export type Job = {
  name: string
  everyMs: number
  run(): Promise<unknown>
}

export function startJobs(jobs: Job[], logger: Logger): () => void {
  const timers = jobs.map((job) => {
    let running = false
    return setInterval(() => {
      if (running) return
      running = true
      job
        .run()
        .catch((error: unknown) =>
          logger.error("job failed", { job: job.name, error })
        )
        .finally(() => {
          running = false
        })
    }, job.everyMs)
  })
  return () => timers.forEach((timer) => clearInterval(timer))
}
