import { model, Schema, type InferSchemaType } from "mongoose"

import { uuidId } from "../../platform/db/schema.ts"
import { tenantIdField, tenantScoped } from "../../platform/db/tenant.ts"

/**
 * One change to a tracked record (Trello BE-04): who changed what, when and
 * why. Append-only: history is never edited or deleted while the company
 * account exists. Every update, replace and delete on this model throws, and
 * so does saving a loaded entry again.
 */
export const ENTITY_TYPES = [
  "ATTENDANCE_DAY",
  "LEAVE_BALANCE",
  "REQUEST",
  "EMPLOYEE",
  "COMPANY_SETTINGS",
] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

/** USER: someone did it. APPROVAL: an approver's decision. SYSTEM_JOB: a scheduled job. */
export const HISTORY_SOURCES = ["USER", "APPROVAL", "SYSTEM_JOB"] as const
export type HistorySource = (typeof HISTORY_SOURCES)[number]

const historyEntrySchema = new Schema(
  {
    _id: uuidId(),
    companyId: tenantIdField(),
    entityType: { type: String, enum: ENTITY_TYPES, required: true },
    entityId: { type: String, required: true },
    /**
     * Whose record it is (BE-03 scoping): the employee for attendance days,
     * balances, requests and employee records; null for company settings.
     */
    subjectEmployeeId: { type: String, default: null },
    action: { type: String, required: true },
    /** The user who made the change; null for system jobs. */
    actorId: { type: String, default: null },
    /** The system job's name when actorId is null, e.g. "attendance.nightlyClose". */
    systemJob: { type: String, default: null },
    source: { type: String, enum: HISTORY_SOURCES, required: true },
    /** When the change happened (UTC). */
    at: { type: Date, required: true },
    /** Only the fields that changed: their values before and after. */
    oldValues: { type: Schema.Types.Mixed, default: {} },
    newValues: { type: Schema.Types.Mixed, default: {} },
    reason: { type: String, default: null },
  },
  { versionKey: false, minimize: false }
)
historyEntrySchema.index({ companyId: 1, entityType: 1, entityId: 1, at: -1 })
historyEntrySchema.plugin(tenantScoped)

export class HistoryImmutableError extends Error {
  override readonly name = "HistoryImmutableError"
  constructor() {
    super("History entries are append-only: they can't be edited or deleted")
  }
}

const CHANGES =
  /^(updateOne|updateMany|findOneAndUpdate|replaceOne|findOneAndReplace|deleteOne|deleteMany|findOneAndDelete)$/
historyEntrySchema.pre(CHANGES, { document: false, query: true }, () => {
  throw new HistoryImmutableError()
})
historyEntrySchema.pre(
  ["updateOne", "deleteOne"],
  { document: true, query: false },
  () => {
    throw new HistoryImmutableError()
  }
)
historyEntrySchema.pre("save", function () {
  if (!this.isNew) throw new HistoryImmutableError()
})
historyEntrySchema.pre("bulkWrite", () => {
  throw new HistoryImmutableError()
})

export type HistoryEntry = InferSchemaType<typeof historyEntrySchema>

export const HistoryEntryModel = model("HistoryEntry", historyEntrySchema)
