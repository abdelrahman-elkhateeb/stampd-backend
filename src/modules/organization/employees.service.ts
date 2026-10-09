import { randomUUID } from "node:crypto"

import { withTransaction } from "../../platform/db/connection.ts"
import { apiErrors, type FieldError } from "../../platform/http/errors.ts"
import type { Clock } from "../../platform/time/clock.ts"
import type { PlainDate } from "../../platform/time/time.ts"
import { recordHistory, type HistoryActor } from "../history/history.service.ts"
import {
  countActiveAdmins,
  createInvitedAccount,
  findAccountIds,
  getAccount,
  getAccounts,
  reactivateAccount,
  setLastWorkingDay,
  updateAccount,
  type Account,
} from "../identity/accounts.ts"
import type { AuthContext } from "../identity/authenticate.ts"
import type { Locale, Role, UserStatus } from "../identity/user.model.ts"
import { loadCompanyToday } from "./calendar.ts"
import { getDepartmentNames } from "./departments.service.ts"
import { EmployeeModel, type EmploymentType } from "./employee.model.ts"
import {
  getEmployeeNames,
  setReportingLine,
  type ReportingLineResult,
} from "./organization.service.ts"

/**
 * Employee management (Trello BE-06). The person is split in two records
 * that share one id: the Employee (profile, employment, reporting line) here,
 * and the login account (email, role, status, last working day) in identity.
 * Every change is recorded in the employee's history (BE-04).
 */
type Deps = { clock: Clock }

export type EmployeeProfile = {
  id: string
  name: string
  email: string
  phone: string | null
  jobTitle: string | null
  employeeCode: string | null
  department: { id: string; name: string } | null
  manager: { id: string; name: string } | null
  role: Role
  status: UserStatus
  joiningDate: PlainDate | null
  employmentType: EmploymentType
  tracksAttendance: boolean
  photoFileId: string | null
  /** Set once offboarding is confirmed: access ends after this day */
  lastWorkingDay: PlainDate | null
}

/** The fields of the HR record itself (not the account or reporting line). */
export type ProfileFields = {
  name?: string
  phone?: string | null
  jobTitle?: string | null
  employeeCode?: string | null
  joiningDate?: PlainDate | null
  employmentType?: EmploymentType
  tracksAttendance?: boolean
}

export type EmployeeChange = ProfileFields & {
  email?: string
  role?: Role
  departmentId?: string | null
  managerId?: string | null
}

const PROFILE_KEYS = [
  "name",
  "phone",
  "jobTitle",
  "employeeCode",
  "joiningDate",
  "employmentType",
  "tracksAttendance",
] as const

type EmployeeDoc = {
  _id: string
  name: string
  managerId?: string | null
  departmentId?: string | null
  photoFileId?: string | null
  phone?: string | null
  jobTitle?: string | null
  employeeCode?: string | null
  joiningDate?: string | null
  employmentType?: string | null
  tracksAttendance?: boolean | null
}

// ─────────────────────────────── reading ───────────────────────────────

async function toProfiles(
  companyId: string,
  employees: EmployeeDoc[]
): Promise<EmployeeProfile[]> {
  const ids = employees.map((e) => e._id)
  const managerIds = employees.flatMap((e) =>
    e.managerId ? [e.managerId] : []
  )
  const departmentIds = employees.flatMap((e) =>
    e.departmentId ? [e.departmentId] : []
  )
  const [accounts, managers, departments] = await Promise.all([
    getAccounts({ companyId, ids }),
    getEmployeeNames({ companyId, ids: [...new Set(managerIds)] }),
    getDepartmentNames({ companyId, ids: [...new Set(departmentIds)] }),
  ])
  return employees.flatMap((e) => {
    const account = accounts.get(e._id)
    if (!account) return []
    const managerName = e.managerId ? managers.get(e.managerId) : undefined
    const departmentName = e.departmentId
      ? departments.get(e.departmentId)
      : undefined
    return [
      {
        id: e._id,
        name: e.name,
        email: account.email,
        phone: e.phone ?? null,
        jobTitle: e.jobTitle ?? null,
        employeeCode: e.employeeCode ?? null,
        department:
          e.departmentId && departmentName
            ? { id: e.departmentId, name: departmentName }
            : null,
        manager:
          e.managerId && managerName
            ? { id: e.managerId, name: managerName }
            : null,
        role: account.role,
        status: account.status,
        joiningDate: e.joiningDate ?? null,
        employmentType: (e.employmentType ?? "FULL_TIME") as EmploymentType,
        tracksAttendance: e.tracksAttendance ?? true,
        photoFileId: e.photoFileId ?? null,
        lastWorkingDay: account.lastWorkingDay,
      },
    ]
  })
}

