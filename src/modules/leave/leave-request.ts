import { z } from "zod"

import {
  apiErrors,
  type ErrorCode,
  type FieldError,
} from "../../platform/http/errors.ts"
import type { Clock } from "../../platform/time/clock.ts"
import { addDays, type PlainDate } from "../../platform/time/time.ts"
import type { HistoryActor } from "../history/history.service.ts"
import type { AuthContext } from "../identity/authenticate.ts"
import {
  availabilityViewer,
  presentAvailability,
} from "../identity/availability.ts"
import {
  holidayOn,
  isWorkingDay,
  loadCompanyToday,
  loadWorkCalendar,
  type WorkCalendar,
} from "../organization/calendar.ts"
import { getRoster } from "../organization/organization.service.ts"
import { getCompanySettings } from "../organization/settings.service.ts"
import { findOverlappingRequests } from "../requests/engine.ts"
import {
  registerRequestType,
  type HookContext,
  type RequestRecord,
} from "../requests/registry.ts"
import { recalcAttendance } from "../requests/request-types.ts"
import { leaveYearOf, leaveYearRange, type DayAmount } from "./balance-math.ts"
import {
  deductApprovedDays,
  getBalance,
  releaseReservation,
  reserveDays,
  restoreDays,
} from "./balance.service.ts"
import { getLeaveType, type LeaveTypeView } from "./leave-types.service.ts"

/**
 * The Leave request type (Trello BE-10), registered on the request engine
 * (BE-09). Its rules: working days only (weekends and holidays excluded), half
 * days on the first/last day, no overlap with the requester's other leave or
 * their WFH days and business trips, date limits, and balance effects for
 * every step (BE-08).
 */
export const LEAVE = "LEAVE"

export const HALVES = ["MORNING", "AFTERNOON"] as const
export type Half = (typeof HALVES)[number]

/** Request types leave may not overlap (pending or approved): WFH and business trips (BE-11). */
export const BLOCKING_TYPES = ["WFH", "BUSINESS_TRIP"]

/** How far back an employee may request leave (sick/emergency after the fact). */
export const MAX_DAYS_IN_PAST = 30

export const leaveData = z.object({
  leaveTypeId: z.uuid(),
  /** Which half of the first day is taken (a range can only start in the AFTERNOON) */
  firstDayHalf: z.enum(HALVES).nullable().optional(),
  /** Which half of the last day is taken (a range can only end in the MORNING) */
  lastDayHalf: z.enum(HALVES).nullable().optional(),
})
export type LeaveData = z.infer<typeof leaveData>

type Deps = { clock: Clock }

// ─────────────────────────────── day counting ───────────────────────────────

export type LeaveDays = {
  /** working days counted (halves as 0.5) */
  days: number
  /** the counted days, per date */
  breakdown: DayAmount[]
  /** days in the range that don't count */
  excluded: {
    date: PlainDate
    reason: "WEEKEND" | "HOLIDAY"
    holiday: string | null
  }[]
}

const isHalf = (
  record: { startDate: PlainDate; endDate: PlainDate },
  data: LeaveData,
  date: PlainDate
) =>
  (date === record.startDate && Boolean(data.firstDayHalf)) ||
  (date === record.endDate &&
    date !== record.startDate &&
    Boolean(data.lastDayHalf))

export async function countLeaveDays(input: {
  companyId: string
  startDate: PlainDate
  endDate: PlainDate
  data: LeaveData
}): Promise<LeaveDays> {
  const calendar = await loadWorkCalendar({
    companyId: input.companyId,
    from: input.startDate,
    to: input.endDate,
  })
  if (!calendar) throw apiErrors.notFound()
  return countLeaveDaysWith(calendar, input)
}

/** countLeaveDays() with a calendar already loaded (covering the request's dates), e.g. for reports. */
export function countLeaveDaysWith(
  calendar: WorkCalendar,
  input: { startDate: PlainDate; endDate: PlainDate; data: LeaveData }
): LeaveDays {
  const result: LeaveDays = { days: 0, breakdown: [], excluded: [] }
  for (
    let date = input.startDate;
    date <= input.endDate;
    date = addDays(date, 1)
  ) {
    if (!isWorkingDay(calendar, date)) {
      const holiday = holidayOn(calendar, date)
      result.excluded.push({
        date,
        reason: holiday ? "HOLIDAY" : "WEEKEND",
        holiday: holiday?.name ?? null,
      })
      continue
    }
    const days = isHalf(input, input.data, date) ? 0.5 : 1
    result.breakdown.push({ date, days })
    result.days += days
  }
  return result
}

