import { model, Schema, type InferSchemaType } from "mongoose"

import { baseSchemaOptions, plainDateField } from "../../platform/db/schema.ts"
import { tenantIdField, tenantScoped } from "../../platform/db/tenant.ts"

/**
 * The HR record of a person. Every login account (identity's User) has exactly
 * one Employee record, and they share the same id (decision 2026-10-09: one
 * account per person; the Admin who signs up is also an employee).
 *
 * BE-03 added the reporting line (manager, department), which decides who
 * may see whose data; BE-06 the profile and employment fields. The login
 * side (email, role, status, last working day) lives on identity's User.
 */
export const EMPLOYMENT_TYPES = [
  "FULL_TIME",
  "PART_TIME",
  "CONTRACTOR",
] as const
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number]

const employeeSchema = new Schema(
  {
    /** Same id as the User it belongs to (set explicitly, no default). */
    _id: { type: String, required: true },
    companyId: tenantIdField(),
    name: { type: String, required: true, trim: true, maxlength: 120 },
    /** The direct manager's employee id. Their team scope is derived from it. */
    managerId: { type: String, default: null },
    /** Colleagues in the same department see each other's "Out" / "WFH". */
    departmentId: { type: String, default: null },
    /** Profile photo (StoredFile id, BE-05 uploads), or null */
    photoFileId: { type: String, default: null },
    phone: { type: String, default: null, trim: true, maxlength: 30 },
    jobTitle: { type: String, default: null, trim: true, maxlength: 100 },
    /** Optional HR code, unique in the company when set */
    employeeCode: { type: String, default: null, trim: true, maxlength: 30 },
    /** Drives leave pro-rating (BE-08) and when attendance is expected (BE-07) */
    joiningDate: plainDateField(),
    /** Informational only */
    employmentType: {
      type: String,
      enum: EMPLOYMENT_TYPES,
      default: "FULL_TIME",
    },
    /** false for people who don't clock in (e.g. field staff, executives) */
    tracksAttendance: { type: Boolean, default: true },
  },
  baseSchemaOptions
)
employeeSchema.index({ companyId: 1, managerId: 1 })
employeeSchema.index({ companyId: 1, departmentId: 1 })
employeeSchema.index(
  { companyId: 1, employeeCode: 1 },
  {
    unique: true,
    partialFilterExpression: { employeeCode: { $type: "string" } },
  }
)
employeeSchema.plugin(tenantScoped)

export type Employee = InferSchemaType<typeof employeeSchema>

export const EmployeeModel = model("Employee", employeeSchema)
