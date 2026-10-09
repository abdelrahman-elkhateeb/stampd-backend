import { model, Schema, type InferSchemaType } from "mongoose"

import { baseSchemaOptions } from "../../platform/db/schema.ts"
import { tenantIdField, tenantScoped } from "../../platform/db/tenant.ts"

/**
 * The HR record of a person. Every login account (identity's User) has exactly
 * one Employee record, and they share the same id (decision 2026-10-09: one
 * account per person; the Admin who signs up is also an employee).
 *
 * BE-03 adds the reporting line (manager, department), which decides who may
 * see whose data. BE-06 adds job title, joining date and the rest, the
 * Department model, and manager-loop prevention.
 */
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
  },
  baseSchemaOptions
)
employeeSchema.index({ companyId: 1, managerId: 1 })
employeeSchema.index({ companyId: 1, departmentId: 1 })
employeeSchema.plugin(tenantScoped)

export type Employee = InferSchemaType<typeof employeeSchema>

export const EmployeeModel = model("Employee", employeeSchema)
