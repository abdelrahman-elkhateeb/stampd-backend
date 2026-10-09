import {
  addDays,
  isPlainDate,
  plainDateInZone,
  type PlainDate,
} from "../../platform/time/time.ts"
import { CompanyModel, WEEKDAYS, type Weekday } from "./company.model.ts"
import { HolidayModel } from "./holiday.model.ts"

/**
 * The work calendar (Trello BE-05), shared by attendance, leave and requests:
 * "is this date a working day?" and "how many working days between two
 * dates?". A working day is one of the company's working weekdays that no
 * holiday covers. All dates are company-calendar days (PlainDate).
 */
export type WorkCalendar = {
  workingDays: readonly Weekday[]
  holidays: readonly {
    id: string
    name: string
    startDate: PlainDate
    endDate: PlainDate
  }[]
}

/** The weekday of a calendar day (no timezone involved). */
export function weekdayOf(date: PlainDate): Weekday {
  if (!isPlainDate(date)) throw new RangeError(`Not a plain date: ${date}`)
  const [y, m, d] = date.split("-").map(Number) as [number, number, number]
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!
}

/** The holiday covering a day, if any. */
export function holidayOn(calendar: WorkCalendar, date: PlainDate) {
  return calendar.holidays.find(
    (holiday) => holiday.startDate <= date && date <= holiday.endDate
  )
}

export function isWorkingDay(calendar: WorkCalendar, date: PlainDate): boolean {
  return (
    calendar.workingDays.includes(weekdayOf(date)) && !holidayOn(calendar, date)
  )
}

/**
 * Working days from `from` to `to`, both included. `halfDayStart` /
 * `halfDayEnd` count the first / last day as half a day (when it is a working
 * day), for half-day leave. A one-day range with either flag counts 0.5.
 */
export function workingDaysBetween(
  calendar: WorkCalendar,
  from: PlainDate,
  to: PlainDate,
  options: { halfDayStart?: boolean; halfDayEnd?: boolean } = {}
): number {
  if (to < from) throw new RangeError(`${to} is before ${from}`)
  let count = 0
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (isWorkingDay(calendar, day)) count += 1
  }
  if (from === to) {
    return (options.halfDayStart || options.halfDayEnd) && count === 1
      ? 0.5
      : count
  }
  if (options.halfDayStart && isWorkingDay(calendar, from)) count -= 0.5
  if (options.halfDayEnd && isWorkingDay(calendar, to)) count -= 0.5
  return count
}

/** Loads a company's calendar with the holidays touching [from, to]. */
export async function loadWorkCalendar(input: {
  companyId: string
  from: PlainDate
  to: PlainDate
}): Promise<WorkCalendar | undefined> {
  const [company, holidays] = await Promise.all([
    CompanyModel.findById(input.companyId, { workingDays: 1 }).lean(),
    HolidayModel.find({
      companyId: input.companyId,
      startDate: { $lte: input.to },
      endDate: { $gte: input.from },
    })
      .sort({ startDate: 1 })
      .lean(),
  ])
  if (!company) return undefined
  return {
    workingDays: company.workingDays as Weekday[],
    holidays: holidays.map((h) => ({
      id: h._id,
      name: h.name,
      startDate: h.startDate!,
      endDate: h.endDate!,
    })),
  }
}

// ─────────────────────────────── timezone ───────────────────────────────

type TimezoneTimeline = {
  timezone: string
  timezoneHistory?: readonly { timezone: string; until?: string | null }[]
}

/**
 * The company timezone that applies to a calendar day. A change made on day D
 * applies from D + 1; days up to D keep the earlier timezone.
 */
export function timezoneOn(company: TimezoneTimeline, date: PlainDate): string {
  for (const earlier of company.timezoneHistory ?? []) {
    if (earlier.until && date <= earlier.until) return earlier.timezone
  }
  return company.timezone
}

/** The company timezone in force at an instant (e.g. a clock-in). */
export function timezoneAt(company: TimezoneTimeline, instant: Date): string {
  for (const earlier of company.timezoneHistory ?? []) {
    if (
      earlier.until &&
      plainDateInZone(instant, earlier.timezone) <= earlier.until
    ) {
      return earlier.timezone
    }
  }
  return company.timezone
}

/** The company's "today" at an instant, in the timezone then in force. */
export function companyToday(
  company: TimezoneTimeline,
  instant: Date
): PlainDate {
  return plainDateInZone(instant, timezoneAt(company, instant))
}
