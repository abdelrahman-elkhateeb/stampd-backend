import { model, Schema, type InferSchemaType } from "mongoose"

import { baseSchemaOptions, uuidId } from "../../platform/db/schema.ts"
import { isTimeZone } from "../../platform/time/time.ts"

/** Weekday codes, the same values the frontend uses (company.weekStart / workingDays). */
export const WEEKDAYS = [
  "SUN",
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
  "SAT",
] as const
export type Weekday = (typeof WEEKDAYS)[number]

/**
 * New companies work Sunday to Thursday (Friday and Saturday off, the GCC
 * norm). Decision 2026-10-09, matching FE-04; the Admin changes it in settings.
 */
export const DEFAULT_WORKING_DAYS: readonly Weekday[] = [
  "SUN",
  "MON",
  "TUE",
  "WED",
  "THU",
]

/**
 * The tenant. Every tenant-owned collection added by later tickets stores the
 * company's id, and BE-02 scopes every query by it.
 *
 * Kept so far: the tenant, its timezone (which decides what "today" means for
 * attendance and leave), its week start and working days (default Sun–Thu),
 * and the signup's terms acceptance. The other settings (work hours, grace,
 * leave year, logo) arrive with BE-05.
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
    /** Terms of service + privacy policy accepted at signup (BE-02). */
    termsVersion: { type: String },
    termsAcceptedAt: { type: Date },
    termsAcceptedBy: { type: String },
    /** First day of the week in calendars and date pickers (BE-05 makes it editable). */
    weekStart: { type: String, enum: WEEKDAYS, default: "SUN" },
    workingDays: {
      type: [{ type: String, enum: WEEKDAYS }],
      default: () => [...DEFAULT_WORKING_DAYS],
      validate: {
        validator: (days: string[]) =>
          days.length > 0 && new Set(days).size === days.length,
        message: "must list at least one weekday, each once",
      },
    },
  },
  baseSchemaOptions
)

export type Company = InferSchemaType<typeof companySchema>

export const CompanyModel = model("Company", companySchema)
