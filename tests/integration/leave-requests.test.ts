import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { registerRequestType } from "../../src/modules/requests/registry.ts"

import { AttendanceDayModel } from "../../src/modules/attendance/attendance.model.ts"
import { runAttendanceClose } from "../../src/modules/attendance/close-job.ts"
import { setEntitlement } from "../../src/modules/leave/balance.service.ts"
import { DepartmentModel } from "../../src/modules/organization/department.model.ts"
import { useApi, type Tokens } from "./api.ts"
import { useTestDatabase } from "./database.ts"
import { newCompany, type Member } from "./people.ts"
import { UserModel } from "../../src/modules/identity/user.model.ts"

/** Leave requests on the request engine (Trello BE-10). */
useTestDatabase()
const api = useApi()
const deps = { clock: api.clock }
const silent = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  child: () => silent,
} as never

type Detail = { id: string; status: string; actions: string[] }
type Balance = {
  leaveType: { name: string }
  available: number | null
  pending: number | null
  upcoming: number | null
}
type Preview = {
  days: number
  workingDays: { date: string; days: number }[]
  excluded: { date: string; reason: string; holiday: string | null }[]
  balance: {
    tracked: boolean
    available: number | null
    availableAfter: number | null
  } | null
  problems: { code: string; field: string | null; message: string }[]
  conflicts: unknown[]
  teamOff: { employeeId: string; name: string; startDate?: string }[]
}

const travelTo = (instant: string) =>
  api.clock.advance(new Date(instant).getTime() - api.clock.now().getTime())

/** Monday 12 October 2026, 10:00 in Dubai. Sun–Thu working week. */
async function org(name: string) {
  travelTo("2026-10-12T06:00:00Z")
  const company = await newCompany(api, name)
  const manager = await company.add("MANAGER", company.admin.id)
  const employee = await company.add("EMPLOYEE", manager.id)
  const colleague = await company.add("EMPLOYEE", manager.id)
  const types = (
    await api.get<{ items: { id: string; name: string }[] }>(
      "/leave/types",
      company.admin.token
    )
  ).body.items
  const typeId = (n: string) => types.find((t) => t.name === n)!.id
  return { ...company, manager, employee, colleague, typeId }
}

const leave = (
  member: Member,
  typeId: string,
  body: Record<string, unknown> = {}
) => {
  const { data, ...rest } = body as { data?: Record<string, unknown> }
  return api.post<Detail>(
    "/requests",
    {
      type: "LEAVE",
      startDate: "2026-11-01",
      endDate: "2026-11-03",
      ...rest,
      data: { leaveTypeId: typeId, ...data },
    },
    member.token
  )
}
const preview = (member: Member, body: Record<string, unknown>) =>
  api.post<Preview>("/leave/requests/preview", body, member.token)
const annualOf = async (member: Member, employeeId: string) =>
  (
    await api.get<{ items: Balance[] }>(
      `/leave/employees/${employeeId}/balances`,
      member.token
    )
  ).body.items.find((b) => b.leaveType.name === "Annual")!

async function relogin(member: Member, companyId: string) {
  const user = await UserModel.findOne(
    { _id: member.id, companyId },
    { email: 1 }
  ).lean()
  member.token = (
    await api.post<Tokens>("/auth/login", {
      email: user!.email,
      password: "blue-river-lantern",
    })
  ).body.accessToken
}

