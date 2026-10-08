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
