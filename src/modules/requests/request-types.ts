import { z } from "zod"

import { apiErrors, type FieldError } from "../../platform/http/errors.ts"
import { addDays, instantAt, type PlainDate } from "../../platform/time/time.ts"
import {
  correctAttendance,
  dayDetail,
  recalculateStoredDays,
} from "../attendance/attendance.service.ts"
import {
  isWorkingDay,
  loadCompanyToday,
  loadWorkCalendar,
  timezoneOn,
} from "../organization/calendar.ts"
import { LOCAL_TIME } from "../organization/company.model.ts"
import {
  getAttendanceRules,
  getCompanySettings,
} from "../organization/settings.service.ts"
import { findOverlappingRequests } from "./engine.ts"
import {
  registerRequestType,
  type HookContext,
  type RequestRecord,
  type RequestTypeDefinition,
} from "./registry.ts"

/**
 * The workplace request types (Trello BE-11), registered on the engine
 * (BE-09) without engine changes: WFH, Attendance Correction, Permission /
 * Early Leave, and Business Trip. Each affects attendance (BE-07).
 */
export const WFH = "WFH"
export const ATTENDANCE_CORRECTION = "ATTENDANCE_CORRECTION"
export const PERMISSION = "PERMISSION"
export const BUSINESS_TRIP = "BUSINESS_TRIP"

/** How far back a correction may be asked for. */
export const CORRECTION_DAYS_BACK = 30

const IN_PLAY = ["PENDING", "APPROVED", "CANCELLATION_REQUESTED"] as const

/**
 * Leave and WFH / business trips never share days (decision 2026-10-10).
 * BE-10 checks the other direction.
 */
async function refuseOverlap(
  ctx: HookContext,
  types: string[],
  describe: (other: RequestRecord) => string
) {
  const others = await findOverlappingRequests({
    companyId: ctx.request.companyId,
    from: ctx.request.startDate,
    to: ctx.request.endDate,
    requesterId: ctx.request.requesterId,
    types,
    statuses: [...IN_PLAY],
  })
  if (others[0]) {
    throw apiErrors.conflictWith("REQUEST_OVERLAP", describe(others[0]))
  }
}

const leaveMessage = (other: RequestRecord) =>
  `You have leave from ${other.startDate} to ${other.endDate} on these days; withdraw or cancel it first`

/** Recomputes stored attendance days when an approved request starts or stops counting. */
export const recalcAttendance = (ctx: HookContext) =>
  recalculateStoredDays(
    {
      companyId: ctx.request.companyId,
      employeeId: ctx.request.requesterId,
      from: ctx.request.startDate,
      to: ctx.request.endDate,
    },
    ctx.deps
  )
const onAttendanceChange = {
  onApprove: recalcAttendance,
  onCancel: async (ctx: HookContext & { from: string }) => {
    if (ctx.from !== "PENDING") await recalcAttendance(ctx)
  },
}

async function hasWorkingDay(
  companyId: string,
  from: PlainDate,
  to: PlainDate
) {
  const calendar = await loadWorkCalendar({ companyId, from, to })
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (calendar && isWorkingDay(calendar, date)) return true
  }
  return false
}

const noWorkingDays = () =>
  apiErrors.fieldError(
    "endDate",
    "NO_WORKING_DAYS",
    "no working days in this range"
  )

// ─────────────────────────────── WFH ───────────────────────────────

const wfh: RequestTypeDefinition = {
  key: WFH,
  label: "Work from home",
  approverPolicy: "MANAGER_WITH_ADMIN_FALLBACK",
  dates: "RANGE",
  times: "NONE",
  reason: "OPTIONAL",
  data: z.object({}),
  colleagueVisibility: "WFH",
  // WFH employees still check in; the day reads WFH (BE-07).
  dayEffect: () => ({ kind: "WFH", fullDay: true }),
  async validate(ctx) {
    const { companyId, startDate, endDate } = ctx.request
    if (!(await hasWorkingDay(companyId, startDate, endDate)))
      throw noWorkingDays()
    await refuseOverlap(ctx, ["LEAVE"], leaveMessage)
    await refuseOverlap(
      ctx,
      [WFH],
      (other) =>
        `You already asked for WFH from ${other.startDate} to ${other.endDate}`
    )
  },
  ...onAttendanceChange,
}

