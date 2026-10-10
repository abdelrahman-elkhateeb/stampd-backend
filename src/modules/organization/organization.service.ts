import { withTransaction } from "../../platform/db/connection.ts"
import type { Clock } from "../../platform/time/clock.ts"
import { recordHistory, type HistoryActor } from "../history/history.service.ts"
import { CompanyModel, type Weekday } from "./company.model.ts"
import { getAccount } from "../identity/accounts.ts"
import { DepartmentModel } from "./department.model.ts"
import { EmployeeModel } from "./employee.model.ts"

/**
 * What other modules may do with companies and employees. They call these
 * functions instead of using the models directly, so the organization module
 * stays the owner of its data. Inside withTransaction(), these writes join the
 * transaction automatically.
 */

export type CompanyBasics = {
  id: string
  name: string
  timezone: string
  weekStart: Weekday
  workingDays: Weekday[]
}

export async function createCompany(input: {
  id: string
  name: string
  timezone: string
  termsVersion: string
  termsAcceptedAt: Date
  termsAcceptedBy: string
}): Promise<string> {
  const { id, ...fields } = input
  const [company] = await CompanyModel.create([{ _id: id, ...fields }])
  return company!._id
}

export async function createEmployee(input: {
  id: string
  companyId: string
  name: string
}): Promise<void> {
  await EmployeeModel.create([
    { _id: input.id, companyId: input.companyId, name: input.name },
  ])
}

export async function renameEmployee(input: {
  id: string
  companyId: string
  name: string
}): Promise<void> {
  await EmployeeModel.updateOne(
    { _id: input.id, companyId: input.companyId },
    { $set: { name: input.name } },
    { runValidators: true }
  )
}

export async function getEmployeeName(input: {
  id: string
  companyId: string
}): Promise<string | undefined> {
  const employee = await EmployeeModel.findOne(
    { _id: input.id, companyId: input.companyId },
    { name: 1 }
  ).lean()
  return employee?.name
}

export async function getCompanyBasics(
  companyId: string
): Promise<CompanyBasics | undefined> {
  const company = await CompanyModel.findById(companyId).lean()
  if (!company) return undefined
  return {
    id: company._id,
    name: company.name,
    timezone: company.timezone,
    weekStart: company.weekStart as Weekday,
    workingDays: company.workingDays as Weekday[],
  }
}

export type ReportingLine = {
  managerId: string | null
  departmentId: string | null
}

/** The employee's manager and department, or undefined when not in this company. */
export async function getReportingLine(input: {
  id: string
  companyId: string
}): Promise<ReportingLine | undefined> {
  const employee = await EmployeeModel.findOne(
    { _id: input.id, companyId: input.companyId },
    { managerId: 1, departmentId: 1 }
  ).lean()
  if (!employee) return undefined
  return {
    managerId: employee.managerId ?? null,
    departmentId: employee.departmentId ?? null,
  }
}

/** Ids of the employees whose direct manager is `managerId` (no skip-level). */
export async function listDirectReportIds(input: {
  managerId: string
  companyId: string
}): Promise<string[]> {
  const reports = await EmployeeModel.find(
    { companyId: input.companyId, managerId: input.managerId },
    { _id: 1 }
  ).lean()
  return reports.map((report) => report._id)
}

/** Ids of the employees in a department. */
export async function listDepartmentMemberIds(input: {
  departmentId: string
  companyId: string
}): Promise<string[]> {
  const members = await EmployeeModel.find(
    { companyId: input.companyId, departmentId: input.departmentId },
    { _id: 1 }
  ).lean()
  return members.map((member) => member._id)
}

export type ReportingLineResult =
  | "UPDATED"
  | "NOT_FOUND"
  | "UNKNOWN_MANAGER"
  | "SELF_MANAGER"
  | "NOT_A_MANAGER"
  | "MANAGER_LOOP"
  | "UNKNOWN_DEPARTMENT"

/**
 * Why a manager can't manage an employee, or undefined when they can:
 *  - the manager must be another employee of the same company,
 *  - with the Manager or Admin role and not deactivated,
 *  - and not someone who reports to the employee, directly or not
 *    (A manages B, so B can't manage A).
 */
export async function managerProblem(input: {
  employeeId: string
  managerId: string
  companyId: string
}): Promise<
  | Exclude<ReportingLineResult, "UPDATED" | "NOT_FOUND" | "UNKNOWN_DEPARTMENT">
  | undefined
