import { withTransaction } from "../../platform/db/connection.ts"
import { isDuplicateKey } from "../../platform/db/schema.ts"
import { apiErrors } from "../../platform/http/errors.ts"
import type { Clock } from "../../platform/time/clock.ts"
import {
  addDays,
  plainDateInZone,
  type PlainDate,
} from "../../platform/time/time.ts"
import {
  assertReason,
  recordHistory,
  type HistoryActor,
} from "../history/history.service.ts"
import { getAccounts, type Account } from "../identity/accounts.ts"
import {
  companyToday,
  holidayOn,
  loadWorkCalendar,
  timezoneOn,
  weekdayOf,
  type WorkCalendar,
} from "../organization/calendar.ts"
import {
  getRoster,
  type RosterEntry,
} from "../organization/organization.service.ts"
import {
  getAttendanceRules,
  type AttendanceRules,
} from "../organization/settings.service.ts"
import {
  AttendanceDayModel,
  AttendanceSessionModel,
  type AttendanceFlag,
  type AttendanceStatus,
} from "./attendance.model.ts"
import { loadDayEffects } from "./day-effects.ts"
import { computeDay, type DayEffect, type DayResult } from "./status.ts"

/**
 * Attendance (Trello BE-07): check-in/out with server time, the daily record
 * and its status, views, Admin corrections and the end-of-day close.
 * Every change to a day is recorded in its history (BE-04).
 */
type Deps = { clock: Clock }

export type RequestMeta = { ip: string | null; userAgent: string | null }

/** A day as the API shows it. */
export type DayView = {
  /** The AttendanceDay id (for GET /history/attendance-days/{id}); null when nothing is stored */
  recordId: string | null
  date: PlainDate
  status: AttendanceStatus | null
  flags: AttendanceFlag[]
  firstCheckInAt: string | null
  lastCheckOutAt: string | null
  workedMinutes: number
}

export type SessionView = {
  id: string
  checkInAt: string
  checkOutAt: string | null
  /** set when the day closed with this session still open */
  autoClosedAt: string | null
  source: "SELF" | "CORRECTION"
}

const iso = (date: Date | null | undefined) =>
  date ? date.toISOString() : null

// ─────────────────────────────── context ───────────────────────────────

type Person = RosterEntry & { account: Account | undefined }

/** Everything the status engine needs for some employees and dates. */
type Context = {
  companyId: string
  rules: AttendanceRules
  calendar: WorkCalendar
  today: PlainDate
  people: Map<string, Person>
  effects: Map<string, DayEffect[]>
}

async function loadContext(
  input: {
    companyId: string
    from: PlainDate
    to: PlainDate
    people: RosterEntry[]
  },
  deps: Deps
): Promise<Context> {
  const { companyId, from, to } = input
  const ids = input.people.map((p) => p.id)
  const [rules, calendar, accounts, effects] = await Promise.all([
    getAttendanceRules(companyId),
    loadWorkCalendar({ companyId, from, to }),
    getAccounts({ companyId, ids }),
    loadDayEffects({ companyId, employeeIds: ids, from, to }),
  ])
  if (!rules || !calendar) throw apiErrors.notFound()
  return {
    companyId,
    rules,
    calendar,
    today: companyToday(rules, deps.clock.now()),
    people: new Map(
      input.people.map((p) => [p.id, { ...p, account: accounts.get(p.id) }])
    ),
    effects,
  }
}

/**
 * Attendance is expected from the joining date through the last working
 * day, for tracked employees with an active (or offboarding) account.
 */
export function isExpected(person: Person, date: PlainDate): boolean {
  const account = person.account
  if (!person.tracksAttendance || !account) return false
  if (account.status === "INVITED") return false
  if (account.status === "DEACTIVATED" && !account.lastWorkingDay) return false
  if (person.joiningDate && date < person.joiningDate) return false
  if (account.lastWorkingDay && date > account.lastWorkingDay) return false
  return true
}

type SessionDoc = {
  _id: string
  checkInAt: Date
  checkOutAt?: Date | null
  open?: boolean | null
  autoClosedAt?: Date | null
  source?: string | null
}

