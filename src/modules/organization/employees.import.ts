import { CsvError, parseCsv } from "../../platform/csv.ts"
import {
  ApiError,
  apiErrors,
  type FieldError,
} from "../../platform/http/errors.ts"
import { toFieldErrors } from "../../platform/http/validation.ts"
import type { Clock } from "../../platform/time/clock.ts"
import type { HistoryActor } from "../history/history.service.ts"
import { findAccountIdByEmail } from "../identity/accounts.ts"
import { departmentNameKey } from "./department.model.ts"
import { departmentIdsByName } from "./departments.service.ts"
import { CSV_COLUMNS, CSV_REQUIRED, csvRowSchema } from "./employee.schemas.ts"
import { hireEmployee } from "./employees.service.ts"

/**
 * CSV import (Trello BE-06): valid rows are created (and invited); invalid
 * rows are reported with their line number and reasons, and nothing is
 * created for them. Each row is its own transaction, so one bad row never
 * undoes the good ones.
 *
 * Columns: see CSV_COLUMNS (header row required, any order, any case).
 * `department` is an existing department's name; `managerEmail` is an
 * existing employee's email or the email of a row ABOVE in the same file.
 */
export const MAX_IMPORT_ROWS = 1000

export type ImportError = FieldError & { row: number }
export type ImportReport = {
  createdCount: number
  created: { row: number; id: string; email: string }[]
  errors: ImportError[]
}

/** Field names in errors are the CSV column names. */
const COLUMN_FOR_FIELD: Record<string, string> = {
  managerId: "managerEmail",
  departmentId: "department",
}

function readHeader(cells: string[]): (typeof CSV_COLUMNS)[number][] {
  const byKey = new Map(CSV_COLUMNS.map((c) => [c.toLowerCase(), c]))
  const columns = cells.map((cell) => {
    const column = byKey.get(cell.trim().toLowerCase())
    if (!column) {
      throw apiErrors.fieldError(
        "file",
        "INVALID_FORMAT",
        `unknown column "${cell.trim()}"; expected ${CSV_COLUMNS.join(", ")}`
      )
    }
    return column
  })
  const missing = CSV_REQUIRED.filter((c) => !columns.includes(c))
  if (missing.length) {
    throw apiErrors.fieldError(
      "file",
      "INVALID_FORMAT",
      `missing column(s): ${missing.join(", ")}`
    )
  }
  return columns
}

export async function importEmployees(
  input: {
    companyId: string
    csv: string
    actor: HistoryActor
    /** Sends the invitation of a created employee */
    invite: (employeeId: string) => Promise<void>
  },
  deps: { clock: Clock }
): Promise<ImportReport> {
  let rows
  try {
    rows = parseCsv(input.csv)
  } catch (error) {
    if (error instanceof CsvError) {
      throw apiErrors.fieldError("file", "INVALID_FORMAT", error.message)
    }
    throw error
  }
  const [header, ...dataRows] = rows
  if (!header || dataRows.length === 0) {
    throw apiErrors.fieldError(
      "file",
      "REQUIRED",
      "the file has no employee rows"
    )
  }
  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw apiErrors.fieldError(
      "file",
      "TOO_LONG",
      `at most ${MAX_IMPORT_ROWS} rows per file`
    )
  }
  const columns = readHeader(header.cells)
  const departments = await departmentIdsByName(input.companyId)
  /** Emails created by rows above, for managerEmail */
  const createdByEmail = new Map<string, string>()
  const seenEmails = new Set<string>()
  const report: ImportReport = { createdCount: 0, created: [], errors: [] }
  const fail = (row: number, errors: FieldError[]) =>
    report.errors.push(...errors.map((error) => ({ row, ...error })))

  for (const { line, cells } of dataRows) {
    const raw = Object.fromEntries(
      columns.map((column, i) => [column, cells[i] ?? ""])
    )
    const parsed = csvRowSchema.safeParse(raw)
    if (!parsed.success) {
      fail(line, toFieldErrors(parsed.error.issues, "row", raw))
      continue
    }
    const row = parsed.data
    const email = row.email.trim().toLowerCase()
    const problems: FieldError[] = []
    if (seenEmails.has(email)) {
      problems.push({
        field: "email",
        code: "ALREADY_EXISTS",
        message: "email appears more than once in the file",
      })
    }
    seenEmails.add(email)

    const departmentId = row.department
      ? departments.get(departmentNameKey(row.department))
      : undefined
    if (row.department && !departmentId) {
      problems.push({
        field: "department",
        code: "UNKNOWN_REFERENCE",
        message: "no department with this name; create it first",
      })
    }
    let managerId: string | undefined
    if (row.managerEmail) {
      const managerEmail = row.managerEmail.trim().toLowerCase()
      managerId =
        createdByEmail.get(managerEmail) ??
        (await findAccountIdByEmail({
          companyId: input.companyId,
          email: managerEmail,
        }))
      if (!managerId) {
        problems.push({
          field: "managerEmail",
          code: "UNKNOWN_REFERENCE",
          message: "no employee with this email (or on a row above)",
        })
      }
    }
    if (problems.length) {
      fail(line, problems)
      continue
    }

    try {
      const id = await hireEmployee(
        {
          companyId: input.companyId,
          actor: input.actor,
          employee: {
            name: row.name,
            email,
            role: row.role,
            locale: "en",
            joiningDate: row.joiningDate,
            jobTitle: row.jobTitle,
            phone: row.phone,
            employeeCode: row.employeeCode,
            employmentType: row.employmentType,
            tracksAttendance: row.tracksAttendance,
            departmentId,
            managerId,
          },
        },
        deps
      )
      await input.invite(id)
      createdByEmail.set(email, id)
      report.created.push({ row: line, id, email })
    } catch (error) {
      if (!(error instanceof ApiError) || error.fieldErrors.length === 0) {
        throw error
      }
      fail(
        line,
        error.fieldErrors.map((e) => ({
          ...e,
          field: COLUMN_FOR_FIELD[e.field] ?? e.field,
        }))
      )
    }
  }
  report.createdCount = report.created.length
  return report
}
