import type { CsvCell } from "../../platform/csv.ts"
import { apiErrors } from "../../platform/http/errors.ts"
import type { Clock } from "../../platform/time/clock.ts"
import {
  addDays,
  plainDateInZone,
  secondsIntoDay,
  type PlainDate,
} from "../../platform/time/time.ts"
import type {
  AttendanceFlag,
  AttendanceStatus,
} from "../attendance/attendance.model.ts"
import { dayStatuses } from "../attendance/attendance.service.ts"
import { getAccounts, type Account } from "../identity/accounts.ts"
import type { AuthContext } from "../identity/authenticate.ts"
import type { Role, UserStatus } from "../identity/user.model.ts"
import { leaveYearOf, leaveYearRange } from "../leave/balance-math.ts"
import { balanceSummaries } from "../leave/balance.service.ts"
import { countLeaveDaysWith, type LeaveData } from "../leave/leave-request.ts"
import { listLeaveTypes } from "../leave/leave-types.service.ts"
import {
  companyToday,
  isWorkingDay,
  loadWorkCalendar,
  timezoneAt,
  weekdayOf,
  type WorkCalendar,
} from "../organization/calendar.ts"
import { getDepartmentNames } from "../organization/departments.service.ts"
import {
  getEmployeeNames,
  getReportingLine,
  getRoster,
  listDirectReportIds,
  type RosterEntry,
} from "../organization/organization.service.ts"
import {
  getAttendanceRules,
  getCompanySettings,
} from "../organization/settings.service.ts"
import {
  listRequestsForReport,
  type ReportRequest,
} from "../requests/engine.ts"
import type { RequestStatus } from "../requests/request.model.ts"

/**
 * Reports (Trello BE-14): attendance, leave and WFH, each as rows for the
 * screen (paginated by the route) and as a CSV built from the very same rows,
 * so the file always matches the screen.
 *
 * Every attendance number comes from dayStatuses() (BE-07), the source the
 * dashboards (BE-13) use too. Leave balances come from the ledger (BE-08),
 * registers from the request engine (BE-09). Reports read only; nothing is
 * created by looking at one.
 *
 * Who is in a report: the employees in the caller's scope (self, team or
 * company) who were employed at some point in the range. Attendance reports
 * list attendance-tracked people only, not still-invited accounts.
 */
type Deps = { clock: Clock }

// ─────────────────────────────── range ───────────────────────────────

export const MAX_RANGE_MONTHS = 13
export const RANGE_PRESETS = [
  "THIS_MONTH",
  "LAST_MONTH",
  "THIS_LEAVE_YEAR",
] as const
export type RangePreset = (typeof RANGE_PRESETS)[number]

const monthEnd = (date: PlainDate) =>
  addDays(`${addDays(`${date.slice(0, 7)}-01`, 31).slice(0, 7)}-01`, -1)

/** The same day `months` later, or that month's last day when it is shorter. */
export function addMonths(date: PlainDate, months: number): PlainDate {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number]
  const index = y * 12 + (m - 1) + months
  const first = `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}-01`
  const last = monthEnd(first)
  const day = `${first.slice(0, 8)}${String(d).padStart(2, "0")}`
  return day > last ? last : day
}

/** The last `to` allowed for a range starting on `from` (13 months, e.g. 1 Jan → 31 Jan next year). */
export const lastDayAllowed = (from: PlainDate) =>
  addDays(addMonths(from, MAX_RANGE_MONTHS), -1)

/**
 * The report's dates: a preset (in the company calendar) or a custom
 * from/to, not both. 422 on `to` when it is before `from` or the range is
 * longer than 13 months.
 */
export function resolveRange(
  input: { preset?: RangePreset; from?: PlainDate; to?: PlainDate },
  company: { today: PlainDate; leaveYearStartMonth: number }
): { from: PlainDate; to: PlainDate } {
  const { today } = company
  if (input.preset) {
    if (input.from || input.to) {
      throw apiErrors.fieldError(
        "preset",
        "INVALID_FORMAT",
        "use either preset or from/to, not both"
      )
    }
    if (input.preset === "THIS_MONTH") {
      return { from: `${today.slice(0, 7)}-01`, to: monthEnd(today) }
    }
    if (input.preset === "LAST_MONTH") {
      const from = addMonths(`${today.slice(0, 7)}-01`, -1)
      return { from, to: monthEnd(from) }
    }
    const year = leaveYearOf(today, company.leaveYearStartMonth)
    const range = leaveYearRange(year, company.leaveYearStartMonth)
    return { from: range.start, to: range.end }
  }
  if (!input.from || !input.to) {
    throw apiErrors.validationFailed(
      (["from", "to"] as const)
        .filter((field) => !input[field])
        .map((field) => ({
          field,
          code: "REQUIRED" as const,
          message: `${field} is required (or use preset)`,
        }))
    )
  }
  if (input.to < input.from || input.to > lastDayAllowed(input.from)) {
    throw apiErrors.fieldError(
      "to",
      "OUT_OF_RANGE",
      `to must be on or after from, at most ${MAX_RANGE_MONTHS} months (until ${lastDayAllowed(input.from)})`
    )
  }
  return { from: input.from, to: input.to }
}

