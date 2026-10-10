import { apiErrors } from "../../platform/http/errors.ts"
import type { Clock } from "../../platform/time/clock.ts"
import { addDays, type PlainDate } from "../../platform/time/time.ts"
import { scopedEmployeeIds } from "../identity/access.ts"
import { getAccounts } from "../identity/accounts.ts"
import type { AuthContext } from "../identity/authenticate.ts"
import { listLeaveTypes } from "../leave/leave-types.service.ts"
import {
  holidayOn,
  isWorkingDay,
  loadWorkCalendar,
} from "../organization/calendar.ts"
import {
  getReportingLine,
  getRoster,
  listDirectReportIds,
  type RosterEntry,
} from "../organization/organization.service.ts"
import { findOverlappingRequests } from "../requests/engine.ts"
import type { RequestRecord } from "../requests/registry.ts"

/**
 * The company calendar and availability (Trello BE-12): approved leave, WFH,
 * business trips and permissions, plus holidays, for a date range, as each
 * viewer may see them.
 *
 *  - Admin: the whole company, in full detail.
 *  - Manager: themselves and their direct reports, in full detail; nothing
 *    about other teams.
 *  - Employee: themselves in full; colleagues in their own department only
 *    as name + "Out" (leave) or name + "WFH" (decisions 2026-10-09); never
 *    colleagues' trips or permissions.
 *
 * Pending requests can be added as tentative for the people the caller sees
 * in detail. Rejected, withdrawn and cancelled requests never appear.
 * Attendance actuals (late, absent) are not part of the calendar.
 */
type Deps = { clock: Clock }

/** The longest range one call answers. */
export const MAX_RANGE_DAYS = 92

export const EVENT_KINDS = [
  "LEAVE",
  "WFH",
  "BUSINESS_TRIP",
  "PERMISSION",
  "HOLIDAY",
] as const
export type EventKind = (typeof EVENT_KINDS)[number]

const REQUEST_KINDS: EventKind[] = [
  "LEAVE",
  "WFH",
  "BUSINESS_TRIP",
  "PERMISSION",
]

export type CalendarFilters = {
  departmentId?: string
  /** only the caller's direct reports */
  team?: boolean
  employeeId?: string
  kinds?: EventKind[]
}

export function assertRange(from: PlainDate, to: PlainDate): void {
  if (to < from) {
    throw apiErrors.fieldError(
      "to",
      "OUT_OF_RANGE",
      "to must be on or after from"
    )
  }
  if (addDays(from, MAX_RANGE_DAYS - 1) < to) {
    throw apiErrors.fieldError(
      "to",
      "OUT_OF_RANGE",
      `at most ${MAX_RANGE_DAYS} days (3 months)`
    )
  }
}

type Audience = {
  /** people the caller sees in full detail ("ALL" for Admins) */
  detail: "ALL" | Set<string>
  /** colleagues the caller sees only as Out / WFH (Employees: same department) */
  colleagues: Set<string>
}

async function audienceOf(auth: AuthContext): Promise<Audience> {
  const detail = await scopedEmployeeIds(auth, "requests", "view")
  const colleagues = new Set<string>()
  if (auth.role === "EMPLOYEE") {
    const line = await getReportingLine({
      id: auth.userId,
      companyId: auth.companyId,
    })
    if (line?.departmentId) {
      const members = await getRoster({
        companyId: auth.companyId,
        departmentId: line.departmentId,
      })
      for (const member of members)
        if (member.id !== auth.userId) colleagues.add(member.id)
    }
  }
  return { detail: detail === "ALL" ? "ALL" : new Set(detail), colleagues }
}

const inDetail = (audience: Audience, id: string) =>
  audience.detail === "ALL" || audience.detail.has(id)