function evaluate(
  ctx: Context,
  employeeId: string,
  date: PlainDate,
  sessions: SessionDoc[]
): DayResult {
  const person = ctx.people.get(employeeId)
  return computeDay({
    sessions: sessions.map((s) => ({
      checkInAt: s.checkInAt,
      checkOutAt: s.checkOutAt ?? null,
      open: Boolean(s.open),
    })),
    workingWeekday: ctx.calendar.workingDays.includes(weekdayOf(date)),
    holiday: Boolean(holidayOn(ctx.calendar, date)),
    expected: person ? isExpected(person, date) : false,
    effects: ctx.effects.get(`${employeeId}|${date}`) ?? [],
    dayOver: date < ctx.today,
    timezone: timezoneOn(ctx.rules, date),
    workStartTime: ctx.rules.workStartTime,
    lateGraceMinutes: ctx.rules.lateGraceMinutes,
  })
}

const sessionsOf = (companyId: string, employeeId: string, date: PlainDate) =>
  AttendanceSessionModel.find({ companyId, employeeId, date })
    .sort({ checkInAt: 1 })
    .lean()

const toSessionView = (s: SessionDoc): SessionView => ({
  id: s._id,
  checkInAt: s.checkInAt.toISOString(),
  checkOutAt: iso(s.checkOutAt),
  autoClosedAt: iso(s.autoClosedAt),
  source: (s.source ?? "SELF") as SessionView["source"],
})

type DayDoc = {
  _id: string
  date?: string | null
  status?: string | null
  flags?: string[] | null
  firstCheckInAt?: Date | null
  lastCheckOutAt?: Date | null
  workedMinutes?: number | null
}

const toDayView = (
  date: PlainDate,
  day: DayDoc | DayResult,
  recordId: string | null
): DayView => ({
  recordId,
  date,
  status: (day.status ?? null) as AttendanceStatus | null,
  flags: (day.flags ?? []) as AttendanceFlag[],
  firstCheckInAt: iso(day.firstCheckInAt),
  lastCheckOutAt: iso(day.lastCheckOutAt),
  workedMinutes: day.workedMinutes ?? 0,
})

/** What history keeps of a day: its sessions and results. */
const daySnapshot = (
  sessions: SessionDoc[],
  day: DayResult | DayDoc | null
) => ({
  sessions: sessions.map((s) => ({
    checkInAt: s.checkInAt.toISOString(),
    checkOutAt: iso(s.checkOutAt),
  })),
  status: day?.status ?? null,
  workedMinutes: day?.workedMinutes ?? 0,
})

/**
 * Recomputes and stores one employee's day from its sessions. Only days with
 * sessions, an earlier record, or an Absent result are stored; weekends,
 * holidays and approved time off without a check-in are computed when shown. Keeps the CORRECTED
 * flag once set (or sets it with `corrected`).
 */
async function recalculateDay(
  ctx: Context,
  employeeId: string,
  date: PlainDate,
  options: { corrected?: boolean; closedAt?: Date } = {}
) {
  const sessions = await sessionsOf(ctx.companyId, employeeId, date)
  const existing = await AttendanceDayModel.findOne({
    companyId: ctx.companyId,
    employeeId,
    date,
  }).lean()
  const result = evaluate(ctx, employeeId, date, sessions)
  if (
    (options.corrected || existing?.flags?.includes("CORRECTED")) &&
    !result.flags.includes("CORRECTED")
  ) {
    result.flags.push("CORRECTED")
  }
  let recordId = existing?._id ?? null
  if (existing || sessions.length || result.status === "ABSENT") {
    const saved = await AttendanceDayModel.findOneAndUpdate(
      { companyId: ctx.companyId, employeeId, date },
      {
        $set: {
          status: result.status,
          flags: result.flags,
          firstCheckInAt: result.firstCheckInAt,
          lastCheckOutAt: result.lastCheckOutAt,
          workedMinutes: result.workedMinutes,
          ...(options.closedAt ? { closedAt: options.closedAt } : {}),
        },
      },
      { upsert: true, returnDocument: "after" }
    ).lean()
    recordId = saved!._id
  }
  return { existing, result, sessions, recordId }
}

