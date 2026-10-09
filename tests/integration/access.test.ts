import { Router } from "express"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import {
  authorize,
  requirePermission,
  scopedEmployeeIds,
} from "../../src/modules/identity/access.ts"
import {
  getAuth,
  requireAuth,
} from "../../src/modules/identity/authenticate.ts"
import { availabilityViewer } from "../../src/modules/identity/availability.ts"
import { MODULES } from "../../src/modules/index.ts"
import type { AppModule } from "../../src/modules/module.ts"
import { hashPassword } from "../../src/modules/identity/passwords.ts"
import { UserModel, type Role } from "../../src/modules/identity/user.model.ts"
import { DepartmentModel } from "../../src/modules/organization/department.model.ts"
import { CompanyModel } from "../../src/modules/organization/company.model.ts"
import {
  createEmployee,
  setReportingLine,
} from "../../src/modules/organization/organization.service.ts"
import { route } from "../../src/platform/http/validation.ts"
import { signupBody, useApi, type Tokens } from "./api.ts"
import { useTestDatabase } from "./database.ts"

/**
 * Authorization per role (Trello BE-03). The probe endpoints below stand in
 * for the real ones later tickets build, and use the helpers the way those
 * must: authorize() for one employee's data, scopedEmployeeIds() for lists,
 * requirePermission() for actions that aren't about one employee.
 */
useTestDatabase()

const probe: AppModule = {
  name: "probe",
  routes: (deps) => {
    const router = Router()
    const auth = requireAuth({
      secret: deps.config.authTokenSecret,
      clock: deps.clock,
    })
    const employeeParams = { params: z.object({ id: z.uuid() }) }

    router.get(
      "/probe/attendance/:id",
      auth,
      route(employeeParams, async ({ params, req }) => {
        await authorize(getAuth(req), "attendance", "view", params.id)
        return { status: 200, body: { employeeId: params.id } }
      })
    )
    router.get(
      "/probe/attendance",
      auth,
      route({}, async ({ req }) => {
        const ids = await scopedEmployeeIds(getAuth(req), "attendance", "view")
        return { status: 200, body: { ids: ids === "ALL" ? ids : ids.sort() } }
      })
    )
    router.post(
      "/probe/leave/:id/approve",
      auth,
      route(employeeParams, async ({ params, req }) => {
        await authorize(getAuth(req), "leave", "approve", params.id)
        return { status: 200, body: { approved: params.id } }
      })
    )
    router.post(
      "/probe/company/rename",
      auth,
      requirePermission("companySettings", "edit"),
      route({ body: z.object({ name: z.string() }) }, async ({ body, req }) => {
        const { companyId } = getAuth(req)
        await CompanyModel.updateOne({ _id: companyId }, { name: body.name })
        return { status: 204 }
      })
    )
    router.get(
      "/probe/availability-viewer",
      auth,
      route({}, async ({ req }) => {
        const viewer = await availabilityViewer(getAuth(req))
        const list = (detail: "ALL" | ReadonlySet<string>) =>
          detail === "ALL" ? detail : [...detail].sort()
        return {
          status: 200,
          body: {
            departmentId: viewer.departmentId,
            leaveDetail: list(viewer.leaveDetail),
            requestDetail: list(viewer.requestDetail),
          },
        }
      })
    )
    return router
  },
}

const api = useApi({ modules: [...MODULES, probe] })

/** setReportingLine as a test fixture (recorded in history as a system change). */
const setLine = (
  input: Omit<Parameters<typeof setReportingLine>[0], "changedBy">
) =>
  setReportingLine(
    { ...input, changedBy: { type: "SYSTEM", job: "test" } },
    { clock: api.clock }
  )

type Member = { id: string; token: string }

