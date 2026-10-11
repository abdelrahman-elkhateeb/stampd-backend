import { withTransaction } from "../../platform/db/connection.ts"
import { isDuplicateKey } from "../../platform/db/schema.ts"
import { purgeAppendOnly } from "../../platform/db/append-only.ts"
import { apiErrors } from "../../platform/http/errors.ts"
import type { Clock } from "../../platform/time/clock.ts"
import { recordHistory, type HistoryActor } from "../history/history.service.ts"
import {
  LeaveBalanceModel,
  LeaveLedgerEntryModel,
  LeaveTypeModel,
  type LeaveIcon,
} from "./leave.model.ts"

/**
 * Leave types and their policies (Trello BE-08). Changes are recorded on the
 * company settings' history (BE-04), keyed "leaveType:{id}".
 */
type Deps = { clock: Clock }

export type LeaveTypePolicy = {
  name: string
  icon: LeaveIcon
  paid: boolean
  tracksBalance: boolean
  defaultAllowanceDays: number
  allowNegativeBalance: boolean
  halfDaysAllowed: boolean
  requiresReason: boolean
}

export type LeaveTypeView = LeaveTypePolicy & {
  id: string
  archived: boolean
  inUse: boolean
}

/**
 * Every new company starts with these (all editable). Allowances follow common
 * GCC practice; the Admin sets their own.
 */
export const DEFAULT_LEAVE_TYPES: readonly LeaveTypePolicy[] = [
  {
    name: "Annual",
    icon: "annual",
    paid: true,
    tracksBalance: true,
    defaultAllowanceDays: 21,
    allowNegativeBalance: false,
    halfDaysAllowed: true,
    requiresReason: false,
  },
  {
    name: "Sick",
    icon: "sick",
    paid: true,
    tracksBalance: true,
    defaultAllowanceDays: 30,
    allowNegativeBalance: false,
    halfDaysAllowed: true,
    requiresReason: true,
  },
  {
    name: "Emergency",
    icon: "emergency",
    paid: true,
    tracksBalance: true,
    defaultAllowanceDays: 3,
    allowNegativeBalance: false,
    halfDaysAllowed: true,
    requiresReason: true,
  },
  {
    name: "Unpaid",
    icon: "unpaid",
    paid: false,
    tracksBalance: false,
    defaultAllowanceDays: 0,
    allowNegativeBalance: false,
    halfDaysAllowed: true,
    requiresReason: true,
  },
]

const nameKey = (name: string) => name.trim().toLocaleLowerCase()

type LeaveTypeDoc = LeaveTypePolicy & {
  _id: string
  archived?: boolean | null
  inUse?: boolean | null
}

export const toLeaveTypeView = (t: LeaveTypeDoc): LeaveTypeView => ({
  id: t._id,
  name: t.name,
  icon: t.icon,
  paid: t.paid,
  tracksBalance: t.tracksBalance,
  defaultAllowanceDays: t.defaultAllowanceDays,
  allowNegativeBalance: t.allowNegativeBalance,
  halfDaysAllowed: t.halfDaysAllowed,
  requiresReason: t.requiresReason,
  archived: Boolean(t.archived),
  inUse: Boolean(t.inUse),
})

const POLICY_KEYS = [
  "name",
  "icon",
  "paid",
  "tracksBalance",
  "defaultAllowanceDays",
  "allowNegativeBalance",
  "halfDaysAllowed",
  "requiresReason",
  "archived",
] as const

const historyValues = (view: LeaveTypeView) => ({
  [`leaveType:${view.id}`]: Object.fromEntries(
    POLICY_KEYS.map((key) => [key, view[key]])
  ),
})

/** Adds the default types a company doesn't have yet (by name). Safe to run again. */
export async function seedDefaultLeaveTypes(companyId: string): Promise<void> {
  for (const policy of DEFAULT_LEAVE_TYPES) {
    await LeaveTypeModel.updateOne(
      { companyId, nameKey: nameKey(policy.name) },
      { $setOnInsert: { ...policy, nameKey: nameKey(policy.name) } },
      { upsert: true }
    )
  }
}

export async function listLeaveTypes(input: {
  companyId: string
  includeArchived: boolean
}): Promise<LeaveTypeView[]> {
  const types = await LeaveTypeModel.find({
    companyId: input.companyId,
    ...(input.includeArchived ? {} : { archived: false }),
  })
    .sort({ archived: 1, nameKey: 1 })
    .lean()
  return types.map((t) => toLeaveTypeView(t as LeaveTypeDoc))
}

export async function getLeaveType(input: {
  companyId: string
  id: string
}): Promise<LeaveTypeView | undefined> {
  const type = await LeaveTypeModel.findOne({
    _id: input.id,
    companyId: input.companyId,
  }).lean()
  return type ? toLeaveTypeView(type as LeaveTypeDoc) : undefined
}

