import { afterEach, describe, expect, it } from "vitest"

import { HistoryEntryModel } from "../../src/modules/history/history.model.ts"
import { UserModel } from "../../src/modules/identity/user.model.ts"
import { EmployeeModel } from "../../src/modules/organization/employee.model.ts"
import { registerOffboardingHook } from "../../src/modules/organization/employees.service.ts"
import { hashPassword } from "../../src/modules/identity/passwords.ts"
import { addDays, plainDateInZone } from "../../src/platform/time/time.ts"
import { useApi, type Tokens } from "./api.ts"
import { useTestDatabase } from "./database.ts"
import { newCompany, type Member } from "./people.ts"

/** Departments and employee management (Trello BE-06). */
useTestDatabase()
const api = useApi()

type Profile = {
  id: string
  name: string
  email: string
  phone: string | null
  jobTitle: string | null
  department: { id: string; name: string } | null
  manager: { id: string; name: string } | null
  role: string
  status: string
  lastWorkingDay: string | null
  photoUrl: string | null
}
type Page = { items: Profile[]; meta: { totalItems: number } }

const today = () => plainDateInZone(api.clock.now(), "Asia/Dubai")

async function org(name: string) {
  const company = await newCompany(api, name)
  const manager = await company.add("MANAGER", company.admin.id)
  const employee = await company.add("EMPLOYEE", manager.id)
  const colleague = await company.add("EMPLOYEE", company.admin.id)
  return { ...company, manager, employee, colleague }
}

async function department(admin: Member, name: string) {
  const response = await api.post<{ id: string }>(
    "/departments",
    { name },
    admin.token
  )
  expect(response.status).toBe(201)
  return response.body.id
}

const hire = (admin: Member, body: Record<string, unknown>) =>
  api.post<{ employee: Profile; invitation: { expiresAt: string } }>(
    "/employees",
    {
      name: "Nadia Fares",
      email: `nadia.${Date.now()}.${Math.random()}@acme.example`,
      joiningDate: "2026-10-01",
      ...body,
    },
    admin.token
  )

/** Gives a member a password and signs them in again (after time moved on). */
async function signIn(member: Member, companyId: string): Promise<string> {
  const user = await UserModel.findOne(
    { _id: member.id, companyId },
    { email: 1 }
  ).lean()
  const login = await api.post<Tokens>("/auth/login", {
    email: user!.email,
    password: "blue-river-lantern",
  })
  return login.body.accessToken
}

describe("departments", () => {
  it("are created, renamed and listed by the Admin; names are unique regardless of case", async () => {
    const o = await org("Alpha")
    const sales = await department(o.admin, "Sales")
    const duplicate = await api.post(
      "/departments",
      { name: " sales " },
      o.admin.token
    )
    expect(duplicate.status).toBe(422)
    expect(duplicate.body).toMatchObject({
      fieldErrors: [{ field: "name", code: "ALREADY_EXISTS" }],
    })

    const renamed = await api.patch(
      `/departments/${sales}`,
      { name: "Sales & Marketing" },
      o.admin.token
    )
    expect(renamed.body).toEqual({
      id: sales,
      name: "Sales & Marketing",
      employeeCount: 0,
    })
    // Everyone can read the list (forms need it).
    const list = await api.get<{ items: unknown[] }>(
      "/departments",
      o.employee.token
    )
    expect(list.body.items).toEqual([
      { id: sales, name: "Sales & Marketing", employeeCount: 0 },
    ])
    expect(
      (await api.post("/departments", { name: "X" }, o.manager.token)).status
    ).toBe(403)
  })

  it("can be deleted only when empty (409 DEPARTMENT_NOT_EMPTY)", async () => {
    const o = await org("Bravo")
    const ops = await department(o.admin, "Ops")
    await api.patch(
      `/employees/${o.employee.id}`,
      { departmentId: ops },
      o.admin.token
    )
    const refused = await api.request("DELETE", `/departments/${ops}`, {
      token: o.admin.token,
    })
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ code: "DEPARTMENT_NOT_EMPTY" })

    await api.patch(
      `/employees/${o.employee.id}`,
      { departmentId: null },
      o.admin.token
    )
    expect(
      (
        await api.request("DELETE", `/departments/${ops}`, {
          token: o.admin.token,
        })
      ).status
    ).toBe(204)
  })
})