// ─────────────────────────────── check-in / out ───────────────────────────────

async function personContext(
  companyId: string,
  employeeId: string,
  from: PlainDate | null,
  to: PlainDate | null,
  deps: Deps
): Promise<Context> {
  const people = await getRoster({ companyId, ids: [employeeId] })
  if (!people.length) throw apiErrors.notFound()
  const rules = await getAttendanceRules(companyId)
  if (!rules) throw apiErrors.notFound()
  const today = companyToday(rules, deps.clock.now())
  return loadContext(
    { companyId, from: from ?? today, to: to ?? today, people },
    deps
  )
}

/**
 * A session left open on an earlier day can't run past the company's
 * midnight: it is closed without a check-out (Missing Checkout).
 */
async function closeStaleSessions(
  ctx: Context,
  employeeId: string,
  deps: Deps
) {
  const now = deps.clock.now()
  const stale = await AttendanceSessionModel.find({
    companyId: ctx.companyId,
    employeeId,
    open: true,
    date: { $lt: ctx.today },
  }).lean()
  for (const session of stale) {
    await AttendanceSessionModel.updateOne(
      { _id: session._id, companyId: ctx.companyId },
      { $unset: { open: 1 }, $set: { autoClosedAt: now } }
    )
    const dayCtx = await personContext(
      ctx.companyId,
      employeeId,
      session.date!,
      session.date!,
      deps
    )
    await recalculateDay(dayCtx, employeeId, session.date!)
  }
}

async function recordSessionChange(
  ctx: Context,
  employeeId: string,
  before: { sessions: SessionDoc[]; day: DayDoc | null },
  after: Awaited<ReturnType<typeof recalculateDay>>,
  deps: Deps
) {
  await recordHistory(
    {
      companyId: ctx.companyId,
      action: "attendance.recorded",
      entityId: after.recordId!,
      subjectEmployeeId: employeeId,
      actor: { type: "USER", userId: employeeId },
      before: daySnapshot(before.sessions, before.day),
      after: daySnapshot(after.sessions, after.result),
    },
    deps
  )
}

/**
 * Check-in with the server's time. With a session already open (double click,
 * two tabs) nothing new is created and the open one is returned.
 */
export async function checkIn(
  input: { companyId: string; employeeId: string; meta: RequestMeta },
  deps: Deps
): Promise<{ created: boolean; today: TodayView }> {
  const { companyId, employeeId } = input
  const ctx = await personContext(companyId, employeeId, null, null, deps)
  if (!ctx.people.get(employeeId)?.tracksAttendance) {
    throw apiErrors.conflictWith(
      "ATTENDANCE_NOT_TRACKED",
      "Attendance isn't tracked for this employee"
    )
  }
  const now = deps.clock.now()
  let created = false
  try {
    created = await withTransaction(async () => {
      await closeStaleSessions(ctx, employeeId, deps)
      const open = await AttendanceSessionModel.exists({
        companyId,
        employeeId,
        open: true,
      })
      if (open) return false
      const beforeSessions = await sessionsOf(companyId, employeeId, ctx.today)
      const beforeDay = await AttendanceDayModel.findOne({
        companyId,
        employeeId,
        date: ctx.today,
      }).lean()
      await AttendanceSessionModel.create([
        {
          companyId,
          employeeId,
          date: ctx.today,
          checkInAt: now,
          open: true,
          checkInIp: input.meta.ip,
          checkInUserAgent: input.meta.userAgent,
        },
      ])
      const after = await recalculateDay(ctx, employeeId, ctx.today)
      await recordSessionChange(
        ctx,
        employeeId,
        { sessions: beforeSessions, day: beforeDay },
        after,
        deps
      )
      return true
    })
  } catch (error) {
    // A parallel check-in won the race: return the session it opened.
    if (!isDuplicateKey(error)) throw error
  }
  return { created, today: await todayFor(companyId, employeeId, deps) }
}

