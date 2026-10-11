import { withTransaction } from "../../platform/db/connection.ts"
import { isDuplicateKey } from "../../platform/db/schema.ts"
import { apiErrors } from "../../platform/http/errors.ts"
import type { Clock } from "../../platform/time/clock.ts"
import { recordHistory, type HistoryActor } from "../history/history.service.ts"
import { DepartmentModel, departmentNameKey } from "./department.model.ts"
import { EmployeeModel } from "./employee.model.ts"

/**
 * Departments (Trello BE-06): a flat list per company. Every change is
 * recorded on the company settings' history (BE-04), keyed "department:{id}".
 */
type Deps = { clock: Clock }

export type DepartmentView = { id: string; name: string; employeeCount: number }

const nameTaken = () =>
  apiErrors.fieldError(
    "name",
    "ALREADY_EXISTS",
    "a department with this name exists"
  )

async function countMembers(companyId: string, departmentId: string) {
  return EmployeeModel.countDocuments({ companyId, departmentId })
}

/** Every department, by name, with how many employees (any status) belong to it. */
export async function listDepartments(
  companyId: string
): Promise<DepartmentView[]> {
  const [departments, counts] = await Promise.all([
    DepartmentModel.find({ companyId }).sort({ nameKey: 1 }).lean(),
    EmployeeModel.aggregate<{ _id: string; count: number }>([
      { $match: { companyId, departmentId: { $ne: null } } },
      { $group: { _id: "$departmentId", count: { $sum: 1 } } },
    ]),
  ])
  const byId = new Map(counts.map((c) => [c._id, c.count]))
  return departments.map((d) => ({
    id: d._id,
    name: d.name,
    employeeCount: byId.get(d._id) ?? 0,
  }))
}

/** Department names by id (unknown ids are left out). */
export async function getDepartmentNames(input: {
  companyId: string
  ids: string[]
}): Promise<Map<string, string>> {
  const departments = await DepartmentModel.find(
    { companyId: input.companyId, _id: { $in: input.ids } },
    { name: 1 }
  ).lean()
  return new Map(departments.map((d) => [d._id, d.name]))
}

/** Department ids by lower-case name, for the CSV import. */
export async function departmentIdsByName(
  companyId: string
): Promise<Map<string, string>> {
  const departments = await DepartmentModel.find(
    { companyId },
    { nameKey: 1 }
  ).lean()
  return new Map(departments.map((d) => [d.nameKey, d._id]))
}

export async function addDepartment(
  input: { companyId: string; name: string; actor: HistoryActor },
  deps: Deps
): Promise<DepartmentView> {
  try {
    return await withTransaction(async () => {
      const [created] = await DepartmentModel.create([
        {
          companyId: input.companyId,
          name: input.name.trim(),
          nameKey: departmentNameKey(input.name),
        },
      ])
      await recordHistory(
        {
          companyId: input.companyId,
          action: "department.added",
          entityId: input.companyId,
          actor: input.actor,
          before: {},
          after: { [`department:${created!._id}`]: { name: created!.name } },
        },
        deps
      )
      return { id: created!._id, name: created!.name, employeeCount: 0 }
    })
  } catch (error) {
    if (isDuplicateKey(error, "nameKey")) throw nameTaken()
    throw error
  }
}

/** Undefined when the department isn't in the company. */
export async function renameDepartment(
  input: { companyId: string; id: string; name: string; actor: HistoryActor },
  deps: Deps
): Promise<DepartmentView | undefined> {
  try {
    return await withTransaction(async () => {
      const before = await DepartmentModel.findOneAndUpdate(
        { _id: input.id, companyId: input.companyId },
        {
          $set: {
            name: input.name.trim(),
            nameKey: departmentNameKey(input.name),
          },
        },
        { runValidators: true }
      ).lean()
      if (!before) return undefined
      const key = `department:${input.id}`
      await recordHistory(
        {
          companyId: input.companyId,
          action: "department.renamed",
          entityId: input.companyId,
          actor: input.actor,
          before: { [key]: { name: before.name } },
          after: { [key]: { name: input.name.trim() } },
        },
        deps
      )
      return {
        id: input.id,
        name: input.name.trim(),
        employeeCount: await countMembers(input.companyId, input.id),
      }
    })
  } catch (error) {
    if (isDuplicateKey(error, "nameKey")) throw nameTaken()
    throw error
  }
}

/**
 * Deletes an empty department. 409 DEPARTMENT_NOT_EMPTY while any employee
 * (deactivated ones too, whose history points at it) belongs to it.
 * false when the department isn't in the company.
 */
export async function removeDepartment(
  input: { companyId: string; id: string; actor: HistoryActor },
  deps: Deps
): Promise<boolean> {
  return withTransaction(async () => {
    const department = await DepartmentModel.findOne({
      _id: input.id,
      companyId: input.companyId,
    }).lean()
    if (!department) return false
    if ((await countMembers(input.companyId, input.id)) > 0) {
      throw apiErrors.conflictWith(
        "DEPARTMENT_NOT_EMPTY",
        "Move its employees to another department first"
      )
    }
    await DepartmentModel.deleteOne({
      _id: input.id,
      companyId: input.companyId,
    })
    await recordHistory(
      {
        companyId: input.companyId,
        action: "department.removed",
        entityId: input.companyId,
        actor: input.actor,
        before: { [`department:${input.id}`]: { name: department.name } },
        after: {},
      },
      deps
    )
    return true
  })
}
