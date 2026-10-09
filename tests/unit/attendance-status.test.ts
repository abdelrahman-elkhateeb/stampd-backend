import { describe, expect, it } from "vitest"

import {
  computeDay,
  isLate,
  type DayInput,
} from "../../src/modules/attendance/status.ts"

// Dubai is UTC+4: 05:00Z is 09:00 local.
const at = (localTime: string) => new Date(`2026-10-11T${localTime}:00+04:00`)

const base: DayInput = {
  sessions: [],
  workingWeekday: true,
  holiday: false,
  expected: true,
  effects: [],
  dayOver: false,
  timezone: "Asia/Dubai",
  workStartTime: "09:00",
  lateGraceMinutes: 10,
}
const session = (from: string, to: string | null) => ({
  checkInAt: at(from),
  checkOutAt: to ? at(to) : null,
  open: to === null,
})

describe("late", () => {
  it("start 09:00 + 10 min grace: 09:07 is Present, 09:12 is Late (BE-07 AC)", () => {
    expect(
      computeDay({ ...base, sessions: [session("09:07", null)] }).status
    ).toBe("PRESENT")
    expect(
      computeDay({ ...base, sessions: [session("09:12", null)] }).status
    ).toBe("LATE")
  })

  it("is strictly after the limit, in the company's timezone", () => {
    const settings = {
      timezone: "Asia/Dubai",
      workStartTime: "09:00",
      lateGraceMinutes: 10,
    }
    expect(isLate(at("09:10"), settings)).toBe(false)
    expect(isLate(new Date("2026-10-11T09:10:01+04:00"), settings)).toBe(true)
    // The same instant is 00:10 in Bogotá (UTC−5): not late there.
    expect(
      isLate(at("09:12"), { ...settings, timezone: "America/Bogota" })
    ).toBe(false)
  })

  it("is excused by an approved permission or half day", () => {
    const late = { ...base, sessions: [session("11:00", "17:00")] }
    expect(
      computeDay({ ...late, effects: [{ kind: "PERMISSION", fullDay: false }] })
        .status
    ).toBe("PRESENT")
    expect(
      computeDay({ ...late, effects: [{ kind: "LEAVE", fullDay: false }] })
        .status
    ).toBe("PRESENT")
  })
})

describe("worked time", () => {
  it("sums the sessions (lunch break), first check-in and last check-out", () => {
    const day = computeDay({
      ...base,
      sessions: [session("13:30", "17:15"), session("08:55", "12:30")],
    })
    expect(day).toEqual({
      status: "PRESENT",
      flags: [],
      firstCheckInAt: at("08:55"),
      lastCheckOutAt: at("17:15"),
      workedMinutes: 215 + 225,
    })
  })

  it("is Missing Checkout when the day closes with a session open, without its time (BE-07 AC)", () => {
    const day = computeDay({
      ...base,
      dayOver: true,
      sessions: [session("08:00", "12:00"), session("13:00", null)],
    })
    expect(day.status).toBe("MISSING_CHECKOUT")
    expect(day.workedMinutes).toBe(240)
  })
})

describe("no check-in", () => {
  it("is Absent once a working day is over, nothing before (BE-07 AC)", () => {
    expect(computeDay(base).status).toBeNull()
    expect(computeDay({ ...base, dayOver: true }).status).toBe("ABSENT")
  })

  it("is never Absent when attendance isn't expected", () => {
    expect(
      computeDay({ ...base, dayOver: true, expected: false }).status
    ).toBeNull()
  })

  it("shows approved leave, WFH and business trips instead", () => {
    for (const [kind, status] of [
      ["LEAVE", "ON_LEAVE"],
      ["WFH", "WFH"],
      ["BUSINESS_TRIP", "BUSINESS_TRIP"],
    ] as const) {
      expect(
        computeDay({
          ...base,
          dayOver: true,
          effects: [{ kind, fullDay: true }],
        }).status
      ).toBe(status)
    }
  })
})

describe("weekends and holidays", () => {
  it("store a check-in with a flag, never Late or Absent (BE-07 AC)", () => {
    const weekend = computeDay({
      ...base,
      workingWeekday: false,
      dayOver: true,
      sessions: [session("12:00", "14:00")],
    })
    expect(weekend).toMatchObject({
      status: "WEEKEND",
      flags: ["WORKED_ON_NON_WORKING_DAY"],
      workedMinutes: 120,
    })
    expect(computeDay({ ...base, holiday: true, dayOver: true }).status).toBe(
      "HOLIDAY"
    )
    expect(
      computeDay({
        ...base,
        holiday: true,
        dayOver: true,
        sessions: [session("12:00", null)],
      })
    ).toMatchObject({ status: "HOLIDAY", flags: ["WORKED_ON_NON_WORKING_DAY"] })
  })

  it("flags work during approved leave", () => {
    expect(
      computeDay({
        ...base,
        sessions: [session("09:30", "10:00")],
        effects: [{ kind: "LEAVE", fullDay: true }],
      })
    ).toMatchObject({ status: "ON_LEAVE", flags: ["WORKED_DURING_TIME_OFF"] })
  })
})
