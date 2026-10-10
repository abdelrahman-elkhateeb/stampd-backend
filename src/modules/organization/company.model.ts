import { model, Schema, type InferSchemaType } from "mongoose"

import {
  baseSchemaOptions,
  plainDateField,
  uuidId,
} from "../../platform/db/schema.ts"
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

/** "HH:mm", 24-hour, a time of day in the company timezone. */
export const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** Defaults for a new company (Trello BE-05; working days per the 2026-10-09 decision). */
export const DEFAULT_SETTINGS = {
  workStartTime: "09:00",
  workEndTime: "17:00",
  lateGraceMinutes: 0,
  /** 1 = January */
  leaveYearStartMonth: 1,
} as const

/**
 * The tenant. Every tenant-owned collection added by later tickets stores the
 * company's id, and BE-02 scopes every query by it.
 *
 * Kept so far: the tenant, its timezone (which decides what "today" means for
 * attendance and leave), its week start and working days (default Sun–Thu),
 * the signup's terms acceptance, and the BE-05 settings: work hours, late
 * grace, leave year start and logo.
 *
 * A timezone change applies from the next day (BE-05 AC): `timezone` is the
 * newest value, and `timezoneHistory` keeps each earlier timezone with the
 * last day it applied to. Read the timezone for a day or an instant through
 * timezoneOn() / timezoneAt() in calendar.ts, never `timezone` directly.
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
    timezoneHistory: {
      type: [
        new Schema(
          {
            timezone: { type: String, required: true },
            /** Last company-calendar day this timezone applied to */
            until: plainDateField({ required: true }),
          },
          { _id: false }
        ),
      ],
      default: () => [],
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
    workStartTime: {
      type: String,
      default: DEFAULT_SETTINGS.workStartTime,
      match: LOCAL_TIME,
    },
    workEndTime: {
      type: String,
      default: DEFAULT_SETTINGS.workEndTime,
      match: LOCAL_TIME,
    },
    lateGraceMinutes: {
      type: Number,
      default: DEFAULT_SETTINGS.lateGraceMinutes,
      min: 0,
      max: 240,
    },
    leaveYearStartMonth: {
      type: Number,
      default: DEFAULT_SETTINGS.leaveYearStartMonth,
      min: 1,
      max: 12,
    },
    /** The logo image (StoredFile id), or null */
    logoFileId: { type: String, default: null },
    /** Request types (BE-09 keys) the company turned off; all are on by default (BE-11) */
    disabledRequestTypes: { type: [String], default: () => [] },
  },
  baseSchemaOptions
)

export type Company = InferSchemaType<typeof companySchema>

export const CompanyModel = model("Company", companySchema)
