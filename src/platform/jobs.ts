import { createHash, timingSafeEqual } from "node:crypto"
import { Router } from "express"
import { z } from "zod"

import { apiErrors } from "./http/errors.ts"
import { route } from "./http/validation.ts"
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

const digest = (text: string) => createHash("sha256").update(text).digest()

/**
 * The same jobs as HTTP endpoints, for hosts without long-running processes
 * (Vercel: its Cron Jobs call these on a schedule). GET /jobs/{name} runs the
 * job once and answers with its result:
 *   200 { job, result }   ran (the jobs are idempotent: running twice is safe)
 *   401 UNAUTHENTICATED   missing or wrong "Authorization: Bearer <secret>"
 *   404 NOT_FOUND         no job with that name
 */
export function jobsRouter(input: {
  jobs: readonly Job[]
  secret: string
  logger: Logger
}): Router {
  const router = Router()
  const expected = digest(`Bearer ${input.secret}`)
  router.get(
    "/jobs/:name",
    route(
      { params: z.object({ name: z.string() }) },
      async ({ params, req }) => {
        const given = digest(req.headers.authorization ?? "")
        if (!timingSafeEqual(given, expected)) throw apiErrors.unauthenticated()
        const job = input.jobs.find((j) => j.name === params.name)
        if (!job) throw apiErrors.notFound()
        const result = await job.run()
        input.logger.info("job ran", { job: job.name })
        return { status: 200, body: { job: job.name, result } }
      }
    )
  )
  return router
}
