import { inTransaction } from "../../platform/db/connection.ts"
import { apiErrors } from "../../platform/http/errors.ts"
import type { Clock } from "../../platform/time/clock.ts"
import {
  HistoryEntryModel,
  type EntityType,
  type HistorySource,
} from "./history.model.ts"

/**
 * Every tracked action (Trello BE-04, "Tracked in MVP"): which record type it
 * changes and whether the person making the change must give a reason. The
 * ticket that builds the change may add actions or adjust the reason rule.
 */
export const HISTORY_ACTIONS = {
  // Attendance (BE-07, BE-08)
  "attendance.recorded": { entityType: "ATTENDANCE_DAY", reason: "optional" },
  "attendance.corrected": { entityType: "ATTENDANCE_DAY", reason: "required" },
  "attendance.closed": { entityType: "ATTENDANCE_DAY", reason: "optional" },
  // Leave balances (BE-08 ledger): automatic changes vs manual adjustments
  "leaveBalance.changed": { entityType: "LEAVE_BALANCE", reason: "optional" },
  "leaveBalance.adjusted": { entityType: "LEAVE_BALANCE", reason: "required" },
  // Requests (BE-09)
  "request.statusChanged": { entityType: "REQUEST", reason: "optional" },
  // Employees (BE-03, BE-06)
  "employee.roleChanged": { entityType: "EMPLOYEE", reason: "optional" },
  "employee.reportingLineChanged": {
    entityType: "EMPLOYEE",
    reason: "optional",
  },
  "employee.statusChanged": { entityType: "EMPLOYEE", reason: "optional" },
  "employee.photoChanged": { entityType: "EMPLOYEE", reason: "optional" },
  // Company settings (BE-05)
  "companySettings.changed": {
    entityType: "COMPANY_SETTINGS",
    reason: "optional",
  },
  // Holidays (BE-05): recorded on the company settings' history
  "holiday.added": { entityType: "COMPANY_SETTINGS", reason: "optional" },
  "holiday.changed": { entityType: "COMPANY_SETTINGS", reason: "optional" },
  "holiday.removed": { entityType: "COMPANY_SETTINGS", reason: "optional" },
} as const satisfies Record<
  string,
  { entityType: EntityType; reason: "optional" | "required" }
>

export type HistoryAction = keyof typeof HISTORY_ACTIONS

/**
 * Who made a change: a user (source USER, or APPROVAL for an approver's
 * decision) or a system job (shown as actor "system").
 */
export type HistoryActor =
  | { type: "USER"; userId: string; source?: "USER" | "APPROVAL" }
  | { type: "SYSTEM"; job: string }

export const REASON_MAX_LENGTH = 500

/**
 * For endpoints: refuse the change before making it when the action needs a
 * reason and none was given (422, field "reason", code REQUIRED).
 * recordHistory() checks again, so a forgotten call can't skip the rule.
 */
export function assertReason(
  action: HistoryAction,
  reason: string | null | undefined
): void {
  if (HISTORY_ACTIONS[action].reason === "required" && !reason?.trim()) {
    throw apiErrors.fieldError(
      "reason",
      "REQUIRED",
      "a reason is required for this change"
    )
  }
}

type Values = Record<string, unknown>

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Keeps only the fields whose value changed (missing counts as null). */
export function changedValues(
  before: Values,
  after: Values
): { oldValues: Values; newValues: Values } {
  const oldValues: Values = {}
  const newValues: Values = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (same(before[key], after[key])) continue
    oldValues[key] = before[key] ?? null
    newValues[key] = after[key] ?? null
  }
  return { oldValues, newValues }
}

export type RecordHistoryInput = {
  companyId: string
  action: HistoryAction
  entityId: string
  /** Whose record it is; required for everything except company settings. */
  subjectEmployeeId?: string
  actor: HistoryActor
  /** The tracked fields before the change ({} when the record is new) */
  before: Values
  /** The same fields after the change */
  after: Values
  reason?: string | null
}

/**
 * Records one change. Call it inside the same withTransaction() as the change
 * itself, so both commit or roll back together; outside a transaction it
 * throws. Stores only the fields that changed; when nothing changed, stores
 * nothing and returns undefined. A missing required reason throws 422, which
 * rolls the change back.
 */
export async function recordHistory(
  input: RecordHistoryInput,
  deps: { clock: Clock }
): Promise<string | undefined> {
  if (!inTransaction()) {
    throw new Error(
      "recordHistory() must run inside withTransaction(), with the change it records"
    )
  }
  const { entityType } = HISTORY_ACTIONS[input.action]
  if (entityType !== "COMPANY_SETTINGS" && !input.subjectEmployeeId) {
    throw new Error(`${input.action} needs subjectEmployeeId`)
  }
  if (entityType === "EMPLOYEE" && input.subjectEmployeeId !== input.entityId) {
    throw new Error("an employee record's subject is the employee itself")
  }
  assertReason(input.action, input.reason)
  const reason = input.reason?.trim() || null
  if (reason && reason.length > REASON_MAX_LENGTH) {
    throw apiErrors.fieldError(
      "reason",
      "TOO_LONG",
      `reason must be at most ${REASON_MAX_LENGTH} characters`
    )
  }

  const { oldValues, newValues } = changedValues(input.before, input.after)
  if (Object.keys(newValues).length === 0) return undefined

  const { actor } = input
  const source: HistorySource =
    actor.type === "SYSTEM" ? "SYSTEM_JOB" : (actor.source ?? "USER")
  const [entry] = await HistoryEntryModel.create([
    {
      companyId: input.companyId,
      entityType,
      entityId: input.entityId,
      subjectEmployeeId:
        entityType === "COMPANY_SETTINGS"
          ? null
          : (input.subjectEmployeeId ?? null),
      action: input.action,
      actorId: actor.type === "USER" ? actor.userId : null,
      systemJob: actor.type === "SYSTEM" ? actor.job : null,
      source,
      at: deps.clock.now(),
      oldValues,
      newValues,
      reason,
    },
  ])
  return entry!._id
}