let emails = 0
/** A company: the Admin from signup, plus members added straight to the database. */
async function newCompany(name: string) {
  const tokens = (
    await api.post<Tokens>(
      "/auth/signup",
      signupBody({ companyName: name, name: `${name} Admin` })
    )
  ).body
  const me = (
    await api.get<{ id: string; company: { id: string } }>(
      "/me",
      tokens.accessToken
    )
  ).body
  const companyId = me.company.id
  const admin: Member = { id: me.id, token: tokens.accessToken }

  async function add(
    role: Role,
    reportingLine: { managerId?: string; departmentId?: string } = {}
  ): Promise<Member> {
    emails += 1
    const email = `member${emails}.${Date.now()}@acme.example`
    const [user] = await UserModel.create([
      {
        companyId,
        email,
        role,
        status: "ACTIVE",
        passwordHash: await hashPassword("blue-river-lantern"),
      },
    ])
    await createEmployee({
      id: user!._id,
      companyId,
      name: `${role} ${emails}`,
    })
    await setLine({ id: user!._id, companyId, ...reportingLine })
    const login = await api.post<Tokens>("/auth/login", {
      email,
      password: "blue-river-lantern",
    })
    return { id: user!._id, token: login.body.accessToken }
  }

  return { companyId, admin, add }
}

/** Admin → manager → two reports (one of whom manages a third); plus an outsider. */
async function orgChart(name: string) {
  const company = await newCompany(name)
  const manager = await company.add("MANAGER", {
    managerId: company.admin.id,
  })
  const report = await company.add("EMPLOYEE", { managerId: manager.id })
  const leadReport = await company.add("MANAGER", { managerId: manager.id })
  const skipLevel = await company.add("EMPLOYEE", {
    managerId: leadReport.id,
  })
  const otherManager = await company.add("MANAGER", {
    managerId: company.admin.id,
  })
  const outsider = await company.add("EMPLOYEE", {
    managerId: otherManager.id,
  })
  return {
    ...company,
    manager,
    report,
    leadReport,
    skipLevel,
    otherManager,
    outsider,
  }
}

const notFound = { code: "NOT_FOUND", message: "Not found" }
const forbidden = { code: "FORBIDDEN", message: "Not allowed for this role" }

describe("Employee", () => {
  it("sees only their own data: another employee's (even their manager's) is 404", async () => {
    const org = await orgChart("Foxtrot")
    const as = org.report.token

    expect(
      (await api.get(`/probe/attendance/${org.report.id}`, as)).status
    ).toBe(200)
    for (const other of [
      org.outsider,
      org.leadReport,
      org.manager,
      org.admin,
    ]) {
      const response = await api.get(`/probe/attendance/${other.id}`, as)
      expect(response.status).toBe(404)
      expect(response.body).toEqual(notFound)
    }
    expect((await api.get("/probe/attendance", as)).body).toEqual({
      ids: [org.report.id],
    })
  })

  it("gets 403 on an Admin-only action, and nothing changes", async () => {
    const org = await orgChart("Golf")
    const response = await api.post(
      "/probe/company/rename",
      { name: "Hijacked" },
      org.report.token
    )
    expect(response.status).toBe(403)
    expect(response.body).toEqual(forbidden)
    expect((await CompanyModel.findById(org.companyId).lean())?.name).toBe(
      "Golf"
    )
  })

  it("can't approve anything (403), not even a colleague's", async () => {
    const org = await orgChart("Hotel")
    const response = await api.post(
      `/probe/leave/${org.outsider.id}/approve`,
      undefined,
      org.report.token
    )
    expect(response.status).toBe(403)
    expect(response.body).toEqual(forbidden)
  })
})