// ─────────────────────────────── scope ───────────────────────────────

export type ReportScope = "self" | "team" | "company"

const SCOPES: Record<Role, readonly ReportScope[]> = {
  EMPLOYEE: ["self"],
  MANAGER: ["team", "self"],
  ADMIN: ["company", "team", "self"],
}

export type ReportFilters = {
  scope?: ReportScope
  departmentId?: string
  managerId?: string
  employeeId?: string
  employeeStatus?: UserStatus[]
}

export type Person = RosterEntry & {
  account: Account | undefined
  departmentName: string | null
}

/** Report context: the company's dates and timezone, and who is in scope. */
export type ReportContext = {
  companyId: string
  scope: ReportScope
  today: PlainDate
  leaveYearStartMonth: number
  /** the company's timezone now (the CSV file name carries it) */
  timezone: string
  rules: NonNullable<Awaited<ReturnType<typeof getAttendanceRules>>>
  people: Person[]
}

/**
 * Who the caller may report on, with the filters applied. The scope defaults
 * to the role's widest (Admin company, Manager team, Employee self); one the
 * role doesn't have is 403. Employees may only see themselves: filtering by
 * department, manager, status or another employee is 403. An employee outside
 * the scope is 404 (BE-03). The team is the caller's active direct reports.
 */
export async function reportContext(
  auth: AuthContext,
  filters: ReportFilters,
  deps: Deps
): Promise<ReportContext> {
  const { companyId } = auth
  const allowed = SCOPES[auth.role]
  const scope = filters.scope ?? allowed[0]!
  if (!allowed.includes(scope)) {
    throw apiErrors.forbidden(`A ${auth.role} can't open ${scope} reports`)
  }
  if (
    auth.role === "EMPLOYEE" &&
    (filters.departmentId ||
      filters.managerId ||
      filters.employeeStatus ||
      (filters.employeeId && filters.employeeId !== auth.userId))
  ) {
    throw apiErrors.forbidden("Employees can only report on themselves")
  }

  let ids: string[] | undefined
  if (scope === "self") ids = [auth.userId]
  if (scope === "team") {
    const reports = await listDirectReportIds({
      managerId: auth.userId,
      companyId,
    })
    const accounts = await getAccounts({ companyId, ids: reports })
    ids = reports.filter((id) => accounts.get(id)?.status !== "DEACTIVATED")
  }
  if (filters.employeeId) {
    const exists = await getReportingLine({ id: filters.employeeId, companyId })
    if (!exists || (ids && !ids.includes(filters.employeeId))) {
      throw apiErrors.notFound()
    }
    ids = [filters.employeeId]
  }

  const [roster, settings, rules] = await Promise.all([
    getRoster({
      companyId,
      ids,
      departmentId: filters.departmentId,
      managerId: filters.managerId,
    }),
    getCompanySettings(companyId, deps),
    getAttendanceRules(companyId),
  ])
  const [accounts, departments] = await Promise.all([
    getAccounts({ companyId, ids: roster.map((p) => p.id) }),
    getDepartmentNames({
      companyId,
      ids: [...new Set(roster.flatMap((p) => p.departmentId ?? []))],
    }),
  ])
  const people = roster
    .map((p) => ({
      ...p,
      account: accounts.get(p.id),
      departmentName: p.departmentId
        ? (departments.get(p.departmentId) ?? null)
        : null,
    }))
    .filter(
      (p) =>
        !filters.employeeStatus ||
        (p.account && filters.employeeStatus.includes(p.account.status))
    )
  return {
    companyId,
    scope,
    today: companyToday(rules!, deps.clock.now()),
    leaveYearStartMonth: settings.leaveYearStartMonth,
    timezone: settings.timezone,
    rules: rules!,
    people,
  }
}

/** Employed at some point from `from` to `to`: joined by the end, not gone before the start. */
export function employedDuring(
  person: Person,
  from: PlainDate,
  to: PlainDate
): boolean {
  const account = person.account
  if (!account) return false
  if (account.status === "DEACTIVATED" && !account.lastWorkingDay) return false
  if (person.joiningDate && person.joiningDate > to) return false
  if (account.lastWorkingDay && account.lastWorkingDay < from) return false
  return true
}

