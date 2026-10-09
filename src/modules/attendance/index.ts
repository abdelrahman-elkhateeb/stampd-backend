import { Router, type Request } from "express"
import { z } from "zod"

import { apiErrors } from "../../platform/http/errors.ts"
import {
  listQuery,
  multiValue,
  toPage,
  toPageRequest,
} from "../../platform/http/pagination.ts"
import { route } from "../../platform/http/validation.ts"
import { addDays, isPlainDate } from "../../platform/time/time.ts"
import {
  authorize,
  requirePermission,
  scopedEmployeeIds,
} from "../identity/access.ts"
import { getAuth, requireAuth } from "../identity/authenticate.ts"
import type { AppModule } from "../module.ts"
import {
  attendanceGrid,
  checkIn,
  checkOut,
  correctAttendance,
  dayDetail,
  listExceptions,
  sessionOwner,
  todayFor,
  type RequestMeta,
} from "./attendance.service.ts"
import { runAttendanceClose } from "./close-job.ts"

const plainDate = z.string().refine(isPlainDate, "must be a date (YYYY-MM-DD)")
const instant = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value))
const reason = z.string().max(500).nullable().optional()
const pageQuery = listQuery({ sortFields: ["name"], defaultSort: "name" })
const gridFilters = {
  departmentId: z.uuid().optional(),
  employeeId: z.uuid().optional(),
}
/** Longest range for the exceptions list, in days. */
const MAX_RANGE_DAYS = 92

const meta = (req: Request): RequestMeta => ({
  ip: req.ip ?? null,
  userAgent: req.headers["user-agent"]?.slice(0, 300) ?? null,
})

/**
 * Attendance (Trello BE-07): check-in/out, today, day and month views,
 * exceptions, Admin corrections, and the end-of-day close job. The exact
 * requests and responses are on the BE-07 card.
 */
