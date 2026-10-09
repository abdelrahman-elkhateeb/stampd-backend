/**
 * Two kinds of time, never mixed (BE-00 conventions, BE-01 rule):
 *
 *  PlainDate  "2026-10-07"                 a calendar day in the company's calendar
 *             (leave day, holiday, attendance date, joining date).
 *             Stored in MongoDB as this exact string (plainDateField() in
 *             platform/db/schema.ts). Never converted with a timezone.
 *
 *  Timestamp  "2026-10-07T09:30:00.000Z"   an instant (check-in, decided at).
 *             Stored as a BSON Date (always UTC), held as a JS Date,
 *             sent as UTC ISO 8601 with Z.
 *
 * Which calendar day an instant falls on depends on the company timezone:
 * use plainDateInZone(instant, company.timezone), never the server's zone.
 *
 * LocalTime "HH:mm" (work hours, typed times) is a time of day in the company
 * timezone; combine it with a PlainDate only through the company timezone.
 */

export type PlainDate = string
export type Timestamp = string

const PLAIN_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** True for a real calendar day in YYYY-MM-DD (rejects 2026-02-30). */
export function isPlainDate(value: unknown): value is PlainDate {
  if (typeof value !== "string") return false
  const match = PLAIN_DATE.exec(value)
  if (!match) return false
  const [, y, m, d] = match.map(Number) as [number, number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d))
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  )
}

/** An instant as a UTC ISO 8601 timestamp with Z. */
export function toTimestamp(instant: Date): Timestamp {
  if (Number.isNaN(instant.getTime())) throw new RangeError("Invalid Date")
  return instant.toISOString()
}

/** The calendar day an instant falls on in a timezone (IANA name). */
export function plainDateInZone(instant: Date, timeZone: string): PlainDate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant)
}

/** Calendar arithmetic on plain dates, without any timezone. */
export function addDays(date: PlainDate, days: number): PlainDate {
  if (!isPlainDate(date)) throw new RangeError(`Not a plain date: ${date}`)
  const [y, m, d] = date.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** True when the IANA timezone name is known to the runtime. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value })
    return true
  } catch {
    return false
  }
}

/** Seconds since midnight of an instant's day in a timezone (0 … 86399). */
export function secondsIntoDay(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant)
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)
  return get("hour") * 3600 + get("minute") * 60 + get("second")
}

/** "HH:mm" → minutes since midnight. */
export function minutesOfLocalTime(time: string): number {
  const [hours, minutes] = time.split(":").map(Number) as [number, number]
  return hours * 60 + minutes
}
