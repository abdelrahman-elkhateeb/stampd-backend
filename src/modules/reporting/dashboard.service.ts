import type { Clock } from "../../platform/time/clock.ts"
import { addDays, type PlainDate } from "../../platform/time/time.ts"
import type { AttendanceStatus } from "../attendance/attendance.model.ts"
import {
  dayStatuses,
  todayFor,
  type PersonDays,
} from "../attendance/attendance.service.ts"
import { recentEntriesAbout } from "../history/history.service.ts"
import type { AuthContext } from "../identity/authenticate.ts"
import { leaveUsageByType, listBalances } from "../leave/balance.service.ts"
import { loadCompanyToday } from "../organization/calendar.ts"
import {
  getEmployeeNames,
  listDirectReportIds,
} from "../organization/organization.service.ts"
import {
  findOverlappingRequests,
  listApprovals,
  listMyRequests,
  pendingByType,
} from "../requests/engine.ts"

/**
 * Dashboard summaries (Trello BE-13): one call per role with the numbers and
 * short lists its dashboard needs. Every attendance number comes from
 * dayStatuses() (BE-07), the same source as the attendance views and the
 * reports (BE-14), so they always agree.
 *
 * "Today" buckets count the people whose attendance is expected today
 * (tracked, joined, not past their last day, not invited); on a working day
 * they add up to exactly that number. Before the day closes, nobody is
 * Absent: no check-in yet is "notYetCheckedIn".
 */
type Deps = { clock: Clock }

export const TODAY_BUCKETS = [
  "present",
  "late",
  "absent",
  "wfh",
  "onLeave",
  "businessTrip",
  "notYetCheckedIn",
] as const
export type TodayBucket = (typeof TODAY_BUCKETS)[number]

const BUCKET_OF: Partial<Record<AttendanceStatus, TodayBucket>> = {
  PRESENT: "present",
  // A past day closed without check-out still counts as attended.
  MISSING_CHECKOUT: "present",
  LATE: "late",
  ABSENT: "absent",
  WFH: "wfh",
  ON_LEAVE: "onLeave",
  BUSINESS_TRIP: "businessTrip",
}

const bucketOf = (status: AttendanceStatus | null): TodayBucket | null =>
  status === null ? "notYetCheckedIn" : (BUCKET_OF[status] ?? null)

/** Today's buckets for some people, with counts and (optionally) names. */
function todayOf(people: PersonDays[], withNames: boolean) {
  const counts = Object.fromEntries(TODAY_BUCKETS.map((b) => [b, 0])) as Record<
    TodayBucket,
    number
  >
  const names = Object.fromEntries(
    TODAY_BUCKETS.map((b) => [b, []])
  ) as unknown as Record<TodayBucket, { id: string; name: string }[]>
  let expected = 0
  let working = false
  for (const person of people) {
    const day = person.days[0]!
    working = day.working
    if (!day.working || !day.expected) continue
    const bucket = bucketOf(day.status)
    if (!bucket) continue
    expected += 1
    counts[bucket] += 1
    if (withNames)
      names[bucket].push({ id: person.employeeId, name: person.name })
  }
  return { working, expected, counts, ...(withNames ? { people: names } : {}) }
}

/** Per working day: attended, late, absent and WFH among people expected that day. */
function dailyCounts(people: PersonDays[], from: PlainDate, to: PlainDate) {
  const days = []
  for (let date = from, i = 0; date <= to; date = addDays(date, 1), i += 1) {
    const row = { date, working: false, present: 0, late: 0, absent: 0, wfh: 0 }
    for (const person of people) {
      const day = person.days[i]!
      row.working ||= day.working
      if (!day.working || !day.expected) continue
      if (day.status === "PRESENT" || day.status === "MISSING_CHECKOUT")
        row.present += 1
      else if (day.status === "LATE") row.late += 1
      else if (day.status === "ABSENT") row.absent += 1
      else if (day.status === "WFH") row.wfh += 1
    }
    days.push(row)
  }
  return days
}

function monthCounts(people: PersonDays[]) {
  let late = 0
  let absences = 0
  let missingCheckouts = 0
  for (const person of people) {
    for (const day of person.days) {
      if (!day.expected) continue
      if (day.status === "LATE") late += 1
      if (day.status === "ABSENT") absences += 1
      if (day.status === "MISSING_CHECKOUT") missingCheckouts += 1
    }
  }
  return { late, absences, missingCheckouts }
}

const firstOfMonth = (date: PlainDate) => `${date.slice(0, 7)}-01`

async function today(auth: AuthContext, deps: Deps) {
  return (await loadCompanyToday(auth.companyId, deps.clock.now()))!
}

async function upcoming(
  auth: AuthContext,
  employeeIds: string[] | undefined,
  from: PlainDate,
  days: number,
  deps: Deps
) {
  void deps
  const requests = await findOverlappingRequests({
    companyId: auth.companyId,
    from,
    to: addDays(from, days - 1),
    types: ["LEAVE", "WFH", "BUSINESS_TRIP"],
    statuses: ["APPROVED", "CANCELLATION_REQUESTED"],
  })
  const mine = employeeIds
    ? requests.filter((r) => employeeIds.includes(r.requesterId))
    : requests
  const names = await getEmployeeNames({
    companyId: auth.companyId,
    ids: [...new Set(mine.map((r) => r.requesterId))],
  })
  return mine.map((r) => ({
    requestId: r.id,
    type: r.type,
    employee: { id: r.requesterId, name: names.get(r.requesterId) ?? null },
    startDate: r.startDate,
    endDate: r.endDate,
  }))
}

