import { model, Schema, type InferSchemaType } from "mongoose"

import { baseSchemaOptions, uuidId } from "../../platform/db/schema.ts"
import { tenantIdField, tenantScoped } from "../../platform/db/tenant.ts"

/**
 * A department (Trello BE-06): a flat list per company, no hierarchy.
 * Names are unique per company regardless of case (nameKey). Deleted only
 * when no employee belongs to it.
 */
const departmentSchema = new Schema(
  {
    _id: uuidId(),
    companyId: tenantIdField(),
    name: { type: String, required: true, trim: true, maxlength: 80 },
    /** name in lower case, for the uniqueness check */
    nameKey: { type: String, required: true },
  },
  baseSchemaOptions
)
departmentSchema.index({ companyId: 1, nameKey: 1 }, { unique: true })
departmentSchema.plugin(tenantScoped)

export const departmentNameKey = (name: string) =>
  name.trim().toLocaleLowerCase()

export type Department = InferSchemaType<typeof departmentSchema>

export const DepartmentModel = model("Department", departmentSchema)