/** Check-out with the server's time. No open session today → 409 NO_OPEN_SESSION. */
export async function checkOut(
  input: { companyId: string; employeeId: string; meta: RequestMeta },
  deps: Deps
): Promise<TodayView> {
  const { companyId, employeeId } = input
  const ctx = await personContext(companyId, employeeId, null, null, deps)
  const now = deps.clock.now()
  await withTransaction(async () => {
    await closeStaleSessions(ctx, employeeId, deps)
    const open = await AttendanceSessionModel.findOne({
      companyId,
      employeeId,
      open: true,
    }).lean()
    if (!open) {
      throw apiErrors.conflictWith("NO_OPEN_SESSION", "You haven't checked in")
    }
    const beforeSessions = await sessionsOf(companyId, employeeId, ctx.today)
    const beforeDay = await AttendanceDayModel.findOne({
      companyId,
      employeeId,
      date: ctx.today,
    }).lean()
    await AttendanceSessionModel.updateOne(
      { _id: open._id, companyId },
      {
        $unset: { open: 1 },
        $set: {
          checkOutAt: now,
          checkOutIp: input.meta.ip,
          checkOutUserAgent: input.meta.userAgent,
        },
      }
    )
    const after = await recalculateDay(ctx, employeeId, ctx.today)
    await recordSessionChange(
      ctx,
      employeeId,
      { sessions: beforeSessions, day: beforeDay },
      after,
      deps
    )
  })
  return todayFor(companyId, employeeId, deps)
}

// ─────────────────────────────── views ───────────────────────────────

export type TodayView = DayView & {
  /** false for days attendance isn't expected (not tracked, not started, …) */
  expected: boolean
  tracksAttendance: boolean
  openSession: { id: string; checkInAt: string } | null
  sessions: SessionView[]
}

/** The caller's own day, as of now. */
export async function todayFor(
  companyId: string,
  employeeId: string,
  deps: Deps
): Promise<TodayView> {
  const ctx = await personContext(companyId, employeeId, null, null, deps)
  const sessions = await sessionsOf(companyId, employeeId, ctx.today)
  const record = await AttendanceDayModel.findOne({
    companyId,
    employeeId,
    date: ctx.today,
  }).lean()
  const result = evaluate(ctx, employeeId, ctx.today, sessions)
  const open = sessions.find((s) => s.open)
  const person = ctx.people.get(employeeId)!
  return {
    ...toDayView(
      ctx.today,
      { ...result, flags: record?.flags ?? result.flags },
      record?._id ?? null
    ),
    expected: isExpected(person, ctx.today),
    tracksAttendance: person.tracksAttendance,
    openSession: open
      ? { id: open._id, checkInAt: open.checkInAt.toISOString() }
      : null,
    sessions: sessions.map(toSessionView),
  }
}

export type GridRow = {
  employee: { id: string; name: string }
  days: DayView[]
}

/**
 * Day and month views: for each employee in scope, every date from `from` to
 * `to`. Stored days are shown as stored; other days are computed (weekends,
 * holidays, approved time off, or Absent for a past expected day the close
 * job hasn't reached).
 */
export async function attendanceGrid(
  input: {
    companyId: string
    visibleIds: "ALL" | string[]
    from: PlainDate
    to: PlainDate
    filters: { departmentId?: string; employeeId?: string }
    page: { skip: number; limit: number }
  },
  deps: Deps
): Promise<{ items: GridRow[]; total: number }> {
  const { companyId, from, to, filters } = input
  let ids = input.visibleIds === "ALL" ? undefined : input.visibleIds
  if (filters.employeeId) {
    ids = ids
      ? ids.filter((id) => id === filters.employeeId)
      : [filters.employeeId]
  }
  const roster = await getRoster({
    companyId,
    ids,
    departmentId: filters.departmentId,
  })
  const pageOf = roster.slice(
    input.page.skip,
    input.page.skip + input.page.limit
  )
  const ctx = await loadContext({ companyId, from, to, people: pageOf }, deps)
  const records = await AttendanceDayModel.find({
    companyId,
    employeeId: { $in: pageOf.map((p) => p.id) },
    date: { $gte: from, $lte: to },
  }).lean()
  const byKey = new Map(records.map((r) => [`${r.employeeId}|${r.date}`, r]))

  const items = pageOf.map((person) => {
    const days: DayView[] = []
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const record = byKey.get(`${person.id}|${date}`)
      days.push(
        record
          ? toDayView(date, record, record._id)
          : toDayView(date, evaluate(ctx, person.id, date, []), null)
      )
    }
    return { employee: { id: person.id, name: person.name }, days }
  })
  return { items, total: roster.length }
}

