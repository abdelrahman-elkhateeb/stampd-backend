import express, { type Request, type Router } from "express"
import { z } from "zod"

import { apiErrors } from "../../platform/http/errors.ts"
import {
  listQuery,
  toPage,
  toPageRequest,
} from "../../platform/http/pagination.ts"
import { plainDate, route } from "../../platform/http/validation.ts"
import { signedFileUrl } from "../../platform/storage/files.ts"
import {
  authorize,
  requirePermission,
  scopedEmployeeIds,
} from "../identity/access.ts"
import { issueInvitation } from "../identity/auth.service.ts"
import { getAuth } from "../identity/authenticate.ts"
import type { AppDeps } from "../module.ts"
import {
  addDepartment,
  listDepartments,
  removeDepartment,
  renameDepartment,
} from "./departments.service.ts"
import {
  createEmployeeBody,
  deactivationBody,
  employeeFilters,
  updateEmployeeBody,
} from "./employee.schemas.ts"
import { importEmployees } from "./employees.import.ts"
import {
  assertMayEdit,
  deactivateEmployee,
  getEmployeeProfile,
  hireEmployee,
  listEmployees,
  previewDeactivation,
  reactivateEmployee,
  updateEmployee,
  type EmployeeProfile,
} from "./employees.service.ts"

/**
 * Departments and employees (Trello BE-06). The exact requests and responses
 * are on the BE-06 card.
 */
