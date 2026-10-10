import { describe, expect, it } from "vitest"

import {
  addMonths,
  lastDayAllowed,
  resolveRange,
} from "../../src/modules/reporting/reports.service.ts"
import type { ApiError } from "../../src/platform/http/errors.ts"

/** Report date ranges (Trello BE-14). */
const company = { today: "2026-04-20", leaveYearStartMonth: 1 }

const fieldOf = (run: () => unknown) => {
  try {
    run()
  } catch (error) {
    return (error as ApiError).fieldErrors.map((f) => `${f.field}:${f.code}`)
  }
  throw new Error("expected an error")
}

describe("report ranges", () => {
  it("adds months, ending on the month's last day when shorter", () => {
    expect(addMonths("2026-01-15", 13)).toBe("2027-02-15")
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28")
    expect(addMonths("2026-03-01", -1)).toBe("2026-02-01")
    expect(addMonths("2026-12-01", 1)).toBe("2027-01-01")
  })

  it("allows at most 13 months (BE-14 AC)", () => {
    expect(lastDayAllowed("2026-01-01")).toBe("2027-01-31")
    expect(
      resolveRange({ from: "2026-01-01", to: "2027-01-31" }, company)
    ).toEqual({ from: "2026-01-01", to: "2027-01-31" })
    expect(
      fieldOf(() =>
        resolveRange({ from: "2026-01-01", to: "2027-02-01" }, company)
      )
    ).toEqual(["to:OUT_OF_RANGE"])
    expect(
      fieldOf(() =>
        resolveRange({ from: "2026-01-01", to: "2027-03-01" }, company)
      )
    ).toEqual(["to:OUT_OF_RANGE"])
    expect(
      fieldOf(() =>
        resolveRange({ from: "2026-03-02", to: "2026-03-01" }, company)
      )
    ).toEqual(["to:OUT_OF_RANGE"])
  })

  it("turns presets into company-calendar dates", () => {
    expect(resolveRange({ preset: "THIS_MONTH" }, company)).toEqual({
      from: "2026-04-01",
      to: "2026-04-30",
    })
    expect(resolveRange({ preset: "LAST_MONTH" }, company)).toEqual({
      from: "2026-03-01",
      to: "2026-03-31",
    })
    expect(
      resolveRange(
        { preset: "LAST_MONTH" },
        { ...company, today: "2026-01-10" }
      )
    ).toEqual({ from: "2025-12-01", to: "2025-12-31" })
    expect(
      resolveRange(
        { preset: "THIS_LEAVE_YEAR" },
        { today: "2026-02-10", leaveYearStartMonth: 4 }
      )
    ).toEqual({ from: "2025-04-01", to: "2026-03-31" })
  })

  it("needs a preset or both dates, not both kinds", () => {
    expect(fieldOf(() => resolveRange({}, company))).toEqual([
      "from:REQUIRED",
      "to:REQUIRED",
    ])
    expect(
      fieldOf(() =>
        resolveRange({ preset: "THIS_MONTH", from: "2026-04-01" }, company)
      )
    ).toEqual(["preset:INVALID_FORMAT"])
  })
})
