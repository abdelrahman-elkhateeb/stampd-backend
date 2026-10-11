import { Router } from "express"
import { z } from "zod"

import { multiValue } from "../../platform/http/pagination.ts"
import {
  booleanFlag,
  plainDate,
  route,
} from "../../platform/http/validation.ts"
import { getAuth, requireAuth } from "../identity/authenticate.ts"
import type { AppModule } from "../module.ts"
import {
  availability,
  calendarEvents,
  EVENT_KINDS,
} from "./calendar.service.ts"

const rangeQuery = z.object({
  from: plainDate,
  to: plainDate,
  departmentId: z.uuid().optional(),
  team: booleanFlag,
  employeeId: z.uuid().optional(),
})

/**
 * Company calendar and availability (Trello BE-12): read-only, every role,
 * scoped and privacy-filtered by calendar.service.ts. The exact responses are
 * on the BE-12 card.
 */
export const calendarModule: AppModule = {
  name: "calendar",
  routes(deps) {
    const router = Router()
    const auth = requireAuth({
      secret: deps.config.authTokenSecret,
      clock: deps.clock,
    })
    const filtersOf = (q: z.infer<typeof rangeQuery>) => ({
      departmentId: q.departmentId,
      team: q.team,
      employeeId: q.employeeId,
    })

    router.get(
      "/calendar/events",
      auth,
      route(
        {
          query: rangeQuery.extend({
            type: multiValue(z.enum(EVENT_KINDS)).optional(),
            includePending: booleanFlag,
          }),
        },
        async ({ query, req }) => ({
          status: 200,
          body: {
            from: query.from,
            to: query.to,
            events: await calendarEvents(
              {
                auth: getAuth(req),
                from: query.from,
                to: query.to,
                filters: { ...filtersOf(query), kinds: query.type },
                includePending: query.includePending,
              },
              deps
            ),
          },
        })
      )
    )
    router.get(
      "/calendar/availability",
      auth,
      route({ query: rangeQuery }, async ({ query, req }) => ({
        status: 200,
        body: {
          from: query.from,
          to: query.to,
          days: await availability(
            {
              auth: getAuth(req),
              from: query.from,
              to: query.to,
              filters: filtersOf(query),
            },
            deps
          ),
        },
      }))
    )
    return router
  },
}