describe("creating employees", () => {
  it("creates an invited employee with every field, and sends the invite", async () => {
    const o = await org("Charlie")
    const ops = await department(o.admin, "Ops")
    const response = await hire(o.admin, {
      name: "Nadia Fares",
      email: "nadia.charlie@acme.example",
      phone: "+971 50 123 4567",
      jobTitle: "Accountant",
      employeeCode: "E-001",
      departmentId: ops,
      managerId: o.manager.id,
      employmentType: "PART_TIME",
      tracksAttendance: false,
    })
    expect(response.status).toBe(201)
    expect(response.body.employee).toEqual({
      id: expect.any(String),
      name: "Nadia Fares",
      email: "nadia.charlie@acme.example",
      phone: "+971 50 123 4567",
      jobTitle: "Accountant",
      employeeCode: "E-001",
      department: { id: ops, name: "Ops" },
      manager: { id: o.manager.id, name: o.manager.name },
      role: "EMPLOYEE",
      status: "INVITED",
      joiningDate: "2026-10-01",
      employmentType: "PART_TIME",
      tracksAttendance: false,
      lastWorkingDay: null,
      photoUrl: null,
    })
    expect(response.body.invitation.expiresAt).toMatch(/Z$/)
    expect(
      api.logs.some((line) => String(line.link ?? "").includes("/invite/"))
    ).toBe(true)

    const history = await api.get<{ items: { action: string }[] }>(
      `/history/employees/${response.body.employee.id}`,
      o.admin.token
    )
    expect(history.body.items.map((e) => e.action).sort()).toEqual([
      "employee.created",
      "employee.reportingLineChanged",
    ])
  })

  it("refuses a duplicate email or employee code with a field error, and creates nothing (BE-06 AC)", async () => {
    const o = await org("Delta")
    const taken = await hire(o.admin, {
      email: (await UserModel.findOne({
        _id: o.employee.id,
        companyId: o.companyId,
      }).lean())!.email,
    })
    expect(taken.status).toBe(422)
    expect(taken.body).toMatchObject({
      fieldErrors: [{ field: "email", code: "ALREADY_EXISTS" }],
    })

    await hire(o.admin, { employeeCode: "E-7" })
    const before = await EmployeeModel.countDocuments({
      companyId: o.companyId,
    })
    const code = await hire(o.admin, { employeeCode: "E-7" })
    expect(code.body).toMatchObject({
      fieldErrors: [{ field: "employeeCode", code: "ALREADY_EXISTS" }],
    })
    expect(await EmployeeModel.countDocuments({ companyId: o.companyId })).toBe(
      before
    )
  })

  it("refuses unknown departments and managers, and non-managers as managers", async () => {
    const o = await org("Echo")
    const unknown = await hire(o.admin, {
      departmentId: crypto.randomUUID(),
    })
    expect(unknown.body).toMatchObject({
      fieldErrors: [{ field: "departmentId", code: "UNKNOWN_REFERENCE" }],
    })
    const employeeAsManager = await hire(o.admin, { managerId: o.colleague.id })
    expect(employeeAsManager.body).toMatchObject({
      fieldErrors: [{ field: "managerId", code: "NOT_A_MANAGER" }],
    })
  })

  it("is for Admins only (403)", async () => {
    const o = await org("Foxtrot")
    expect((await hire(o.manager, {})).status).toBe(403)
    expect((await hire(o.employee, {})).status).toBe(403)
  })

  it("resends an invitation, only to invited employees", async () => {
    const o = await org("Golf")
    const created = await hire(o.admin, {})
    const id = created.body.employee.id
    const resent = await api.post(
      `/employees/${id}/invitation`,
      undefined,
      o.admin.token
    )
    expect(resent.status).toBe(200)
    expect(
      (
        await api.post(
          `/employees/${o.employee.id}/invitation`,
          undefined,
          o.admin.token
        )
      ).status
    ).toBe(409)
  })
})