describe("balance and overlap", () => {
  it("refuses 3 days when 2 are available, saying so (BE-10 AC)", async () => {
    const o = await org("Alpha")
    await setEntitlement(
      {
        companyId: o.companyId,
        employeeId: o.employee.id,
        leaveTypeId: o.typeId("Annual"),
        days: 2,
        actor: { type: "USER", userId: o.admin.id },
      },
      deps
    )
    const refused = await leave(o.employee, o.typeId("Annual")) // Sun 1 – Tue 3 November
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({
      code: "INSUFFICIENT_BALANCE",
      message: "Only 2 day(s) available",
    })
    expect((await annualOf(o.employee, o.employee.id)).available).toBe(2)
  })

  it("refuses leave overlapping the employee's own approved leave (BE-10 AC)", async () => {
    const o = await org("Bravo")
    const first = await leave(o.employee, o.typeId("Annual"), {
      startDate: "2026-11-10",
      endDate: "2026-11-12",
    })
    await api.post(`/requests/${first.body.id}/approve`, {}, o.manager.token)
    const overlapping = await leave(o.employee, o.typeId("Annual"), {
      startDate: "2026-11-11",
      endDate: "2026-11-14",
    })
    expect(overlapping.status).toBe(409)
    expect(overlapping.body).toMatchObject({ code: "REQUEST_OVERLAP" })
  })

  it("reserves on submit, releases on reject or withdraw, deducts on approve", async () => {
    const o = await org("Charlie")
    const annual = o.typeId("Annual")
    const a = await leave(o.employee, annual)
    expect(a.status).toBe(201)
    expect(await annualOf(o.employee, o.employee.id)).toMatchObject({
      available: 18,
      pending: 3,
    })
    await api.post(
      `/requests/${a.body.id}/reject`,
      { reason: "Busy week" },
      o.manager.token
    )
    expect(await annualOf(o.employee, o.employee.id)).toMatchObject({
      available: 21,
      pending: 0,
    })

    const b = await leave(o.employee, annual)
    await api.post(`/requests/${b.body.id}/withdraw`, {}, o.employee.token)
    expect((await annualOf(o.employee, o.employee.id)).available).toBe(21)

    const c = await leave(o.employee, annual)
    await api.post(`/requests/${c.body.id}/approve`, {}, o.manager.token)
    expect(await annualOf(o.employee, o.employee.id)).toMatchObject({
      available: 18,
      pending: 0,
      upcoming: 3,
    })
  })

  it("never limits an untracked type (Unpaid)", async () => {
    const o = await org("Delta")
    const long = await leave(o.employee, o.typeId("Unpaid"), {
      startDate: "2026-11-01",
      endDate: "2026-12-31",
      reason: "Family matters",
    })
    expect(long.status).toBe(201)
  })
})

describe("WFH and business trips on the same days", () => {
  // Stand-ins until BE-11 registers the real WFH and BUSINESS_TRIP types.
  let undo: (() => void)[] = []
  beforeAll(() => {
    undo = ["WFH", "BUSINESS_TRIP"].map((key) =>
      registerRequestType({
        key,
        label: key,
        approverPolicy: "MANAGER_WITH_ADMIN_FALLBACK",
        dates: "RANGE",
        times: "NONE",
        reason: "OPTIONAL",
        data: z.object({}),
        colleagueVisibility: "HIDDEN",
      })
    )
  })
  afterAll(() => undo.forEach((u) => u()))

  it("block the leave, pending or approved, with a message to withdraw or cancel them first", async () => {
    const o = await org("Echo-2")
    const wfh = await api.post<Detail>(
      "/requests",
      { type: "WFH", startDate: "2026-11-02", endDate: "2026-11-02" },
      o.employee.token
    )
    expect(wfh.status).toBe(201)
    const trip = await api.post<Detail>(
      "/requests",
      { type: "BUSINESS_TRIP", startDate: "2026-11-15", endDate: "2026-11-16" },
      o.employee.token
    )
    await api.post(`/requests/${trip.body.id}/approve`, {}, o.manager.token)

    const onWfh = await leave(o.employee, o.typeId("Annual"), {
      startDate: "2026-11-01",
      endDate: "2026-11-03",
    })
    expect(onWfh.status).toBe(409)
    expect(onWfh.body).toMatchObject({
      code: "REQUEST_OVERLAP",
      message:
        "You have a WFH request from 2026-11-02 to 2026-11-02 on these days; withdraw or cancel it first",
    })
    const onTrip = await leave(o.employee, o.typeId("Annual"), {
      startDate: "2026-11-16",
      endDate: "2026-11-17",
    })
    expect(onTrip.body).toMatchObject({
      code: "REQUEST_OVERLAP",
      message: expect.stringContaining("business trip"),
    })

    const shown = await preview(o.employee, {
      leaveTypeId: o.typeId("Annual"),
      startDate: "2026-11-01",
      endDate: "2026-11-03",
    })
    expect(shown.body.problems).toEqual([
      expect.objectContaining({
        code: "REQUEST_OVERLAP",
        message: expect.stringContaining("WFH"),
      }),
    ])
    expect(shown.body.conflicts).toEqual([
      expect.objectContaining({ requestId: wfh.body.id, type: "WFH" }),
    ])

    // Once the WFH request is withdrawn, the leave goes through.
    await api.post(`/requests/${wfh.body.id}/withdraw`, {}, o.employee.token)
    expect(
      (
        await leave(o.employee, o.typeId("Annual"), {
          startDate: "2026-11-01",
          endDate: "2026-11-03",
        })
      ).status
    ).toBe(201)
  })
})