// ─────────────────────────────── the rules ───────────────────────────────

export type LeaveProblem = {
  status: 409 | 422
  code: ErrorCode | FieldError["code"]
  field: string | null
  message: string
}

export type LeaveCheck = {
  leaveType: LeaveTypeView | null
  year: number | null
  days: LeaveDays | null
  problems: LeaveProblem[]
  /** the requester's WFH or business trips on the same days (they block the leave) */
  conflicts: RequestRecord[]
}

const field = (
  name: string,
  code: FieldError["code"],
  message: string
): LeaveProblem => ({ status: 422, code, field: name, message })

/**
 * Every rule a leave request must pass, collected (the preview shows them
 * all; submission refuses with the first kind found). The balance is checked
 * here for the preview, and again under the balance lock on submission.
 */
export async function checkLeave(
  input: {
    companyId: string
    requesterId: string
    startDate: PlainDate
    endDate: PlainDate
    data: LeaveData
    reason: string | null
    /** an Admin recording it for the employee: no limit on past dates */
    onBehalf: boolean
    excludeRequestId?: string
    withBalance: boolean
  },
  deps: Deps
): Promise<LeaveCheck> {
  const { companyId, startDate, endDate, data } = input
  const problems: LeaveProblem[] = []
  const result: LeaveCheck = {
    leaveType: null,
    year: null,
    days: null,
    problems,
    conflicts: [],
  }

  const leaveType = await getLeaveType({ companyId, id: data.leaveTypeId })
  if (!leaveType || leaveType.archived) {
    problems.push(
      field(
        "data.leaveTypeId",
        "UNKNOWN_REFERENCE",
        "no active leave type with this id"
      )
    )
    return result
  }
  result.leaveType = leaveType
  if (leaveType.requiresReason && !input.reason?.trim()) {
    problems.push(
      field("reason", "REQUIRED", `a reason is required for ${leaveType.name}`)
    )
  }

  const single = startDate === endDate
  if ((data.firstDayHalf || data.lastDayHalf) && !leaveType.halfDaysAllowed) {
    problems.push(
      field(
        data.firstDayHalf ? "data.firstDayHalf" : "data.lastDayHalf",
        "INVALID_FORMAT",
        `${leaveType.name} can't be taken in half days`
      )
    )
  }
  if (single && data.lastDayHalf) {
    problems.push(
      field(
        "data.lastDayHalf",
        "INVALID_FORMAT",
        "a single day uses firstDayHalf only"
      )
    )
  }
  if (!single && data.firstDayHalf === "MORNING") {
    problems.push(
      field(
        "data.firstDayHalf",
        "OUT_OF_RANGE",
        "a leave of several days can only start at noon (AFTERNOON)"
      )
    )
  }
  if (!single && data.lastDayHalf === "AFTERNOON") {
    problems.push(
      field(
        "data.lastDayHalf",
        "OUT_OF_RANGE",
        "a leave of several days can only end at noon (MORNING)"
      )
    )
  }

  const [settings, today] = await Promise.all([
    getCompanySettings(companyId, deps),
    loadCompanyToday(companyId, deps.clock.now()),
  ])
  const startMonth = settings.leaveYearStartMonth
  const year = leaveYearOf(startDate, startMonth)
  result.year = year
  if (!input.onBehalf && startDate < addDays(today!, -MAX_DAYS_IN_PAST)) {
    problems.push(
      field(
        "startDate",
        "OUT_OF_RANGE",
        `at most ${MAX_DAYS_IN_PAST} days in the past; ask HR to record older leave`
      )
    )
  }
  const lastAllowed = leaveYearRange(
    leaveYearOf(today!, startMonth) + 1,
    startMonth
  ).end
  if (endDate > lastAllowed) {
    problems.push(
      field(
        "endDate",
        "OUT_OF_RANGE",
        `at most until ${lastAllowed} (end of next leave year)`
      )
    )
  }
  if (leaveYearOf(endDate, startMonth) !== year) {
    problems.push(
      field(
        "endDate",
        "CROSSES_LEAVE_YEAR",
        `split it into two requests: one up to ${leaveYearRange(year, startMonth).end}, one from the next day`
      )
    )
  }

  const days = await countLeaveDays({ companyId, startDate, endDate, data })
  result.days = days
  if (days.days === 0) {
    problems.push(
      field("endDate", "NO_WORKING_DAYS", "no working days in this range")
    )
  }

  const overlapping = await findOverlappingRequests({
    companyId,
    from: startDate,
    to: endDate,
    requesterId: input.requesterId,
    statuses: ["PENDING", "APPROVED", "CANCELLATION_REQUESTED"],
    excludeId: input.excludeRequestId,
  })
  const otherLeave = overlapping.find((r) => r.type === LEAVE)
  if (otherLeave) {
    problems.push({
      status: 409,
      code: "REQUEST_OVERLAP",
      field: null,
      message: `Overlaps your leave from ${otherLeave.startDate} to ${otherLeave.endDate}`,
    })
  }
  // Leave can't share days with a WFH day or business trip (decision
  // 2026-10-10; BE-11 applies the same rule the other way round).
  result.conflicts = overlapping.filter((r) => BLOCKING_TYPES.includes(r.type))
  for (const other of result.conflicts) {
    const label = other.type === "WFH" ? "WFH request" : "business trip"
    problems.push({
      status: 409,
      code: "REQUEST_OVERLAP",
      field: null,
      message: `You have a ${label} from ${other.startDate} to ${other.endDate} on these days; withdraw or cancel it first`,
    })
  }

  if (
    input.withBalance &&
    leaveType.tracksBalance &&
    !leaveType.allowNegativeBalance &&
    days.days > 0
  ) {
    const balance = await getBalance(
      {
        companyId,
        employeeId: input.requesterId,
        leaveTypeId: leaveType.id,
        year,
      },
      deps
    )
    if (balance.available! < days.days) {
      problems.push({
        status: 409,
        code: "INSUFFICIENT_BALANCE",
        field: null,
        message: `Only ${balance.available} day(s) available`,
      })
    }
  }
  return result
}

