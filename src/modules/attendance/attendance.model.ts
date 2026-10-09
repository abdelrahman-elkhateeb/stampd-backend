import { model, Schema, type InferSchemaType } from "mongoose"

import {
  baseSchemaOptions,
  plainDateField,
  uuidId,
} from "../../platform/db/schema.ts"
import { tenantIdField, tenantScoped } from "../../platform/db/tenant.ts"

/**
 * Attendance (Trello BE-07).
 *
 *  AttendanceSession  one check-in … check-out. Several per day are allowed
 *                     (e.g. a lunch break), but never two open at once: a
 *                     unique index on the open flag guarantees it, even for a
 *                     double click or two tabs.
 *  AttendanceDay      the daily record per employee and company-calendar day:
 *                     first check-in, last check-out, worked minutes, status
 *                     and flags. Recalculated from the sessions on every
 *                     change; its id is what history (BE-04) is keyed by.
 *  AttendanceCloseRun which days the end-of-day job has closed, per company.
 */
export const ATTENDANCE_STATUSES = [
  "PRESENT",
  "LATE",
  "ABSENT",
  "WFH",
  "ON_LEAVE",
  "BUSINESS_TRIP",
  "HOLIDAY",
  "WEEKEND",
  "MISSING_CHECKOUT",
] as const
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number]

export const ATTENDANCE_FLAGS = [
  /** checked in on a weekend or holiday */
  "WORKED_ON_NON_WORKING_DAY",
  /** checked in although an approved leave or business trip covers the day */
  "WORKED_DURING_TIME_OFF",
  /** a correction changed the day */
  "CORRECTED",
] as const
export type AttendanceFlag = (typeof ATTENDANCE_FLAGS)[number]

const sessionSchema = new Schema(
  {
    _id: uuidId(),
    companyId: tenantIdField(),
    employeeId: { type: String, required: true },
    /** The company-calendar day the session belongs to */
    date: plainDateField({ required: true }),
    checkInAt: { type: Date, required: true },
    /** null while open, and for a session the day closed without a check-out */
    checkOutAt: { type: Date, default: null },
    /** true only while open; unique per employee (see index) */
    open: { type: Boolean, default: undefined },
    /** Set when the day closed with this session still open (Missing Checkout) */
    autoClosedAt: { type: Date, default: null },
    checkInIp: { type: String, default: null },
    checkInUserAgent: { type: String, default: null },
    checkOutIp: { type: String, default: null },
    checkOutUserAgent: { type: String, default: null },
    /** SELF: the employee's own check-in/out; CORRECTION: added by an Admin */
    source: { type: String, enum: ["SELF", "CORRECTION"], default: "SELF" },
  },
  baseSchemaOptions
)
sessionSchema.index({ companyId: 1, employeeId: 1, date: 1, checkInAt: 1 })
sessionSchema.index(
  { companyId: 1, employeeId: 1, open: 1 },
  { unique: true, partialFilterExpression: { open: true } }
)
sessionSchema.plugin(tenantScoped)

export type AttendanceSession = InferSchemaType<typeof sessionSchema>
export const AttendanceSessionModel = model("AttendanceSession", sessionSchema)

const daySchema = new Schema(
  {
    _id: uuidId(),
    companyId: tenantIdField(),
    employeeId: { type: String, required: true },
    date: plainDateField({ required: true }),
    status: { type: String, enum: ATTENDANCE_STATUSES, default: null },
    flags: { type: [{ type: String, enum: ATTENDANCE_FLAGS }], default: [] },
    firstCheckInAt: { type: Date, default: null },
    lastCheckOutAt: { type: Date, default: null },
    /** Sum of closed sessions; an open or unclosed session doesn't count */
    workedMinutes: { type: Number, default: 0 },
    /** When the end-of-day job closed the day */
    closedAt: { type: Date, default: null },
  },
  baseSchemaOptions
)
daySchema.index({ companyId: 1, employeeId: 1, date: 1 }, { unique: true })
daySchema.index({ companyId: 1, date: 1, status: 1 })
daySchema.plugin(tenantScoped)

export type AttendanceDay = InferSchemaType<typeof daySchema>
export const AttendanceDayModel = model("AttendanceDay", daySchema)

const closeRunSchema = new Schema(
  {
    _id: uuidId(),
    companyId: tenantIdField(),
    date: plainDateField({ required: true }),
    closedAt: { type: Date, required: true },
  },
  { versionKey: false }
)
closeRunSchema.index({ companyId: 1, date: 1 }, { unique: true })
closeRunSchema.plugin(tenantScoped)

export const AttendanceCloseRunModel = model(
  "AttendanceCloseRun",
  closeRunSchema
)