/** The part of the range the person was employed: [start, end]. */
const employment = (person: Person, from: PlainDate, to: PlainDate) => ({
  start:
    person.joiningDate && person.joiningDate > from ? person.joiningDate : from,
  end:
    person.account?.lastWorkingDay && person.account.lastWorkingDay < to
      ? person.account.lastWorkingDay
      : to,
})

const tracked = (person: Person) =>
  person.tracksAttendance && person.account?.status !== "INVITED"

// ─────────────────────────────── shared bits ───────────────────────────────

export type EmployeeRef = {
  id: string
  name: string
  employeeCode: string | null
}

const employeeOf = (p: Person): EmployeeRef => ({
  id: p.id,
  name: p.name,
  employeeCode: p.employeeCode,
})
const departmentOf = (p: Person) =>
  p.departmentId ? { id: p.departmentId, name: p.departmentName } : null

const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100

const datesOf = (from: PlainDate, to: PlainDate) => {
  const dates: PlainDate[] = []
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date)
  return dates
}

/** Requests in effect (approved, or cancellation asked but not decided). */
const IN_EFFECT: RequestStatus[] = ["APPROVED", "CANCELLATION_REQUESTED"]

/** A calendar covering every request's dates and the range. */
async function calendarFor(
  companyId: string,
  requests: readonly { startDate: PlainDate; endDate: PlainDate }[],
  from: PlainDate,
  to: PlainDate
): Promise<WorkCalendar> {
  const start = requests.reduce(
    (min, r) => (r.startDate < min ? r.startDate : min),
    from
  )
  const end = requests.reduce(
    (max, r) => (r.endDate > max ? r.endDate : max),
    to
  )
  const calendar = await loadWorkCalendar({ companyId, from: start, to: end })
  if (!calendar) throw apiErrors.notFound()
  return calendar
}

const leaveDataOf = (r: ReportRequest) => r.data as LeaveData

/** Leave days per date of a leave request (halves as 0.5). */
const leaveDays = (calendar: WorkCalendar, r: ReportRequest) =>
  countLeaveDaysWith(calendar, { ...r, data: leaveDataOf(r) }).breakdown

/** Working days of a WFH / business-trip request, per date. */
const workingDates = (calendar: WorkCalendar, r: ReportRequest) =>
  datesOf(r.startDate, r.endDate)
    .filter((date) => isWorkingDay(calendar, date))
    .map((date) => ({ date, days: 1 }))

const sumIn = (
  days: readonly { date: PlainDate; days: number }[],
  from: PlainDate,
  to: PlainDate
) =>
  days
    .filter((d) => d.date >= from && d.date <= to)
    .reduce((sum, d) => sum + d.days, 0)

/** An instant in company time: "HH:mm" (or "YYYY-MM-DD HH:mm"), for CSV files. */
function localTime(ctx: ReportContext, instant: Date | null, withDate = false) {
  if (!instant) return null
  const zone = timezoneAt(ctx.rules, instant)
  const seconds = secondsIntoDay(instant, zone)
  const time = `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}`
  return withDate ? `${plainDateInZone(instant, zone)} ${time}` : time
}

async function namesOf(companyId: string, ids: (string | null)[]) {
  return getEmployeeNames({
    companyId,
    ids: [...new Set(ids.flatMap((id) => id ?? []))],
  })
}

/** Labels for CSV files: the status names the app shows everywhere (FE-15). */
export const STATUS_LABELS: Record<AttendanceStatus, string> = {
  PRESENT: "Present",
  LATE: "Late",
  ABSENT: "Absent",
  WFH: "WFH",
  ON_LEAVE: "On Leave",
  BUSINESS_TRIP: "Business Trip",
  HOLIDAY: "Holiday",
  WEEKEND: "Weekend",
  MISSING_CHECKOUT: "Missing Checkout",
}
const FLAG_LABELS: Record<AttendanceFlag, string> = {
  WORKED_ON_NON_WORKING_DAY: "Worked on non-working day",
  WORKED_DURING_TIME_OFF: "Worked during time off",
  CORRECTED: "Corrected",
  WFH_NO_CHECK_IN: "WFH no check-in",
}
const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  WITHDRAWN: "Withdrawn",
  CANCELLATION_REQUESTED: "Cancellation requested",
  CANCELLED: "Cancelled",
}
const REQUEST_TYPE_LABELS: Record<string, string> = {
  WFH: "WFH",
  BUSINESS_TRIP: "Business Trip",
}

/** What every report returns: its rows (sorted) and how to write them as CSV. */
export type Report<R> = {
  rows: R[]
  /** rows before pagination (the detail view computes only the page asked for) */
  total: number
  totals?: Record<string, number>
  header: readonly string[]
  csvRow: (row: R) => CsvCell[]
}

export type SortOrder = { field: string; direction: "asc" | "desc" }