/** The people the filters select, among those the caller may see at all. */
async function selectPeople(
  auth: AuthContext,
  audience: Audience,
  filters: CalendarFilters
): Promise<RosterEntry[]> {
  let ids: string[] | undefined =
    audience.detail === "ALL"
      ? undefined
      : [...audience.detail, ...audience.colleagues]
  if (filters.team) {
    const reports = await listDirectReportIds({
      managerId: auth.userId,
      companyId: auth.companyId,
    })
    ids = ids ? ids.filter((id) => reports.includes(id)) : reports
  }
  if (filters.employeeId) {
    ids = (ids ?? [filters.employeeId]).filter(
      (id) => id === filters.employeeId
    )
  }
  if (ids && ids.length === 0) return []
  return getRoster({
    companyId: auth.companyId,
    ids,
    departmentId: filters.departmentId,
  })
}

export type CalendarEvent =
  | {
      kind: "HOLIDAY"
      id: string
      name: string
      startDate: PlainDate
      endDate: PlainDate
    }
  | {
      kind: Exclude<EventKind, "HOLIDAY">
      requestId: string
      tentative: boolean
      employee: { id: string; name: string }
      startDate: PlainDate
      endDate: PlainDate
      startTime: string | null
      endTime: string | null
      /** full detail only */
      leaveType?: { id: string; name: string } | null
      reason?: string | null
      destination?: string | null
      purpose?: string | null
    }
  | {
      /** a colleague's day, availability only (Employee viewers) */
      kind: "OUT" | "WFH"
      colleague: true
      employee: { id: string; name: string }
      startDate: PlainDate
      endDate: PlainDate
    }

const kindOf = (type: string): Exclude<EventKind, "HOLIDAY"> | null =>
  type === "LEAVE" ||
  type === "WFH" ||
  type === "BUSINESS_TRIP" ||
  type === "PERMISSION"
    ? type
    : null

/** Events for [from, to], sorted by start date (holidays first on a day). */
export async function calendarEvents(
  input: {
    auth: AuthContext
    from: PlainDate
    to: PlainDate
    filters: CalendarFilters
    includePending: boolean
  },
  deps: Deps
): Promise<CalendarEvent[]> {
  void deps
  const { auth, from, to, filters } = input
  assertRange(from, to)
  const kinds = new Set(filters.kinds ?? EVENT_KINDS)
  const audience = await audienceOf(auth)
  const people = await selectPeople(auth, audience, filters)
  const byId = new Map(people.map((p) => [p.id, p]))
  const events: CalendarEvent[] = []

  if (kinds.has("HOLIDAY")) {
    const calendar = await loadWorkCalendar({
      companyId: auth.companyId,
      from,
      to,
    })
    for (const h of calendar?.holidays ?? []) {
      events.push({
        kind: "HOLIDAY",
        id: h.id,
        name: h.name,
        startDate: h.startDate,
        endDate: h.endDate,
      })
    }
  }

  const requestKinds = REQUEST_KINDS.filter((k) => kinds.has(k))
  if (requestKinds.length && byId.size) {
    const requests = await findOverlappingRequests({
      companyId: auth.companyId,
      from,
      to,
      types: requestKinds,
      statuses: input.includePending
        ? ["APPROVED", "CANCELLATION_REQUESTED", "PENDING"]
        : ["APPROVED", "CANCELLATION_REQUESTED"],
    })
    const leaveTypes = new Map(
      (
        await listLeaveTypes({
          companyId: auth.companyId,
          includeArchived: true,
        })
      ).map((t) => [t.id, t.name])
    )
    for (const request of requests) {
      const person = byId.get(request.requesterId)
      const kind = kindOf(request.type)
      if (!person || !kind) continue
      const event = present(audience, person, kind, request, leaveTypes)
      if (event) events.push(event)
    }
  }
  return events.sort(
    (a, b) =>
      a.startDate.localeCompare(b.startDate) ||
      Number(b.kind === "HOLIDAY") - Number(a.kind === "HOLIDAY")
  )
}