// ─────────────────────────────── Business trip ───────────────────────────────

const businessTrip: RequestTypeDefinition = {
  key: BUSINESS_TRIP,
  label: "Business trip",
  approverPolicy: "MANAGER_WITH_ADMIN_FALLBACK",
  dates: "RANGE",
  times: "NONE",
  reason: "OPTIONAL",
  data: z.object({
    destination: z.string().trim().min(1).max(100),
    purpose: z.string().trim().min(1).max(500),
  }),
  fields: [
    { name: "destination", kind: "text", required: true, maxLength: 100 },
    { name: "purpose", kind: "text", required: true, maxLength: 500 },
  ],
  colleagueVisibility: "HIDDEN",
  // Days of the trip show Business Trip, never Absent (BE-07).
  dayEffect: () => ({ kind: "BUSINESS_TRIP", fullDay: true }),
  async validate(ctx) {
    await refuseOverlap(ctx, ["LEAVE"], leaveMessage)
  },
  ...onAttendanceChange,
}

// ─────────────────────────────── Permission ───────────────────────────────

const permission: RequestTypeDefinition = {
  key: PERMISSION,
  label: "Permission / early leave",
  approverPolicy: "MANAGER_WITH_ADMIN_FALLBACK",
  dates: "SINGLE_DAY",
  times: "REQUIRED",
  reason: "OPTIONAL",
  data: z.object({}),
  colleagueVisibility: "HIDDEN",
  // Arriving before the permission ends isn't late (BE-07). Leaving early
  // inside the window isn't flagged (attendance has no early-leave flag).
  dayEffect: (request) => ({
    kind: "PERMISSION",
    fullDay: false,
    until: request.endTime ?? undefined,
  }),
  async validate(ctx) {
    const { companyId, startDate, startTime, endTime } = ctx.request
    if (!(await hasWorkingDay(companyId, startDate, startDate))) {
      throw apiErrors.fieldError(
        "startDate",
        "NO_WORKING_DAYS",
        "not a working day"
      )
    }
    const settings = await getCompanySettings(companyId, ctx.deps)
    const errors: FieldError[] = []
    if (startTime! < settings.workStartTime) {
      errors.push({
        field: "startTime",
        code: "OUT_OF_RANGE",
        message: `within working hours (from ${settings.workStartTime})`,
      })
    }
    if (endTime! > settings.workEndTime) {
      errors.push({
        field: "endTime",
        code: "OUT_OF_RANGE",
        message: `within working hours (until ${settings.workEndTime})`,
      })
    }
    if (errors.length) throw apiErrors.validationFailed(errors)
  },
  ...onAttendanceChange,
}

// ─────────────────────────────── Attendance correction ───────────────────────────────

const correctionData = z
  .object({
    checkInTime: z
      .string()
      .regex(LOCAL_TIME, "must be a time (HH:mm)")
      .nullable()
      .optional(),
    checkOutTime: z
      .string()
      .regex(LOCAL_TIME, "must be a time (HH:mm)")
      .nullable()
      .optional(),
  })
  .refine((d) => d.checkInTime || d.checkOutTime, {
    message: "give a check-in and/or a check-out time",
    path: ["checkInTime"],
  })
type CorrectionData = z.infer<typeof correctionData>

/**
 * Turns the proposed times into corrections of the day (BE-07):
 *  - no session that day: one session from check-in to check-out (both needed);
 *  - otherwise: check-in moves the first session's start, check-out sets the
 *    last session's end (e.g. a missing check-out).
 */
async function correctionPlan(
  request: RequestRecord,
  deps: HookContext["deps"]
) {
  const data = request.data as CorrectionData
  const rules = await getAttendanceRules(request.companyId)
  const zone = timezoneOn(rules!, request.startDate)
  const at = (time: string) => instantAt(request.startDate, time, zone)
  const { sessions } = await dayDetail(
    {
      companyId: request.companyId,
      employeeId: request.requesterId,
      date: request.startDate,
      withDevice: false,
    },
    deps
  )
  return { data, sessions, at }
}

