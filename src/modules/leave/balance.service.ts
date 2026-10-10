import { withTransaction } from "../../platform/db/connection.ts"
import { apiErrors } from "../../platform/http/errors.ts"
import type { Clock } from "../../platform/time/clock.ts"
import type { PlainDate } from "../../platform/time/time.ts"
import {
  assertReason,
  recordHistory,
  type HistoryActor,
} from "../history/history.service.ts"
import { loadCompanyToday } from "../organization/calendar.ts"
import {
  getEmployeeNames,
  getRoster,
} from "../organization/organization.service.ts"
import { getCompanySettings } from "../organization/settings.service.ts"
import {
  leaveYearOf,
  leaveYearRange,
  proratedAllowance,
  summarize,
  type BalanceSummary,
  type DayAmount,
  type LedgerEntryType,
} from "./balance-math.ts"
import {
  LeaveBalanceModel,
  LeaveLedgerEntryModel,
  LeaveTypeModel,
} from "./leave.model.ts"
import {
  getLeaveType,
  markLeaveTypeInUse,
  toLeaveTypeView,
  type LeaveTypeView,
} from "./leave-types.service.ts"

/**
 * Leave balances (Trello BE-08): yearly entitlements, the ledger, and the
 * functions the leave request flow (BE-10) calls to reserve, release, deduct
 * and restore days. Every function joins the caller's transaction (or opens
 * one), and locks the balance first, so concurrent requests are applied one
 * after the other and two requests can never spend the same days.
 */
type Deps = { clock: Clock }

export type BalanceKey = {
  companyId: string
  employeeId: string
  leaveTypeId: string
  /** Leave year; defaults to the one containing the company's today */
  year?: number
}

export type BalanceView = {
  /** for GET /history/leave-balances/{balanceId} (BE-04); null for untracked types */
  balanceId: string | null
  leaveType: Pick<
    LeaveTypeView,
    | "id"
    | "name"
    | "icon"
    | "paid"
    | "tracksBalance"
    | "allowNegativeBalance"
    | "halfDaysAllowed"
    | "requiresReason"
  >
  year: number
  period: { start: PlainDate; end: PlainDate }
  /** false: no balance kept, requests aren't limited (all numbers null) */
  tracked: boolean
  proposedEntitlement: number | null
  entitlementSource: "DEFAULT" | "PRORATED" | "OVERRIDE" | null
} & { [K in keyof BalanceSummary]: number | null }

export type LedgerEntryView = {
  id: string
  type: LedgerEntryType
  days: number
  breakdown: DayAmount[] | null
  requestId: string | null
  reason: string | null
  actor:
    | { type: "USER"; id: string; name: string | null }
    | { type: "SYSTEM"; job: string | null }
  at: string
}

const ENTITLEMENT_JOB = "leave.entitlement"

async function companyContext(companyId: string, deps: Deps) {
  const [settings, today] = await Promise.all([
    getCompanySettings(companyId, deps),
    loadCompanyToday(companyId, deps.clock.now()),
  ])
  return { startMonth: settings.leaveYearStartMonth, today: today! }
}

async function requireType(companyId: string, leaveTypeId: string) {
  const type = await getLeaveType({ companyId, id: leaveTypeId })
  if (!type) throw apiErrors.notFound("Leave type not found")
  return type
}

/**
 * The balance record of an employee, tracked type and year, creating it (and
 * its ALLOWANCE entry: the default allowance, pro-rated from the joining
 * date) the first time. Safe to call concurrently.
 */
async function ensureBalance(
  input: {
    companyId: string
    employeeId: string
    type: LeaveTypeView
    year: number
    startMonth: number
  },
  deps: Deps
) {
  const { companyId, employeeId, type, year } = input
  const existing = await LeaveBalanceModel.findOne({
    companyId,
    employeeId,
    leaveTypeId: type.id,
    year,
  }).lean()
  if (existing) return existing
  const [person] = await getRoster({ companyId, ids: [employeeId] })
  if (!person) throw apiErrors.notFound()
  const proposed = proratedAllowance({
    allowance: type.defaultAllowanceDays,
    joiningDate: person.joiningDate,
    year,
    startMonth: input.startMonth,
  })
  return withTransaction(async () => {
    const result = await LeaveBalanceModel.findOneAndUpdate(
      { companyId, employeeId, leaveTypeId: type.id, year },
      {
        $setOnInsert: {
          proposedDays: proposed,
          entitlementSource:
            proposed === type.defaultAllowanceDays ? "DEFAULT" : "PRORATED",
        },
      },
      { upsert: true, returnDocument: "after", includeResultMetadata: true }
    )
    const balance = result.value!
    if (!result.lastErrorObject?.updatedExisting && proposed !== 0) {
      await LeaveLedgerEntryModel.create([
        {
          companyId,
          balanceId: balance._id,
          employeeId,
          leaveTypeId: type.id,
          year,
          type: "ALLOWANCE",
          days: proposed,
          systemJob: ENTITLEMENT_JOB,
          at: deps.clock.now(),
        },
      ])
    }
    return balance.toObject()
  })
}