describe("Manager", () => {
  it("sees their own data and their direct reports'; anyone else is 404 (no skip-level)", async () => {
    const org = await orgChart("India")
    const as = org.manager.token

    for (const allowed of [org.manager, org.report, org.leadReport]) {
      expect(
        (await api.get(`/probe/attendance/${allowed.id}`, as)).status
      ).toBe(200)
    }
    for (const other of [
      org.skipLevel,
      org.outsider,
      org.otherManager,
      org.admin,
    ]) {
      const response = await api.get(`/probe/attendance/${other.id}`, as)
      expect(response.status).toBe(404)
      expect(response.body).toEqual(notFound)
    }
    expect((await api.get("/probe/attendance", as)).body).toEqual({
      ids: [org.manager.id, org.report.id, org.leadReport.id].sort(),
    })
  })

  it("loses access to a report reassigned to another manager on the very next request", async () => {
    const org = await orgChart("Juliett")
    const path = `/probe/attendance/${org.report.id}`
    expect((await api.get(path, org.manager.token)).status).toBe(200)
    expect((await api.get(path, org.otherManager.token)).status).toBe(404)

    await setLine({
      id: org.report.id,
      companyId: org.companyId,
      managerId: org.otherManager.id,
    })

    expect((await api.get(path, org.manager.token)).status).toBe(404)
    expect((await api.get(path, org.otherManager.token)).status).toBe(200)
    expect(
      (await api.get<{ ids: string[] }>("/probe/attendance", org.manager.token))
        .body.ids
    ).not.toContain(org.report.id)
  })

  it("loses a deactivated report (the Admin keeps access)", async () => {
    const org = await orgChart("Kilo")
    await UserModel.updateOne(
      { _id: org.report.id, companyId: org.companyId },
      { status: "DEACTIVATED" }
    )
    const path = `/probe/attendance/${org.report.id}`
    expect((await api.get(path, org.manager.token)).status).toBe(404)
    expect((await api.get(path, org.admin.token)).status).toBe(200)
    expect(
      (await api.get<{ ids: string[] }>("/probe/attendance", org.manager.token))
        .body.ids
    ).not.toContain(org.report.id)
  })

  it("approves direct reports only, and never their own request (403 SELF_APPROVAL)", async () => {
    const org = await orgChart("Lima")
    const approve = (id: string) =>
      api.post(`/probe/leave/${id}/approve`, undefined, org.manager.token)

    expect((await approve(org.report.id)).status).toBe(200)
    expect((await approve(org.skipLevel.id)).status).toBe(404)
    expect((await approve(org.outsider.id)).status).toBe(404)

    const own = await approve(org.manager.id)
    expect(own.status).toBe(403)
    expect(own.body).toEqual({
      code: "SELF_APPROVAL",
      message: "You can't approve your own request",
    })
  })

  it("can't edit company settings (403)", async () => {
    const org = await orgChart("Mike")
    const response = await api.post(
      "/probe/company/rename",
      { name: "Renamed" },
      org.manager.token
    )
    expect(response.status).toBe(403)
    expect((await CompanyModel.findById(org.companyId).lean())?.name).toBe(
      "Mike"
    )
  })
})

describe("Admin", () => {
  it("sees every employee of their company; another company's is 404", async () => {
    const org = await orgChart("November")
    const other = await orgChart("Oscar")
    const as = org.admin.token

    for (const member of [
      org.admin,
      org.manager,
      org.report,
      org.skipLevel,
      org.outsider,
    ]) {
      expect((await api.get(`/probe/attendance/${member.id}`, as)).status).toBe(
        200
      )
    }
    for (const foreign of [other.admin, other.report]) {
      const response = await api.get(`/probe/attendance/${foreign.id}`, as)
      expect(response.status).toBe(404)
      expect(response.body).toEqual(notFound)
    }
    expect((await api.get("/probe/attendance", as)).body).toEqual({
      ids: "ALL",
    })
  })

  it("approves anyone in the company except themselves", async () => {
    const org = await orgChart("Papa")
    const other = await orgChart("Quebec")
    const approve = (id: string) =>
      api.post(`/probe/leave/${id}/approve`, undefined, org.admin.token)

    expect((await approve(org.skipLevel.id)).status).toBe(200)
    expect((await approve(org.manager.id)).status).toBe(200)
    expect((await approve(other.report.id)).status).toBe(404)
    expect((await approve(org.admin.id)).body).toMatchObject({
      code: "SELF_APPROVAL",
    })
  })

  it("edits company settings", async () => {
    const org = await orgChart("Romeo")
    const response = await api.post(
      "/probe/company/rename",
      { name: "Romeo Ltd" },
      org.admin.token
    )
    expect(response.status).toBe(204)
    expect((await CompanyModel.findById(org.companyId).lean())?.name).toBe(
      "Romeo Ltd"
    )
  })
})

