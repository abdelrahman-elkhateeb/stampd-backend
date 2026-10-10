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
 *     grace (unless a half day of leave covers it, or an approved permission
 *     runs until later), else PRESENT. An approved WFH day without a
 *     check-in is ABSENT once over, flagged WFH_NO_CHECK_IN.
 *  4. No check-in: ABSENT once the day is over, if attendance was expected;
 *     null (nothing to show yet, or not expected) otherwise.
 */
export type DayEffectKind = "LEAVE" | "WFH" | "BUSINESS_TRIP" | "PERMISSION"

/** An approved request that touches the day (from leave/requests, BE-10/BE-11). */
export type DayEffect = {
  kind: DayEffectKind
  fullDay: boolean
  /** PERMISSION: arriving up to this time ("HH:mm") isn't late (BE-11) */
  until?: string
}

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
  },
  /** an approved permission's end time: arriving before it is excused */
  excusedUntil?: string
): boolean {
  const limit =
    Math.max(
      minutesOfLocalTime(settings.workStartTime) + settings.lateGraceMinutes,
      excusedUntil ? minutesOfLocalTime(excusedUntil) : 0
    ) * 60
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
    // WFH still means checking in (BE-11): no check-in by the end of the day
    // is Absent, flagged so it reads as "WFH, no check-in".
    if (
      fullDay.kind === "WFH" &&
      !checkedIn &&
      input.dayOver &&
      input.expected
    ) {
      result.status = "ABSENT"
      result.flags.push("WFH_NO_CHECK_IN")
      return result
    }
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
      // A half day of leave excuses the day; a permission excuses arriving
      // until its end time.
      const halfDayLeave = input.effects.some(
        (e) => !e.fullDay && e.kind !== "PERMISSION"
      )
      const permitted = input.effects
        .filter((e) => e.kind === "PERMISSION" && e.until)
        .map((e) => e.until!)
        .sort()
        .at(-1)
      result.status =
        !halfDayLeave && isLate(sessions[0]!.checkInAt, input, permitted)
          ? "LATE"
          : "PRESENT"
    }
    return result
  }

  if (input.dayOver && input.expected) result.status = "ABSENT"
  return result
}