/** Serialises changes to one balance (see the module comment). */
const lock = (companyId: string, balanceId: string) =>
  LeaveBalanceModel.updateOne(
    { _id: balanceId, companyId },
    { $inc: { version: 1 } }
  )

const entriesOf = (companyId: string, balanceId: string) =>
  LeaveLedgerEntryModel.find({ companyId, balanceId }).sort({ _id: 1 }).lean()

function toView(
  type: LeaveTypeView,
  year: number,
  startMonth: number,
  balance: {
    _id: string
    proposedDays: number
    entitlementSource: string
  } | null,
  summary: BalanceSummary | null
): BalanceView {
  return {
    balanceId: balance?._id ?? null,
    leaveType: {
      id: type.id,
      name: type.name,
      icon: type.icon,
      paid: type.paid,
      tracksBalance: type.tracksBalance,
      allowNegativeBalance: type.allowNegativeBalance,
      halfDaysAllowed: type.halfDaysAllowed,
      requiresReason: type.requiresReason,
    },
    year,
    period: leaveYearRange(year, startMonth),
    tracked: type.tracksBalance,
    proposedEntitlement: balance?.proposedDays ?? null,
    entitlementSource: (balance?.entitlementSource ??
      null) as BalanceView["entitlementSource"],
    entitlement: summary?.entitlement ?? null,
    adjustments: summary?.adjustments ?? null,
    used: summary?.used ?? null,
    upcoming: summary?.upcoming ?? null,
    pending: summary?.pending ?? null,
    available: summary?.available ?? null,
  }
}

async function loadBalance(key: BalanceKey, deps: Deps) {
  const type = await requireType(key.companyId, key.leaveTypeId)
  const ctx = await companyContext(key.companyId, deps)
  const year = key.year ?? leaveYearOf(ctx.today, ctx.startMonth)
  if (!type.tracksBalance) {
    return {
      type,
      ctx,
      year,
      balance: null,
      view: toView(type, year, ctx.startMonth, null, null),
    }
  }
  const balance = await ensureBalance(
    {
      companyId: key.companyId,
      employeeId: key.employeeId,
      type,
      year,
      startMonth: ctx.startMonth,
    },
    deps
  )
  const summary = summarize(
    await entriesOf(key.companyId, balance._id),
    ctx.today
  )
  return {
    type,
    ctx,
    year,
    balance,
    view: toView(type, year, ctx.startMonth, balance, summary),
  }
}

// ─────────────────────────────── reading ───────────────────────────────

export async function getBalance(
  key: BalanceKey,
  deps: Deps
): Promise<BalanceView> {
  return (await loadBalance(key, deps)).view
}

/** Every active leave type's balance for one employee and year. */
export async function listBalances(
  input: { companyId: string; employeeId: string; year?: number },
  deps: Deps
): Promise<{ year: number; items: BalanceView[] }> {
  const ctx = await companyContext(input.companyId, deps)
  const year = input.year ?? leaveYearOf(ctx.today, ctx.startMonth)
  const types = await LeaveTypeModel.find({
    companyId: input.companyId,
    archived: false,
  })
    .sort({ nameKey: 1 })
    .lean()
  const items: BalanceView[] = []
  for (const type of types) {
    items.push(
      await getBalance(
        {
          companyId: input.companyId,
          employeeId: input.employeeId,
          leaveTypeId: type._id,
          year,
        },
        deps
      )
    )
  }
  return { year, items }
}

