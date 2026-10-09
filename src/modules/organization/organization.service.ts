import { CompanyModel, type Weekday } from "./company.model.ts"
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

/**
 * Changes an employee's manager and/or department (a field left out stays as
 * it is; null clears it). Access follows at once: the old manager loses the
 * employee on their next request. The manager must be another employee of
 * the same company. BE-06 adds the HTTP endpoint and loop prevention.
 */
export async function setReportingLine(input: {
  id: string
  companyId: string
  managerId?: string | null
  departmentId?: string | null
}): Promise<"UPDATED" | "NOT_FOUND" | "INVALID_MANAGER"> {
  const { id, companyId, managerId, departmentId } = input
  if (managerId != null) {
    if (managerId === id) return "INVALID_MANAGER"
    const manager = await EmployeeModel.exists({ _id: managerId, companyId })
    if (!manager) return "INVALID_MANAGER"
  }
  const result = await EmployeeModel.updateOne(
    { _id: id, companyId },
    {
      $set: {
        ...(managerId === undefined ? {} : { managerId }),
        ...(departmentId === undefined ? {} : { departmentId }),
      },
    }
  )
  return result.matchedCount === 0 ? "NOT_FOUND" : "UPDATED"
}