/** Once a type has been used, it can only be archived (BE-08 AC). Called by BE-10 too. */
export async function markLeaveTypeInUse(input: {
  companyId: string
  id: string
}): Promise<void> {
  await LeaveTypeModel.updateOne(
    { _id: input.id, companyId: input.companyId, inUse: { $ne: true } },
    { $set: { inUse: true } }
  )
}

const nameTaken = () =>
  apiErrors.fieldError(
    "name",
    "ALREADY_EXISTS",
    "a leave type with this name exists"
  )
const inUse = (message: string) =>
  apiErrors.conflictWith("LEAVE_TYPE_IN_USE", message)

export async function addLeaveType(
  input: { companyId: string; policy: LeaveTypePolicy; actor: HistoryActor },
  deps: Deps
): Promise<LeaveTypeView> {
  try {
    return await withTransaction(async () => {
      const [created] = await LeaveTypeModel.create([
        {
          companyId: input.companyId,
          ...input.policy,
          defaultAllowanceDays: input.policy.tracksBalance
            ? input.policy.defaultAllowanceDays
            : 0,
          nameKey: nameKey(input.policy.name),
        },
      ])
      const view = toLeaveTypeView(created!.toObject() as LeaveTypeDoc)
      await recordHistory(
        {
          companyId: input.companyId,
          action: "leaveType.added",
          entityId: input.companyId,
          actor: input.actor,
          before: {},
          after: historyValues(view),
        },
        deps
      )
      return view
    })
  } catch (error) {
    if (isDuplicateKey(error, "nameKey")) throw nameTaken()
    throw error
  }
}

/**
 * Changes a policy (or archives / unarchives the type). Turning balance
 * tracking on or off once the type is in use is refused (409
 * LEAVE_TYPE_IN_USE): existing balances would stop adding up. A new default
 * allowance applies to entitlements created from now on.
 */
export async function changeLeaveType(
  input: {
    companyId: string
    id: string
    change: Partial<LeaveTypePolicy> & { archived?: boolean }
    actor: HistoryActor
  },
  deps: Deps
): Promise<LeaveTypeView | undefined> {
  const { companyId, id, change } = input
  try {
    return await withTransaction(async () => {
      const existing = await LeaveTypeModel.findOne({
        _id: id,
        companyId,
      }).lean()
      if (!existing) return undefined
      const before = toLeaveTypeView(existing as LeaveTypeDoc)
      if (
        change.tracksBalance !== undefined &&
        change.tracksBalance !== before.tracksBalance &&
        before.inUse
      ) {
        throw inUse("Balance tracking can't change once the type has been used")
      }
      await LeaveTypeModel.updateOne(
        { _id: id, companyId },
        {
          $set: {
            ...change,
            ...(change.name ? { nameKey: nameKey(change.name) } : {}),
          },
        },
        { runValidators: true }
      )
      const after = toLeaveTypeView(
        (await LeaveTypeModel.findOne({
          _id: id,
          companyId,
        }).lean()) as LeaveTypeDoc
      )
      await recordHistory(
        {
          companyId,
          action: "leaveType.changed",
          entityId: companyId,
          actor: input.actor,
          before: historyValues(before),
          after: historyValues(after),
        },
        deps
      )
      return after
    })
  } catch (error) {
    if (isDuplicateKey(error, "nameKey")) throw nameTaken()
    throw error
  }
}

/**
 * Deletes a type nobody has used yet, with its (unused) entitlements. A used
 * type is refused with 409 LEAVE_TYPE_IN_USE: archive it instead.
 * false when the type isn't in the company.
 */
export async function removeLeaveType(
  input: { companyId: string; id: string; actor: HistoryActor },
  deps: Deps
): Promise<boolean> {
  const { companyId, id } = input
  return withTransaction(async () => {
    const existing = await LeaveTypeModel.findOne({ _id: id, companyId }).lean()
    if (!existing) return false
    const used =
      existing.inUse ||
      (await LeaveLedgerEntryModel.exists({
        companyId,
        leaveTypeId: id,
        type: { $ne: "ALLOWANCE" },
      }))
    if (used) {
      throw inUse("This leave type has been used; archive it instead")
    }
    // Only allowance entries exist, and no balance was ever spent: they never
    // took effect, so they go with the type.
    await purgeAppendOnly(
      LeaveLedgerEntryModel.deleteMany({ companyId, leaveTypeId: id })
    )
    await LeaveBalanceModel.deleteMany({ companyId, leaveTypeId: id })
    await LeaveTypeModel.deleteOne({ _id: id, companyId })
    await recordHistory(
      {
        companyId,
        action: "leaveType.removed",
        entityId: companyId,
        actor: input.actor,
        before: historyValues(toLeaveTypeView(existing as LeaveTypeDoc)),
        after: {},
      },
      deps
    )
    return true
  })
}
