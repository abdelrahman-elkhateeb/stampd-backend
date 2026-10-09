import { model, Schema, type InferSchemaType } from "mongoose"

import {
  baseSchemaOptions,
  plainDateField,
  uuidId,
} from "../../platform/db/schema.ts"
import { tenantIdField, tenantScoped } from "../../platform/db/tenant.ts"

/**
 * A public holiday: one record from startDate to endDate, both included (a
 * one-day holiday has start = end). Decision 2026-10-09 on Trello BE-05. It
 * belongs to a year's list when any of its days falls in that year.
 */
const holidaySchema = new Schema(
  {
    _id: uuidId(),
    companyId: tenantIdField(),
    name: { type: String, required: true, trim: true, maxlength: 100 },
    startDate: plainDateField({ required: true }),
    endDate: plainDateField({ required: true }),
  },
  baseSchemaOptions
)
holidaySchema.index({ companyId: 1, startDate: 1, endDate: 1 })
holidaySchema.plugin(tenantScoped)

export type Holiday = InferSchemaType<typeof holidaySchema>

export const HolidayModel = model("Holiday", holidaySchema)