/** The ledger of one balance (its "balance history"), oldest first. */
export async function listLedgerEntries(
  key: BalanceKey,
  page: { skip: number; limit: number },
  deps: Deps
): Promise<{ balance: BalanceView; items: LedgerEntryView[]; total: number }> {
  const { balance, view } = await loadBalance(key, deps)
  if (!balance) return { balance: view, items: [], total: 0 }
  const filter = { companyId: key.companyId, balanceId: balance._id }
  const [entries, total] = await Promise.all([
    LeaveLedgerEntryModel.find(filter)
      .sort({ _id: 1 })
      .skip(page.skip)
      .limit(page.limit)
      .lean(),
    LeaveLedgerEntryModel.countDocuments(filter),
  ])
  const names = await getEmployeeNames({
    companyId: key.companyId,
    ids: [...new Set(entries.flatMap((e) => (e.actorId ? [e.actorId] : [])))],
  })
  return {
    balance: view,
    total,
    items: entries.map((e) => ({
      id: e._id,
      type: e.type as LedgerEntryType,
      days: e.days,
      breakdown:
        e.breakdown?.map((d) => ({ date: d.date!, days: d.days })) ?? null,
      requestId: e.requestId ?? null,
      reason: e.reason ?? null,
      actor: e.actorId
        ? { type: "USER", id: e.actorId, name: names.get(e.actorId) ?? null }
        : { type: "SYSTEM", job: e.systemJob ?? null },
      at: e.at.toISOString(),
    })),
  }
}

// ─────────────────────────────── Admin changes ───────────────────────────────

const isHalfDays = (days: number) => Number.isInteger(days * 2)

async function post(
  input: {
    balance: {
      _id: string
      employeeId: string
      leaveTypeId: string
      year: number
    }
    companyId: string
    type: LedgerEntryType
    days: number
    breakdown?: DayAmount[]
    requestId?: string
    reason?: string | null
    actor: HistoryActor
  },
  deps: Deps
) {
  const [entry] = await LeaveLedgerEntryModel.create([
    {
      companyId: input.companyId,
      balanceId: input.balance._id,
      employeeId: input.balance.employeeId,
      leaveTypeId: input.balance.leaveTypeId,
      year: input.balance.year,
      type: input.type,
      days: input.days,
      breakdown: input.breakdown,
      requestId: input.requestId ?? null,
      reason: input.reason?.trim() || null,
      actorId: input.actor.type === "USER" ? input.actor.userId : null,
      systemJob: input.actor.type === "SYSTEM" ? input.actor.job : null,
      at: deps.clock.now(),
    },
  ])
  return entry!
}

const untracked = () =>
  apiErrors.conflictWith(
    "LEAVE_TYPE_NOT_TRACKED",
    "This leave type has no balance"
  )

/**
 * An Admin's manual change (+/−, half days allowed) with a required reason
 * (422 reason REQUIRED). Recorded in the ledger and the balance's history.
 */
export async function adjustBalance(
  input: BalanceKey & {
    days: number
    reason: string | null | undefined
    actor: HistoryActor
  },
  deps: Deps
): Promise<BalanceView> {
  assertReason("leaveBalance.adjusted", input.reason)
  if (input.days === 0 || !isHalfDays(input.days)) {
    throw apiErrors.fieldError(
      "days",
      "INVALID_FORMAT",
      "a non-zero number of whole or half days"
    )
  }
  const { type, balance, view } = await loadBalance(input, deps)
  if (!balance) throw untracked()
  await withTransaction(async () => {
    await lock(input.companyId, balance._id)
    await post(
      {
        balance,
        companyId: input.companyId,
        type: "ADJUSTMENT",
        days: input.days,
        reason: input.reason,
        actor: input.actor,
      },
      deps
    )
    await markLeaveTypeInUse({ companyId: input.companyId, id: type.id })
    await recordHistory(
      {
        companyId: input.companyId,
        action: "leaveBalance.adjusted",
        entityId: balance._id,
        subjectEmployeeId: input.employeeId,
        actor: input.actor,
        before: { adjustments: view.adjustments, available: view.available },
        after: {
          adjustments: view.adjustments! + input.days,
          available: view.available! + input.days,
        },
        reason: input.reason,
      },
      deps
    )
  })
  return getBalance(input, deps)
}

/**
 * Sets an employee's entitlement for a year (overriding the default or
 * pro-rated value): an ALLOWANCE entry for the difference.
 */
