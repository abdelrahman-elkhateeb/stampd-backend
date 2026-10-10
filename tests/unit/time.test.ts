import { describe, expect, it } from "vitest"

import {
  addDays,
  isPlainDate,
  isTimeZone,
  plainDateInZone,
} from "../../src/platform/time/time.ts"

describe("plain dates (calendar days)", () => {
  it("accepts real YYYY-MM-DD days only", () => {
    expect(isPlainDate("2026-10-07")).toBe(true)
    expect(isPlainDate("2028-02-29")).toBe(true) // leap year
    expect(isPlainDate("2026-02-29")).toBe(false)
    expect(isPlainDate("2026-13-01")).toBe(false)
    expect(isPlainDate("07/10/2026")).toBe(false)
    expect(isPlainDate("2026-10-07T00:00:00Z")).toBe(false)
    expect(isPlainDate(20261007)).toBe(false)
  })

  it("adds days without any timezone, across months and years", () => {
    expect(addDays("2026-10-07", 1)).toBe("2026-10-08")
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01")
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28")
    expect(() => addDays("2026-02-30", 1)).toThrow(RangeError)
  })
})

describe("plainDateInZone", () => {
  // 22:30 UTC on 6 Oct is already 7 Oct in Riyadh (UTC+3), still 6 Oct in New York.
  const instant = new Date("2026-10-06T22:30:00Z")

  it("uses the company timezone, not the server's", () => {
    expect(plainDateInZone(instant, "Asia/Riyadh")).toBe("2026-10-07")
    expect(plainDateInZone(instant, "America/New_York")).toBe("2026-10-06")
    expect(plainDateInZone(instant, "UTC")).toBe("2026-10-06")
  })

  it("recognises IANA timezone names", () => {
    expect(isTimeZone("Asia/Riyadh")).toBe(true)
    expect(isTimeZone("Mars/Olympus")).toBe(false)
  })
})

describe("instantAt", () => {
  it("turns a company's local date and time into the UTC instant", async () => {
    const { instantAt } = await import("../../src/platform/time/time.ts")
    expect(instantAt("2026-10-12", "08:30", "Asia/Dubai").toISOString()).toBe(
      "2026-10-12T04:30:00.000Z"
    )
    expect(
      instantAt("2026-10-12", "08:30", "America/Bogota").toISOString()
    ).toBe("2026-10-12T13:30:00.000Z")
    // Across a daylight-saving change (London: BST until 25 Oct 2026).
    expect(
      instantAt("2026-10-24", "09:00", "Europe/London").toISOString()
    ).toBe("2026-10-24T08:00:00.000Z")
    expect(
      instantAt("2026-10-26", "09:00", "Europe/London").toISOString()
    ).toBe("2026-10-26T09:00:00.000Z")
  })
})