export async function getEmployeeProfile(input: {
  companyId: string
  id: string
}): Promise<EmployeeProfile | undefined> {
  const employee = await EmployeeModel.findOne({
    _id: input.id,
    companyId: input.companyId,
  }).lean()
  if (!employee) return undefined
  return (await toProfiles(input.companyId, [employee]))[0]
}

export type EmployeeFilters = {
  search?: string
  departmentId?: string
  managerId?: string
  statuses?: UserStatus[]
  roles?: Role[]
}

const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * A page of employees. `visibleIds` is the caller's scope from BE-03
 * ("ALL" for Admins, the direct reports for Managers). Search matches name,
 * email or employee code (case-insensitive, anywhere in the text).
 */
export async function listEmployees(input: {
  companyId: string
  visibleIds: "ALL" | string[]
  filters: EmployeeFilters
  page: { skip: number; limit: number; mongoSort: Record<string, 1 | -1> }
}): Promise<{ items: EmployeeProfile[]; total: number }> {
  const { companyId, filters } = input
  const idSets: string[][] = []
  if (input.visibleIds !== "ALL") idSets.push(input.visibleIds)
  if (filters.statuses || filters.roles) {
    idSets.push(
      await findAccountIds({
        companyId,
        statuses: filters.statuses,
        roles: filters.roles,
      })
    )
  }
  const allowed = idSets.length
    ? idSets.reduce((a, b) => a.filter((id) => b.includes(id)))
    : undefined

  const query: Record<string, unknown> = { companyId }
  if (allowed) query._id = { $in: allowed }
  if (filters.departmentId) query.departmentId = filters.departmentId
  if (filters.managerId) query.managerId = filters.managerId
  if (filters.search) {
    const pattern = { $regex: escapeRegex(filters.search), $options: "i" }
    const emailMatches = await findAccountIds({
      companyId,
      emailContains: filters.search,
    })
    query.$or = [
      { name: pattern },
      { employeeCode: pattern },
      { _id: { $in: emailMatches } },
    ]
  }
  const [employees, total] = await Promise.all([
    EmployeeModel.find(query)
      .sort(input.page.mongoSort)
      .skip(input.page.skip)
      .limit(input.page.limit)
      .lean(),
    EmployeeModel.countDocuments(query),
  ])
  return { items: await toProfiles(companyId, employees), total }
}

// ─────────────────────────────── rules ───────────────────────────────

const REPORTING_LINE_ERRORS: Record<
  Exclude<ReportingLineResult, "UPDATED" | "NOT_FOUND">,
  Omit<FieldError, "field"> & { field: "managerId" | "departmentId" }
> = {
  UNKNOWN_MANAGER: {
    field: "managerId",
    code: "UNKNOWN_REFERENCE",
    message: "no such employee in this company",
  },
  SELF_MANAGER: {
    field: "managerId",
    code: "SELF_MANAGER",
    message: "an employee can't be their own manager",
  },
  NOT_A_MANAGER: {
    field: "managerId",
    code: "NOT_A_MANAGER",
    message: "the manager must be an active Manager or Admin",
  },
  MANAGER_LOOP: {
    field: "managerId",
    code: "MANAGER_LOOP",
    message: "this manager reports to the employee (directly or not)",
  },
  UNKNOWN_DEPARTMENT: {
    field: "departmentId",
    code: "UNKNOWN_REFERENCE",
    message: "no such department in this company",
  },
}

