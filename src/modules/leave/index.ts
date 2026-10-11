import { Router, type Request } from "express"
import { z } from "zod"

import { apiErrors } from "../../platform/http/errors.ts"
import {
  listQuery,
  toPage,
  toPageRequest,
} from "../../platform/http/pagination.ts"
import { plainDate, route } from "../../platform/http/validation.ts"
import { authorize, requirePermission } from "../identity/access.ts"
import { getAuth, requireAuth } from "../identity/authenticate.ts"
import type { AppModule } from "../module.ts"
import {
  adjustBalance,
  listBalances,
  listLedgerEntries,
  setEntitlement,
} from "./balance.service.ts"
import { LEAVE_ICONS } from "./leave.model.ts"
import {
  addLeaveType,
  changeLeaveType,
  listLeaveTypes,
  removeLeaveType,
} from "./leave-types.service.ts"
import { runLeaveRollover } from "./rollover-job.ts"
import {
  HALVES,
  LEAVE,
  previewLeave,
  registerLeaveRequestType,
} from "./leave-request.ts"
import { listRequestsOf } from "../requests/engine.ts"
import { REQUEST_STATUSES } from "../requests/request.model.ts"

// Leave requests run on the request engine (BE-09) as the type "LEAVE".
registerLeaveRequestType()

const halfDays = (min: number) =>
  z
    .number()
    .min(min)
    .max(366)
    .refine((n) => Number.isInteger(n * 2), "whole or half days")

const policyBody = z.object({
  name: z.string().trim().min(1).max(60),
  icon: z.enum(LEAVE_ICONS).default("other"),
  paid: z.boolean().default(true),
  tracksBalance: z.boolean().default(true),
  defaultAllowanceDays: halfDays(0).default(0),
  allowNegativeBalance: z.boolean().default(false),
  halfDaysAllowed: z.boolean().default(true),
  requiresReason: z.boolean().default(false),
})
const policyChange = z
  .object({
    name: policyBody.shape.name,
    icon: z.enum(LEAVE_ICONS),
    paid: z.boolean(),
    tracksBalance: z.boolean(),
    defaultAllowanceDays: halfDays(0),
    allowNegativeBalance: z.boolean(),
    halfDaysAllowed: z.boolean(),
    requiresReason: z.boolean(),
    archived: z.boolean(),
  })
  .partial()

const year = z.coerce.number().int().min(2000).max(2100)
const balanceParams = z.object({ employeeId: z.uuid(), leaveTypeId: z.uuid() })

/**
 * Leave (BE-08): leave types and policies, balances and their ledger, Admin
 * adjustments and entitlement overrides, and the leave-year rollover job.
 * Leave requests come with BE-10, using balance.service.ts. The exact
 * requests and responses are on the Trello BE-08 card.
 */