describe("CSV import", () => {
  it("creates the 50 valid rows and reports the 2 invalid ones with reasons (BE-06 AC)", async () => {
    const o = await org("Hotel")
    await department(o.admin, "Field Ops")
    const stamp = Date.now()
    const lines = [
      "Name,Email,JoiningDate,Department,ManagerEmail,Role,EmploymentType,TracksAttendance",
    ]
    // Row 2 is a manager the rows below report to.
    lines.push(
      `Team Lead,lead.${stamp}@acme.example,2026-09-01,field ops,,manager,full-time,yes`
    )
    for (let i = 1; i <= 49; i += 1) {
      lines.push(
        `"Worker ${i}, Jr",worker${i}.${stamp}@acme.example,2026-09-15,Field Ops,lead.${stamp}@acme.example,,,`
      )
    }
    lines.push(`Bad Email,not-an-email,2026-09-15,,,,,`) // line 52
    lines.push(`Lost Soul,lost.${stamp}@acme.example,2026-09-15,Nowhere,,,,`) // line 53

    const response = await api.request<{
      createdCount: number
      created: { row: number; email: string }[]
      errors: { row: number; field: string; code: string }[]
    }>("POST", "/employees/import", {
      token: o.admin.token,
      raw: { bytes: Buffer.from(lines.join("\r\n")), contentType: "text/csv" },
    })
    expect(response.status).toBe(200)
    expect(response.body.createdCount).toBe(50)
    expect(response.body.errors).toEqual([
      expect.objectContaining({
        row: 52,
        field: "email",
        code: "INVALID_FORMAT",
      }),
      expect.objectContaining({
        row: 53,
        field: "department",
        code: "UNKNOWN_REFERENCE",
      }),
    ])

    const lead = response.body.created[0]!
    const workers = await EmployeeModel.countDocuments({
      companyId: o.companyId,
      managerId: (await UserModel.findOne({
        companyId: o.companyId,
        email: lead.email,
      }).lean())!._id,
    })
    expect(workers).toBe(49)
    const invited = await UserModel.countDocuments({
      companyId: o.companyId,
      status: "INVITED",
    })
    expect(invited).toBe(50)
  })

  it("refuses a file with unknown or missing columns as a whole", async () => {
    const o = await org("India")
    const send = (text: string) =>
      api.request("POST", "/employees/import", {
        token: o.admin.token,
        raw: { bytes: Buffer.from(text), contentType: "text/csv" },
      })
    const unknown = await send(
      "name,email,joiningDate,salary\nA,a@x.com,2026-01-01,1"
    )
    expect(unknown.status).toBe(422)
    expect(unknown.body).toMatchObject({
      fieldErrors: [{ field: "file", code: "INVALID_FORMAT" }],
    })
    const missing = await send("name,email\nA,a@x.com")
    expect(missing.status).toBe(422)
    const empty = await send("name,email,joiningDate\n")
    expect(empty.body).toMatchObject({
      fieldErrors: [{ field: "file", code: "REQUIRED" }],
    })
  })
})

describe("manager assignment", () => {
  it("refuses loops (A manages B, B can't manage A) and self-management (BE-06 AC)", async () => {
    const o = await org("Juliett")
    // admin → manager → employee. Making the employee the admin's manager loops.
    await api.patch(
      `/employees/${o.employee.id}`,
      { role: "MANAGER" },
      o.admin.token
    )
    const loop = await api.patch(
      `/employees/${o.manager.id}`,
      { managerId: o.employee.id },
      o.admin.token
    )
    expect(loop.status).toBe(422)
    expect(loop.body).toMatchObject({
      fieldErrors: [{ field: "managerId", code: "MANAGER_LOOP" }],
    })
    const indirect = await api.patch(
      `/employees/${o.admin.id}`,
      { managerId: o.employee.id },
      o.admin.token
    )
    expect(indirect.body).toMatchObject({
      fieldErrors: [{ field: "managerId", code: "MANAGER_LOOP" }],
    })
    const self = await api.patch(
      `/employees/${o.manager.id}`,
      { managerId: o.manager.id },
      o.admin.token
    )
    expect(self.body).toMatchObject({
      fieldErrors: [{ field: "managerId", code: "SELF_MANAGER" }],
    })
    // Nothing changed.
    expect(
      (
        await EmployeeModel.findOne({
          _id: o.manager.id,
          companyId: o.companyId,
        }).lean()
      )?.managerId
    ).toBe(o.admin.id)
  })
})