describe("counting days", () => {
  it("Mon–Fri with a Wednesday holiday: 4 days, the holiday listed as excluded (BE-10 AC)", async () => {
    const o = await org("Echo")
    await api.patch(
      "/company/settings",
      { workingDays: ["MON", "TUE", "WED", "THU", "FRI"] },
      o.admin.token
    )
    await api.post(
      "/company/holidays",
      { name: "Founding Day", startDate: "2026-11-04", endDate: "2026-11-04" },
      o.admin.token
    )
    const result = await preview(o.employee, {
      leaveTypeId: o.typeId("Annual"),
      startDate: "2026-11-02",
      endDate: "2026-11-06",
    })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      days: 4,
      excluded: [
        { date: "2026-11-04", reason: "HOLIDAY", holiday: "Founding Day" },
      ],
      balance: { tracked: true, available: 21, availableAfter: 17 },
      problems: [],
    })
    expect(result.body.workingDays.map((d) => d.date)).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-05",
      "2026-11-06",
    ])
  })

  it("counts a single morning half day as 0.5 (BE-10 AC)", async () => {
    const o = await org("Foxtrot")
    const body = {
      startDate: "2026-11-02",
      endDate: "2026-11-02",
      data: { firstDayHalf: "MORNING" },
    }
    expect(
      (
        await preview(o.employee, {
          leaveTypeId: o.typeId("Annual"),
          startDate: "2026-11-02",
          firstDayHalf: "MORNING",
        })
      ).body.days
    ).toBe(0.5)
    expect((await leave(o.employee, o.typeId("Annual"), body)).status).toBe(201)
    expect(await annualOf(o.employee, o.employee.id)).toMatchObject({
      pending: 0.5,
      available: 20.5,
    })
  })

  it("refuses a range with no working days (BE-10 AC)", async () => {
    const o = await org("Golf")
    const weekend = await leave(o.employee, o.typeId("Annual"), {
      startDate: "2026-11-06",
      endDate: "2026-11-07",
    })
    expect(weekend.status).toBe(422)
    expect(weekend.body).toMatchObject({
      fieldErrors: [{ field: "endDate", code: "NO_WORKING_DAYS" }],
    })
  })

  it("checks half days, leave years and the reason a type requires", async () => {
    const o = await org("Hotel")
    const annual = o.typeId("Annual")
    const badHalves = await leave(o.employee, annual, {
      data: { firstDayHalf: "MORNING", lastDayHalf: "AFTERNOON" },
    })
    expect(
      (
        badHalves.body as unknown as { fieldErrors: { field: string }[] }
      ).fieldErrors
        .map((e) => e.field)
        .sort()
    ).toEqual(["data.firstDayHalf", "data.lastDayHalf"])

    const twoYears = await leave(o.employee, annual, {
      startDate: "2026-12-28",
      endDate: "2027-01-05",
    })
    expect(twoYears.body).toMatchObject({
      fieldErrors: [{ field: "endDate", code: "CROSSES_LEAVE_YEAR" }],
    })

    const sickNoReason = await leave(o.employee, o.typeId("Sick"))
    expect(sickNoReason.body).toMatchObject({
      fieldErrors: [{ field: "reason", code: "REQUIRED" }],
    })
  })
})

describe("date limits", () => {
  it("refuses an employee's sick leave from 40 days ago; an Admin can record it (BE-10 AC)", async () => {
    const o = await org("India")
    const old = {
      startDate: "2026-09-02",
      endDate: "2026-09-02",
      reason: "Flu",
    }
    const byEmployee = await leave(o.employee, o.typeId("Sick"), old)
    expect(byEmployee.status).toBe(422)
    expect(byEmployee.body).toMatchObject({
      fieldErrors: [{ field: "startDate", code: "OUT_OF_RANGE" }],
    })

    const byAdmin = await leave(o.admin, o.typeId("Sick"), {
      ...old,
      employeeId: o.employee.id,
      approved: true,
    })
    expect(byAdmin.status).toBe(201)
    expect(byAdmin.body.status).toBe("APPROVED")
  })
})

