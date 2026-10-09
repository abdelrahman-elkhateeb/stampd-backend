import { describe, expect, it } from "vitest"

import {
  HistoryEntryModel,
  HistoryImmutableError,
} from "../../src/modules/history/history.model.ts"
import {
  recordHistory,
  type RecordHistoryInput,
} from "../../src/modules/history/history.service.ts"
import { issueInvitation } from "../../src/modules/identity/auth.service.ts"
import { hashPassword } from "../../src/modules/identity/passwords.ts"
import { UserModel, type Role } from "../../src/modules/identity/user.model.ts"
import { EmployeeModel } from "../../src/modules/organization/employee.model.ts"
import {
  createEmployee,
  setReportingLine,
} from "../../src/modules/organization/organization.service.ts"
import { withTransaction } from "../../src/platform/db/connection.ts"
import { signupBody, useApi, type Tokens } from "./api.ts"
import { useTestDatabase } from "./database.ts"

/** History (Trello BE-04): append-only entries, written with the change, read per record. */
useTestDatabase()
const api = useApi()
const deps = { clock: api.clock }

type Member = { id: string; token: string }
type Page = {
  items: {
    id: string
    action: string
    at: string
    actor: Record<string, unknown>
    source: string
    oldValues: Record<string, unknown>
    newValues: Record<string, unknown>
    reason: string | null
  }[]
  meta: {
    page: number
    pageSize: number
    totalItems: number
    totalPages: number
  }
}

let emails = 0
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

  async function add(role: Role, managerId?: string): Promise<Member> {
    emails += 1
    const email = `history${emails}.${Date.now()}@acme.example`
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
    if (managerId) {
      await setReportingLine(
        {
          id: user!._id,
          companyId,
          managerId,
          changedBy: { type: "USER", userId: admin.id },
        },
        deps
      )
    }
    const login = await api.post<Tokens>("/auth/login", {
      email,
      password: "blue-river-lantern",
    })
    return { id: user!._id, token: login.body.accessToken }
  }

  const manager = await add("MANAGER", admin.id)
  const employee = await add("EMPLOYEE", manager.id)
  const colleague = await add("EMPLOYEE", admin.id)
  return { companyId, admin, manager, employee, colleague }
}

/** An attendance-day change for `employeeId`, as BE-07/BE-08 will record it. */
function attendanceChange(
  companyId: string,
  employeeId: string,
  dayId: string,
  overrides: Partial<RecordHistoryInput> = {}
): RecordHistoryInput {
  return {
    companyId,
    action: "attendance.recorded",
    entityId: dayId,
    subjectEmployeeId: employeeId,
    actor: { type: "USER", userId: employeeId },
    before: {},
    after: { clockIn: "08:02" },
    ...overrides,
  }
}

const countFor = (companyId: string, entityId: string) =>
  HistoryEntryModel.countDocuments({ companyId, entityId })

