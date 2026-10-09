import { describe, expect, it } from "vitest"

import {
  companyToday,
  isWorkingDay,
  timezoneAt,
  timezoneOn,
  weekdayOf,
  workingDaysBetween,
  type WorkCalendar,
} from "../../src/modules/organization/calendar.ts"
import {
  detectImageType,
  isValidFileSignature,
  signedFileUrl,
} from "../../src/platform/storage/files.ts"

const sunToThu: WorkCalendar = {
  workingDays: ["SUN", "MON", "TUE", "WED", "THU"],
  holidays: [],
}
const monToFri: WorkCalendar = {
  workingDays: ["MON", "TUE", "WED", "THU", "FRI"],
  holidays: [],
}

describe("work calendar", () => {
  it("knows weekdays without any timezone", () => {
    expect(weekdayOf("2026-10-08")).toBe("THU")
    expect(weekdayOf("2026-10-11")).toBe("SUN")
    expect(weekdayOf("2024-02-29")).toBe("THU")
  })

  it("Sun–Thu: Thursday to the following Sunday is 2 working days (BE-05 AC)", () => {
    expect(workingDaysBetween(sunToThu, "2026-10-08", "2026-10-11")).toBe(2)
  })

  it("Mon–Fri with a Wednesday holiday: Monday to Friday is 4 (BE-05 AC)", () => {
    const calendar: WorkCalendar = {
      ...monToFri,
      holidays: [
        {
          id: "h",
          name: "Founding Day",
          startDate: "2026-10-14",
          endDate: "2026-10-14",
        },
      ],
    }
    expect(workingDaysBetween(calendar, "2026-10-12", "2026-10-16")).toBe(4)
    expect(isWorkingDay(calendar, "2026-10-14")).toBe(false)
  })

  it("excludes every day of a multi-day holiday", () => {
    const calendar: WorkCalendar = {
      ...sunToThu,
      holidays: [
        {
          id: "eid",
          name: "Eid",
          startDate: "2026-10-12",
          endDate: "2026-10-14",
        },
      ],
    }
    // Sun 11 … Thu 15: only Sun and Thu remain.
    expect(workingDaysBetween(calendar, "2026-10-11", "2026-10-15")).toBe(2)
  })

  it("supports half days at the start and end", () => {
    // Sun 11 … Thu 15 is 5 working days.
    expect(
      workingDaysBetween(sunToThu, "2026-10-11", "2026-10-15", {
        halfDayStart: true,
      })
    ).toBe(4.5)
    expect(
      workingDaysBetween(sunToThu, "2026-10-11", "2026-10-15", {
        halfDayStart: true,
        halfDayEnd: true,
      })
    ).toBe(4)
    expect(
      workingDaysBetween(sunToThu, "2026-10-11", "2026-10-11", {
        halfDayEnd: true,
      })
    ).toBe(0.5)
    // A half day on a weekend changes nothing.
    expect(
      workingDaysBetween(sunToThu, "2026-10-09", "2026-10-11", {
        halfDayStart: true,
      })
    ).toBe(1)
    expect(() =>
      workingDaysBetween(sunToThu, "2026-10-11", "2026-10-10")
    ).toThrow(RangeError)
  })
})

describe("company timezone over time", () => {
  // Changed on 2026-10-09 (Riyadh) from Riyadh to Dubai: applies from the 10th.
  const company = {
    timezone: "Asia/Dubai",
    timezoneHistory: [{ timezone: "Asia/Riyadh", until: "2026-10-09" }],
  }

  it("keeps the old timezone up to the change day, the new one after", () => {
    expect(timezoneOn(company, "2026-10-09")).toBe("Asia/Riyadh")
    expect(timezoneOn(company, "2026-10-10")).toBe("Asia/Dubai")
    expect(timezoneOn({ timezone: "Asia/Dubai" }, "2020-01-01")).toBe(
      "Asia/Dubai"
    )
  })

  it("switches at midnight of the change day in the old timezone", () => {
    // 20:59Z on the 9th is 23:59 in Riyadh: still the old timezone.
    const beforeMidnight = new Date("2026-10-09T20:59:00Z")
    expect(timezoneAt(company, beforeMidnight)).toBe("Asia/Riyadh")
    expect(companyToday(company, beforeMidnight)).toBe("2026-10-09")
    // 21:00Z is midnight in Riyadh: the new day, in the new timezone (01:00 Dubai).
    const midnight = new Date("2026-10-09T21:00:00Z")
    expect(timezoneAt(company, midnight)).toBe("Asia/Dubai")
    expect(companyToday(company, midnight)).toBe("2026-10-10")
  })
})

describe("uploads", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])
  const webp = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("WEBPVP8 "),
  ])

  it("recognises PNG, JPEG and WebP by their content only", () => {
    expect(detectImageType(png)).toBe("image/png")
    expect(detectImageType(jpeg)).toBe("image/jpeg")
    expect(detectImageType(webp)).toBe("image/webp")
  })

  it("refuses SVG, GIF, PDF and anything else", () => {
    for (const other of [
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      "GIF89a",
      "%PDF-1.7",
      "RIFF\0\0\0\0WAVEfmt ",
      "",
    ]) {
      expect(detectImageType(Buffer.from(other))).toBeUndefined()
    }
  })

  it("signs file URLs that expire, and rejects any other id, time or signature", () => {
    const secret = "test-secret-0123456789abcdefghijklmnopqrstuv"
    const now = new Date("2026-10-09T08:20:00Z")
    const url = new URL(signedFileUrl("file-1", { secret, now }), "http://x")
    expect(url.pathname).toBe("/files/file-1")
    const expires = Number(url.searchParams.get("expires"))
    const signature = url.searchParams.get("signature")!
    // At least 24 h, rounded up to the hour (stable URLs for caching).
    expect(expires).toBe(Date.parse("2026-10-10T09:00:00Z") / 1000)

    const valid = { fileId: "file-1", expires, signature }
    expect(isValidFileSignature(valid, { secret, now })).toBe(true)
    expect(
      isValidFileSignature({ ...valid, fileId: "file-2" }, { secret, now })
    ).toBe(false)
    expect(
      isValidFileSignature(
        { ...valid, expires: expires + 3600 },
        { secret, now }
      )
    ).toBe(false)
    expect(
      isValidFileSignature({ ...valid, signature: "x" }, { secret, now })
    ).toBe(false)
    expect(isValidFileSignature(valid, { secret: `${secret}x`, now })).toBe(
      false
    )
    expect(
      isValidFileSignature(valid, { secret, now: new Date(expires * 1000) })
    ).toBe(false)
  })
})
