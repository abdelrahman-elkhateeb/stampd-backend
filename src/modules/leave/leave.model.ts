import { model, Schema, type InferSchemaType } from "mongoose"

import { appendOnly } from "../../platform/db/append-only.ts"
import {
  baseSchemaOptions,
  plainDateField,
  uuidId,
  uuidV7,
} from "../../platform/db/schema.ts"
import { tenantIdField, tenantScoped } from "../../platform/db/tenant.ts"
import { LEDGER_ENTRY_TYPES } from "./balance-math.ts"

/**
 * Leave (Trello BE-08).
 *
 *  LeaveType          a company's leave type and its policy
 *  LeaveBalance       one per employee, tracked type and leave year: how its
 *                     entitlement was set; also the lock that serialises
 *                     changes, so two requests can never spend the same days
 *  LeaveLedgerEntry   every change to a balance, append-only; balances are
 *                     always computed from these entries
 *  LeaveYearRun       which leave years the rollover job has opened per company
 */

/** Icon keys the frontend maps to its icons (a fixed set, Trello BE-08). */
export const LEAVE_ICONS = [
  "annual",
  "sick",
  "emergency",
  "unpaid",
  "maternity",
  "paternity",
  "bereavement",
  "marriage",
  "hajj",
  "study",
  "other",
] as const
export type LeaveIcon = (typeof LEAVE_ICONS)[number]

const leaveTypeSchema = new Schema(
  {
    _id: uuidId(),
    companyId: tenantIdField(),
    name: { type: String, required: true, trim: true, maxlength: 60 },
    /** lower-case name, unique per company */
    nameKey: { type: String, required: true },
    icon: { type: String, enum: LEAVE_ICONS, default: "other" },
    paid: { type: Boolean, default: true },
    /** false: no balance is kept and requests are never limited (e.g. Unpaid) */
    tracksBalance: { type: Boolean, default: true },
    /** Yearly allowance in days (half days allowed) for new entitlements */
    defaultAllowanceDays: { type: Number, default: 0, min: 0, max: 366 },
    allowNegativeBalance: { type: Boolean, default: false },
    halfDaysAllowed: { type: Boolean, default: true },
    requiresReason: { type: Boolean, default: false },
    archived: { type: Boolean, default: false },
    /** Set once any request or balance movement used it: then it can only be archived */
    inUse: { type: Boolean, default: false },
  },
  baseSchemaOptions
)
leaveTypeSchema.index({ companyId: 1, nameKey: 1 }, { unique: true })
leaveTypeSchema.plugin(tenantScoped)

export type LeaveType = InferSchemaType<typeof leaveTypeSchema>
export const LeaveTypeModel = model("LeaveType", leaveTypeSchema)

const balanceSchema = new Schema(
  {
    _id: uuidId(),
    companyId: tenantIdField(),
    employeeId: { type: String, required: true },
    leaveTypeId: { type: String, required: true },
    /** The leave year (named by the calendar year it starts in) */
    year: { type: Number, required: true },
    /** What the entitlement was first set to: the default, or pro-rated */
    proposedDays: { type: Number, required: true },
    /** DEFAULT / PRORATED from the policy, OVERRIDE once an Admin set it */
    entitlementSource: {
      type: String,
      enum: ["DEFAULT", "PRORATED", "OVERRIDE"],
      required: true,
    },
    /** Bumped by every change, inside its transaction: concurrent changes serialise */
    version: { type: Number, default: 0 },
  },
  baseSchemaOptions
)
balanceSchema.index(
  { companyId: 1, employeeId: 1, leaveTypeId: 1, year: 1 },
  { unique: true }
)
balanceSchema.plugin(tenantScoped)

export type LeaveBalance = InferSchemaType<typeof balanceSchema>
export const LeaveBalanceModel = model("LeaveBalance", balanceSchema)

const ledgerEntrySchema = new Schema(
  {
    /** Time-ordered, so entries list in the order they were made */
    _id: { type: String, default: () => uuidV7() },
    companyId: tenantIdField(),
    balanceId: { type: String, required: true },
    employeeId: { type: String, required: true },
    leaveTypeId: { type: String, required: true },
    year: { type: Number, required: true },
    type: { type: String, enum: LEDGER_ENTRY_TYPES, required: true },
    /** ALLOWANCE and ADJUSTMENT are signed; the others are positive */
    days: { type: Number, required: true },
    /** DEDUCTION / RESTORATION: the days per date */
    breakdown: {
      type: [
        new Schema(
          {
            date: plainDateField({ required: true }),
            days: { type: Number, required: true },
          },
          { _id: false }
        ),
      ],
      default: undefined,
    },
    /** The leave request (BE-10) for RESERVATION … RESTORATION */
    requestId: { type: String, default: null },
    reason: { type: String, default: null },
    actorId: { type: String, default: null },
    systemJob: { type: String, default: null },
    at: { type: Date, required: true },
  },
  { versionKey: false }
)
ledgerEntrySchema.index({ companyId: 1, balanceId: 1, _id: 1 })
ledgerEntrySchema.index({ companyId: 1, requestId: 1 })
ledgerEntrySchema.plugin(tenantScoped)
ledgerEntrySchema.plugin(appendOnly, { what: "Leave ledger entries" })

export type LeaveLedgerEntry = InferSchemaType<typeof ledgerEntrySchema>
export const LeaveLedgerEntryModel = model(
  "LeaveLedgerEntry",
  ledgerEntrySchema
)

const yearRunSchema = new Schema(
  {
    _id: uuidId(),
    companyId: tenantIdField(),
    year: { type: Number, required: true },
    openedAt: { type: Date, required: true },
  },
  { versionKey: false }
)
yearRunSchema.index({ companyId: 1, year: 1 }, { unique: true })
yearRunSchema.plugin(tenantScoped)

export const LeaveYearRunModel = model("LeaveYearRun", yearRunSchema)