/** Throws the 422 for a refused reporting-line change (field renamed if given). */
function assertReportingLine(
  result: ReportingLineResult,
  field?: string
): void {
  if (result === "UPDATED") return
  if (result === "NOT_FOUND") throw apiErrors.notFound()
  const error = REPORTING_LINE_ERRORS[result]
  throw apiErrors.fieldError(field ?? error.field, error.code, error.message)
}

/** Direct reports whose accounts aren't deactivated. */
async function activeDirectReports(companyId: string, managerId: string) {
  const reports = await EmployeeModel.find(
    { companyId, managerId },
    { name: 1 }
  )
    .sort({ name: 1 })
    .lean()
  const accounts = await getAccounts({
    companyId,
    ids: reports.map((r) => r._id),
  })
  return reports
    .filter((r) => accounts.get(r._id)?.status !== "DEACTIVATED")
    .map((r) => ({ id: r._id, name: r.name }))
}

/**
 * A role change that would leave the company without an Admin, or leave
 * direct reports with a manager who can't approve, is refused (409).
 */
async function assertRoleChange(
  companyId: string,
  account: Account,
  role: Role
): Promise<void> {
  if (role === account.role) return
  if (account.role === "ADMIN" && (await countActiveAdmins(companyId)) <= 1) {
    throw apiErrors.conflictWith(
      "LAST_ADMIN",
      "The company needs at least one Admin"
    )
  }
  if (
    role === "EMPLOYEE" &&
    (await activeDirectReports(companyId, account.id)).length > 0
  ) {
    throw apiErrors.conflictWith(
      "HAS_DIRECT_REPORTS",
      "Give their direct reports a new manager first"
    )
  }
}

const isDuplicateCode = (error: unknown) => {
  const e = error as { code?: number; keyPattern?: Record<string, unknown> }
  return e?.code === 11000 && Boolean(e.keyPattern?.employeeCode)
}
const codeTaken = () =>
  apiErrors.fieldError(
    "employeeCode",
    "ALREADY_EXISTS",
    "employee code already used"
  )

// ─────────────────────────────── create ───────────────────────────────

export type NewEmployee = ProfileFields & {
  name: string
  email: string
  role: Role
  locale: Locale
  departmentId?: string | null
  managerId?: string | null
}

/**
 * Creates the account (INVITED) and the employee in one transaction, with
 * history. The caller sends the invitation afterwards.
 */
export async function hireEmployee(
  input: { companyId: string; employee: NewEmployee; actor: HistoryActor },
  deps: Deps
): Promise<string> {
  const { companyId, employee } = input
  const id = randomUUID()
  try {
    await withTransaction(async () => {
      await createInvitedAccount({
        id,
        companyId,
        email: employee.email,
        role: employee.role,
        locale: employee.locale,
      })
      const fields = Object.fromEntries(
        PROFILE_KEYS.flatMap((key) =>
          employee[key] === undefined ? [] : [[key, employee[key]]]
        )
      )
      await EmployeeModel.create([{ _id: id, companyId, ...fields }])
      await recordHistory(
        {
          companyId,
          action: "employee.created",
          entityId: id,
          subjectEmployeeId: id,
          actor: input.actor,
          before: {},
          after: { ...fields, email: employee.email, role: employee.role },
        },
        deps
      )
      if (employee.managerId != null || employee.departmentId != null) {
        assertReportingLine(
          await setReportingLine(
            {
              id,
              companyId,
              managerId: employee.managerId ?? undefined,
              departmentId: employee.departmentId ?? undefined,
              changedBy: input.actor,
            },
            deps
          )
        )
      }
    })
  } catch (error) {
    if (isDuplicateCode(error)) throw codeTaken()
    throw error
  }
  return id
}

// ─────────────────────────────── update ───────────────────────────────

/** What an employee may change on their own record (BE-06: phone; photo via BE-05). */
export const SELF_EDITABLE = ["phone"] as const

/**
 * Who may change what:
 *  - Admin: everything, for anyone in the company;
 *  - anyone else: only their own phone. Any other field, or someone else's
 *    record they can see (a Manager's report), is 403.
 * The caller has already checked the record is visible (404 otherwise).
 */
