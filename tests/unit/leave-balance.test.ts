import { describe, expect, it } from "vitest"

import {
  leaveYearOf,
  leaveYearRange,
  proratedAllowance,
  roundToHalf,
  summarize,
  type LedgerLine,
} from "../../src/modules/leave/balance-math.ts"

describe("leave year", () => {
  it("is the calendar year by default, or starts in the chosen month", () => {
    expect(leaveYearRange(2026, 1)).toEqual({
      start: "2026-01-01",
      end: "2026-12-31",
    })
    expect(leaveYearRange(2026, 4)).toEqual({
      start: "2026-04-01",
      end: "2027-03-31",
    })
    expect(leaveYearOf("2026-10-10", 1)).toBe(2026)
    expect(leaveYearOf("2027-02-10", 4)).toBe(2026)
    expect(leaveYearOf("2027-04-01", 4)).toBe(2027)
  })
})

describe("pro-rating", () => {
  it("21 days, January year, joining 1 July → 10.5 days (BE-08 AC)", () => {
    expect(
      proratedAllowance({
        allowance: 21,
        joiningDate: "2026-07-01",
        year: 2026,
        startMonth: 1,
      })
    ).toBe(10.5)
  })

  it("gives the full allowance when joined before the year, nothing after it", () => {
    const base = { allowance: 21, year: 2026, startMonth: 1 }
    expect(proratedAllowance({ ...base, joiningDate: null })).toBe(21)
    expect(proratedAllowance({ ...base, joiningDate: "2020-03-15" })).toBe(21)
    expect(proratedAllowance({ ...base, joiningDate: "2026-01-01" })).toBe(21)
    expect(proratedAllowance({ ...base, joiningDate: "2027-01-01" })).toBe(0)
    expect(proratedAllowance({ ...base, joiningDate: "2026-12-31" })).toBe(0)
  })

  it("rounds to the nearest half day", () => {
    expect(roundToHalf(10.24)).toBe(10)
    expect(roundToHalf(10.26)).toBe(10.5)
    expect(roundToHalf(10.75)).toBe(11)
    // 30 days, April year, joining 1 October 2026: 182 of 365 days left.
    expect(
      proratedAllowance({
        allowance: 30,
        joiningDate: "2026-10-01",
        year: 2026,
        startMonth: 4,
      })
    ).toBe(15)
  })
})

describe("balance from the ledger", () => {
  const allowance: LedgerLine = { type: "ALLOWANCE", days: 10 }
  const days = (...dates: string[]) => dates.map((date) => ({ date, days: 1 }))
  const request = days("2026-11-02", "2026-11-03", "2026-11-04")

  it("a pending 3-day request reserves: available 7, pending 3 (BE-08 AC)", () => {
    expect(
      summarize([allowance, { type: "RESERVATION", days: 3 }], "2026-10-10")
    ).toEqual({
      entitlement: 10,
      adjustments: 0,
      used: 0,
      upcoming: 0,
      pending: 3,
      available: 7,
    })
  })

  it("rejected or withdrawn: available back to 10 (BE-08 AC)", () => {
    expect(
      summarize(
        [
          allowance,
          { type: "RESERVATION", days: 3 },
          { type: "RELEASE", days: 3 },
        ],
        "2026-10-10"
      ).available
    ).toBe(10)
  })

  it("approved: available stays 7, pending moves to upcoming, then used once the dates pass (BE-08 AC)", () => {
    const approved: LedgerLine[] = [
      allowance,
      { type: "RESERVATION", days: 3 },
      { type: "RELEASE", days: 3 },
      { type: "DEDUCTION", days: 3, breakdown: request },
    ]
    expect(summarize(approved, "2026-10-10")).toMatchObject({
      pending: 0,
      upcoming: 3,
      used: 0,
      available: 7,
    })
    expect(summarize(approved, "2026-11-04")).toMatchObject({
      used: 2,
      upcoming: 1,
      available: 7,
    })
    expect(summarize(approved, "2026-11-05")).toMatchObject({
      used: 3,
      upcoming: 0,
      available: 7,
    })
  })

  it("a cancelled approved request is restored (BE-08 AC)", () => {
    expect(
      summarize(
        [
          allowance,
          { type: "DEDUCTION", days: 3, breakdown: request },
          { type: "RESTORATION", days: 3, breakdown: request },
        ],
        "2026-10-10"
      )
    ).toMatchObject({ upcoming: 0, available: 10 })
  })

  it("adjustments add or remove days, including half days", () => {
    expect(
      summarize(
        [
          allowance,
          { type: "ADJUSTMENT", days: 2 },
          { type: "ADJUSTMENT", days: -0.5 },
          { type: "ALLOWANCE", days: -1 },
        ],
        "2026-10-10"
      )
    ).toMatchObject({ entitlement: 9, adjustments: 1.5, available: 10.5 })
  })
})