export async function setEntitlement(
  input: BalanceKey & {
    days: number
    reason?: string | null
    actor: HistoryActor
  },
  deps: Deps
): Promise<BalanceView> {
  if (input.days < 0 || !isHalfDays(input.days)) {
    throw apiErrors.fieldError(
      "days",
      "INVALID_FORMAT",
      "whole or half days, 0 or more"
    )
  }
  const { balance, view } = await loadBalance(input, deps)
  if (!balance) throw untracked()
  await withTransaction(async () => {
    await lock(input.companyId, balance._id)
    const current = summarize(
      await entriesOf(input.companyId, balance._id),
      "0000-01-01"
    )
    const delta = input.days - current.entitlement
    if (delta !== 0) {
      await post(
        {
          balance,
          companyId: input.companyId,
          type: "ALLOWANCE",
          days: delta,
          reason: input.reason,
          actor: input.actor,
        },
        deps
      )
    }
    await LeaveBalanceModel.updateOne(
      { _id: balance._id, companyId: input.companyId },
      { $set: { entitlementSource: "OVERRIDE" } }
    )
    await recordHistory(
      {
        companyId: input.companyId,
        action: "leaveBalance.entitlementSet",
        entityId: balance._id,
        subjectEmployeeId: input.employeeId,
        actor: input.actor,
        before: { entitlement: view.entitlement },
        after: { entitlement: input.days },
        reason: input.reason,
      },
      deps
    )
  })
  return getBalance(input, deps)
}

// ─────────────────────────────── for leave requests (BE-10) ───────────────────────────────

export type RequestKey = BalanceKey & { requestId: string; actor: HistoryActor }

/** Net days of a request per entry type. */
async function requestTotals(
  companyId: string,
  balanceId: string,
  requestId: string
) {
  const entries = await LeaveLedgerEntryModel.find({
    companyId,
    balanceId,
    requestId,
  }).lean()
  const sum = (type: LedgerEntryType) =>
    entries.filter((e) => e.type === type).reduce((s, e) => s + e.days, 0)
  const byDate = new Map<string, number>()
  for (const e of entries) {
    const sign = e.type === "DEDUCTION" ? 1 : e.type === "RESTORATION" ? -1 : 0
    for (const d of e.breakdown ?? []) {
      byDate.set(d.date!, (byDate.get(d.date!) ?? 0) + sign * d.days)
    }
  }
  return { reserved: sum("RESERVATION") - sum("RELEASE"), taken: byDate }
}

function assertAvailable(view: BalanceView, type: LeaveTypeView, days: number) {
  if (type.allowNegativeBalance) return
  if (view.available! < days) {
    throw apiErrors.conflictWith(
      "INSUFFICIENT_BALANCE",
      `Only ${view.available} day(s) available`
    )
  }
}

/**
 * A request is submitted: its days are reserved (pending). Refused with 409
 * INSUFFICIENT_BALANCE when not enough is available, unless the type allows a
 * negative balance. Untracked types (e.g. Unpaid) are never limited and keep
 * no balance. Returns the balance after.
 */
export async function reserveDays(
  input: RequestKey & { days: number },
  deps: Deps
): Promise<BalanceView> {
  return withTransaction(async () => {
    const { type, balance, view } = await loadBalance(input, deps)
    await markLeaveTypeInUse({ companyId: input.companyId, id: type.id })
    if (!balance) return view
    await lock(input.companyId, balance._id)
    const fresh = await getBalance(input, deps)
    assertAvailable(fresh, type, input.days)
    await post(
      {
        balance,
        companyId: input.companyId,
        type: "RESERVATION",
        days: input.days,
        requestId: input.requestId,
        actor: input.actor,
      },
      deps
    )
    return getBalance(input, deps)
  })
}

/** A pending request is rejected or withdrawn: whatever it still holds is released. */
export async function releaseReservation(
  input: RequestKey,
  deps: Deps
): Promise<BalanceView> {
  return withTransaction(async () => {
    const { balance, view } = await loadBalance(input, deps)
    if (!balance) return view
    await lock(input.companyId, balance._id)
    const { reserved } = await requestTotals(
      input.companyId,
      balance._id,
      input.requestId
    )
    if (reserved > 0) {
      await post(
        {
          balance,
          companyId: input.companyId,
          type: "RELEASE",
          days: reserved,
          requestId: input.requestId,
          actor: input.actor,
        },
        deps
      )
    }
    return getBalance(input, deps)
  })
}

/**
 * A request is approved: its reservation is released and the days are
 * deducted per date (upcoming until each date passes, then used). Without a
 * reservation (e.g. an Admin's request already approved), availability is
 * checked first.
 */