const correction: RequestTypeDefinition = {
  key: ATTENDANCE_CORRECTION,
  label: "Attendance correction",
  // Corrections protect data integrity: HR/Admin only (BE-11).
  approverPolicy: "ADMIN_ONLY",
  dates: "SINGLE_DAY",
  times: "NONE",
  reason: "REQUIRED",
  data: correctionData,
  fields: [
    { name: "checkInTime", kind: "time", required: false },
    { name: "checkOutTime", kind: "time", required: false },
  ],
  colleagueVisibility: "HIDDEN",
  async validate(ctx) {
    const { companyId, requesterId, startDate } = ctx.request
    const today = (await loadCompanyToday(companyId, ctx.deps.clock.now()))!
    if (startDate > today) {
      throw apiErrors.fieldError(
        "startDate",
        "OUT_OF_RANGE",
        "can't correct a future day"
      )
    }
    if (startDate < addDays(today, -CORRECTION_DAYS_BACK)) {
      throw apiErrors.fieldError(
        "startDate",
        "OUT_OF_RANGE",
        `at most ${CORRECTION_DAYS_BACK} days back`
      )
    }
    const detail = await dayDetail(
      {
        companyId,
        employeeId: requesterId,
        date: startDate,
        withDevice: false,
      },
      ctx.deps
    )
    const hasRecord = Boolean(detail.day.recordId) || detail.sessions.length > 0
    if (!hasRecord && !(await hasWorkingDay(companyId, startDate, startDate))) {
      throw apiErrors.fieldError(
        "startDate",
        "NO_WORKING_DAYS",
        "not a working day and nothing recorded"
      )
    }
    const data = ctx.request.data as CorrectionData
    if (!detail.sessions.length && !(data.checkInTime && data.checkOutTime)) {
      throw apiErrors.fieldError(
        data.checkInTime ? "data.checkOutTime" : "data.checkInTime",
        "REQUIRED",
        "nothing is recorded that day: give both times"
      )
    }
  },
  /** On approval the BE-07 correction service applies it, with the request in its history. */
  async onApprove(ctx) {
    const { data, sessions, at } = await correctionPlan(ctx.request, ctx.deps)
    const base = {
      companyId: ctx.request.companyId,
      employeeId: ctx.request.requesterId,
      date: ctx.request.startDate,
      reason: ctx.request.reason,
      actor: ctx.actor,
      requestId: ctx.request.id,
    }
    if (!sessions.length) {
      await correctAttendance(
        {
          ...base,
          operation: {
            type: "add",
            checkInAt: at(data.checkInTime!),
            checkOutAt: at(data.checkOutTime!),
          },
        },
        ctx.deps
      )
      return
    }
    const first = sessions[0]!
    const last = sessions.at(-1)!
    if (first.id === last.id) {
      await correctAttendance(
        {
          ...base,
          operation: {
            type: "edit",
            sessionId: first.id,
            checkInAt: data.checkInTime ? at(data.checkInTime) : undefined,
            checkOutAt: data.checkOutTime ? at(data.checkOutTime) : undefined,
          },
        },
        ctx.deps
      )
      return
    }
    if (data.checkInTime) {
      await correctAttendance(
        {
          ...base,
          operation: {
            type: "edit",
            sessionId: first.id,
            checkInAt: at(data.checkInTime),
          },
        },
        ctx.deps
      )
    }
    if (data.checkOutTime) {
      await correctAttendance(
        {
          ...base,
          operation: {
            type: "edit",
            sessionId: last.id,
            checkOutAt: at(data.checkOutTime),
          },
        },
        ctx.deps
      )
    }
  },
}

let registered = false

/** Registers the four types on the engine, once. */
export function registerWorkplaceRequestTypes(): void {
  if (registered) return
  registered = true
  for (const definition of [wfh, businessTrip, permission, correction]) {
    registerRequestType(definition)
  }
}
