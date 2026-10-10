import { Router } from "express"
import { z } from "zod"

import {
  listQuery,
  multiValue,
  toPage,
  toPageRequest,
} from "../../platform/http/pagination.ts"
import { route } from "../../platform/http/validation.ts"
import { isPlainDate } from "../../platform/time/time.ts"
import { requirePermission } from "../identity/access.ts"
import { getAuth, requireAuth } from "../identity/authenticate.ts"
import type { AppModule } from "../module.ts"
import {
  approveRequest,
  cancelRequest,
  companyRequestTypes,
  decideCancellation,
  getRequestDetail,
  listApprovals,
  listMyRequests,
  rejectRequest,
  requestCancellation,
  submitRequest,
  withdrawRequest,
} from "./engine.ts"
import { registerWorkplaceRequestTypes } from "./request-types.ts"
import { REQUEST_STATUSES } from "./request.model.ts"

// WFH, Attendance Correction, Permission and Business Trip (BE-11).
registerWorkplaceRequestTypes()

const plainDate = z.string().refine(isPlainDate, "must be a date (YYYY-MM-DD)")
const text = (max: number) => z.string().max(max).nullable().optional()

const submitBody = z.object({
  type: z.string().min(1).max(50),
  employeeId: z.uuid().optional(),
  startDate: plainDate,
  endDate: plainDate.optional(),
  startTime: z.string().nullable().optional(),
  endTime: z.string().nullable().optional(),
  reason: text(1000),
  data: z.record(z.string(), z.unknown()).optional(),
  approved: z.boolean().optional(),
})

const listFilters = listQuery({
  sortFields: ["createdAt", "startDate"],
  defaultSort: "-createdAt",
}).extend({
  type: multiValue(z.string().max(50)).optional(),
  status: multiValue(z.enum(REQUEST_STATUSES)).optional(),
  employeeId: z.uuid().optional(),
  from: plainDate.optional(),
  to: plainDate.optional(),
})
type ListQuery = z.infer<typeof listFilters>
const filtersOf = (query: ListQuery) => ({
  types: query.type,
  statuses: query.status,
  employeeId: query.employeeId,
  from: query.from,
  to: query.to,
})

/**
 * Requests and approvals (Trello BE-09). The engine is generic: request types
 * are registered by the leave (BE-10) and request-type (BE-11) tickets. The
 * exact requests and responses are on the BE-09 card.
 */
export const requestsModule: AppModule = {
  name: "requests",
  routes(deps) {
    const router = Router()
    const auth = requireAuth({
      secret: deps.config.authTokenSecret,
      clock: deps.clock,
    })
    const idParams = { params: z.object({ id: z.uuid() }) }

    router.get(
      "/requests/types",
      auth,
      route(
        {
          query: z.object({
            includeDisabled: z.enum(["true", "false"]).default("false"),
          }),
        },
        async ({ query, req }) => {
          const callerAuth = getAuth(req)
          const types = await companyRequestTypes(
            callerAuth.companyId,
            {
              // Turned-off types are an Admin concern (settings screen).
              includeDisabled:
                callerAuth.role === "ADMIN" && query.includeDisabled === "true",
            },
            deps
          )
          return {
            status: 200,
            body: {
              items: types.map(({ definition: t, enabled }) => ({
                key: t.key,
                label: t.label,
                enabled,
                approverPolicy: t.approverPolicy,
                dates: t.dates,
                times: t.times,
                reason: t.reason,
                colleagueVisibility: t.colleagueVisibility,
                fields: t.fields ?? [],
              })),
            },
          }
        }
      )
    )
    router.post(
      "/requests",
      auth,
      route({ body: submitBody }, async ({ body, req }) => {
        const record = await submitRequest(
          { auth: getAuth(req), request: body },
          deps
        )
        return {
          status: 201,
          body: await getRequestDetail(getAuth(req), record.id, deps),
        }
      })
    )
    router.get(
      "/requests/mine",
      auth,
      route({ query: listFilters }, async ({ query, req }) => {
        const page = toPageRequest(query)
        const { items, total } = await listMyRequests(
          getAuth(req),
          filtersOf(query),
          page,
          deps
        )
        return { status: 200, body: toPage(items, total, page) }
      })
    )
    router.get(
      "/requests/approvals",
      auth,
      requirePermission("requests", "approve"),
      route({ query: listFilters }, async ({ query, req }) => {
        const page = toPageRequest(query)
        const { items, total } = await listApprovals(
          getAuth(req),
          filtersOf(query),
          page,
          deps
        )
        return { status: 200, body: toPage(items, total, page) }
      })
    )
    router.get(
      "/requests/:id",
      auth,
      route(idParams, async ({ params, req }) => ({
        status: 200,
        body: await getRequestDetail(getAuth(req), params.id, deps),
      }))
    )

    // Every action answers with the request detail after it.
    const act = (
      path: string,
      body: z.ZodObject,
      run: (input: {
        req: Parameters<typeof getAuth>[0]
        id: string
        body: Record<string, unknown>
      }) => Promise<unknown>
    ) =>
      router.post(
        `/requests/:id/${path}`,
        auth,
        route(
          { ...idParams, body: body.optional() },
          async ({ params, body: parsed, req }) => {
            await run({
              req,
              id: params.id,
              body: (parsed ?? {}) as Record<string, unknown>,
            })
            return {
              status: 200,
              body: await getRequestDetail(getAuth(req), params.id, deps),
            }
          }
        )
      )
    const comment = z.object({ comment: text(1000) })
    const reason = z.object({ reason: text(1000) })

    act("approve", comment, ({ req, id, body }) =>
      approveRequest(
        { auth: getAuth(req), id, comment: body.comment as string | null },
        deps
      )
    )
    act("reject", reason, ({ req, id, body }) =>
      rejectRequest(
        { auth: getAuth(req), id, reason: body.reason as string | null },
        deps
      )
    )
    act("withdraw", z.object({}), ({ req, id }) =>
      withdrawRequest({ auth: getAuth(req), id }, deps)
    )
    act("cancellation", reason, ({ req, id, body }) =>
      requestCancellation(
        { auth: getAuth(req), id, reason: body.reason as string | null },
        deps
      )
    )
    act("cancellation/approve", comment, ({ req, id, body }) =>
      decideCancellation(
        {
          auth: getAuth(req),
          id,
          accept: true,
          comment: body.comment as string | null,
        },
        deps
      )
    )
    act("cancellation/decline", comment, ({ req, id, body }) =>
      decideCancellation(
        {
          auth: getAuth(req),
          id,
          accept: false,
          comment: body.comment as string | null,
        },
        deps
      )
    )
    act("cancel", reason, ({ req, id, body }) =>
      cancelRequest(
        { auth: getAuth(req), id, reason: body.reason as string | null },
        deps
      )
    )

    return router
  },
}