export function assertMayEdit(
  auth: AuthContext,
  employeeId: string,
  change: EmployeeChange
): void {
  if (auth.role === "ADMIN") return
  const selfOnly = Object.keys(change).every((key) =>
    (SELF_EDITABLE as readonly string[]).includes(key)
  )
  if (employeeId !== auth.userId || !selfOnly) {
    throw apiErrors.forbidden("Only HR can change this")
  }
}

export async function updateEmployee(
  input: {
    companyId: string
    id: string
    change: EmployeeChange
    actor: HistoryActor
  },
  deps: Deps
): Promise<void> {
  const { companyId, id, change } = input
  const account = await getAccount({ companyId, id })
  const employee = await EmployeeModel.findOne({ _id: id, companyId }).lean()
  if (!account || !employee) throw apiErrors.notFound()
  if (change.role) await assertRoleChange(companyId, account, change.role)

  try {
    await withTransaction(async () => {
      if (change.email || change.role) {
        await updateAccount({
          id,
          companyId,
          email: change.email,
          role: change.role,
        })
      }
      const fields = Object.fromEntries(
        PROFILE_KEYS.flatMap((key) =>
          change[key] === undefined ? [] : [[key, change[key]]]
        )
      )
      if (Object.keys(fields).length) {
        await EmployeeModel.updateOne(
          { _id: id, companyId },
          { $set: fields },
          { runValidators: true }
        )
      }
      const before = {
        ...Object.fromEntries(
          PROFILE_KEYS.map((key) => [
            key,
            (employee as Record<string, unknown>)[key] ?? null,
          ])
        ),
        email: account.email,
      }
      await recordHistory(
        {
          companyId,
          action: "employee.profileChanged",
          entityId: id,
          subjectEmployeeId: id,
          actor: input.actor,
          before,
          after: {
            ...before,
            ...fields,
            ...(change.email
              ? { email: change.email.trim().toLowerCase() }
              : {}),
          },
        },
        deps
      )
      if (change.role) {
        await recordHistory(
          {
            companyId,
            action: "employee.roleChanged",
            entityId: id,
            subjectEmployeeId: id,
            actor: input.actor,
            before: { role: account.role },
            after: { role: change.role },
          },
          deps
        )
      }
      if (change.managerId !== undefined || change.departmentId !== undefined) {
        assertReportingLine(
          await setReportingLine(
            {
              id,
              companyId,
              managerId: change.managerId,
              departmentId: change.departmentId,
              changedBy: input.actor,
            },
            deps
          )
        )
      }
    })
  } catch (error) {
    if (isDuplicateCode(error)) throw codeTaken()
    throw error
  }
}

// ─────────────────────────────── offboarding ───────────────────────────────

export type OffboardingItem = {
  id: string
  type: string
  startDate: PlainDate
  endDate: PlainDate
}

export type OffboardingImpact = {
  pendingRequests: OffboardingItem[]
  futureApprovedTimeOff: OffboardingItem[]
}

/**
 * How the leave and request modules (BE-09, BE-10) take part in offboarding:
 * `preview` lists what deactivation will change; `apply` changes it (withdraw
 * pending requests, cancel future approved leave/WFH and restore balances)
 * inside the deactivation transaction. Until they register, both are empty.
 */
export type OffboardingHook = {
  preview(input: {
    companyId: string
    employeeId: string
    lastWorkingDay: PlainDate
  }): Promise<Partial<OffboardingImpact>>
  apply(input: {
    companyId: string
    employeeId: string
    lastWorkingDay: PlainDate
    actor: HistoryActor
  }): Promise<void>
}

const offboardingHooks: OffboardingHook[] = []

export function registerOffboardingHook(hook: OffboardingHook): () => void {
  offboardingHooks.push(hook)
  return () => {
    offboardingHooks.splice(offboardingHooks.indexOf(hook), 1)
  }
}

export type DeactivationPreview = OffboardingImpact & {
  lastWorkingDay: PlainDate
  /** Active direct reports: they need a new manager (reassignReportsTo) */
  directReports: { id: string; name: string }[]
}