export const leaveModule: AppModule = {
  name: "leave",
  jobs: (deps) => [
    {
      name: "leave.rollover",
      everyMs: 15 * 60_000,
      run: () => runLeaveRollover(deps),
    },
  ],
  routes(deps) {
    const router = Router()
    const auth = requireAuth({
      secret: deps.config.authTokenSecret,
      clock: deps.clock,
    })
    const actor = (req: Request) =>
      ({ type: "USER", userId: getAuth(req).userId }) as const
    const adminTypes = requirePermission("leaveTypes", "edit")
    const adminBalances = requirePermission("leaveBalances", "edit")
    const idParams = z.object({ id: z.uuid() })

    // ── leave types ──
    router.get(
      "/leave/types",
      auth,
      requirePermission("leaveTypes", "view"),
      route(
        {
          query: z.object({
            includeArchived: z.enum(["true", "false"]).default("false"),
          }),
        },
        async ({ query, req }) => {
          const { companyId, role } = getAuth(req)
          return {
            status: 200,
            body: {
              items: await listLeaveTypes({
                companyId,
                // Archived types are an Admin concern.
                includeArchived:
                  role === "ADMIN" && query.includeArchived === "true",
              }),
            },
          }
        }
      )
    )
    router.post(
      "/leave/types",
      auth,
      adminTypes,
      route({ body: policyBody }, async ({ body, req }) => ({
        status: 201,
        body: await addLeaveType(
          {
            companyId: getAuth(req).companyId,
            policy: body,
            actor: actor(req),
          },
          deps
        ),
      }))
    )
    router.patch(
      "/leave/types/:id",
      auth,
      adminTypes,
      route(
        { params: idParams, body: policyChange },
        async ({ params, body, req }) => {
          const type = await changeLeaveType(
            {
              companyId: getAuth(req).companyId,
              id: params.id,
              change: body,
              actor: actor(req),
            },
            deps
          )
          if (!type) throw apiErrors.notFound()
          return { status: 200, body: type }
        }
      )
    )
    router.delete(
      "/leave/types/:id",
      auth,
      adminTypes,
      route({ params: idParams }, async ({ params, req }) => {
        const removed = await removeLeaveType(
          {
            companyId: getAuth(req).companyId,
            id: params.id,
            actor: actor(req),
          },
          deps
        )
        if (!removed) throw apiErrors.notFound()
        return { status: 204 }
      })
    )

    // ── balances (own, a Manager's direct reports, everyone for Admins) ──
    router.get(
      "/leave/employees/:employeeId/balances",
      auth,
      route(
        {
          params: z.object({ employeeId: z.uuid() }),
          query: z.object({ year: year.optional() }),
        },
        async ({ params, query, req }) => {
          const callerAuth = getAuth(req)
          await authorize(callerAuth, "leave", "view", params.employeeId)
          return {
            status: 200,
            body: await listBalances(
              {
                companyId: callerAuth.companyId,
                employeeId: params.employeeId,
                year: query.year,
              },
              deps
            ),
          }
        }
      )
    )
    router.get(
      "/leave/employees/:employeeId/balances/:leaveTypeId/entries",
      auth,
      route(
        {
          params: balanceParams,
          query: listQuery({ sortFields: ["at"], defaultSort: "at" }).extend({
            year: year.optional(),
          }),
        },
        async ({ params, query, req }) => {
          const callerAuth = getAuth(req)
          await authorize(callerAuth, "leave", "view", params.employeeId)
          const page = toPageRequest(query)
          const { balance, items, total } = await listLedgerEntries(
            { companyId: callerAuth.companyId, ...params, year: query.year },
            page,
            deps
          )
          return {
            status: 200,
            body: { balance, ...toPage(items, total, page) },
          }
        }
      )
    )
    router.post(
      "/leave/employees/:employeeId/balances/:leaveTypeId/adjustments",
      auth,
      adminBalances,
      route(
        {
          params: balanceParams,
          body: z.object({
            year: year.optional(),
            days: z.number(),
            reason: z.string().max(500).nullable().optional(),
          }),
        },
        async ({ params, body, req }) => {
          const callerAuth = getAuth(req)
          await authorize(callerAuth, "leave", "view", params.employeeId)
          return {
            status: 201,
            body: await adjustBalance(
              {
                companyId: callerAuth.companyId,
                ...params,
                year: body.year,
                days: body.days,
                reason: body.reason,
                actor: actor(req),
              },
              deps
            ),
          }
        }
      )
    )
    router.put(
      "/leave/employees/:employeeId/balances/:leaveTypeId/entitlement",
      auth,
      adminBalances,
      route(
        {
          params: balanceParams,
          body: z.object({
            year: year.optional(),
            days: z.number(),
            reason: z.string().max(500).nullable().optional(),
          }),
        },
        async ({ params, body, req }) => {
          const callerAuth = getAuth(req)
          await authorize(callerAuth, "leave", "view", params.employeeId)
          return {
            status: 200,
            body: await setEntitlement(
              {
                companyId: callerAuth.companyId,
                ...params,
                year: body.year,
                days: body.days,
                reason: body.reason,
                actor: actor(req),
              },
              deps
            ),
          }
        }
      )
    )

    // ── leave requests (submitted with POST /requests, type "LEAVE"; BE-10) ──
    router.post(
      "/leave/requests/preview",
      auth,
      route(
        {
          body: z.object({
            employeeId: z.uuid().optional(),
            leaveTypeId: z.uuid(),
            startDate: plainDate,
            endDate: plainDate.optional(),
            firstDayHalf: z.enum(HALVES).nullable().optional(),
            lastDayHalf: z.enum(HALVES).nullable().optional(),
            reason: z.string().max(1000).nullable().optional(),
          }),
        },
        async ({ body, req }) => {
          const callerAuth = getAuth(req)
          const employeeId = body.employeeId ?? callerAuth.userId
          if (employeeId !== callerAuth.userId) {
            // Only Admins submit for someone else, so only they preview for them.
            if (callerAuth.role !== "ADMIN") throw apiErrors.forbidden()
            await authorize(callerAuth, "leave", "view", employeeId)
          }
          const endDate = body.endDate ?? body.startDate
          if (endDate < body.startDate) {
            throw apiErrors.fieldError(
              "endDate",
              "OUT_OF_RANGE",
              "endDate must be on or after startDate"
            )
          }
          return {
            status: 200,
            body: await previewLeave(
              {
                auth: callerAuth,
                employeeId,
                startDate: body.startDate,
                endDate,
                data: {
                  leaveTypeId: body.leaveTypeId,
                  firstDayHalf: body.firstDayHalf,
                  lastDayHalf: body.lastDayHalf,
                },
                reason: body.reason ?? null,
              },
              deps
            ),
          }
        }
      )
    )
    router.get(
      "/leave/employees/:employeeId/requests",
      auth,
      route(
        {
          params: z.object({ employeeId: z.uuid() }),
          query: listQuery({
            sortFields: ["startDate", "createdAt"],
            defaultSort: "-startDate",
          }).extend({
            status: z
              .preprocess(
                (v) => (v === undefined ? undefined : [v].flat()),
                z.array(z.enum(REQUEST_STATUSES))
              )
              .optional(),
            from: plainDate.optional(),
            to: plainDate.optional(),
          }),
        },
        async ({ params, query, req }) => {
          const page = toPageRequest(query)
          const { items, total } = await listRequestsOf(
            getAuth(req),
            params.employeeId,
            {
              types: [LEAVE],
              statuses: query.status,
              from: query.from,
              to: query.to,
            },
            page,
            deps
          )
          return { status: 200, body: toPage(items, total, page) }
        }
      )
    )

    return router
  },
}