function present(
  audience: Audience,
  person: RosterEntry,
  kind: Exclude<EventKind, "HOLIDAY">,
  request: RequestRecord,
  leaveTypes: Map<string, string>
): CalendarEvent | null {
  const employee = { id: person.id, name: person.name }
  if (inDetail(audience, person.id)) {
    const data = request.data as Record<string, string | undefined>
    return {
      kind,
      requestId: request.id,
      tentative: request.status === "PENDING",
      employee,
      startDate: request.startDate,
      endDate: request.endDate,
      startTime: request.startTime,
      endTime: request.endTime,
      reason: request.reason,
      leaveType:
        kind === "LEAVE" && data.leaveTypeId
          ? {
              id: data.leaveTypeId,
              name: leaveTypes.get(data.leaveTypeId) ?? "",
            }
          : null,
      destination: data.destination ?? null,
      purpose: data.purpose ?? null,
    }
  }
  // A colleague: approved leave and WFH only, as Out / WFH, nothing else.
  if (!audience.colleagues.has(person.id) || request.status === "PENDING")
    return null
  if (kind !== "LEAVE" && kind !== "WFH") return null
  return {
    kind: kind === "LEAVE" ? "OUT" : "WFH",
    colleague: true,
    employee,
    startDate: request.startDate,
    endDate: request.endDate,
  }
}

// ─────────────────────────────── availability ───────────────────────────────

export type DayAvailability = {
  date: PlainDate
  working: boolean
  holiday: string | null
  /** people in scope expected that day (joined, not past their last day) */
  total: number
  out: number
  wfh: number
  inOffice: number
}

/**
 * Per day: how many people in the selected scope are out (leave, or a
 * business trip for people seen in detail), working from home, or in the
 * office. Approved requests only. Non-working days count nobody.
 */
export async function availability(
  input: {
    auth: AuthContext
    from: PlainDate
    to: PlainDate
    filters: CalendarFilters
  },
  deps: Deps
): Promise<DayAvailability[]> {
  void deps
  const { auth, from, to } = input
  assertRange(from, to)
  const audience = await audienceOf(auth)
  const people = await selectPeople(auth, audience, input.filters)
  const accounts = await getAccounts({
    companyId: auth.companyId,
    ids: people.map((p) => p.id),
  })
  const calendar = await loadWorkCalendar({
    companyId: auth.companyId,
    from,
    to,
  })
  const requests = people.length
    ? await findOverlappingRequests({
        companyId: auth.companyId,
        from,
        to,
        types: ["LEAVE", "WFH", "BUSINESS_TRIP"],
        statuses: ["APPROVED", "CANCELLATION_REQUESTED"],
      })
    : []

  const days: DayAvailability[] = []
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const working = Boolean(calendar && isWorkingDay(calendar, date))
    const holiday = (calendar && holidayOn(calendar, date)?.name) ?? null
    const present = working
      ? people.filter((p) => {
          const account = accounts.get(p.id)
          if (!account || account.status === "INVITED") return false
          if (account.status === "DEACTIVATED" && !account.lastWorkingDay)
            return false
          if (account.lastWorkingDay && date > account.lastWorkingDay)
            return false
          return !p.joiningDate || p.joiningDate <= date
        })
      : []
    let out = 0
    let wfh = 0
    for (const person of present) {
      const covering = requests.filter(
        (r) =>
          r.requesterId === person.id &&
          r.startDate <= date &&
          date <= r.endDate
      )
      // A colleague's trip is never revealed to an Employee: they count as in.
      const visible = covering.filter(
        (r) => inDetail(audience, person.id) || r.type !== "BUSINESS_TRIP"
      )
      if (visible.some((r) => r.type === "LEAVE" || r.type === "BUSINESS_TRIP"))
        out += 1
      else if (visible.some((r) => r.type === "WFH")) wfh += 1
    }
    days.push({
      date,
      working,
      holiday,
      total: present.length,
      out,
      wfh,
      inOffice: present.length - out - wfh,
    })
  }
  return days
}
