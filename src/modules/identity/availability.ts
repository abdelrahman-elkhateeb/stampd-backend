import { getReportingLine } from "../organization/organization.service.ts"
import { scopedEmployeeIds } from "./access.ts"
import type { AuthContext } from "./authenticate.ts"

/**
 * Field-level privacy for "who is out today" views (Trello BE-03 decisions,
 * 2026-10-09). For each colleague entry, the viewer gets one of:
 *
 *   full detail   their own entries, their direct reports' (Manager) and
 *                 everyone's (Admin/HR): type, reason, dates, ...
 *   name + status a colleague in the viewer's department on leave ("OUT")
 *                 or working from home ("WFH"); nothing else
 *   nothing       everything else: other departments, and colleagues'
 *                 business trips and permissions
 *
 * The leave/request modules (BE-09 … BE-11) load the day's entries, then pass
 * each through presentAvailability() before answering.
 */
export type AvailabilityKind = "LEAVE" | "WFH" | "BUSINESS_TRIP" | "PERMISSION"

export type AvailabilityEntry = {
  employeeId: string
  name: string
  /** The colleague's department (Employee.departmentId) */
  departmentId: string | null
  kind: AvailabilityKind
}

export type ColleagueAvailability = {
  employeeId: string
  name: string
  status: "OUT" | "WFH"
}

/** What presentAvailability needs to know about the viewer; see availabilityViewer(). */
export type AvailabilityViewer = {
  departmentId: string | null
  /** Whose leave entries the viewer sees in full ("ALL" = whole company) */
  leaveDetail: "ALL" | ReadonlySet<string>
  /** Whose WFH, trip and permission entries the viewer sees in full */
  requestDetail: "ALL" | ReadonlySet<string>
}

export async function availabilityViewer(
  auth: AuthContext
): Promise<AvailabilityViewer> {
  const [line, leave, requests] = await Promise.all([
    getReportingLine({ id: auth.userId, companyId: auth.companyId }),
    scopedEmployeeIds(auth, "leave", "view"),
    scopedEmployeeIds(auth, "requests", "view"),
  ])
  return {
    departmentId: line?.departmentId ?? null,
    leaveDetail: leave === "ALL" ? "ALL" : new Set(leave),
    requestDetail: requests === "ALL" ? "ALL" : new Set(requests),
  }
}

function sees(detail: "ALL" | ReadonlySet<string>, employeeId: string) {
  return detail === "ALL" || detail.has(employeeId)
}

/**
 * The full entry, the colleague view (name + "OUT"/"WFH"), or undefined when
 * the viewer must not see the entry at all.
 */
export function presentAvailability<E extends AvailabilityEntry>(
  viewer: AvailabilityViewer,
  entry: E
): E | ColleagueAvailability | undefined {
  const detail =
    entry.kind === "LEAVE" ? viewer.leaveDetail : viewer.requestDetail
  if (sees(detail, entry.employeeId)) return entry

  const sameDepartment =
    viewer.departmentId !== null && viewer.departmentId === entry.departmentId
  if (!sameDepartment) return undefined
  if (entry.kind === "LEAVE") {
    return { employeeId: entry.employeeId, name: entry.name, status: "OUT" }
  }
  if (entry.kind === "WFH") {
    return { employeeId: entry.employeeId, name: entry.name, status: "WFH" }
  }
  return undefined
}