async function offboardingTarget(auth: AuthContext, id: string) {
  const account = await getAccount({ companyId: auth.companyId, id })
  if (!account) throw apiErrors.notFound()
  if (id === auth.userId) {
    throw apiErrors.forbidden("You can't deactivate your own account")
  }
  if (account.status === "DEACTIVATED") {
    throw apiErrors.conflict("Already deactivated")
  }
  return account
}

/** Step 1: what deactivating this employee will change. Nothing is written. */
export async function previewDeactivation(input: {
  auth: AuthContext
  id: string
  lastWorkingDay: PlainDate
}): Promise<DeactivationPreview> {
  const { auth, id, lastWorkingDay } = input
  await offboardingTarget(auth, id)
  const impacts = await Promise.all(
    offboardingHooks.map((hook) =>
      hook.preview({
        companyId: auth.companyId,
        employeeId: id,
        lastWorkingDay,
      })
    )
  )
  return {
    lastWorkingDay,
    directReports: await activeDirectReports(auth.companyId, id),
    pendingRequests: impacts.flatMap((i) => i.pendingRequests ?? []),
    futureApprovedTimeOff: impacts.flatMap(
      (i) => i.futureApprovedTimeOff ?? []
    ),
  }
}

/**
 * Step 2: deactivates. Direct reports must move to `reassignReportsTo`
 * (409 HAS_DIRECT_REPORTS without it). Sign-in stops after the last working
 * day (at once when that day is already over). History is kept.
 */
export async function deactivateEmployee(
  input: {
    auth: AuthContext
    id: string
    lastWorkingDay: PlainDate
    reassignReportsTo?: string | null
  },
  deps: Deps
): Promise<void> {
  const { auth, id, lastWorkingDay } = input
  const { companyId } = auth
  const account = await offboardingTarget(auth, id)
  const reports = await activeDirectReports(companyId, id)
  if (reports.length && !input.reassignReportsTo) {
    throw apiErrors.conflictWith(
      "HAS_DIRECT_REPORTS",
      "Choose a new manager for their direct reports (reassignReportsTo)"
    )
  }
  if (input.reassignReportsTo === id) {
    throw apiErrors.fieldError(
      "reassignReportsTo",
      "NOT_A_MANAGER",
      "the departing employee can't keep their reports"
    )
  }
  const actor: HistoryActor = { type: "USER", userId: auth.userId }
  const today = (await loadCompanyToday(companyId, deps.clock.now()))!

  await withTransaction(async () => {
    for (const report of reports) {
      assertReportingLine(
        await setReportingLine(
          {
            id: report.id,
            companyId,
            managerId: input.reassignReportsTo,
            changedBy: actor,
            reason: "manager offboarded",
          },
          deps
        ),
        "reassignReportsTo"
      )
    }
    for (const hook of offboardingHooks) {
      await hook.apply({ companyId, employeeId: id, lastWorkingDay, actor })
    }
    const status = await setLastWorkingDay({
      id,
      companyId,
      lastWorkingDay,
      today,
    })
    await recordHistory(
      {
        companyId,
        action: "employee.statusChanged",
        entityId: id,
        subjectEmployeeId: id,
        actor,
        before: {
          status: account.status,
          lastWorkingDay: account.lastWorkingDay,
        },
        after: { status, lastWorkingDay },
      },
      deps
    )
  })
}

/** Undoes a deactivation (or a scheduled one): the person can sign in again. */
export async function reactivateEmployee(
  input: { companyId: string; id: string; actor: HistoryActor },
  deps: Deps
): Promise<void> {
  const account = await getAccount(input)
  if (!account) throw apiErrors.notFound()
  if (account.status !== "DEACTIVATED" && !account.lastWorkingDay) {
    throw apiErrors.conflict("Not deactivated")
  }
  await withTransaction(async () => {
    const status = await reactivateAccount(input)
    await recordHistory(
      {
        companyId: input.companyId,
        action: "employee.statusChanged",
        entityId: input.id,
        subjectEmployeeId: input.id,
        actor: input.actor,
        before: {
          status: account.status,
          lastWorkingDay: account.lastWorkingDay,
        },
        after: { status, lastWorkingDay: null },
      },
      deps
    )
  })
}
