import { minutesOfLocalTime, secondsIntoDay } from "../../platform/time/time.ts"
import type { AttendanceFlag, AttendanceStatus } from "./attendance.model.ts"

/**
 * The daily status engine (Trello BE-07). Pure: everything it needs comes in,
 * so the rules are tested directly.
 *
 * Precedence:
 *  1. Weekend or holiday: WEEKEND / HOLIDAY, never Late or Absent. A check-in
 *     adds the flag WORKED_ON_NON_WORKING_DAY.
 *  2. An approved full-day leave, WFH or business trip: ON_LEAVE / WFH /
 *     BUSINESS_TRIP. A check-in during leave or a trip adds
 *     WORKED_DURING_TIME_OFF.
 *  3. Checked in: MISSING_CHECKOUT when the day is over with a session still
 *     open; otherwise LATE when the first check-in is after work start +
 *     grace (unless an approved permission or half day covers it), else
 *     PRESENT.
 *  4. No check-in: ABSENT once the day is over, if attendance was expected;
 *     null (nothing to show yet, or not expected) otherwise.
 */
export type DayEffectKind = "LEAVE" | "WFH" | "BUSINESS_TRIP" | "PERMISSION"

/** An approved request that touches the day (from leave/requests, BE-10/BE-11). */
export type DayEffect = { kind: DayEffectKind; fullDay: boolean }

export type SessionTimes = {
  checkInAt: Date
  checkOutAt: Date | null
  /** still open (not checked out, not closed by the end-of-day job) */
  open: boolean
}

export type DayInput = {
  sessions: SessionTimes[]
  /** a company working weekday */
  workingWeekday: boolean
  holiday: boolean
  /** attendance expected: tracked employee, joined, not past the last day */
  expected: boolean
  effects: DayEffect[]
  /** the day is over in the company calendar */
  dayOver: boolean
  timezone: string
  workStartTime: string
  lateGraceMinutes: number
}

export type DayResult = {
  status: AttendanceStatus | null
  flags: AttendanceFlag[]
  firstCheckInAt: Date | null
  lastCheckOutAt: Date | null
  workedMinutes: number
}

const FULL_DAY: Partial<Record<DayEffectKind, AttendanceStatus>> = {
  LEAVE: "ON_LEAVE",
  WFH: "WFH",
  BUSINESS_TRIP: "BUSINESS_TRIP",
}

/** true when the instant is after work start + grace, in the company timezone. */
export function isLate(
  checkInAt: Date,
  settings: {
    timezone: string
    workStartTime: string
    lateGraceMinutes: number
  }
): boolean {
  const limit =
    (minutesOfLocalTime(settings.workStartTime) + settings.lateGraceMinutes) *
    60
  return secondsIntoDay(checkInAt, settings.timezone) > limit
}

export function computeDay(input: DayInput): DayResult {
  const sessions = [...input.sessions].sort(
    (a, b) => a.checkInAt.getTime() - b.checkInAt.getTime()
  )
  const closed = sessions.filter((s) => s.checkOutAt)
  const workedMinutes = Math.floor(
    closed.reduce(
      (sum, s) => sum + (s.checkOutAt!.getTime() - s.checkInAt.getTime()),
      0
    ) / 60_000
  )
  const lastCheckOut = closed.reduce<Date | null>(
    (last, s) => (!last || s.checkOutAt! > last ? s.checkOutAt : last),
    null
  )
  const result: DayResult = {
    status: null,
    flags: [],
    firstCheckInAt: sessions[0]?.checkInAt ?? null,
    lastCheckOutAt: lastCheckOut,
    workedMinutes,
  }
  const checkedIn = sessions.length > 0

  if (!input.workingWeekday || input.holiday) {
    result.status = input.holiday ? "HOLIDAY" : "WEEKEND"
    if (checkedIn) result.flags.push("WORKED_ON_NON_WORKING_DAY")
    return result
  }

  const fullDay = input.effects.find((e) => e.fullDay && FULL_DAY[e.kind])
  if (fullDay) {
    result.status = FULL_DAY[fullDay.kind]!
    if (checkedIn && fullDay.kind !== "WFH") {
      result.flags.push("WORKED_DURING_TIME_OFF")
    }
    return result
  }

  if (checkedIn) {
    const stillOpen = sessions.some((s) => s.open || !s.checkOutAt)
    if (input.dayOver && stillOpen) {
      result.status = "MISSING_CHECKOUT"
    } else {
      const excused = input.effects.some(
        (e) => e.kind === "PERMISSION" || !e.fullDay
      )
      result.status =
        !excused && isLate(sessions[0]!.checkInAt, input) ? "LATE" : "PRESENT"
    }
    return result
  }

  if (input.dayOver && input.expected) result.status = "ABSENT"
  return result
}