describe("recording", () => {
  it("stores exactly one entry with the old and new values when the change commits", async () => {
    const org = await newCompany("Alpha")
    const before = await countFor(org.companyId, org.employee.id)
    api.clock.advance(1000)
    await setReportingLine(
      {
        id: org.employee.id,
        companyId: org.companyId,
        managerId: org.admin.id,
        changedBy: { type: "USER", userId: org.admin.id },
        reason: "team restructure",
      },
      deps
    )

    const entries = await HistoryEntryModel.find({
      companyId: org.companyId,
      entityId: org.employee.id,
    })
      .sort({ at: 1 })
      .lean()
    expect(entries).toHaveLength(before + 1)
    const last = entries.at(-1)!
    expect(last).toMatchObject({
      entityType: "EMPLOYEE",
      subjectEmployeeId: org.employee.id,
      action: "employee.reportingLineChanged",
      actorId: org.admin.id,
      source: "USER",
      oldValues: { managerId: org.manager.id },
      newValues: { managerId: org.admin.id },
      reason: "team restructure",
    })
    expect(last.at).toEqual(api.clock.now())
  })

  it("stores nothing when nothing changed", async () => {
    const org = await newCompany("Bravo")
    const before = await countFor(org.companyId, org.employee.id)
    await setReportingLine(
      {
        id: org.employee.id,
        companyId: org.companyId,
        managerId: org.manager.id,
        changedBy: { type: "USER", userId: org.admin.id },
      },
      deps
    )
    expect(await countFor(org.companyId, org.employee.id)).toBe(before)
  })

  it("keeps no entry (and no change) when the transaction rolls back", async () => {
    const org = await newCompany("Charlie")
    const dayId = crypto.randomUUID()
    await expect(
      withTransaction(async () => {
        await EmployeeModel.updateOne(
          { _id: org.employee.id, companyId: org.companyId },
          { name: "Changed" }
        )
        await recordHistory(
          attendanceChange(org.companyId, org.employee.id, dayId),
          deps
        )
        throw new Error("something later in the change failed")
      })
    ).rejects.toThrow("something later")

    expect(await countFor(org.companyId, dayId)).toBe(0)
    expect(
      (
        await EmployeeModel.findOne({
          _id: org.employee.id,
          companyId: org.companyId,
        }).lean()
      )?.name
    ).not.toBe("Changed")
  })

  it("refuses a change without the required reason (422), and the change rolls back", async () => {
    const org = await newCompany("Delta")
    const dayId = crypto.randomUUID()
    const attempt = withTransaction(async () => {
      await EmployeeModel.updateOne(
        { _id: org.employee.id, companyId: org.companyId },
        { name: "Corrected" }
      )
      await recordHistory(
        attendanceChange(org.companyId, org.employee.id, dayId, {
          action: "attendance.corrected",
          actor: { type: "USER", userId: org.admin.id },
          reason: "  ",
        }),
        deps
      )
    })
    await expect(attempt).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_FAILED",
      fieldErrors: [
        {
          field: "reason",
          code: "REQUIRED",
          message: "a reason is required for this change",
        },
      ],
    })
    expect(await countFor(org.companyId, dayId)).toBe(0)
    expect(
      (
        await EmployeeModel.findOne({
          _id: org.employee.id,
          companyId: org.companyId,
        }).lean()
      )?.name
    ).not.toBe("Corrected")
  })

  it("only works inside a transaction", async () => {
    const org = await newCompany("Echo")
    await expect(
      recordHistory(
        attendanceChange(org.companyId, org.employee.id, crypto.randomUUID()),
        deps
      )
    ).rejects.toThrow(/inside withTransaction/)
  })

  it("records system jobs with actor 'system'", async () => {
    const org = await newCompany("Foxtrot")
    const dayId = crypto.randomUUID()
    await withTransaction(() =>
      recordHistory(
        attendanceChange(org.companyId, org.employee.id, dayId, {
          action: "attendance.closed",
          actor: { type: "SYSTEM", job: "attendance.nightlyClose" },
          before: { status: "OPEN" },
          after: { status: "CLOSED" },
        }),
        deps
      )
    )
    const page = await api.get<Page>(
      `/history/attendance-days/${dayId}`,
      org.admin.token
    )
    expect(page.body.items).toEqual([
      {
        id: expect.any(String),
        action: "attendance.closed",
        at: api.clock.now().toISOString(),
        actor: { type: "SYSTEM", job: "attendance.nightlyClose" },
        source: "SYSTEM_JOB",
        oldValues: { status: "OPEN" },
        newValues: { status: "CLOSED" },
        reason: null,
      },
    ])
  })

  it("records an invited employee becoming active", async () => {
    const org = await newCompany("Golf")
    const [user] = await UserModel.create([
      {
        companyId: org.companyId,
        email: `invitee.${Date.now()}@acme.example`,
        role: "EMPLOYEE",
        status: "INVITED",
      },
    ])
    await createEmployee({
      id: user!._id,
      companyId: org.companyId,
      name: "New",
    })
    const { link } = await issueInvitation(
      { id: user!._id, companyId: org.companyId },
      api.authDeps()
    )
    const accepted = await api.post("/auth/invitations/accept", {
      token: link.split("/").at(-1),
      name: "Nadia Fares",
      password: "blue-river-lantern",
    })
    expect(accepted.status).toBe(200)

    const page = await api.get<Page>(
      `/history/employees/${user!._id}`,
      org.admin.token
    )
    expect(page.body.items[0]).toMatchObject({
      action: "employee.statusChanged",
      actor: { type: "USER", id: user!._id, name: "Nadia Fares" },
      oldValues: { status: "INVITED" },
      newValues: { status: "ACTIVE" },
    })
  })
})