/** One employee's day with its sessions (IP and browser for Admins). */
export async function dayDetail(
  input: {
    companyId: string
    employeeId: string
    date: PlainDate
    withDevice: boolean
  },
  deps: Deps
) {
  const { companyId, employeeId, date } = input
  const ctx = await personContext(companyId, employeeId, date, date, deps)
  const sessions = await sessionsOf(companyId, employeeId, date)
  const record = await AttendanceDayModel.findOne({
    companyId,
    employeeId,
    date,
  }).lean()
  const person = ctx.people.get(employeeId)!
  return {
    employee: { id: person.id, name: person.name },
    day: record
      ? toDayView(date, record, record._id)
      : toDayView(date, evaluate(ctx, employeeId, date, sessions), null),
    sessions: sessions.map((s) => ({
      ...toSessionView(s),
      ...(input.withDevice
        ? {
            checkInIp: s.checkInIp ?? null,
            checkInUserAgent: s.checkInUserAgent ?? null,
            checkOutIp: s.checkOutIp ?? null,
            checkOutUserAgent: s.checkOutUserAgent ?? null,
          }
        : {}),
    })),
  }
}

/** Missing Checkout and Absent days for the Admin, newest first. */
export async function listExceptions(input: {
  companyId: string
  from: PlainDate
  to: PlainDate
  statuses: ("MISSING_CHECKOUT" | "ABSENT")[]
  page: { skip: number; limit: number }
}) {
  const filter = {
    companyId: input.companyId,
    date: { $gte: input.from, $lte: input.to },
    status: { $in: input.statuses },
  }
  const [records, total] = await Promise.all([
    AttendanceDayModel.find(filter)
      .sort({ date: -1, employeeId: 1 })
      .skip(input.page.skip)
      .limit(input.page.limit)
      .lean(),
    AttendanceDayModel.countDocuments(filter),
  ])
  const roster = await getRoster({
    companyId: input.companyId,
    ids: [...new Set(records.map((r) => r.employeeId))],
  })
  const names = new Map(roster.map((p) => [p.id, p.name]))
  return {
    items: records.map((r) => ({
      employee: { id: r.employeeId, name: names.get(r.employeeId) ?? null },
      ...toDayView(r.date!, r, r._id),
    })),
    total,
  }
}

// ─────────────────────────────── corrections ───────────────────────────────

export type CorrectionOperation =
  | { type: "add"; checkInAt: Date; checkOutAt: Date }
  | { type: "edit"; sessionId: string; checkInAt?: Date; checkOutAt?: Date }
  | { type: "remove"; sessionId: string }

/** The employee and day a session belongs to, or undefined when not in the company. */
export async function sessionOwner(input: {
  companyId: string
  sessionId: string
}) {
  const session = await AttendanceSessionModel.findOne(
    { _id: input.sessionId, companyId: input.companyId },
    { employeeId: 1, date: 1 }
  ).lean()
  return session
    ? { employeeId: session.employeeId, date: session.date! }
    : undefined
}

const outOfRange = (field: string, message: string) =>
  apiErrors.fieldError(field, "OUT_OF_RANGE", message)

/**
 * The one correction service (Trello BE-07): used by the Admin endpoints now
 * and by approved correction requests (BE-11, actor with source APPROVAL).
 * A reason is required. Times must fall inside the company day (no session
 * crosses midnight), check-out after check-in, not in the future, and
 * sessions of a day may not overlap. The day is recalculated and history
 * keeps the old and new sessions and status.
 */