/** Sorts by a column (numbers or text), then by employee name, then id. */
function sortRows<R extends { employee: EmployeeRef }>(
  rows: R[],
  sort: SortOrder,
  value: (row: R, field: string) => string | number | null
) {
  const sign = sort.direction === "asc" ? 1 : -1
  const byName = (a: R, b: R) =>
    a.employee.name.localeCompare(b.employee.name) ||
    a.employee.id.localeCompare(b.employee.id)
  return rows.sort((a, b) => {
    const x = value(a, sort.field)
    const y = value(b, sort.field)
    const diff =
      x === y
        ? 0
        : x === null
          ? 1
          : y === null
            ? -1
            : typeof x === "number" && typeof y === "number"
              ? x - y
              : String(x).localeCompare(String(y))
    return diff * sign || byName(a, b)
  })
}

const sumColumns = <R>(rows: R[], columns: readonly (keyof R & string)[]) =>
  Object.fromEntries(
    columns.map((c) => [
      c,
      Math.round(rows.reduce((sum, r) => sum + (r[c] as number), 0) * 100) /
        100,
    ])
  )

// ─────────────────────────────── attendance ───────────────────────────────

export const ATTENDANCE_SUMMARY_COLUMNS = [
  "workingDays",
  "present",
  "late",
  "absent",
  "wfh",
  "onLeave",
  "unpaidLeaveDays",
  "businessTrip",
  "missingCheckouts",
  "notYetRecorded",
  "holidays",
  "workedMinutes",
  "workedHours",
  "corrections",
] as const
type SummaryColumn = (typeof ATTENDANCE_SUMMARY_COLUMNS)[number]

export type AttendanceSummaryRow = {
  employee: EmployeeRef
  department: { id: string; name: string | null } | null
} & Record<SummaryColumn, number>

const STATUS_COLUMN: Partial<Record<AttendanceStatus, SummaryColumn>> = {
  PRESENT: "present",
  LATE: "late",
  ABSENT: "absent",
  WFH: "wfh",
  ON_LEAVE: "onLeave",
  BUSINESS_TRIP: "businessTrip",
  MISSING_CHECKOUT: "missingCheckouts",
}

/** Unpaid leave days in the range per employee, from approved leave of unpaid types. */
async function unpaidLeaveDays(
  ctx: ReportContext,
  people: Person[],
  from: PlainDate,
  to: PlainDate
) {
  const unpaid = (
    await listLeaveTypes({ companyId: ctx.companyId, includeArchived: true })
  )
    .filter((t) => !t.paid)
    .map((t) => t.id)
  const result = new Map<string, number>()
  if (!unpaid.length || !people.length) return result
  const requests = await listRequestsForReport({
    companyId: ctx.companyId,
    types: ["LEAVE"],
    requesterIds: people.map((p) => p.id),
    from,
    to,
    statuses: IN_EFFECT,
    leaveTypeIds: unpaid,
  })
  const calendar = await calendarFor(ctx.companyId, requests, from, to)
  const byId = new Map(people.map((p) => [p.id, p]))
  for (const r of requests) {
    const span = employment(byId.get(r.requesterId)!, from, to)
    const days = sumIn(leaveDays(calendar, r), span.start, span.end)
    result.set(r.requesterId, (result.get(r.requesterId) ?? 0) + days)
  }
  return result
}

/**
 * One row per attendance-tracked employee employed in the range. On each
 * working day they were expected, exactly one of present, late, absent, WFH,
 * on leave, business trip, missing checkout or not yet recorded (today before
 * a check-in, or a future day) counts, so those add up to workingDays.
 */
