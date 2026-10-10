import { Router, type Response } from "express"
import { z } from "zod"

import { toCsv } from "../../platform/csv.ts"
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
import { USER_STATUSES } from "../identity/user.model.ts"
import type { AppModule } from "../module.ts"
import { REQUEST_STATUSES } from "../requests/request.model.ts"
import {
  adminSummary,
  employeeSummary,
  managerSummary,
} from "./dashboard.service.ts"
import {
  ATTENDANCE_SUMMARY_COLUMNS,
  attendanceDetail,
  attendanceSummary,
  csvFileName,
  leaveBalances,
  leaveRegister,
  RANGE_PRESETS,
  REGISTER_SORTS,
  reportContext,
  resolveRange,
  WFH_SUMMARY_COLUMNS,
  wfhRegister,
  wfhSummary,
  type Report,
  type ReportContext,
} from "./reports.service.ts"

const plainDate = z.string().refine(isPlainDate, "must be a date (YYYY-MM-DD)")

/** What every report takes: who is in it, the format, and paging/sorting. */
const reportQuery = <const F extends string>(
  sortFields: readonly F[],
  defaultSort: F | `-${F}`
) =>
  listQuery({ sortFields, defaultSort }).extend({
    format: z.enum(["json", "csv"]).default("json"),
    scope: z.enum(["self", "team", "company"]).optional(),
    departmentId: z.uuid().optional(),
    managerId: z.uuid().optional(),
    employeeId: z.uuid().optional(),
    employeeStatus: multiValue(z.enum(USER_STATUSES)).optional(),
  })
/** A preset, or a custom from/to (resolveRange checks them). */
const rangeQuery = {
  preset: z.enum(RANGE_PRESETS).optional(),
  from: plainDate.optional(),
  to: plainDate.optional(),
}
const requestStatus = multiValue(z.enum(REQUEST_STATUSES)).optional()
const leaveTypeId = multiValue(z.uuid()).optional()

type ReportQuery = z.infer<ReturnType<typeof reportQuery>>

/**
 * Sends a report: with format=csv the file with every row, otherwise one
 * page of rows as JSON (with the totals for summaries).
 */
function send<R>(
  res: Response,
  ctx: ReportContext,
  query: ReportQuery,
  report: Report<R>,
  file: { name: string; period: string },
  extra: Record<string, unknown>,
  /** the detail view computes only the page asked for */
  paged = false
) {
  if (query.format === "csv") {
    res
      .status(200)
      .set({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csvFileName(ctx, file.name, file.period)}"`,
        "Cache-Control": "no-store",
      })
      .send(toCsv(report.header, report.rows.map(report.csvRow)))
    return { status: 200 }
  }
  const page = toPageRequest(query)
  const items = paged
    ? report.rows
    : report.rows.slice(page.skip, page.skip + page.limit)
  return {
    status: 200,
    body: {
      ...extra,
      scope: ctx.scope,
      timezone: ctx.timezone,
      ...(report.totals ? { totals: report.totals } : {}),
      ...toPage(items, report.total, page),
    },
  }
}

const sortOf = (query: ReportQuery) => toPageRequest(query).sort

/**
 * Reporting: dashboard summaries (BE-13) and reports with CSV export (BE-14).
 * The calendar and availability live in calendar/ (BE-12). The exact
 * requests and responses are on the Trello BE-13 and BE-14 cards.
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

    // ── reports: JSON for the screen; the same rows as CSV with format=csv ──
    const reports = requirePermission("reports", "view")
    const period = (range: { from: string; to: string }) =>
      `${range.from}_${range.to}`

    router.get(
      "/reports/attendance/summary",
      auth,
      reports,
      route(
        {
          query: reportQuery(
            ["name", "department", ...ATTENDANCE_SUMMARY_COLUMNS],
            "name"
          ).extend(rangeQuery),
        },
        async ({ query, req, res }) => {
          const ctx = await reportContext(getAuth(req), query, deps)
          const range = resolveRange(query, ctx)
          const report = await attendanceSummary(
            ctx,
            range,
            sortOf(query),
            deps
          )
          return send(
            res,
            ctx,
            query,
            report,
            { name: "attendance-summary", period: period(range) },
            range
          )
        }
      )
    )
    router.get(
      "/reports/attendance/detail",
      auth,
      reports,
      route(
        { query: reportQuery(["name"], "name").extend(rangeQuery) },
        async ({ query, req, res }) => {
          const ctx = await reportContext(getAuth(req), query, deps)
          const range = resolveRange(query, ctx)
          const report = await attendanceDetail(
            ctx,
            range,
            query.format === "csv" ? null : toPageRequest(query),
            deps
          )
          return send(
            res,
            ctx,
            query,
            report,
            { name: "attendance-detail", period: period(range) },
            range,
            true
          )
        }
      )
    )
    router.get(
      "/reports/leave/balances",
      auth,
      reports,
      route(
        {
          query: reportQuery(["name"], "name").extend({
            year: z.coerce.number().int().min(2000).max(2100).optional(),
            leaveTypeId,
          }),
        },
        async ({ query, req, res }) => {
          const ctx = await reportContext(getAuth(req), query, deps)
          const report = await leaveBalances(
            ctx,
            { year: query.year, leaveTypeIds: query.leaveTypeId },
            deps
          )
          return send(
            res,
            ctx,
            query,
            report,
            { name: "leave-balances", period: String(report.year) },
            { year: report.year, period: report.period }
          )
        }
      )
    )
    router.get(
      "/reports/leave/register",
      auth,
      reports,
      route(
        {
          query: reportQuery(REGISTER_SORTS, "startDate").extend({
            ...rangeQuery,
            status: requestStatus,
            leaveTypeId,
          }),
        },
        async ({ query, req, res }) => {
          const ctx = await reportContext(getAuth(req), query, deps)
          const range = resolveRange(query, ctx)
          const report = await leaveRegister(
            ctx,
            {
              ...range,
              statuses: query.status,
              leaveTypeIds: query.leaveTypeId,
            },
            sortOf(query)
          )
          return send(
            res,
            ctx,
            query,
            report,
            { name: "leave-register", period: period(range) },
            range
          )
        }
      )
    )
    router.get(
      "/reports/wfh/summary",
      auth,
      reports,
      route(
        {
          query: reportQuery(
            ["name", "department", ...WFH_SUMMARY_COLUMNS],
            "name"
          ).extend(rangeQuery),
        },
        async ({ query, req, res }) => {
          const ctx = await reportContext(getAuth(req), query, deps)
          const range = resolveRange(query, ctx)
          const report = await wfhSummary(ctx, range, sortOf(query))
          return send(
            res,
            ctx,
            query,
            report,
            { name: "wfh-summary", period: period(range) },
            range
          )
        }
      )
    )
    router.get(
      "/reports/wfh/register",
      auth,
      reports,
      route(
        {
          query: reportQuery(REGISTER_SORTS, "startDate").extend({
            ...rangeQuery,
            status: requestStatus,
            type: multiValue(z.enum(["WFH", "BUSINESS_TRIP"])).optional(),
          }),
        },
        async ({ query, req, res }) => {
          const ctx = await reportContext(getAuth(req), query, deps)
          const range = resolveRange(query, ctx)
          const report = await wfhRegister(
            ctx,
            { ...range, types: query.type ?? ["WFH"], statuses: query.status },
            sortOf(query)
          )
          return send(
            res,
            ctx,
            query,
            report,
            { name: "wfh-register", period: period(range) },
            range
          )
        }
      )
    )
    return router
  },
}