export async function correctAttendance(
  input: {
    companyId: string
    employeeId: string
    date: PlainDate
    operation: CorrectionOperation
    reason: string | null | undefined
    actor: HistoryActor
    /** The approved correction request (BE-11), kept in the history entry */
    requestId?: string
  },
  deps: Deps
) {
  const { companyId, employeeId, date, operation } = input
  assertReason("attendance.corrected", input.reason)
  const ctx = await personContext(companyId, employeeId, date, date, deps)
  if (date > ctx.today) throw outOfRange("date", "can't correct a future day")

  await withTransaction(async () => {
    const sessions = await sessionsOf(companyId, employeeId, date)
    const target =
      operation.type === "add"
        ? undefined
        : sessions.find((s) => s._id === operation.sessionId)
    if (operation.type !== "add" && !target) throw apiErrors.notFound()

    if (operation.type !== "remove") {
      const checkInAt =
        operation.type === "add"
          ? operation.checkInAt
          : (operation.checkInAt ?? target!.checkInAt)
      const checkOutAt =
        operation.type === "add"
          ? operation.checkOutAt
          : (operation.checkOutAt ?? target!.checkOutAt ?? null)
      const zone = timezoneOn(ctx.rules, date)
      if (plainDateInZone(checkInAt, zone) !== date) {
        throw outOfRange("checkInAt", `must be on ${date} in company time`)
      }
      if (!checkOutAt) {
        throw apiErrors.fieldError(
          "checkOutAt",
          "REQUIRED",
          "checkOutAt is required"
        )
      }
      if (plainDateInZone(checkOutAt, zone) !== date) {
        throw outOfRange(
          "checkOutAt",
          `must be on ${date} in company time (no session crosses midnight)`
        )
      }
      if (checkOutAt <= checkInAt) {
        throw outOfRange("checkOutAt", "must be after checkInAt")
      }
      if (checkOutAt > deps.clock.now()) {
        throw outOfRange("checkOutAt", "can't be in the future")
      }
      const overlaps = sessions.some(
        (s) =>
          s._id !== target?._id &&
          s.checkInAt < checkOutAt &&
          (s.checkOutAt ?? deps.clock.now()) > checkInAt
      )
      if (overlaps) throw outOfRange("checkInAt", "overlaps another session")

      if (operation.type === "add") {
        await AttendanceSessionModel.create([
          {
            companyId,
            employeeId,
            date,
            checkInAt,
            checkOutAt,
            source: "CORRECTION",
          },
        ])
      } else {
        await AttendanceSessionModel.updateOne(
          { _id: target!._id, companyId },
          { $set: { checkInAt, checkOutAt }, $unset: { open: 1 } }
        )
      }
    } else {
      await AttendanceSessionModel.deleteOne({ _id: target!._id, companyId })
    }

    const beforeDay = await AttendanceDayModel.findOne({
      companyId,
      employeeId,
      date,
    }).lean()
    const after = await recalculateDay(ctx, employeeId, date, {
      corrected: true,
    })
    await recordHistory(
      {
        companyId,
        action: "attendance.corrected",
        entityId: after.recordId!,
        subjectEmployeeId: employeeId,
        actor: input.actor,
        before: daySnapshot(sessions, beforeDay),
        after: {
          ...daySnapshot(after.sessions, after.result),
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        reason: input.reason,
      },
      deps
    )
  })
  return dayDetail({ companyId, employeeId, date, withDevice: true }, deps)
}

// ─────────────────────────────── end-of-day close ───────────────────────────────

/**
 * Closes one company day (the end-of-day job): sessions still open become
 * Missing Checkout (their time doesn't count), and every employee expected
 * that day without a check-in or covering request becomes Absent. Changes
 * are recorded in history with actor "system". Safe to run again.
 */
export async function closeAttendanceDay(
  input: { companyId: string; date: PlainDate },
  deps: Deps
): Promise<{ closed: number }> {
  const { companyId, date } = input
  const now = deps.clock.now()
  const roster = await getRoster({ companyId })
  const ctx = await loadContext(
    { companyId, from: date, to: date, people: roster },
    deps
  )
  if (date >= ctx.today) {
    throw new Error(`${date} isn't over yet for company ${companyId}`)
  }

  await AttendanceSessionModel.updateMany(
    { companyId, open: true, date: { $lte: date } },
    { $unset: { open: 1 }, $set: { autoClosedAt: now } }
  )
  let closed = 0
  for (const person of roster) {
    await withTransaction(async () => {
      const before = await AttendanceDayModel.findOne({
        companyId,
        employeeId: person.id,
        date,
      }).lean()
      const after = await recalculateDay(ctx, person.id, date, {
        closedAt: now,
      })
      if (!after.recordId) return
      closed += 1
      await recordHistory(
        {
          companyId,
          action: "attendance.closed",
          entityId: after.recordId,
          subjectEmployeeId: person.id,
          actor: { type: "SYSTEM", job: "attendance.nightlyClose" },
          before: { status: before?.status ?? null },
          after: { status: after.result.status },
        },
        deps
      )
    })
  }
  return { closed }
}

/**
 * Recomputes an employee's stored days in a range, e.g. after approved leave
 * covering them is approved or cancelled (BE-10): a past day closed as Absent
 * becomes On Leave, and back. Days with nothing stored are computed when
 * shown, so they need nothing. Joins the caller's transaction.
 */
export async function recalculateStoredDays(
  input: {
    companyId: string
    employeeId: string
    from: PlainDate
    to: PlainDate
  },
  deps: Deps
): Promise<void> {
  const { companyId, employeeId, from, to } = input
  const stored = await AttendanceDayModel.find(
    { companyId, employeeId, date: { $gte: from, $lte: to } },
    { date: 1 }
  ).lean()
  if (!stored.length) return
  const ctx = await personContext(companyId, employeeId, from, to, deps)
  for (const day of stored) await recalculateDay(ctx, employeeId, day.date!)
}

export type PersonDays = {
  employeeId: string
  name: string
  days: {
    date: PlainDate
    /** a company working day (not weekend or holiday) */
    working: boolean
    /** attendance expected: tracked, joined, not past the last day, not invited */
    expected: boolean
    status: AttendanceStatus | null
    flags: AttendanceFlag[]
    firstCheckInAt: Date | null
    lastCheckOutAt: Date | null
    /** closed sessions only (an open session doesn't count yet) */
    workedMinutes: number
  }[]
}

/**
 * Everyone's status for each day of a range, exactly as the attendance views
 * show it (stored days as stored, the rest computed). The one source for
 * dashboards and reports (BE-13, BE-14), so their numbers always agree.
 */
export async function dayStatuses(
  input: {
    companyId: string
    from: PlainDate
    to: PlainDate
    employeeIds?: string[]
  },
  deps: Deps
): Promise<PersonDays[]> {
  const { companyId, from, to } = input
  const roster = await getRoster({ companyId, ids: input.employeeIds })
  if (!roster.length) return []
  const ctx = await loadContext({ companyId, from, to, people: roster }, deps)
  const records = await AttendanceDayModel.find(
    {
      companyId,
      employeeId: { $in: roster.map((p) => p.id) },
      date: { $gte: from, $lte: to },
    },
    {
      employeeId: 1,
      date: 1,
      status: 1,
      flags: 1,
      firstCheckInAt: 1,
      lastCheckOutAt: 1,
      workedMinutes: 1,
    }
  ).lean()
  const byKey = new Map(records.map((r) => [`${r.employeeId}|${r.date}`, r]))
  const dates: PlainDate[] = []
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date)
  return roster.map((person) => {
    const full = ctx.people.get(person.id)!
    return {
      employeeId: person.id,
      name: person.name,
      days: dates.map((date) => {
        const record = byKey.get(`${person.id}|${date}`)
        const result = record ?? evaluate(ctx, person.id, date, [])
        return {
          date,
          working:
            ctx.calendar.workingDays.includes(weekdayOf(date)) &&
            !holidayOn(ctx.calendar, date),
          expected: isExpected(full, date),
          status: (result.status ?? null) as AttendanceStatus | null,
          flags: (result.flags ?? []) as AttendanceFlag[],
          firstCheckInAt: result.firstCheckInAt ?? null,
          lastCheckOutAt: result.lastCheckOutAt ?? null,
          workedMinutes: result.workedMinutes ?? 0,
        }
      }),
    }
  })
}
