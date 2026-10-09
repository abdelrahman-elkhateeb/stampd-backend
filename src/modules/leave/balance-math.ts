import { addDays, type PlainDate } from "../../platform/time/time.ts"

/**
 * Leave arithmetic (Trello BE-08), pure so every rule is tested directly.
 *
 * Leave year: named by the calendar year it starts in. With a leave year
 * starting in April, "2026" runs from 2026-04-01 to 2027-03-31; with January
 * (the default), it is the calendar year.
 */
export function leaveYearOf(date: PlainDate, startMonth: number): number {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  return month >= startMonth ? year : year - 1
}

export function leaveYearRange(
  year: number,
  startMonth: number
): { start: PlainDate; end: PlainDate } {
  const month = String(startMonth).padStart(2, "0")
  return {
    start: `${year}-${month}-01`,
    end: addDays(`${year + 1}-${month}-01`, -1),
  }
}

const dayNumber = (date: PlainDate) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d) / 86_400_000
}

/** Rounds to the nearest half day (10.586 → 10.5, 10.75 → 11). */
export const roundToHalf = (days: number) => Math.round(days * 2) / 2

/**
 * The entitlement proposed for a leave year: the full allowance, or for
 * someone joining during the year, the share of the year left from their
 * joining date (both days included), rounded to the nearest 0.5 day.
 * 21 days, January year, joining 1 July → 21 × 184/365 = 10.59 → 10.5.
 */
export function proratedAllowance(input: {
  allowance: number
  joiningDate: PlainDate | null
  year: number
  startMonth: number
}): number {
  const { start, end } = leaveYearRange(input.year, input.startMonth)
  const joined = input.joiningDate
  if (!joined || joined <= start) return input.allowance
  if (joined > end) return 0
  const remaining = dayNumber(end) - dayNumber(joined) + 1
  const total = dayNumber(end) - dayNumber(start) + 1
  return roundToHalf((input.allowance * remaining) / total)
}

// ─────────────────────────────── the ledger ───────────────────────────────

/**
 * Ledger entry types. Every balance change is one entry; balances are always
 * computed from them, never stored.
 *   ALLOWANCE    entitlement for the year (and later corrections of it), ±
 *   ADJUSTMENT   an Admin's manual change, ± (reason required)
 *   RESERVATION  a pending request holds days
 *   RELEASE      a reservation ends (rejected, withdrawn, or approved)
 *   DEDUCTION    an approved request takes days (one amount per date)
 *   RESTORATION  a cancelled approved request gives days back (per date)
 */
export const LEDGER_ENTRY_TYPES = [
  "ALLOWANCE",
  "ADJUSTMENT",
  "RESERVATION",
  "RELEASE",
  "DEDUCTION",
  "RESTORATION",
] as const
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number]

export type DayAmount = { date: PlainDate; days: number }

export type LedgerLine = {
  type: LedgerEntryType
  /** ALLOWANCE and ADJUSTMENT are signed; the others are positive amounts */
  days: number
  /** DEDUCTION and RESTORATION: which dates the days are on */
  breakdown?: readonly DayAmount[] | null
}

export type BalanceSummary = {
  entitlement: number
  adjustments: number
  /** approved days whose date has passed */
  used: number
  /** approved days from today on */
  upcoming: number
  /** days held by pending requests */
  pending: number
  /** entitlement + adjustments − used − upcoming − pending */
  available: number
}

/** The balance at `today`, from the ledger entries of one employee, type and year. */
export function summarize(
  entries: readonly LedgerLine[],
  today: PlainDate
): BalanceSummary {
  let entitlement = 0
  let adjustments = 0
  let pending = 0
  let used = 0
  let upcoming = 0
  for (const entry of entries) {
    switch (entry.type) {
      case "ALLOWANCE":
        entitlement += entry.days
        break
      case "ADJUSTMENT":
        adjustments += entry.days
        break
      case "RESERVATION":
        pending += entry.days
        break
      case "RELEASE":
        pending -= entry.days
        break
      case "DEDUCTION":
      case "RESTORATION": {
        const sign = entry.type === "DEDUCTION" ? 1 : -1
        for (const day of entry.breakdown ?? []) {
          if (day.date < today) used += sign * day.days
          else upcoming += sign * day.days
        }
        break
      }
    }
  }
  // Half days only, so sums are exact in binary; round anyway for safety.
  const r = (n: number) => Math.round(n * 100) / 100
  return {
    entitlement: r(entitlement),
    adjustments: r(adjustments),
    used: r(used),
    upcoming: r(upcoming),
    pending: r(pending),
    available: r(entitlement + adjustments - used - upcoming - pending),
  }
}