/** Turns the problems into the error a submission gets: field errors first. */
function refuse(problems: LeaveProblem[]): void {
  const fields = problems.filter((p) => p.status === 422)
  if (fields.length) {
    throw apiErrors.validationFailed(
      fields.map((p) => ({
        field: p.field!,
        code: p.code as FieldError["code"],
        message: p.message,
      }))
    )
  }
  const conflict = problems.find((p) => p.status === 409)
  if (conflict)
    throw apiErrors.conflictWith(conflict.code as ErrorCode, conflict.message)
}

// ─────────────────────────────── preview ───────────────────────────────

/**
 * The form's preview (BE-10): days counted and excluded, the balance before
 * and after, every problem a submission would hit (including the requester's
 * WFH/trips on those days, which block it), and who else is off — as the caller may see them (BE-03:
 * an Employee sees same-department colleagues by name only).
 */
export async function previewLeave(
  input: {
    auth: AuthContext
    employeeId: string
    startDate: PlainDate
    endDate: PlainDate
    data: LeaveData
    reason: string | null
  },
  deps: Deps
) {
  const { auth, employeeId, startDate, endDate } = input
  const check = await checkLeave(
    {
      companyId: auth.companyId,
      requesterId: employeeId,
      startDate,
      endDate,
      data: input.data,
      reason: input.reason,
      onBehalf: employeeId !== auth.userId,
      withBalance: true,
    },
    deps
  )
  let balance = null
  if (check.leaveType && check.year !== null) {
    const view = await getBalance(
      {
        companyId: auth.companyId,
        employeeId,
        leaveTypeId: check.leaveType.id,
        year: check.year,
      },
      deps
    )
    balance = {
      tracked: view.tracked,
      year: view.year,
      available: view.available,
      availableAfter:
        view.available === null
          ? null
          : view.available - (check.days?.days ?? 0),
    }
  }
  return {
    leaveType: check.leaveType
      ? { id: check.leaveType.id, name: check.leaveType.name }
      : null,
    days: check.days?.days ?? 0,
    workingDays: check.days?.breakdown ?? [],
    excluded: check.days?.excluded ?? [],
    balance,
    problems: check.problems.map(({ code, field, message }) => ({
      code,
      field,
      message,
    })),
    conflicts: check.conflicts.map((r) => ({
      requestId: r.id,
      type: r.type,
      startDate: r.startDate,
      endDate: r.endDate,
      status: r.status,
    })),
    teamOff: await whoIsOff(auth, employeeId, startDate, endDate),
  }
}