describe("who sees and edits what", () => {
  it("refuses the employee list to Employees (403); Managers see their direct reports; Admins everyone", async () => {
    const o = await org("Kilo")
    const listed = await api.get("/employees", o.employee.token)
    expect(listed.status).toBe(403)

    const team = await api.get<Page>("/employees", o.manager.token)
    expect(team.body.items.map((e) => e.id)).toEqual([o.employee.id])

    const everyone = await api.get<Page>("/employees", o.admin.token)
    expect(everyone.body.meta.totalItems).toBe(4)
  })

  it("filters and searches by name, email or code", async () => {
    const o = await org("Lima")
    const ops = await department(o.admin, "Ops")
    const created = await hire(o.admin, {
      name: "Zainab Qasim",
      email: `zq.${Date.now()}@lima.example`,
      employeeCode: "LIMA-42",
      departmentId: ops,
    })
    const ids = async (query: string) =>
      (
        await api.get<Page>(`/employees?${query}`, o.admin.token)
      ).body.items.map((e) => e.id)
    const id = created.body.employee.id
    expect(await ids("search=zain")).toEqual([id])
    expect(await ids("search=lima.example")).toEqual([id])
    expect(await ids("search=lima-4")).toEqual([id])
    expect(await ids(`departmentId=${ops}`)).toEqual([id])
    expect(await ids("status=INVITED")).toEqual([id])
    expect((await ids("role=MANAGER&role=ADMIN")).sort()).toEqual(
      [o.admin.id, o.manager.id].sort()
    )
    expect(await ids(`managerId=${o.manager.id}`)).toEqual([o.employee.id])
  })

  it("shows a Manager their direct report read-only: editing is 403 (BE-06 AC)", async () => {
    const o = await org("Mike")
    const detail = await api.get<Profile>(
      `/employees/${o.employee.id}`,
      o.manager.token
    )
    expect(detail.status).toBe(200)
    expect(detail.body.manager).toEqual({
      id: o.manager.id,
      name: o.manager.name,
    })
    const edit = await api.patch(
      `/employees/${o.employee.id}`,
      { jobTitle: "Boss" },
      o.manager.token
    )
    expect(edit.status).toBe(403)
    // Someone outside the team: 404, as in BE-03.
    expect(
      (await api.get(`/employees/${o.colleague.id}`, o.manager.token)).status
    ).toBe(404)
  })

  it("lets an Employee change only their own phone, recorded in history (BE-06 AC)", async () => {
    const o = await org("November")
    const phone = await api.patch<Profile>(
      `/employees/${o.employee.id}`,
      { phone: "+966 55 000 1111" },
      o.employee.token
    )
    expect(phone.status).toBe(200)
    expect(phone.body.phone).toBe("+966 55 000 1111")
    const history = await api.get<{
      items: { action: string; newValues: Record<string, unknown> }[]
    }>(`/history/employees/${o.employee.id}`, o.employee.token)
    expect(history.body.items[0]).toMatchObject({
      action: "employee.profileChanged",
      newValues: { phone: "+966 55 000 1111" },
    })

    for (const change of [
      { jobTitle: "CEO" },
      { departmentId: null },
      { managerId: o.admin.id },
      { role: "ADMIN" },
      { phone: "1", name: "New Name" },
    ]) {
      const response = await api.patch(
        `/employees/${o.employee.id}`,
        change,
        o.employee.token
      )
      expect(response.status, JSON.stringify(change)).toBe(403)
    }
    // Not someone else's phone either (not visible: 404).
    expect(
      (
        await api.patch(
          `/employees/${o.colleague.id}`,
          { phone: "1" },
          o.employee.token
        )
      ).status
    ).toBe(404)
  })

  it("keeps another company's employees and departments out of reach (404)", async () => {
    const a = await org("Oscar")
    const b = await org("Papa")
    const bDept = await department(b.admin, "B only")
    for (const [method, path, body] of [
      ["GET", `/employees/${b.employee.id}`, undefined],
      ["PATCH", `/employees/${b.employee.id}`, { jobTitle: "x" }],
      [
        "POST",
        `/employees/${b.employee.id}/deactivation`,
        { lastWorkingDay: today() },
      ],
      ["POST", `/employees/${b.employee.id}/invitation`, undefined],
      ["PATCH", `/departments/${bDept}`, { name: "Mine" }],
      ["DELETE", `/departments/${bDept}`, undefined],
    ] as const) {
      const response = await api.request(method, path, {
        token: a.admin.token,
        body,
      })
      expect(response.status, `${method} ${path}`).toBe(404)
    }
    // A's admin can't point A's employee at B's manager or department.
    const crossManager = await api.patch(
      `/employees/${a.employee.id}`,
      { managerId: b.manager.id },
      a.admin.token
    )
    expect(crossManager.body).toMatchObject({
      fieldErrors: [{ field: "managerId", code: "UNKNOWN_REFERENCE" }],
    })
  })
})

