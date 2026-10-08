import { model, Schema, type InferSchemaType } from "mongoose"

import { baseSchemaOptions, uuidId } from "../../platform/db/schema.ts"
import { isTimeZone } from "../../platform/time/time.ts"

/**
 * The tenant. Every tenant-owned collection added by later tickets stores the
 * company's id, and BE-02 scopes every query by it.
 *
 * BE-01 keeps only what the foundation needs: the tenant itself and its
 * timezone, which decides what "today" means for attendance and leave.
 * Settings (working days, work hours, leave year, logo) arrive with BE-05.
 */
const companySchema = new Schema(
  {
    _id: uuidId(),
    name: { type: String, required: true, trim: true },
    /** IANA timezone, e.g. Asia/Riyadh */
    timezone: {
      type: String,
      required: true,
      validate: { validator: isTimeZone, message: "must be an IANA timezone" },
    },
  },
  baseSchemaOptions
)

export type Company = InferSchemaType<typeof companySchema>

export const CompanyModel = model("Company", companySchema)
