import { Router } from "express"

import { route } from "../../platform/http/validation.ts"
import type { AppModule } from "../module.ts"

/**
 * Operational endpoints (BE-01).
 *
 * GET /health (no auth): any answer at all means the API process is up; the
 * body says whether the database answers too.
 *   200 { status: "OK", database: "UP" }          API + database healthy
 *   503 { status: "DEGRADED", database: "DOWN" }  API up, database unreachable
 */
export const systemModule: AppModule = {
  name: "system",
  routes({ checkDatabase }) {
    const router = Router()
    router.get(
      "/health",
      route({}, async () =>
        (await checkDatabase())
          ? { status: 200, body: { status: "OK", database: "UP" } }
          : { status: 503, body: { status: "DEGRADED", database: "DOWN" } }
      )
    )
    return router
  },
}