export async function attendanceSummary(
  ctx: ReportContext,
  range: { from: PlainDate; to: PlainDate },
  sort: SortOrder,
  deps: Deps
): Promise<Report<AttendanceSummaryRow>> {
  const { from, to } = range
  const people = ctx.people.filter(
    (p) => tracked(p) && employedDuring(p, from, to)
  )
  const [statuses, unpaid] = await Promise.all([
    people.length
      ? dayStatuses(
          {
            companyId: ctx.companyId,
            from,
            to,
            employeeIds: people.map((p) => p.id),
          },
          deps
        )
      : [],
    unpaidLeaveDays(ctx, people, from, to),
  ])
  const daysOf = new Map(statuses.map((s) => [s.employeeId, s.days]))
  const rows = people.map((person) => {
    const row = {
      employee: employeeOf(person),
      department: departmentOf(person),
      ...(Object.fromEntries(
        ATTENDANCE_SUMMARY_COLUMNS.map((c) => [c, 0])
      ) as Record<SummaryColumn, number>),
    }
    for (const day of daysOf.get(person.id) ?? []) {
      row.workedMinutes += day.workedMinutes
      if (day.flags.includes("CORRECTED")) row.corrections += 1
      if (!day.expected) continue
      if (day.status === "HOLIDAY") row.holidays += 1
      if (!day.working) continue
      row.workingDays += 1
      const column = day.status ? STATUS_COLUMN[day.status] : "notYetRecorded"
      if (column) row[column] += 1
    }
    row.workedHours = hours(row.workedMinutes)
    row.unpaidLeaveDays = unpaid.get(person.id) ?? 0
    return row
  })
  sortRows(rows, sort, (row, field) =>
    field === "name"
      ? row.employee.name
      : field === "department"
        ? (row.department?.name ?? null)
        : row[field as SummaryColumn]
  )
  const totals = sumColumns(rows, ATTENDANCE_SUMMARY_COLUMNS)
  totals.workedHours = hours(totals.workedMinutes!)
  return {
    rows,
    total: rows.length,
    totals,
    header: [
      "Employee",
      "Employee code",
      "Department",
      "Working days",
      "Present",
      "Late",
      "Absent",
      "WFH",
      "On leave",
      "Unpaid leave days",
      "Business trip",
      "Missing checkouts",
      "Not yet recorded",
      "Holidays",
      "Worked hours",
      "Corrections",
    ],
    csvRow: (r) => [
      r.employee.name,
      r.employee.employeeCode,
      r.department?.name,
      r.workingDays,
      r.present,
      r.late,
      r.absent,
      r.wfh,
      r.onLeave,
      r.unpaidLeaveDays,
      r.businessTrip,
      r.missingCheckouts,
      r.notYetRecorded,
      r.holidays,
      r.workedHours,
      r.corrections,
    ],
  }
}

export type AttendanceDetailRow = {
  employee: EmployeeRef
  department: { id: string; name: string | null } | null
  date: PlainDate
  weekday: string
  status: AttendanceStatus | null
  flags: AttendanceFlag[]
  firstCheckInAt: string | null
  lastCheckOutAt: string | null
  workedMinutes: number
  workedHours: number
  corrected: boolean
}

/**
 * Employee × day, by name then date: every day each tracked person was
 * employed in the range (weekends and holidays included). With `page`, only
 * that page's people are computed.
 */
export async function attendanceDetail(
  ctx: ReportContext,
  range: { from: PlainDate; to: PlainDate },
  page: { skip: number; limit: number } | null,
  deps: Deps
): Promise<Report<AttendanceDetailRow>> {
  const { from, to } = range
  const people = ctx.people
    .filter((p) => tracked(p) && employedDuring(p, from, to))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const spans = people.map((p) => employment(p, from, to))
  const counts = spans.map(
    (s) =>
      Math.round((Date.parse(s.end) - Date.parse(s.start)) / 86_400_000) + 1
  )
  const total = counts.reduce((a, b) => a + b, 0)

  // The people whose days fall in the page, and where the page starts.
  const skip = page?.skip ?? 0
  const limit = page?.limit ?? total
  const chosen: number[] = []
  let offset = 0
  for (let i = 0, seen = 0; i < people.length; seen += counts[i]!, i += 1) {
    if (seen + counts[i]! <= skip) continue
    if (seen >= skip + limit) break
    if (!chosen.length) offset = skip - seen
    chosen.push(i)
  }

  const statuses = chosen.length
    ? await dayStatuses(
        {
          companyId: ctx.companyId,
          from,
          to,
          employeeIds: chosen.map((i) => people[i]!.id),
        },
        deps
      )
    : []
  const daysOf = new Map(statuses.map((s) => [s.employeeId, s.days]))
  const rows: AttendanceDetailRow[] = []
  for (const i of chosen) {
    const person = people[i]!
    const span = spans[i]!
    for (const day of daysOf.get(person.id) ?? []) {
      if (day.date < span.start || day.date > span.end) continue
      rows.push({
        employee: employeeOf(person),
        department: departmentOf(person),
        date: day.date,
        weekday: weekdayOf(day.date),
        status: day.status,
        flags: day.flags,
        firstCheckInAt: day.firstCheckInAt?.toISOString() ?? null,
        lastCheckOutAt: day.lastCheckOutAt?.toISOString() ?? null,
        workedMinutes: day.workedMinutes,
        workedHours: hours(day.workedMinutes),
        corrected: day.flags.includes("CORRECTED"),
      })
    }
  }
  const instant = (iso: string | null) => (iso ? new Date(iso) : null)
  return {
    rows: rows.slice(offset, offset + limit),
    total,
    header: [
      "Employee",
      "Employee code",
      "Department",
      "Date",
      "Weekday",
      "Status",
      "First in",
      "Last out",
      "Worked hours",
      "Flags",
      "Corrected",
    ],
    csvRow: (r) => [
      r.employee.name,
      r.employee.employeeCode,
      r.department?.name,
      r.date,
      r.weekday,
      r.status ? STATUS_LABELS[r.status] : null,
      localTime(ctx, instant(r.firstCheckInAt)),
      localTime(ctx, instant(r.lastCheckOutAt)),
      r.workedHours,
      r.flags.map((f) => FLAG_LABELS[f]).join("; "),
      r.corrected,
    ],
  }
}

