import { Router } from "express"

import { route } from "../../platform/http/validation.ts"
import { requirePermission } from "../identity/access.ts"
import { getAuth, requireAuth } from "../identity/authenticate.ts"
import type { AppModule } from "../module.ts"
import {
  adminSummary,
  employeeSummary,
  managerSummary,
} from "./dashboard.service.ts"

/**
 * Reporting: dashboard summaries (BE-13); reports with CSV export come with
 * BE-14. The calendar and availability live in calendar/ (BE-12). The exact
 * responses are on the Trello BE-13 card.
 */
export const reportingModule: AppModule = {
  name: "reporting",
  routes(deps) {
    const router = Router()
    const auth = requireAuth({
      secret: deps.config.authTokenSecret,
      clock: deps.clock,
    })
    router.get(
      "/dashboard/employee",
      auth,
      route({}, async ({ req }) => ({
        status: 200,
        body: await employeeSummary(getAuth(req), deps),
      }))
    )
    router.get(
      "/dashboard/manager",
      auth,
      requirePermission("teamDashboard", "view"),
      route({}, async ({ req }) => ({
        status: 200,
        body: await managerSummary(getAuth(req), deps),
      }))
    )
    router.get(
      "/dashboard/admin",
      auth,
      requirePermission("companyDashboard", "view"),
      route({}, async ({ req }) => ({
        status: 200,
        body: await adminSummary(getAuth(req), deps),
      }))
    )
    return router
  },
}