> {
  const { employeeId, managerId, companyId } = input
  if (managerId === employeeId) return "SELF_MANAGER"
  const account = await getAccount({ id: managerId, companyId })
  if (
    !account ||
    !(await EmployeeModel.exists({ _id: managerId, companyId }))
  ) {
    return "UNKNOWN_MANAGER"
  }
  if (account.role === "EMPLOYEE" || account.status === "DEACTIVATED") {
    return "NOT_A_MANAGER"
  }
  // Walk up from the new manager; reaching the employee means a loop.
  const seen = new Set<string>()
  let current: string | null = managerId
  while (current && !seen.has(current)) {
    if (current === employeeId) return "MANAGER_LOOP"
    seen.add(current)
    const next: { managerId?: string | null } | null =
      await EmployeeModel.findOne(
        { _id: current, companyId },
        { managerId: 1 }
      ).lean()
    current = next?.managerId ?? null
  }
  return undefined
}

/**
 * Changes an employee's manager and/or department (a field left out stays as
 * it is; null clears it), and records it in the employee's history
 * (employee.reportingLineChanged) in the same transaction. Access follows at
 * once: the old manager loses the employee on their next request. The
 * manager rules are in managerProblem(); the department must exist.
 */
export async function setReportingLine(
  input: {
    id: string
    companyId: string
    managerId?: string | null
    departmentId?: string | null
    changedBy: HistoryActor
    reason?: string | null
  },
  deps: { clock: Clock }
): Promise<ReportingLineResult> {
  const { id, companyId, managerId, departmentId } = input
  if (!(await EmployeeModel.exists({ _id: id, companyId }))) return "NOT_FOUND"
  if (managerId != null) {
    const problem = await managerProblem({
      employeeId: id,
      managerId,
      companyId,
    })
    if (problem) return problem
  }
  if (
    departmentId != null &&
    !(await DepartmentModel.exists({ _id: departmentId, companyId }))
  ) {
    return "UNKNOWN_DEPARTMENT"
  }
  const change = {
    ...(managerId === undefined ? {} : { managerId }),
    ...(departmentId === undefined ? {} : { departmentId }),
  }
  return withTransaction(async () => {
    const before = await EmployeeModel.findOneAndUpdate(
      { _id: id, companyId },
      { $set: change }
    ).lean()
    if (!before) return "NOT_FOUND"
    await recordHistory(
      {
        companyId,
        action: "employee.reportingLineChanged",
        entityId: id,
        subjectEmployeeId: id,
        actor: input.changedBy,
        before: {
          managerId: before.managerId ?? null,
          departmentId: before.departmentId ?? null,
        },
        after: {
          managerId: before.managerId ?? null,
          departmentId: before.departmentId ?? null,
          ...change,
        },
        reason: input.reason,
      },
      deps
    )
    return "UPDATED"
  })
}

/** Names of employees by id (for showing who did something); unknown ids are left out. */
export async function getEmployeeNames(input: {
  ids: string[]
  companyId: string
}): Promise<Map<string, string>> {
  const employees = await EmployeeModel.find(
    { companyId: input.companyId, _id: { $in: input.ids } },
    { name: 1 }
  ).lean()
  return new Map(employees.map((employee) => [employee._id, employee.name]))
}

/** What attendance needs to know about each employee (BE-07). */
export type RosterEntry = {
  id: string
  name: string
  departmentId: string | null
  managerId: string | null
  tracksAttendance: boolean
  joiningDate: string | null
  employeeCode: string | null
}

/** Employees of a company, optionally only some ids, one department or one manager's reports, by name. */
export async function getRoster(input: {
  companyId: string
  ids?: string[]
  departmentId?: string
  managerId?: string
}): Promise<RosterEntry[]> {
  const employees = await EmployeeModel.find(
    {
      companyId: input.companyId,
      ...(input.ids ? { _id: { $in: input.ids } } : {}),
      ...(input.departmentId ? { departmentId: input.departmentId } : {}),
      ...(input.managerId ? { managerId: input.managerId } : {}),
    },
    {
      name: 1,
      departmentId: 1,
      managerId: 1,
      tracksAttendance: 1,
      joiningDate: 1,
      employeeCode: 1,
    }
  )
    .sort({ name: 1, _id: 1 })
    .lean()
  return employees.map((e) => ({
    id: e._id,
    name: e.name,
    departmentId: e.departmentId ?? null,
    managerId: e.managerId ?? null,
    tracksAttendance: e.tracksAttendance ?? true,
    joiningDate: e.joiningDate ?? null,
    employeeCode: e.employeeCode ?? null,
  }))
}