async function whoIsOff(
  auth: AuthContext,
  employeeId: string,
  from: PlainDate,
  to: PlainDate
) {
  const leave = (
    await findOverlappingRequests({
      companyId: auth.companyId,
      from,
      to,
      types: [LEAVE],
      statuses: ["APPROVED", "CANCELLATION_REQUESTED"],
    })
  ).filter((r) => r.requesterId !== employeeId)
  if (!leave.length) return []
  const [viewer, roster] = await Promise.all([
    availabilityViewer(auth),
    getRoster({
      companyId: auth.companyId,
      ids: [...new Set(leave.map((r) => r.requesterId))],
    }),
  ])
  const people = new Map(roster.map((p) => [p.id, p]))
  const seen = new Set<string>()
  const off = []
  for (const request of leave) {
    const person = people.get(request.requesterId)
    if (!person || seen.has(person.id)) continue
    const shown = presentAvailability(viewer, {
      employeeId: person.id,
      name: person.name,
      departmentId: person.departmentId,
      kind: "LEAVE" as const,
      startDate: request.startDate,
      endDate: request.endDate,
    })
    if (!shown) continue
    seen.add(person.id)
    off.push(
      "status" in shown
        ? { employeeId: shown.employeeId, name: shown.name }
        : {
            employeeId: shown.employeeId,
            name: shown.name,
            startDate: shown.startDate,
            endDate: shown.endDate,
          }
    )
  }
  return off
}

// ─────────────────────────────── the type ───────────────────────────────

const dataOf = (request: RequestRecord) => leaveData.parse(request.data)

async function balanceKey(ctx: HookContext) {
  const data = dataOf(ctx.request)
  const settings = await getCompanySettings(ctx.request.companyId, ctx.deps)
  return {
    companyId: ctx.request.companyId,
    employeeId: ctx.request.requesterId,
    leaveTypeId: data.leaveTypeId,
    year: leaveYearOf(ctx.request.startDate, settings.leaveYearStartMonth),
    requestId: ctx.request.id,
    actor: ctx.actor as HistoryActor,
  }
}

let registered = false

/** Registers Leave on the request engine, once. */
export function registerLeaveRequestType(): void {
  if (registered) return
  registered = true
  registerRequestType({
    key: LEAVE,
    label: "Leave",
    approverPolicy: "MANAGER_WITH_ADMIN_FALLBACK",
    dates: "RANGE",
    times: "NONE",
    // Required or not per leave type: checked in validate().
    reason: "OPTIONAL",
    data: leaveData,
    fields: [
      { name: "leaveTypeId", kind: "leaveType", required: true },
      {
        name: "firstDayHalf",
        kind: "choice",
        required: false,
        options: [...HALVES],
      },
      {
        name: "lastDayHalf",
        kind: "choice",
        required: false,
        options: ["MORNING"],
      },
    ],
    colleagueVisibility: "OUT",
    dayEffect: (request, date) => ({
      kind: "LEAVE",
      fullDay: !isHalf(request, dataOf(request), date),
    }),
    async validate(ctx) {
      const check = await checkLeave(
        {
          companyId: ctx.request.companyId,
          requesterId: ctx.request.requesterId,
          startDate: ctx.request.startDate,
          endDate: ctx.request.endDate,
          data: ctx.data as LeaveData,
          reason: ctx.request.reason,
          onBehalf:
            ctx.actor.type === "USER" &&
            ctx.actor.userId !== ctx.request.requesterId,
          // Checked under the balance lock when the days are reserved.
          withBalance: false,
        },
        ctx.deps
      )
      refuse(check.problems)
    },
    async onSubmit(ctx) {
      const { days } = await countLeaveDays({
        ...ctx.request,
        data: dataOf(ctx.request),
      })
      await reserveDays({ ...(await balanceKey(ctx)), days }, ctx.deps)
    },
    async onApprove(ctx) {
      const { breakdown } = await countLeaveDays({
        ...ctx.request,
        data: dataOf(ctx.request),
      })
      await deductApprovedDays(
        { ...(await balanceKey(ctx)), breakdown },
        ctx.deps
      )
      await recalcAttendance(ctx)
    },
    async onReject(ctx) {
      await releaseReservation(await balanceKey(ctx), ctx.deps)
    },
    async onCancel(ctx) {
      if (ctx.from === "PENDING") {
        await releaseReservation(await balanceKey(ctx), ctx.deps)
        return
      }
      await restoreDays(await balanceKey(ctx), ctx.deps)
      await recalcAttendance(ctx)
    },
  })
}
