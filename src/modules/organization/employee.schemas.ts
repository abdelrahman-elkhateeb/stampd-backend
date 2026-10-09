import { z } from "zod"

import { isPlainDate } from "../../platform/time/time.ts"
import { LOCALES, ROLES, USER_STATUSES } from "../identity/user.model.ts"
import { EMPLOYMENT_TYPES } from "./employee.model.ts"

/** Request bodies of the employee endpoints (Trello BE-06), shared with the CSV import. */
export const plainDate = z
  .string()
  .refine(isPlainDate, "must be a date (YYYY-MM-DD)")

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || null)
    .nullable()
    .optional()

export const employeeFields = {
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  phone: optionalText(30),
  jobTitle: optionalText(100),
  employeeCode: optionalText(30),
  joiningDate: plainDate,
  employmentType: z.enum(EMPLOYMENT_TYPES),
  tracksAttendance: z.boolean(),
  role: z.enum(ROLES),
  departmentId: z.uuid().nullable(),
  managerId: z.uuid().nullable(),
  locale: z.enum(LOCALES),
}

export const createEmployeeBody = z.object({
  ...employeeFields,
  employmentType: employeeFields.employmentType.default("FULL_TIME"),
  tracksAttendance: employeeFields.tracksAttendance.default(true),
  role: employeeFields.role.default("EMPLOYEE"),
  departmentId: employeeFields.departmentId.optional(),
  managerId: employeeFields.managerId.optional(),
  locale: employeeFields.locale.default("en"),
})

/** PATCH: any subset; an empty body changes nothing. */
export const updateEmployeeBody = z
  .object({
    name: employeeFields.name,
    email: employeeFields.email,
    phone: employeeFields.phone,
    jobTitle: employeeFields.jobTitle,
    employeeCode: employeeFields.employeeCode,
    joiningDate: employeeFields.joiningDate.nullable(),
    employmentType: employeeFields.employmentType,
    tracksAttendance: employeeFields.tracksAttendance,
    role: employeeFields.role,
    departmentId: employeeFields.departmentId,
    managerId: employeeFields.managerId,
  })
  .partial()

const multi = <T extends z.ZodType>(item: T) =>
  z.preprocess(
    (value) => (value === undefined ? undefined : [value].flat()),
    z.array(item)
  )

export const employeeFilters = {
  search: z.string().trim().min(1).max(100).optional(),
  departmentId: z.uuid().optional(),
  managerId: z.uuid().optional(),
  status: multi(z.enum(USER_STATUSES)).optional(),
  role: multi(z.enum(ROLES)).optional(),
}

export const deactivationBody = z.object({
  lastWorkingDay: plainDate,
  reassignReportsTo: z.uuid().nullable().optional(),
})

/** CSV columns (header names, any order, case-insensitive). */
export const CSV_COLUMNS = [
  "name",
  "email",
  "joiningDate",
  "role",
  "department",
  "managerEmail",
  "jobTitle",
  "phone",
  "employeeCode",
  "employmentType",
  "tracksAttendance",
] as const
export const CSV_REQUIRED = ["name", "email", "joiningDate"] as const

const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value

/** One CSV row, as strings; blank cells use the defaults. */
export const csvRowSchema = z.object({
  name: employeeFields.name,
  email: employeeFields.email,
  joiningDate: plainDate,
  role: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
    z.preprocess(blankToUndefined, employeeFields.role.default("EMPLOYEE"))
  ),
  department: z.preprocess(
    blankToUndefined,
    z.string().trim().max(80).optional()
  ),
  managerEmail: z.preprocess(blankToUndefined, z.email().optional()),
  jobTitle: employeeFields.jobTitle,
  phone: employeeFields.phone,
  employeeCode: employeeFields.employeeCode,
  employmentType: z.preprocess(
    (v) =>
      typeof v === "string"
        ? v.trim().toUpperCase().replace(/[\s-]/g, "_") || undefined
        : v,
    employeeFields.employmentType.default("FULL_TIME")
  ),
  tracksAttendance: z.preprocess((v) => {
    if (typeof v !== "string" || v.trim() === "") return undefined
    const text = v.trim().toLowerCase()
    if (["true", "yes", "1", "y"].includes(text)) return true
    if (["false", "no", "0", "n"].includes(text)) return false
    return v
  }, employeeFields.tracksAttendance.default(true)),
})