// ─────────────────────────────── leave ───────────────────────────────

export type LeaveBalanceRow = {
  employee: EmployeeRef
  department: { id: string; name: string | null } | null
  leaveType: { id: string; name: string; paid: boolean; tracksBalance: boolean }
  year: number
  /** null for untracked types (e.g. Unpaid): no balance is kept */
  entitlement: number | null
  adjustments: number | null
  used: number
  upcoming: number
  pending: number
  available: number | null
}

/**
 * Employee × active leave type for one leave year (default: the current
 * one), for everyone employed during that year. Tracked types come from the
 * ledger; untracked ones (e.g. Unpaid) show the days used, upcoming and
 * pending from the requests.
 */
export async function leaveBalances(
  ctx: ReportContext,
  input: { year?: number; leaveTypeIds?: string[] },
  deps: Deps
): Promise<
  Report<LeaveBalanceRow> & {
    year: number
    period: { start: PlainDate; end: PlainDate }
  }
> {
  const year = input.year ?? leaveYearOf(ctx.today, ctx.leaveYearStartMonth)
  const period = leaveYearRange(year, ctx.leaveYearStartMonth)
  const people = ctx.people.filter((p) =>
    employedDuring(p, period.start, period.end)
  )
  const types = (
    await listLeaveTypes({ companyId: ctx.companyId, includeArchived: false })
  ).filter((t) => !input.leaveTypeIds || input.leaveTypeIds.includes(t.id))
  const trackedTypes = types.filter((t) => t.tracksBalance)
  const untrackedTypes = types.filter((t) => !t.tracksBalance)

  const [summaries, requests] = await Promise.all([
    people.length && trackedTypes.length
      ? balanceSummaries(
          {
            companyId: ctx.companyId,
            year,
            employees: people,
            leaveTypes: trackedTypes,
          },
          deps
        )
      : new Map(),
    people.length && untrackedTypes.length
      ? listRequestsForReport({
          companyId: ctx.companyId,
          types: ["LEAVE"],
          requesterIds: people.map((p) => p.id),
          from: period.start,
          to: period.end,
          statuses: [...IN_EFFECT, "PENDING"],
          leaveTypeIds: untrackedTypes.map((t) => t.id),
        })
      : [],
  ])
  const untracked = new Map<
    string,
    { used: number; upcoming: number; pending: number }
  >()
  if (requests.length) {
    const calendar = await calendarFor(
      ctx.companyId,
      requests,
      period.start,
      period.end
    )
    for (const r of requests) {
      const key = `${r.requesterId}|${leaveDataOf(r).leaveTypeId}`
      const entry = untracked.get(key) ?? { used: 0, upcoming: 0, pending: 0 }
      for (const day of leaveDays(calendar, r)) {
        if (day.date < period.start || day.date > period.end) continue
        if (r.status === "PENDING") entry.pending += day.days
        else if (day.date < ctx.today) entry.used += day.days
        else entry.upcoming += day.days
      }
      untracked.set(key, entry)
    }
  }

  const rows: LeaveBalanceRow[] = []
  for (const person of people) {
    for (const type of types) {
      const key = `${person.id}|${type.id}`
      const base = {
        employee: employeeOf(person),
        department: departmentOf(person),
        leaveType: {
          id: type.id,
          name: type.name,
          paid: type.paid,
          tracksBalance: type.tracksBalance,
        },
        year,
      }
      if (type.tracksBalance) {
        const s = summaries.get(key)!
        rows.push({ ...base, ...s })
      } else {
        const u = untracked.get(key) ?? { used: 0, upcoming: 0, pending: 0 }
        rows.push({
          ...base,
          entitlement: null,
          adjustments: null,
          ...u,
          available: null,
        })
      }
    }
  }
  rows.sort(
    (a, b) =>
      a.employee.name.localeCompare(b.employee.name) ||
      a.employee.id.localeCompare(b.employee.id) ||
      a.leaveType.name.localeCompare(b.leaveType.name)
  )
  return {
    year,
    period,
    rows,
    total: rows.length,
    header: [
      "Employee",
      "Employee code",
      "Department",
      "Leave type",
      "Paid",
      "Balance tracked",
      "Leave year",
      "Entitlement",
      "Adjustments",
      "Used",
      "Upcoming",
      "Pending",
      "Available",
    ],
    csvRow: (r) => [
      r.employee.name,
      r.employee.employeeCode,
      r.department?.name,
      r.leaveType.name,
      r.leaveType.paid,
      r.leaveType.tracksBalance,
      r.year,
      r.entitlement,
      r.adjustments,
      r.used,
      r.upcoming,
      r.pending,
      r.available,
    ],
  }
}