describe("append-only", () => {
  it("refuses every edit and delete at the database layer", async () => {
    const org = await newCompany("Hotel")
    const dayId = crypto.randomUUID()
    await withTransaction(() =>
      recordHistory(
        attendanceChange(org.companyId, org.employee.id, dayId),
        deps
      )
    )
    const scope = { companyId: org.companyId, entityId: dayId }

    await expect(
      HistoryEntryModel.updateOne(scope, { reason: "x" })
    ).rejects.toThrow(HistoryImmutableError)
    await expect(
      HistoryEntryModel.updateMany(scope, { reason: "x" })
    ).rejects.toThrow(HistoryImmutableError)
    await expect(
      HistoryEntryModel.findOneAndUpdate(scope, { reason: "x" })
    ).rejects.toThrow(HistoryImmutableError)
    await expect(
      HistoryEntryModel.replaceOne(scope, { action: "x" })
    ).rejects.toThrow(HistoryImmutableError)
    await expect(HistoryEntryModel.deleteOne(scope)).rejects.toThrow(
      HistoryImmutableError
    )
    await expect(HistoryEntryModel.deleteMany(scope)).rejects.toThrow(
      HistoryImmutableError
    )
    await expect(HistoryEntryModel.findOneAndDelete(scope)).rejects.toThrow(
      HistoryImmutableError
    )
    await expect(
      HistoryEntryModel.bulkWrite([{ deleteOne: { filter: scope } }])
    ).rejects.toThrow(HistoryImmutableError)

    const loaded = await HistoryEntryModel.findOne(scope)
    loaded!.reason = "edited"
    await expect(loaded!.save()).rejects.toThrow(HistoryImmutableError)
    await expect(loaded!.deleteOne()).rejects.toThrow(HistoryImmutableError)

    expect(await HistoryEntryModel.findOne(scope).lean()).toMatchObject({
      reason: null,
    })
  })

  it("has no endpoint to create, edit or delete an entry", async () => {
    const org = await newCompany("India")
    const dayId = crypto.randomUUID()
    await withTransaction(() =>
      recordHistory(
        attendanceChange(org.companyId, org.employee.id, dayId),
        deps
      )
    )
    const [entry] = await HistoryEntryModel.find({
      companyId: org.companyId,
      entityId: dayId,
    }).lean()

    for (const path of [
      `/history/attendance-days/${dayId}`,
      `/history/attendance-days/${dayId}/${entry!._id}`,
      `/history/${entry!._id}`,
    ]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const response = await api.request(method, path, {
          token: org.admin.token,
          body: method === "DELETE" ? undefined : { reason: "x" },
        })
        expect(response.status, `${method} ${path}`).toBe(404)
      }
    }
    expect(await countFor(org.companyId, dayId)).toBe(1)
  })
})