describe("role changes and reporting lines", () => {
  it("apply on the next request: a demoted manager loses the team at once", async () => {
    const org = await orgChart("Sierra")
    const path = `/probe/attendance/${org.report.id}`
    expect((await api.get(path, org.manager.token)).status).toBe(200)

    await UserModel.updateOne(
      { _id: org.manager.id, companyId: org.companyId },
      { role: "EMPLOYEE" }
    )

    expect((await api.get(path, org.manager.token)).status).toBe(404)
    expect(
      (
        await api.post(
          `/probe/leave/${org.report.id}/approve`,
          undefined,
          org.manager.token
        )
      ).status
    ).toBe(403)
  })

  it("apply on the next request: a promoted employee gets the Admin's reach", async () => {
    const org = await orgChart("Tango")
    await UserModel.updateOne(
      { _id: org.report.id, companyId: org.companyId },
      { role: "ADMIN" }
    )
    expect(
      (await api.get(`/probe/attendance/${org.outsider.id}`, org.report.token))
        .status
    ).toBe(200)
  })

  it("refuse a manager from another company, yourself, or an unknown employee", async () => {
    const org = await orgChart("Uniform")
    const other = await orgChart("Victor")
    expect(
      await setLine({
        id: org.report.id,
        companyId: org.companyId,
        managerId: other.manager.id,
      })
    ).toBe("UNKNOWN_MANAGER")
    expect(
      await setLine({
        id: org.report.id,
        companyId: org.companyId,
        managerId: org.report.id,
      })
    ).toBe("SELF_MANAGER")
    expect(
      await setLine({
        id: other.report.id,
        companyId: org.companyId,
        departmentId: "sales",
      })
    ).toBe("NOT_FOUND")
  })
})

describe("availability viewer (who sees colleagues' details)", () => {
  it("knows the viewer's department and whose entries they see in full", async () => {
    const org = await orgChart("Whiskey")
    await DepartmentModel.create({
      _id: "11111111-1111-4111-8111-111111111111",
      companyId: org.companyId,
      name: "Sales",
      nameKey: "sales",
    })
    await setLine({
      id: org.manager.id,
      companyId: org.companyId,
      departmentId: "11111111-1111-4111-8111-111111111111",
    })

    expect(
      (await api.get("/probe/availability-viewer", org.manager.token)).body
    ).toEqual({
      departmentId: "11111111-1111-4111-8111-111111111111",
      leaveDetail: [org.manager.id, org.report.id, org.leadReport.id].sort(),
      requestDetail: [org.manager.id, org.report.id, org.leadReport.id].sort(),
    })
    expect(
      (await api.get("/probe/availability-viewer", org.report.token)).body
    ).toEqual({
      departmentId: null,
      leaveDetail: [org.report.id],
      requestDetail: [org.report.id],
    })
    expect(
      (await api.get("/probe/availability-viewer", org.admin.token)).body
    ).toMatchObject({ leaveDetail: "ALL", requestDetail: "ALL" })
  })
})

describe("existing endpoints per role", () => {
  it("/me answers with the caller's own record, whatever the role", async () => {
    const org = await orgChart("Xray")
    for (const member of [org.admin, org.manager, org.report]) {
      expect((await api.get<{ id: string }>("/me", member.token)).body.id).toBe(
        member.id
      )
    }
  })
})