type RegisterBase = {
  requestId: string
  employee: EmployeeRef
  department: { id: string; name: string | null } | null
  startDate: PlainDate
  endDate: PlainDate
  /** working days of the whole request */
  days: number
  /** working days inside the report's range */
  daysInRange: number
  status: RequestStatus
  submittedAt: string | null
  approver: { id: string; name: string | null } | null
  decidedAt: string | null
  cancelledAt: string | null
}

export type LeaveRegisterRow = RegisterBase & {
  leaveType: { id: string; name: string | null; paid: boolean | null }
  firstDayHalf: string | null
  lastDayHalf: string | null
}

export const REGISTER_SORTS = ["startDate", "name", "status"] as const

function sortRegister<R extends RegisterBase>(rows: R[], sort: SortOrder) {
  return sortRows(rows, sort, (r, field) =>
    field === "name"
      ? r.employee.name
      : field === "status"
        ? r.status
        : `${r.startDate}|${r.requestId}`
  )
}

async function registerBase(
  ctx: ReportContext,
  requests: ReportRequest[],
  days: (r: ReportRequest) => { date: PlainDate; days: number }[],
  range: { from: PlainDate; to: PlainDate }
) {
  const byId = new Map(ctx.people.map((p) => [p.id, p]))
  const approvers = await namesOf(
    ctx.companyId,
    requests.map((r) => r.decidedBy)
  )
  return (r: ReportRequest): RegisterBase => {
    const person = byId.get(r.requesterId)!
    const counted = days(r)
    return {
      requestId: r.id,
      employee: employeeOf(person),
      department: departmentOf(person),
      startDate: r.startDate,
      endDate: r.endDate,
      days: counted.reduce((sum, d) => sum + d.days, 0),
      daysInRange: sumIn(counted, range.from, range.to),
      status: r.status,
      submittedAt: r.submittedAt?.toISOString() ?? null,
      approver: r.decidedBy
        ? { id: r.decidedBy, name: approvers.get(r.decidedBy) ?? null }
        : null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      cancelledAt: r.cancelledAt?.toISOString() ?? null,
    }
  }
}

const instantOf = (iso: string | null) => (iso ? new Date(iso) : null)

/** One row per leave request overlapping the range (any status unless filtered). */
export async function leaveRegister(
  ctx: ReportContext,
  input: {
    from: PlainDate
    to: PlainDate
    statuses?: RequestStatus[]
    leaveTypeIds?: string[]
  },
  sort: SortOrder
): Promise<Report<LeaveRegisterRow>> {
  const requests = ctx.people.length
    ? await listRequestsForReport({
        companyId: ctx.companyId,
        types: ["LEAVE"],
        requesterIds: ctx.people.map((p) => p.id),
        from: input.from,
        to: input.to,
        statuses: input.statuses,
        leaveTypeIds: input.leaveTypeIds,
      })
    : []
  const [calendar, types] = await Promise.all([
    calendarFor(ctx.companyId, requests, input.from, input.to),
    listLeaveTypes({ companyId: ctx.companyId, includeArchived: true }),
  ])
  const typeOf = new Map(types.map((t) => [t.id, t]))
  const base = await registerBase(
    ctx,
    requests,
    (r) => leaveDays(calendar, r),
    input
  )
  const rows = requests.map((r) => {
    const data = leaveDataOf(r)
    const type = typeOf.get(data.leaveTypeId)
    return {
      ...base(r),
      leaveType: {
        id: data.leaveTypeId,
        name: type?.name ?? null,
        paid: type?.paid ?? null,
      },
      firstDayHalf: data.firstDayHalf ?? null,
      lastDayHalf: data.lastDayHalf ?? null,
    }
  })
  sortRegister(rows, sort)
  return {
    rows,
    total: rows.length,
    header: [
      "Request ID",
      "Employee",
      "Employee code",
      "Department",
      "Leave type",
      "Paid",
      "Start date",
      "End date",
      "First day half",
      "Last day half",
      "Days",
      "Days in range",
      "Status",
      "Submitted at",
      "Approver",
      "Decided at",
      "Cancelled at",
    ],
    csvRow: (r) => [
      r.requestId,
      r.employee.name,
      r.employee.employeeCode,
      r.department?.name,
      r.leaveType.name,
      r.leaveType.paid,
      r.startDate,
      r.endDate,
      r.firstDayHalf,
      r.lastDayHalf,
      r.days,
      r.daysInRange,
      REQUEST_STATUS_LABELS[r.status],
      localTime(ctx, instantOf(r.submittedAt), true),
      r.approver?.name,
      localTime(ctx, instantOf(r.decidedAt), true),
      localTime(ctx, instantOf(r.cancelledAt), true),
    ],
  }
}