describe("reading a record's history (BE-03 rules)", () => {
  it("returns an Employee their own attendance day's history; another employee's is 404", async () => {
    const org = await newCompany("Juliett")
    const ownDay = crypto.randomUUID()
    const colleagueDay = crypto.randomUUID()
    await withTransaction(async () => {
      await recordHistory(
        attendanceChange(org.companyId, org.employee.id, ownDay),
        deps
      )
      await recordHistory(
        attendanceChange(org.companyId, org.colleague.id, colleagueDay),
        deps
      )
    })

    const own = await api.get<Page>(
      `/history/attendance-days/${ownDay}`,
      org.employee.token
    )
    expect(own.status).toBe(200)
    expect(own.body.items).toHaveLength(1)
    expect(own.body.meta).toEqual({
      page: 1,
      pageSize: 20,
      totalItems: 1,
      totalPages: 1,
    })

    const other = await api.get(
      `/history/attendance-days/${colleagueDay}`,
      org.employee.token
    )
    expect(other.status).toBe(404)
    expect(other.body).toEqual({ code: "NOT_FOUND", message: "Not found" })
  })

  it("gives Managers their direct reports' history and Admins everyone's; other companies get 404", async () => {
    const org = await newCompany("Kilo")
    const other = await newCompany("Lima")
    const day = crypto.randomUUID()
    await withTransaction(() =>
      recordHistory(attendanceChange(org.companyId, org.employee.id, day), deps)
    )
    const path = `/history/attendance-days/${day}`

    expect((await api.get(path, org.manager.token)).status).toBe(200)
    expect((await api.get(path, org.admin.token)).status).toBe(200)
    expect((await api.get(path, org.colleague.token)).status).toBe(404)
    expect((await api.get(path, other.admin.token)).status).toBe(404)
    expect(
      (
        await api.get(
          `/history/employees/${org.employee.id}`,
          other.admin.token
        )
      ).status
    ).toBe(404)
  })

  it("shows an employee record's history to the employee, their manager and the Admin only", async () => {
    const org = await newCompany("Mike")
    const path = `/history/employees/${org.employee.id}`

    const own = await api.get<Page>(path, org.employee.token)
    expect(own.status).toBe(200)
    expect(own.body.items[0]).toMatchObject({
      action: "employee.reportingLineChanged",
      actor: { type: "USER", id: org.admin.id, name: "Mike Admin" },
      source: "USER",
      oldValues: { managerId: null },
      newValues: { managerId: org.manager.id },
    })
    expect((await api.get(path, org.manager.token)).status).toBe(200)
    expect((await api.get(path, org.admin.token)).status).toBe(200)
    expect((await api.get(path, org.colleague.token)).status).toBe(404)
  })

  it("lists newest first, paginated", async () => {
    const org = await newCompany("November")
    const day = crypto.randomUUID()
    for (const clockIn of ["08:00", "08:05", "08:10"]) {
      api.clock.advance(60_000)
      await withTransaction(() =>
        recordHistory(
          attendanceChange(org.companyId, org.employee.id, day, {
            after: { clockIn },
          }),
          deps
        )
      )
    }
    const page = await api.get<Page>(
      `/history/attendance-days/${day}?pageSize=2`,
      org.employee.token
    )
    expect(page.body.items.map((e) => e.newValues.clockIn)).toEqual([
      "08:10",
      "08:05",
    ])
    expect(page.body.meta).toMatchObject({ totalItems: 3, totalPages: 2 })
  })

  it("answers 404 for a record without history, and for another company's settings", async () => {
    const org = await newCompany("Oscar")
    const other = await newCompany("Papa")
    expect(
      (
        await api.get(
          `/history/requests/${crypto.randomUUID()}`,
          org.admin.token
        )
      ).status
    ).toBe(404)

    const ownSettings = await api.get<Page>(
      `/history/company-settings/${org.companyId}`,
      org.employee.token
    )
    expect(ownSettings.status).toBe(200)
    expect(ownSettings.body.items).toEqual([])
    expect(
      (
        await api.get(
          `/history/company-settings/${other.companyId}`,
          org.admin.token
        )
      ).status
    ).toBe(404)
  })

  it("validates the record type and id", async () => {
    const org = await newCompany("Quebec")
    const badType = await api.get(
      `/history/payslips/${crypto.randomUUID()}`,
      org.admin.token
    )
    expect(badType.status).toBe(422)
    expect(
      (await api.get("/history/requests/not-a-uuid", org.admin.token)).status
    ).toBe(422)
    expect(
      (await api.get(`/history/requests/${crypto.randomUUID()}`)).status
    ).toBe(401)
  })
})