export const attendanceModule: AppModule = {
  name: "attendance",
  jobs: (deps) => [
    {
      name: "attendance.close",
      everyMs: 60_000,
      run: () => runAttendanceClose(deps),
    },
  ],
  routes(deps) {
    const router = Router()
    const auth = requireAuth({
      secret: deps.config.authTokenSecret,
      clock: deps.clock,
    })
    const corrections = requirePermission("attendance", "edit")

    // ── self ──
    router.post(
      "/attendance/check-in",
      auth,
      route({}, async ({ req }) => {
        const { companyId, userId } = getAuth(req)
        const result = await checkIn(
          { companyId, employeeId: userId, meta: meta(req) },
          deps
        )
        return { status: result.created ? 201 : 200, body: result.today }
      })
    )
    router.post(
      "/attendance/check-out",
      auth,
      route({}, async ({ req }) => {
        const { companyId, userId } = getAuth(req)
        return {
          status: 200,
          body: await checkOut(
            { companyId, employeeId: userId, meta: meta(req) },
            deps
          ),
        }
      })
    )
    router.get(
      "/attendance/today",
      auth,
      route({}, async ({ req }) => {
        const { companyId, userId } = getAuth(req)
        return { status: 200, body: await todayFor(companyId, userId, deps) }
      })
    )

    // ── views (self / team / company by BE-03) ──
    const grid = async (
      req: Request,
      from: string,
      to: string,
      query: z.infer<typeof pageQuery> & {
        departmentId?: string
        employeeId?: string
      }
    ) => {
      const callerAuth = getAuth(req)
      const page = toPageRequest(query)
      const { items, total } = await attendanceGrid(
        {
          companyId: callerAuth.companyId,
          visibleIds: await scopedEmployeeIds(callerAuth, "attendance", "view"),
          from,
          to,
          filters: {
            departmentId: query.departmentId,
            employeeId: query.employeeId,
          },
          page,
        },
        deps
      )
      return { status: 200, body: { from, to, ...toPage(items, total, page) } }
    }
    router.get(
      "/attendance/days",
      auth,
      route(
        { query: pageQuery.extend({ date: plainDate, ...gridFilters }) },
        async ({ query, req }) => grid(req, query.date, query.date, query)
      )
    )
    router.get(
      "/attendance/month",
      auth,
      route(
        {
          query: pageQuery.extend({
            month: z
              .string()
              .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "must be a month (YYYY-MM)"),
            ...gridFilters,
          }),
        },
        async ({ query, req }) => {
          const from = `${query.month}-01`
          const to = addDays(`${addDays(from, 31).slice(0, 7)}-01`, -1)
          return grid(req, from, to, query)
        }
      )
    )
    router.get(
      "/attendance/employees/:employeeId/days/:date",
      auth,
      route(
        { params: z.object({ employeeId: z.uuid(), date: plainDate }) },
        async ({ params, req }) => {
          const callerAuth = getAuth(req)
          await authorize(callerAuth, "attendance", "view", params.employeeId)
          return {
            status: 200,
            body: await dayDetail(
              {
                companyId: callerAuth.companyId,
                employeeId: params.employeeId,
                date: params.date,
                withDevice: callerAuth.role === "ADMIN",
              },
              deps
            ),
          }
        }
      )
    )
    router.get(
      "/attendance/exceptions",
      auth,
      requirePermission("attendanceExceptions", "view"),
      route(
        {
          query: listQuery({
            sortFields: ["date"],
            defaultSort: "-date",
          }).extend({
            from: plainDate,
            to: plainDate,
            type: multiValue(z.enum(["MISSING_CHECKOUT", "ABSENT"])).optional(),
          }),
        },
        async ({ query, req }) => {
          if (
            query.to < query.from ||
            addDays(query.from, MAX_RANGE_DAYS - 1) < query.to
          ) {
            throw apiErrors.fieldError(
              "to",
              "OUT_OF_RANGE",
              `to must be on or after from, at most ${MAX_RANGE_DAYS} days`
            )
          }
          const page = toPageRequest(query)
          const { items, total } = await listExceptions({
            companyId: getAuth(req).companyId,
            from: query.from,
            to: query.to,
            statuses: query.type ?? ["MISSING_CHECKOUT", "ABSENT"],
            page,
          })
          return { status: 200, body: toPage(items, total, page) }
        }
      )
    )

    // ── Admin corrections (reason required) ──
    const actor = (req: Request) =>
      ({ type: "USER", userId: getAuth(req).userId }) as const
    router.post(
      "/attendance/employees/:employeeId/days/:date/sessions",
      auth,
      corrections,
      route(
        {
          params: z.object({ employeeId: z.uuid(), date: plainDate }),
          body: z.object({ checkInAt: instant, checkOutAt: instant, reason }),
        },
        async ({ params, body, req }) => ({
          status: 201,
          body: await correctAttendance(
            {
              companyId: getAuth(req).companyId,
              employeeId: params.employeeId,
              date: params.date,
              operation: {
                type: "add",
                checkInAt: body.checkInAt,
                checkOutAt: body.checkOutAt,
              },
              reason: body.reason,
              actor: actor(req),
            },
            deps
          ),
        })
      )
    )
    const sessionParams = z.object({ id: z.uuid() })
    const owned = async (req: Request, sessionId: string) => {
      const owner = await sessionOwner({
        companyId: getAuth(req).companyId,
        sessionId,
      })
      if (!owner) throw apiErrors.notFound()
      return owner
    }
    router.patch(
      "/attendance/sessions/:id",
      auth,
      corrections,
      route(
        {
          params: sessionParams,
          body: z.object({
            checkInAt: instant.optional(),
            checkOutAt: instant.optional(),
            reason,
          }),
        },
        async ({ params, body, req }) => {
          const owner = await owned(req, params.id)
          return {
            status: 200,
            body: await correctAttendance(
              {
                companyId: getAuth(req).companyId,
                ...owner,
                operation: {
                  type: "edit",
                  sessionId: params.id,
                  checkInAt: body.checkInAt,
                  checkOutAt: body.checkOutAt,
                },
                reason: body.reason,
                actor: actor(req),
              },
              deps
            ),
          }
        }
      )
    )
    router.delete(
      "/attendance/sessions/:id",
      auth,
      corrections,
      route(
        { params: sessionParams, body: z.object({ reason }).optional() },
        async ({ params, body, req }) => {
          const owner = await owned(req, params.id)
          return {
            status: 200,
            body: await correctAttendance(
              {
                companyId: getAuth(req).companyId,
                ...owner,
                operation: { type: "remove", sessionId: params.id },
                reason: body?.reason,
                actor: actor(req),
              },
              deps
            ),
          }
        }
      )
    )

    return router
  },
}