// ─────────────────────────────── Employee ───────────────────────────────

export async function employeeSummary(auth: AuthContext, deps: Deps) {
  const day = await todayFor(auth.companyId, auth.userId, deps)
  const now = deps.clock.now().getTime()
  const openMinutes = day.openSession
    ? Math.floor((now - Date.parse(day.openSession.checkInAt)) / 60_000)
    : 0
  const [balances, pending, coming, activity] = await Promise.all([
    listBalances({ companyId: auth.companyId, employeeId: auth.userId }, deps),
    listMyRequests(
      auth,
      { statuses: ["PENDING"] },
      { skip: 0, limit: 10, mongoSort: { createdAt: -1 } },
      deps
    ),
    upcoming(auth, [auth.userId], day.date, 30, deps),
    recentEntriesAbout({
      companyId: auth.companyId,
      subjectEmployeeId: auth.userId,
      limit: 10,
    }),
  ])
  const actorNames = await getEmployeeNames({
    companyId: auth.companyId,
    ids: [...new Set(activity.flatMap((a) => (a.actorId ? [a.actorId] : [])))],
  })
  return {
    today: {
      date: day.date,
      status: day.status,
      flags: day.flags,
      expected: day.expected,
      firstCheckInAt: day.firstCheckInAt,
      lastCheckOutAt: day.lastCheckOutAt,
      openSession: day.openSession,
      /** closed sessions plus the open one so far */
      workedMinutes: day.workedMinutes + openMinutes,
    },
    balances: balances.items
      .filter((b) => b.tracked)
      .map((b) => ({
        leaveType: b.leaveType,
        available: b.available,
        pending: b.pending,
      })),
    pendingRequests: { total: pending.total, items: pending.items },
    upcoming: coming,
    recentActivity: activity.map((a) => ({
      action: a.action,
      recordType: a.entityType,
      recordId: a.entityId,
      at: a.at.toISOString(),
      actor: a.actorId
        ? {
            type: "USER" as const,
            id: a.actorId,
            name: actorNames.get(a.actorId) ?? null,
          }
        : { type: "SYSTEM" as const, job: a.systemJob },
      reason: a.reason,
    })),
  }
}

// ─────────────────────────────── Manager ───────────────────────────────

/** For Managers (and Admins): their direct reports only. */
export async function managerSummary(auth: AuthContext, deps: Deps) {
  const date = await today(auth, deps)
  // The team is the caller's direct reports (an Admin's too). Deactivated
  // people drop out of the counts: attendance isn't expected from them.
  const reports = await listDirectReportIds({
    managerId: auth.userId,
    companyId: auth.companyId,
  })
  const monthStart = firstOfMonth(date)
  const [approvals, todayPeople, monthPeople, coming] = await Promise.all([
    listApprovals(
      auth,
      {},
      { skip: 0, limit: 10, mongoSort: { createdAt: 1 } },
      deps
    ),
    reports.length
      ? dayStatuses(
          {
            companyId: auth.companyId,
            from: date,
            to: date,
            employeeIds: reports,
          },
          deps
        )
      : [],
    reports.length && monthStart < date
      ? dayStatuses(
          {
            companyId: auth.companyId,
            from: monthStart,
            to: addDays(date, -1),
            employeeIds: reports,
          },
          deps
        )
      : [],
    reports.length ? upcoming(auth, reports, date, 14, deps) : [],
  ])
  return {
    date,
    pendingApprovals: { total: approvals.total, oldestFirst: approvals.items },
    teamToday: todayOf(todayPeople, true),
    teamOutNext14Days: coming,
    teamThisMonth: monthCounts(monthPeople),
  }
}

// ─────────────────────────────── HR / Admin ───────────────────────────────

export const TREND_DAYS = 30

export async function adminSummary(auth: AuthContext, deps: Deps) {
  const date = await today(auth, deps)
  const yesterday = addDays(date, -1)
  const monthStart = firstOfMonth(date)
  const trendFrom = addDays(date, -TREND_DAYS)
  const [todayPeople, history, pending, leave] = await Promise.all([
    dayStatuses({ companyId: auth.companyId, from: date, to: date }, deps),
    dayStatuses(
      { companyId: auth.companyId, from: trendFrom, to: yesterday },
      deps
    ),
    pendingByType(auth.companyId, deps),
    leaveUsageByType({ companyId: auth.companyId }, deps),
  ])
  // This month's exceptions come from the same days as the trend.
  const monthOffset =
    monthStart > trendFrom
      ? Math.round(
          (Date.parse(monthStart) - Date.parse(trendFrom)) / 86_400_000
        )
      : 0
  const thisMonth = history.map((p) => ({
    ...p,
    days: p.days.slice(monthOffset),
  }))
  const month =
    monthStart < date
      ? monthCounts(thisMonth)
      : { late: 0, absences: 0, missingCheckouts: 0 }
  return {
    date,
    companyToday: todayOf(todayPeople, false),
    pendingRequests: pending,
    exceptionsThisMonth: {
      missingCheckouts: month.missingCheckouts,
      absences: month.absences,
    },
    leaveUsage: leave,
    attendanceTrend: dailyCounts(history, trendFrom, yesterday),
  }
}