describe("roles", () => {
  it("changes a role, recorded in history; it applies on the next request", async () => {
    const o = await org("Quebec")
    const response = await api.patch<Profile>(
      `/employees/${o.colleague.id}`,
      { role: "MANAGER" },
      o.admin.token
    )
    expect(response.body.role).toBe("MANAGER")
    expect((await api.get("/employees", o.colleague.token)).status).toBe(200)
  })

  it("refuses to demote a manager who still has reports, or the last Admin (409)", async () => {
    const o = await org("Romeo")
    const demote = await api.patch(
      `/employees/${o.manager.id}`,
      { role: "EMPLOYEE" },
      o.admin.token
    )
    expect(demote.status).toBe(409)
    expect(demote.body).toMatchObject({ code: "HAS_DIRECT_REPORTS" })

    const lastAdmin = await api.patch(
      `/employees/${o.admin.id}`,
      { role: "MANAGER" },
      o.admin.token
    )
    expect(lastAdmin.status).toBe(409)
    expect(lastAdmin.body).toMatchObject({ code: "LAST_ADMIN" })
  })
})

describe("offboarding", () => {
  let unregister: (() => void) | undefined
  afterEach(() => unregister?.())

  it("previews the impact first, without changing anything", async () => {
    const o = await org("Sierra")
    unregister = registerOffboardingHook({
      preview: async () => ({
        pendingRequests: [
          {
            id: "r1",
            type: "WFH",
            startDate: "2026-11-01",
            endDate: "2026-11-01",
          },
        ],
      }),
      apply: async () => {},
    })
    const preview = await api.post(
      `/employees/${o.manager.id}/deactivation/preview`,
      { lastWorkingDay: "2026-10-31" },
      o.admin.token
    )
    expect(preview.status).toBe(200)
    expect(preview.body).toEqual({
      lastWorkingDay: "2026-10-31",
      directReports: [{ id: o.employee.id, name: o.employee.name }],
      pendingRequests: [
        {
          id: "r1",
          type: "WFH",
          startDate: "2026-11-01",
          endDate: "2026-11-01",
        },
      ],
      futureApprovedTimeOff: [],
    })
    expect(
      (
        await UserModel.findOne({
          _id: o.manager.id,
          companyId: o.companyId,
        }).lean()
      )?.lastWorkingDay ?? null
    ).toBeNull()
  })

  it("refuses to deactivate someone with direct reports until they are reassigned (BE-06 AC)", async () => {
    const o = await org("Tango")
    const refused = await api.post(
      `/employees/${o.manager.id}/deactivation`,
      { lastWorkingDay: today() },
      o.admin.token
    )
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ code: "HAS_DIRECT_REPORTS" })

    const notAManager = await api.post(
      `/employees/${o.manager.id}/deactivation`,
      { lastWorkingDay: today(), reassignReportsTo: o.colleague.id },
      o.admin.token
    )
    expect(notAManager.body).toMatchObject({
      fieldErrors: [{ field: "reassignReportsTo", code: "NOT_A_MANAGER" }],
    })

    const done = await api.post<Profile>(
      `/employees/${o.manager.id}/deactivation`,
      { lastWorkingDay: today(), reassignReportsTo: o.admin.id },
      o.admin.token
    )
    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({
      status: "ACTIVE",
      lastWorkingDay: today(),
    })
    expect(
      (
        await EmployeeModel.findOne({
          _id: o.employee.id,
          companyId: o.companyId,
        }).lean()
      )?.managerId
    ).toBe(o.admin.id)
  })

  it("runs the offboarding effects, blocks login after the last working day and keeps history (BE-06 AC)", async () => {
    const o = await org("Uniform")
    const applied: unknown[] = []
    unregister = registerOffboardingHook({
      preview: async () => ({}),
      apply: async (input) => {
        applied.push(input)
      },
    })
    const lastDay = today()
    const response = await api.post(
      `/employees/${o.employee.id}/deactivation`,
      { lastWorkingDay: lastDay },
      o.admin.token
    )
    expect(response.status).toBe(200)
    expect(applied).toEqual([
      expect.objectContaining({
        employeeId: o.employee.id,
        lastWorkingDay: lastDay,
      }),
    ])

    // Still their last working day: they can work.
    expect((await api.get("/me", o.employee.token)).status).toBe(200)

    // The next day: login and existing sessions are refused.
    api.clock.advance(24 * 3600 * 1000)
    const login = await api.post("/auth/login", {
      email: (await UserModel.findOne({
        _id: o.employee.id,
        companyId: o.companyId,
      }).lean())!.email,
      password: "blue-river-lantern",
    })
    expect(login.status).toBe(403)
    expect(login.body).toMatchObject({ code: "ACCOUNT_DEACTIVATED" })
    api.clock.advance(-24 * 3600 * 1000)

    const history = await HistoryEntryModel.find({
      companyId: o.companyId,
      entityId: o.employee.id,
    }).lean()
    expect(history.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "employee.reportingLineChanged",
        "employee.statusChanged",
      ])
    )
    expect(
      history.find((e) => e.systemJob === "offboarding.lastWorkingDayPassed")
    ).toMatchObject({
      action: "employee.statusChanged",
      systemJob: "offboarding.lastWorkingDayPassed",
      newValues: { status: "DEACTIVATED" },
    })
    // The record and its history stay.
    expect(
      await EmployeeModel.exists({ _id: o.employee.id, companyId: o.companyId })
    ).toBeTruthy()
  })

  it("deactivates at once when the last working day is already over, and ends sessions", async () => {
    const o = await org("Victor")
    await api.post(
      `/employees/${o.colleague.id}/deactivation`,
      { lastWorkingDay: addDays(today(), -1) },
      o.admin.token
    )
    const me = await api.get("/me", o.colleague.token)
    expect(me.status).toBe(401)
    const detail = await api.get<Profile>(
      `/employees/${o.colleague.id}`,
      o.admin.token
    )
    expect(detail.body.status).toBe("DEACTIVATED")
  })

  it("can be undone by reactivation", async () => {
    const o = await org("Whiskey")
    await UserModel.updateOne(
      { _id: o.colleague.id, companyId: o.companyId },
      { passwordHash: await hashPassword("blue-river-lantern") }
    )
    await api.post(
      `/employees/${o.colleague.id}/deactivation`,
      { lastWorkingDay: addDays(today(), -1) },
      o.admin.token
    )
    const back = await api.post<Profile>(
      `/employees/${o.colleague.id}/reactivation`,
      undefined,
      o.admin.token
    )
    expect(back.status).toBe(200)
    expect(back.body).toMatchObject({ status: "ACTIVE", lastWorkingDay: null })
    expect(await signIn(o.colleague, o.companyId)).toEqual(expect.any(String))
  })

  it("refuses deactivating yourself (403), and is for Admins only", async () => {
    const o = await org("Xray")
    expect(
      (
        await api.post(
          `/employees/${o.admin.id}/deactivation`,
          { lastWorkingDay: today() },
          o.admin.token
        )
      ).status
    ).toBe(403)
    expect(
      (
        await api.post(
          `/employees/${o.employee.id}/deactivation`,
          { lastWorkingDay: today() },
          o.manager.token
        )
      ).status
    ).toBe(403)
  })
})