describe("attendance", () => {
  it("shows approved leave as On Leave, and recalculates when it is cancelled (BE-10 AC)", async () => {
    const o = await org("Juliett")
    const request = await leave(o.employee, o.typeId("Annual"), {
      startDate: "2026-11-01",
      endDate: "2026-11-03",
    })
    await api.post(`/requests/${request.body.id}/approve`, {}, o.manager.token)
    const days = async () =>
      (
        await api.get<{ items: { days: { status: string | null }[] }[] }>(
          `/attendance/days?date=2026-11-02&employeeId=${o.employee.id}`,
          o.admin.token
        )
      ).body.items[0]!.days[0]!.status
    expect(await days()).toBe("ON_LEAVE")

    await api.post(
      `/requests/${request.body.id}/cancel`,
      { reason: "Project deadline" },
      o.admin.token
    )
    expect(await days()).toBeNull()
    expect(await annualOf(o.employee, o.employee.id)).toMatchObject({
      available: 21,
      upcoming: 0,
    })
  })

  it("turns a past day closed as Absent into On Leave when leave is recorded for it", async () => {
    const o = await org("Kilo")
    travelTo("2026-10-12T20:30:00Z") // after midnight in Dubai: Monday the 12th closes
    await runAttendanceClose({ clock: api.clock, logger: silent })
    const stored = () =>
      AttendanceDayModel.findOne({
        companyId: o.companyId,
        employeeId: o.employee.id,
        date: "2026-10-12",
      }).lean()
    expect((await stored())?.status).toBe("ABSENT")

    await relogin(o.admin, o.companyId)
    const recorded = await leave(o.admin, o.typeId("Sick"), {
      employeeId: o.employee.id,
      approved: true,
      startDate: "2026-10-12",
      endDate: "2026-10-12",
      reason: "Fever",
    })
    expect(recorded.status).toBe(201)
    expect((await stored())?.status).toBe("ON_LEAVE")
  })
})

describe("who else is off (privacy)", () => {
  it("shows an Employee same-department colleagues by name only; Managers see their reports' dates", async () => {
    const o = await org("Lima")
    const dept = await DepartmentModel.create({
      companyId: o.companyId,
      name: "Ops",
      nameKey: "ops",
    })
    for (const member of [o.employee, o.colleague]) {
      await api.patch(
        `/employees/${member.id}`,
        { departmentId: dept._id },
        o.admin.token
      )
    }
    const away = await leave(o.colleague, o.typeId("Annual"), {
      startDate: "2026-11-02",
      endDate: "2026-11-03",
    })
    await api.post(`/requests/${away.body.id}/approve`, {}, o.manager.token)

    const asEmployee = await preview(o.employee, {
      leaveTypeId: o.typeId("Annual"),
      startDate: "2026-11-01",
      endDate: "2026-11-05",
    })
    expect(asEmployee.body.teamOff).toEqual([
      { employeeId: o.colleague.id, name: o.colleague.name },
    ])

    const asManager = await preview(o.manager, {
      leaveTypeId: o.typeId("Annual"),
      startDate: "2026-11-01",
      endDate: "2026-11-05",
    })
    expect(asManager.body.teamOff).toEqual([
      {
        employeeId: o.colleague.id,
        name: o.colleague.name,
        startDate: "2026-11-02",
        endDate: "2026-11-03",
      },
    ])

    // Someone in another department sees nothing.
    const outsider = await o.add("EMPLOYEE", o.admin.id)
    const asOutsider = await preview(outsider, {
      leaveTypeId: o.typeId("Annual"),
      startDate: "2026-11-01",
      endDate: "2026-11-05",
    })
    expect(asOutsider.body.teamOff).toEqual([])
  })
})

describe("leave history", () => {
  it("lists an employee's leave requests for them, their manager and Admins only", async () => {
    const o = await org("Mike")
    const a = await leave(o.employee, o.typeId("Annual"))
    await api.post(`/requests/${a.body.id}/approve`, {}, o.manager.token)
    await leave(o.employee, o.typeId("Annual"), {
      startDate: "2026-11-15",
      endDate: "2026-11-16",
    })
    const path = `/leave/employees/${o.employee.id}/requests`
    const own = await api.get<{ items: { status: string }[] }>(
      path,
      o.employee.token
    )
    expect(own.body.items.map((r) => r.status).sort()).toEqual([
      "APPROVED",
      "PENDING",
    ])
    expect((await api.get(path, o.manager.token)).status).toBe(200)
    expect((await api.get(path, o.colleague.token)).status).toBe(404)
  })
})
