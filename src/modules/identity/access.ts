import type { RequestHandler } from "express"

import { apiErrors } from "../../platform/http/errors.ts"
import {
  getReportingLine,
  listDirectReportIds,
} from "../organization/organization.service.ts"
import type { AuthContext } from "./authenticate.ts"
import { getAuth } from "./authenticate.ts"
import { UserModel, type Role } from "./user.model.ts"

/**
 * Who may do what (Trello BE-03). Every endpoint checks here, on the server;
 * hiding a button in the UI is not security.
 *
 * Scopes:
 *   self     the caller's own records
 *   team     the caller's direct reports: employees whose managerId is the
 *            caller, read from the database on every check (a reassignment
 *            applies on the next request). No skip-level. Deactivated
 *            employees drop out of the team; Admins keep access.
 *   company  every employee of the caller's company
 *
 * Answers:
 *   the role has no grant for the action at all       → 403 FORBIDDEN
 *   it has one, but the employee is outside its scope → 404 NOT_FOUND
 *     (the same answer as for an id that doesn't exist, so it reveals nothing)
 *   approving your own request                        → 403 SELF_APPROVAL
 */
export type Scope = "self" | "team" | "company"
export type Action = "view" | "create" | "edit" | "delete" | "approve"

type Grants = Partial<Record<Role, readonly Scope[]>>

const SELF: Grants = { EMPLOYEE: ["self"], MANAGER: ["self"], ADMIN: ["self"] }
const PERSONAL: Grants = {
  EMPLOYEE: ["self"],
  MANAGER: ["self", "team"],
  ADMIN: ["company"],
}
const APPROVERS: Grants = { MANAGER: ["team"], ADMIN: ["company"] }
const ADMIN_ONLY: Grants = { ADMIN: ["company"] }
const EVERYONE: Grants = {
  EMPLOYEE: ["company"],
  MANAGER: ["company"],
  ADMIN: ["company"],
}

/**
 * The permission matrix (also in the README and on Trello BE-03). The ticket
 * that builds a resource's endpoints may adjust its row; nothing else changes.
 */
export const PERMISSIONS = {
  /** An employee's HR profile (BE-06) */
  employee: {
    view: PERSONAL,
    create: ADMIN_ONLY,
    edit: ADMIN_ONLY,
    delete: ADMIN_ONLY,
  },
  /** Clock in/out and timesheets (BE-07, BE-08); corrections by Admin/HR */
  attendance: { view: PERSONAL, create: SELF, edit: ADMIN_ONLY },
  /** Leave balances (BE-08) and leave requests (BE-10); edit = cancel your own */
  leave: { view: PERSONAL, create: SELF, edit: SELF, approve: APPROVERS },
  /** WFH, business trips, permissions and other requests (BE-09) */
  requests: { view: PERSONAL, create: SELF, edit: SELF, approve: APPROVERS },
  /** Reports, limited to the data the caller may see (BE-13) */
  reports: { view: PERSONAL },
  /** Company settings, working days, holidays, departments (BE-05) */
  companySettings: { view: EVERYONE, edit: ADMIN_ONLY },
  /** Invitations, roles and deactivation (BE-06) */
  users: {
    view: ADMIN_ONLY,
    create: ADMIN_ONLY,
    edit: ADMIN_ONLY,
    delete: ADMIN_ONLY,
  },
} as const satisfies Record<string, Partial<Record<Action, Grants>>>

export type Resource = keyof typeof PERMISSIONS
export type ResourceAction<R extends Resource> = keyof (typeof PERMISSIONS)[R] &
  Action

/** The scopes the caller's role has for an action; empty when none. */
export function scopesFor<R extends Resource>(
  role: Role,
  resource: R,
  action: ResourceAction<R>
): readonly Scope[] {
  const grants = (PERMISSIONS[resource] as Partial<Record<Action, Grants>>)[
    action
  ]
  return grants?.[role] ?? []
}

/**
 * Route guard for actions that aren't about one employee (e.g. edit company
 * settings): 403 FORBIDDEN, before anything runs, when the role has no grant.
 */
export function requirePermission<R extends Resource>(
  resource: R,
  action: ResourceAction<R>
): RequestHandler {
  return (req, _res, next) => {
    const { role } = getAuth(req)
    if (scopesFor(role, resource, action).length === 0) {
      throw apiErrors.forbidden()
    }
    next()
  }
}

/** true when `employeeId` is the caller's active direct report. */
export async function isActiveDirectReport(
  auth: AuthContext,
  employeeId: string
): Promise<boolean> {
  const line = await getReportingLine({
    id: employeeId,
    companyId: auth.companyId,
  })
  if (line?.managerId !== auth.userId) return false
  const user = await UserModel.findOne(
    { _id: employeeId, companyId: auth.companyId },
    { status: 1 }
  ).lean()
  return user?.status !== "DEACTIVATED"
}

async function employeeExists(
  auth: AuthContext,
  employeeId: string
): Promise<boolean> {
  return (
    (await getReportingLine({ id: employeeId, companyId: auth.companyId })) !==
    undefined
  )
}

/**
 * The check for one employee's data, e.g. "may the caller view Lina's
 * attendance?". Resolves when allowed; throws 403/404 (see above) otherwise.
 * For "approve", also refuses the caller's own requests.
 */
export async function authorize<R extends Resource>(
  auth: AuthContext,
  resource: R,
  action: ResourceAction<R>,
  employeeId: string
): Promise<void> {
  const scopes = scopesFor(auth.role, resource, action)
  if (scopes.length === 0) throw apiErrors.forbidden()
  if (action === "approve") assertNotSelfApproval(auth, employeeId)

  if (scopes.includes("company")) {
    if (await employeeExists(auth, employeeId)) return
  } else {
    if (scopes.includes("self") && employeeId === auth.userId) return
    if (
      scopes.includes("team") &&
      (await isActiveDirectReport(auth, employeeId))
    ) {
      return
    }
  }
  throw apiErrors.notFound()
}

/**
 * For lists: whose records the caller may see. "ALL" means every employee of
 * the caller's company (still filter by companyId); otherwise a list of ids
 * to filter with { employeeId: { $in: ids } }.
 */
export async function scopedEmployeeIds<R extends Resource>(
  auth: AuthContext,
  resource: R,
  action: ResourceAction<R>
): Promise<"ALL" | string[]> {
  const scopes = scopesFor(auth.role, resource, action)
  if (scopes.length === 0) throw apiErrors.forbidden()
  if (scopes.includes("company")) return "ALL"

  const ids = new Set<string>()
  if (scopes.includes("self")) ids.add(auth.userId)
  if (scopes.includes("team")) {
    const reports = await listDirectReportIds({
      managerId: auth.userId,
      companyId: auth.companyId,
    })
    const deactivated = await UserModel.find(
      {
        companyId: auth.companyId,
        _id: { $in: reports },
        status: "DEACTIVATED",
      },
      { _id: 1 }
    ).lean()
    const gone = new Set(deactivated.map((user) => user._id))
    for (const id of reports) if (!gone.has(id)) ids.add(id)
  }
  return [...ids]
}

/**
 * Nobody approves their own request, whatever their role (Trello BE-03; used
 * by the request engine, BE-09). 403 SELF_APPROVAL.
 */
export function assertNotSelfApproval(
  auth: AuthContext,
  requesterId: string
): void {
  if (requesterId === auth.userId) throw apiErrors.selfApproval()
}