// ─────────────────────────────── WFH ───────────────────────────────

export const WFH_SUMMARY_COLUMNS = [
  "wfhDays",
  "approved",
  "rejected",
  "pending",
] as const
type WfhColumn = (typeof WFH_SUMMARY_COLUMNS)[number]

export type WfhSummaryRow = {
  employee: EmployeeRef
  department: { id: string; name: string | null } | null
} & Record<WfhColumn, number>

/**
 * One row per employee employed in the range: approved WFH working days in
 * the range (while employed), and how many WFH requests overlapping the range
 * are approved (or awaiting a cancellation decision), rejected and pending.
 */
export async function wfhSummary(
  ctx: ReportContext,
  range: { from: PlainDate; to: PlainDate },
  sort: SortOrder
): Promise<Report<WfhSummaryRow>> {
  const { from, to } = range
  const people = ctx.people.filter((p) => employedDuring(p, from, to))
  const requests = people.length
    ? await listRequestsForReport({
        companyId: ctx.companyId,
        types: ["WFH"],
        requesterIds: people.map((p) => p.id),
        from,
        to,
        statuses: [...IN_EFFECT, "REJECTED", "PENDING"],
      })
    : []
  const calendar = await calendarFor(ctx.companyId, requests, from, to)
  const rows = people.map((person) => {
    const span = employment(person, from, to)
    const row = {
      employee: employeeOf(person),
      department: departmentOf(person),
      wfhDays: 0,
      approved: 0,
      rejected: 0,
      pending: 0,
    }
    for (const r of requests.filter((r) => r.requesterId === person.id)) {
      if (r.status === "REJECTED") row.rejected += 1
      else if (r.status === "PENDING") row.pending += 1
      else {
        row.approved += 1
        row.wfhDays += sumIn(workingDates(calendar, r), span.start, span.end)
      }
    }
    return row
  })
  sortRows(rows, sort, (row, field) =>
    field === "name"
      ? row.employee.name
      : field === "department"
        ? (row.department?.name ?? null)
        : row[field as WfhColumn]
  )
  return {
    rows,
    total: rows.length,
    totals: sumColumns(rows, WFH_SUMMARY_COLUMNS),
    header: [
      "Employee",
      "Employee code",
      "Department",
      "WFH days",
      "Approved requests",
      "Rejected requests",
      "Pending requests",
    ],
    csvRow: (r) => [
      r.employee.name,
      r.employee.employeeCode,
      r.department?.name,
      r.wfhDays,
      r.approved,
      r.rejected,
      r.pending,
    ],
  }
}

export type WfhRegisterRow = RegisterBase & { type: string }

/** One row per WFH (and, when asked, business-trip) request overlapping the range. */
export async function wfhRegister(
  ctx: ReportContext,
  input: {
    from: PlainDate
    to: PlainDate
    types: ("WFH" | "BUSINESS_TRIP")[]
    statuses?: RequestStatus[]
  },
  sort: SortOrder
): Promise<Report<WfhRegisterRow>> {
  const requests = ctx.people.length
    ? await listRequestsForReport({
        companyId: ctx.companyId,
        types: input.types,
        requesterIds: ctx.people.map((p) => p.id),
        from: input.from,
        to: input.to,
        statuses: input.statuses,
      })
    : []
  const calendar = await calendarFor(
    ctx.companyId,
    requests,
    input.from,
    input.to
  )
  const base = await registerBase(
    ctx,
    requests,
    (r) => workingDates(calendar, r),
    input
  )
  const rows = requests.map((r) => ({ ...base(r), type: r.type }))
  sortRegister(rows, sort)
  return {
    rows,
    total: rows.length,
    header: [
      "Request ID",
      "Type",
      "Employee",
      "Employee code",
      "Department",
      "Start date",
      "End date",
      "Days",
      "Days in range",
      "Status",
      "Submitted at",
      "Approver",
      "Decided at",
      "Cancelled at",
    ],
    csvRow: (r) => [
      r.requestId,
      REQUEST_TYPE_LABELS[r.type] ?? r.type,
      r.employee.name,
      r.employee.employeeCode,
      r.department?.name,
      r.startDate,
      r.endDate,
      r.days,
      r.daysInRange,
      REQUEST_STATUS_LABELS[r.status],
      localTime(ctx, instantOf(r.submittedAt), true),
      r.approver?.name,
      localTime(ctx, instantOf(r.decidedAt), true),
      localTime(ctx, instantOf(r.cancelledAt), true),
    ],
  }
}

/** The CSV file name: report, dates and the company timezone ("/" → "-"). */
export const csvFileName = (
  ctx: ReportContext,
  report: string,
  period: string
) => `${report}_${period}_${ctx.timezone.replaceAll("/", "-")}.csv`