export async function deductApprovedDays(
  input: RequestKey & { breakdown: DayAmount[] },
  deps: Deps
): Promise<BalanceView> {
  const total = input.breakdown.reduce((s, d) => s + d.days, 0)
  return withTransaction(async () => {
    const { type, balance, view } = await loadBalance(input, deps)
    await markLeaveTypeInUse({ companyId: input.companyId, id: type.id })
    if (!balance) return view
    await lock(input.companyId, balance._id)
    const { reserved } = await requestTotals(
      input.companyId,
      balance._id,
      input.requestId
    )
    if (reserved > 0) {
      await post(
        {
          balance,
          companyId: input.companyId,
          type: "RELEASE",
          days: reserved,
          requestId: input.requestId,
          actor: input.actor,
        },
        deps
      )
    }
    if (total > reserved) {
      assertAvailable(await getBalance(input, deps), type, total - reserved)
    }
    await post(
      {
        balance,
        companyId: input.companyId,
        type: "DEDUCTION",
        days: total,
        breakdown: input.breakdown,
        requestId: input.requestId,
        actor: input.actor,
      },
      deps
    )
    return getBalance(input, deps)
  })
}

/**
 * An approved request is cancelled: its days from `fromDate` on (default:
 * the company's today, i.e. the days not taken yet) are restored.
 */
export async function restoreDays(
  input: RequestKey & { fromDate?: PlainDate },
  deps: Deps
): Promise<BalanceView> {
  return withTransaction(async () => {
    const { balance, view, ctx } = await loadBalance(input, deps)
    if (!balance) return view
    await lock(input.companyId, balance._id)
    const from = input.fromDate ?? ctx.today
    const { taken } = await requestTotals(
      input.companyId,
      balance._id,
      input.requestId
    )
    const breakdown = [...taken.entries()]
      .filter(([date, days]) => date >= from && days > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, days]) => ({ date, days }))
    const total = breakdown.reduce((s, d) => s + d.days, 0)
    if (total > 0) {
      await post(
        {
          balance,
          companyId: input.companyId,
          type: "RESTORATION",
          days: total,
          breakdown,
          requestId: input.requestId,
          actor: input.actor,
        },
        deps
      )
    }
    return getBalance(input, deps)
  })
}

// ─────────────────────────────── rollover ───────────────────────────────

/**
 * Opens a leave year for a company: creates every active employee's
 * entitlement for every tracked type (pro-rated for joiners). No carry-over:
 * the Admin adds it as an adjustment. Safe to run again.
 */
export async function openLeaveYear(
  input: { companyId: string; year: number; employeeIds: string[] },
  deps: Deps
): Promise<number> {
  const { startMonth } = await companyContext(input.companyId, deps)
  const types = await LeaveTypeModel.find({
    companyId: input.companyId,
    archived: false,
    tracksBalance: true,
  }).lean()
  let created = 0
  for (const employeeId of input.employeeIds) {
    for (const type of types) {
      const before = await LeaveBalanceModel.exists({
        companyId: input.companyId,
        employeeId,
        leaveTypeId: type._id,
        year: input.year,
      })
      if (before) continue
      await ensureBalance(
        {
          companyId: input.companyId,
          employeeId,
          type: toLeaveTypeView(type as Parameters<typeof toLeaveTypeView>[0]),
          year: input.year,
          startMonth,
        },
        deps
      )
      created += 1
    }
  }
  return created
}

/**
 * Leave usage of a leave year per tracked type, company-wide (BE-13):
 * entitled (entitlements + adjustments), used (dates passed), upcoming
 * (approved, ahead) and pending, summed over every balance of the year.
 */
export async function leaveUsageByType(
  input: { companyId: string; year?: number },
  deps: Deps
) {
  const ctx = await companyContext(input.companyId, deps)
  const year = input.year ?? leaveYearOf(ctx.today, ctx.startMonth)
  const [types, entries] = await Promise.all([
    LeaveTypeModel.find({
      companyId: input.companyId,
      tracksBalance: true,
      archived: false,
    })
      .sort({ nameKey: 1 })
      .lean(),
    LeaveLedgerEntryModel.find(
      { companyId: input.companyId, year },
      { leaveTypeId: 1, type: 1, days: 1, breakdown: 1 }
    ).lean(),
  ])
  return {
    year,
    items: types.map((type) => {
      const summary = summarize(
        entries
          .filter((e) => e.leaveTypeId === type._id)
          .map((e) => ({
            type: e.type as LedgerEntryType,
            days: e.days,
            breakdown: e.breakdown?.map((d) => ({
              date: d.date!,
              days: d.days,
            })),
          })),
        ctx.today
      )
      return {
        leaveType: { id: type._id, name: type.name, icon: type.icon },
        entitled: summary.entitlement + summary.adjustments,
        used: summary.used,
        upcoming: summary.upcoming,
        pending: summary.pending,
      }
    }),
  }
}