export function addEmployeeRoutes(
  router: Router,
  deps: AppDeps,
  auth: express.RequestHandler
): void {
  const idParams = { params: z.object({ id: z.uuid() }) }
  const actor = (req: Request) =>
    ({ type: "USER", userId: getAuth(req).userId }) as const
  const view = ({ photoFileId, ...profile }: EmployeeProfile) => ({
    ...profile,
    photoUrl: photoFileId
      ? signedFileUrl(photoFileId, {
          secret: deps.config.authTokenSecret,
          now: deps.clock.now(),
        })
      : null,
  })
  const profileOf = async (req: Request, id: string) => {
    const profile = await getEmployeeProfile({
      companyId: getAuth(req).companyId,
      id,
    })
    if (!profile) throw apiErrors.notFound()
    return view(profile)
  }
  const authDeps = {
    config: deps.config,
    logger: deps.logger,
    clock: deps.clock,
  }
  const invite = (companyId: string) => async (id: string) => {
    await issueInvitation({ id, companyId }, authDeps)
  }

  // ── departments ──
  router.get(
    "/departments",
    auth,
    requirePermission("companySettings", "view"),
    route({}, async ({ req }) => ({
      status: 200,
      body: { items: await listDepartments(getAuth(req).companyId) },
    }))
  )
  const departmentBody = z.object({ name: z.string().trim().min(1).max(80) })
  const adminSettings = requirePermission("companySettings", "edit")
  router.post(
    "/departments",
    auth,
    adminSettings,
    route({ body: departmentBody }, async ({ body, req }) => ({
      status: 201,
      body: await addDepartment(
        {
          companyId: getAuth(req).companyId,
          name: body.name,
          actor: actor(req),
        },
        deps
      ),
    }))
  )
  router.patch(
    "/departments/:id",
    auth,
    adminSettings,
    route(
      { ...idParams, body: departmentBody },
      async ({ params, body, req }) => {
        const department = await renameDepartment(
          {
            companyId: getAuth(req).companyId,
            id: params.id,
            name: body.name,
            actor: actor(req),
          },
          deps
        )
        if (!department) throw apiErrors.notFound()
        return { status: 200, body: department }
      }
    )
  )
  router.delete(
    "/departments/:id",
    auth,
    adminSettings,
    route(idParams, async ({ params, req }) => {
      const removed = await removeDepartment(
        { companyId: getAuth(req).companyId, id: params.id, actor: actor(req) },
        deps
      )
      if (!removed) throw apiErrors.notFound()
      return { status: 204 }
    })
  )

  // ── employees: list, create, import ──
  router.get(
    "/employees",
    auth,
    requirePermission("employeeDirectory", "view"),
    route(
      {
        query: listQuery({
          sortFields: ["name", "joiningDate", "createdAt"],
          defaultSort: "name",
        }).extend(employeeFilters),
      },
      async ({ query, req }) => {
        const callerAuth = getAuth(req)
        const page = toPageRequest(query)
        const { items, total } = await listEmployees({
          companyId: callerAuth.companyId,
          visibleIds: await scopedEmployeeIds(
            callerAuth,
            "employeeDirectory",
            "view"
          ),
          filters: {
            search: query.search,
            departmentId: query.departmentId,
            managerId: query.managerId,
            statuses: query.status,
            roles: query.role,
          },
          page,
        })
        return { status: 200, body: toPage(items.map(view), total, page) }
      }
    )
  )
  router.post(
    "/employees",
    auth,
    requirePermission("employee", "create"),
    route({ body: createEmployeeBody }, async ({ body, req }) => {
      const { companyId } = getAuth(req)
      const id = await hireEmployee(
        { companyId, employee: body, actor: actor(req) },
        deps
      )
      const invitation = await issueInvitation({ id, companyId }, authDeps)
      return {
        status: 201,
        body: {
          employee: await profileOf(req, id),
          invitation: { expiresAt: invitation.expiresAt.toISOString() },
        },
      }
    })
  )
  router.post(
    "/employees/import",
    auth,
    requirePermission("employee", "create"),
    express.text({ type: ["text/csv", "text/plain"], limit: "1mb" }),
    route({}, async ({ req }) => {
      if (typeof req.body !== "string") {
        throw apiErrors.fieldError(
          "file",
          "REQUIRED",
          "send the CSV as the body with Content-Type text/csv"
        )
      }
      const { companyId } = getAuth(req)
      const report = await importEmployees(
        {
          companyId,
          csv: req.body,
          actor: actor(req),
          invite: invite(companyId),
        },
        deps
      )
      return { status: 200, body: report }
    })
  )

  // ── one employee ──
  router.get(
    "/employees/:id",
    auth,
    route(idParams, async ({ params, req }) => {
      await authorize(getAuth(req), "employee", "view", params.id)
      return { status: 200, body: await profileOf(req, params.id) }
    })
  )
  router.patch(
    "/employees/:id",
    auth,
    route(
      { ...idParams, body: updateEmployeeBody },
      async ({ params, body, req }) => {
        const callerAuth = getAuth(req)
        await authorize(callerAuth, "employee", "view", params.id)
        assertMayEdit(callerAuth, params.id, body)
        await updateEmployee(
          {
            companyId: callerAuth.companyId,
            id: params.id,
            change: body,
            actor: actor(req),
          },
          deps
        )
        return { status: 200, body: await profileOf(req, params.id) }
      }
    )
  )
  router.post(
    "/employees/:id/invitation",
    auth,
    requirePermission("users", "create"),
    route(idParams, async ({ params, req }) => {
      const invitation = await issueInvitation(
        { id: params.id, companyId: getAuth(req).companyId },
        authDeps
      )
      return {
        status: 200,
        body: { expiresAt: invitation.expiresAt.toISOString() },
      }
    })
  )

  // ── offboarding ──
  const adminUsers = requirePermission("users", "edit")
  router.post(
    "/employees/:id/deactivation/preview",
    auth,
    adminUsers,
    route(
      { ...idParams, body: z.object({ lastWorkingDay: plainDate }) },
      async ({ params, body, req }) => ({
        status: 200,
        body: await previewDeactivation({
          auth: getAuth(req),
          id: params.id,
          lastWorkingDay: body.lastWorkingDay,
        }),
      })
    )
  )
  router.post(
    "/employees/:id/deactivation",
    auth,
    adminUsers,
    route(
      { ...idParams, body: deactivationBody },
      async ({ params, body, req }) => {
        await deactivateEmployee(
          { auth: getAuth(req), id: params.id, ...body },
          deps
        )
        return { status: 200, body: await profileOf(req, params.id) }
      }
    )
  )
  router.post(
    "/employees/:id/reactivation",
    auth,
    adminUsers,
    route(idParams, async ({ params, req }) => {
      await reactivateEmployee(
        { companyId: getAuth(req).companyId, id: params.id, actor: actor(req) },
        deps
      )
      return { status: 200, body: await profileOf(req, params.id) }
    })
  )
}
