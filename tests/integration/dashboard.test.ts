import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"

import { runLeaveRollover } from "../../src/modules/leave/rollover-job.ts"
import { UserModel } from "../../src/modules/identity/user.model.ts"
import { EmployeeModel } from "../../src/modules/organization/employee.model.ts"
import { useApi, type Tokens } from "./api.ts"
import { useTestDatabase } from "./database.ts"
import { newCompany, type Member } from "./people.ts"

/** Dashboard summaries (Trello BE-13). */
useTestDatabase()
const api = useApi()
const silent = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  child: () => silent,
} as never

type Buckets = Record<
  | "present"
  | "late"
  | "absent"
  | "wfh"
  | "onLeave"
  | "businessTrip"
  | "notYetCheckedIn",
  number
>
type Today = {
  working: boolean
  expected: number
  counts: Buckets
  people?: Record<string, { id: string; name: string }[]>
}

const travelTo = (instant: string) =>
  api.clock.advance(new Date(instant).getTime() - api.clock.now().getTime())

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

/**
 * Monday 12 October 2026 in Dubai, work from 09:00, no grace, every day a
 * working day. Admin ── M ── e1, e2, e3; Admin ── e4, e5; e6 untracked.
 */
async function org(name: string) {
  travelTo("2026-10-12T04:00:00Z") // 08:00
  const c = await newCompany(api, name)
  const m = await c.add("MANAGER", c.admin.id)
  const e1 = await c.add("EMPLOYEE", m.id)
  const e2 = await c.add("EMPLOYEE", m.id)
  const e3 = await c.add("EMPLOYEE", m.id)
  const e4 = await c.add("EMPLOYEE", c.admin.id)
  const e5 = await c.add("EMPLOYEE", c.admin.id)
  const e6 = await c.add("EMPLOYEE", c.admin.id)
  await api.patch(
    "/company/settings",
    {
      workingDays: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"],
      workStartTime: "09:00",
      lateGraceMinutes: 0,
    },
    c.admin.token
  )
  await api.patch(
    `/employees/${e6.id}`,
    { tracksAttendance: false },
    c.admin.token
  )
  const sick = (
    await api.get<{ items: { id: string; name: string }[] }>(
      "/leave/types",
      c.admin.token
    )
  ).body.items.find((t) => t.name === "Sick")!.id
  const record = (who: Member, body: Record<string, unknown>) =>
    api.post(
      "/requests",
      { employeeId: who.id, approved: true, ...body },
      c.admin.token
    )
  await record(e3, { type: "WFH", startDate: "2026-10-12" })
  await record(e4, {
    type: "LEAVE",
    startDate: "2026-10-12",
    endDate: "2026-10-12",
    reason: "Flu",
    data: { leaveTypeId: sick },
  })
  await record(e5, {
    type: "BUSINESS_TRIP",
    startDate: "2026-10-12",
    data: { destination: "Doha", purpose: "Expo" },
  })

  travelTo("2026-10-12T04:30:00Z") // 08:30: e1 on time
  await relogin(e1, c.companyId)
  await api.post("/attendance/check-in", undefined, e1.token)
  travelTo("2026-10-12T05:30:00Z") // 09:30: e2 late
  await relogin(e2, c.companyId)
  await api.post("/attendance/check-in", undefined, e2.token)
  for (const member of [c.admin, m, e1, e2, e3, e4, e5, e6])
    await relogin(member, c.companyId)
  return { ...c, m, e1, e2, e3, e4, e5, e6, sick }
}

const sum = (counts: Buckets) =>
  Object.values(counts).reduce((a, b) => a + b, 0)

describe("HR / Admin summary", () => {
  it("today's buckets add up to the active tracked employees (BE-13 AC)", async () => {
    const o = await org("Alpha")
    const summary = await api.get<{ companyToday: Today }>(
      "/dashboard/admin",
      o.admin.token
    )
    expect(summary.status).toBe(200)
    expect(summary.body.companyToday).toEqual({
      working: true,
      // Admin, M and e1–e5; e6 isn't tracked.
      expected: 7,
      counts: {
        present: 1,
        late: 1,
        absent: 0,
        wfh: 1,
        onLeave: 1,
        businessTrip: 1,
        notYetCheckedIn: 2,
      },
    })
    expect(sum(summary.body.companyToday.counts)).toBe(
      summary.body.companyToday.expected
    )
  })

  it("moves an employee from 'not yet checked in' to Present or Late when they check in (BE-13 AC)", async () => {
    const o = await org("Bravo")
    const counts = async () =>
      (
        await api.get<{ companyToday: Today }>(
          "/dashboard/admin",
          o.admin.token
        )
      ).body.companyToday.counts
    expect((await counts()).notYetCheckedIn).toBe(2)
    await api.post("/attendance/check-in", undefined, o.m.token) // 09:30: late
    expect(await counts()).toMatchObject({ notYetCheckedIn: 1, late: 2 })
  })

  it("matches the attendance day view for the same day (BE-13 AC)", async () => {
    const o = await org("Charlie")
    const dashboard = (
      await api.get<{ companyToday: Today }>("/dashboard/admin", o.admin.token)
    ).body.companyToday
    const view = await api.get<{
      items: { employee: { id: string }; days: { status: string | null }[] }[]
    }>("/attendance/days?date=2026-10-12&pageSize=100", o.admin.token)
    const tracked = view.body.items.filter((i) => i.employee.id !== o.e6.id)
    const statusCount = (status: string | null) =>
      tracked.filter((i) => i.days[0]!.status === status).length
    expect(dashboard.counts).toEqual({
      present: statusCount("PRESENT"),
      late: statusCount("LATE"),
      absent: statusCount("ABSENT"),
      wfh: statusCount("WFH"),
      onLeave: statusCount("ON_LEAVE"),
      businessTrip: statusCount("BUSINESS_TRIP"),
      notYetCheckedIn: statusCount(null),
    })
  })

  it("lists pending requests by type and flags those older than 3 days", async () => {
    const o = await org("Delta")
    travelTo("2026-10-08T06:00:00Z") // 4 days earlier
    await relogin(o.e1, o.companyId)
    await api.post(
      "/requests",
      { type: "WFH", startDate: "2026-10-20" },
      o.e1.token
    )
    travelTo("2026-10-12T06:00:00Z")
    await relogin(o.e2, o.companyId)
    await api.post(
      "/requests",
      { type: "WFH", startDate: "2026-10-21" },
      o.e2.token
    )
    await relogin(o.admin, o.companyId)
    const summary = await api.get<{
      pendingRequests: {
        type: string
        count: number
        overdue: number
        oldestAgeDays: number
      }[]
    }>("/dashboard/admin", o.admin.token)
    expect(summary.body.pendingRequests).toEqual([
      expect.objectContaining({
        type: "WFH",
        count: 2,
        overdue: 1,
        oldestAgeDays: 4,
      }),
    ])
  })

  it("reports leave usage per type, this month's exceptions and a 30-day trend", async () => {
    const o = await org("Echo")
    await runLeaveRollover({ clock: api.clock, logger: silent })
    const summary = await api.get<{
      leaveUsage: {
        year: number
        items: { leaveType: { name: string }; entitled: number; used: number }[]
      }
      attendanceTrend: { date: string; working: boolean }[]
      exceptionsThisMonth: { missingCheckouts: number; absences: number }
    }>("/dashboard/admin", o.admin.token)
    const sick = summary.body.leaveUsage.items.find(
      (i) => i.leaveType.name === "Sick"
    )!
    // 8 people × 30 days of Sick leave; e4's sick day is today (upcoming, not used yet).
    expect(sick).toMatchObject({ entitled: 240, used: 0 })
    expect(summary.body.attendanceTrend).toHaveLength(30)
    expect(summary.body.attendanceTrend.at(-1)!.date).toBe("2026-10-11")
    expect(summary.body.exceptionsThisMonth).toEqual({
      missingCheckouts: 0,
      absences: expect.any(Number),
    })
  })

  it("is refused to Employees and Managers (403) (BE-13 AC)", async () => {
    const o = await org("Foxtrot")
    expect((await api.get("/dashboard/admin", o.e1.token)).status).toBe(403)
    expect((await api.get("/dashboard/admin", o.m.token)).status).toBe(403)
  })
})

describe("Manager summary", () => {
  it("covers direct reports only, with names (BE-13 AC)", async () => {
    const o = await org("Golf")
    await relogin(o.e1, o.companyId)
    await api.post(
      "/requests",
      { type: "WFH", startDate: "2026-10-20" },
      o.e1.token
    )
    const summary = await api.get<{
      pendingApprovals: { total: number }
      teamToday: Today
      teamOutNext14Days: { employee: { id: string }; type: string }[]
    }>("/dashboard/manager", o.m.token)
    expect(summary.status).toBe(200)
    expect(summary.body.teamToday).toMatchObject({
      expected: 3,
      counts: {
        present: 1,
        late: 1,
        wfh: 1,
        onLeave: 0,
        businessTrip: 0,
        notYetCheckedIn: 0,
      },
      people: {
        present: [{ id: o.e1.id, name: o.e1.name }],
        late: [{ id: o.e2.id, name: o.e2.name }],
        wfh: [{ id: o.e3.id, name: o.e3.name }],
      },
    })
    expect(summary.body.pendingApprovals.total).toBe(1)
    expect(summary.body.teamOutNext14Days.map((r) => r.employee.id)).toEqual([
      o.e3.id,
    ])
    expect((await api.get("/dashboard/manager", o.e1.token)).status).toBe(403)
  })
})

describe("Employee summary", () => {
  it("shows my day, balances, pending requests, upcoming time off and recent activity", async () => {
    const o = await org("Hotel")
    travelTo("2026-10-12T06:30:00Z") // an hour after e2's 09:30 check-in
    await relogin(o.e2, o.companyId)
    await api.post(
      "/requests",
      { type: "WFH", startDate: "2026-10-25" },
      o.e2.token
    )
    const summary = await api.get<{
      today: { status: string; workedMinutes: number; openSession: unknown }
      balances: { leaveType: { name: string }; available: number }[]
      pendingRequests: { total: number }
      upcoming: unknown[]
      recentActivity: { action: string }[]
    }>("/dashboard/employee", o.e2.token)
    expect(summary.body.today).toMatchObject({
      status: "LATE",
      workedMinutes: 60,
    })
    expect(summary.body.today.openSession).not.toBeNull()
    expect(summary.body.balances.map((b) => b.leaveType.name)).toEqual([
      "Annual",
      "Emergency",
      "Sick",
    ])
    expect(summary.body.pendingRequests.total).toBe(1)
    expect(summary.body.recentActivity.map((a) => a.action)).toEqual(
      expect.arrayContaining(["request.statusChanged", "attendance.recorded"])
    )
  })
})

describe("speed", () => {
  it("answers each summary in under a second for 300 employees (BE-13 AC)", async () => {
    const o = await org("Big Co")
    const employees = Array.from({ length: 293 }, () => randomUUID())
    await UserModel.insertMany(
      employees.map((id, i) => ({
        _id: id,
        companyId: o.companyId,
        email: `bulk${i}.${Date.now()}@big.example`,
        role: "EMPLOYEE",
        status: "ACTIVE",
      }))
    )
    await EmployeeModel.insertMany(
      employees.map((id, i) => ({
        _id: id,
        companyId: o.companyId,
        name: `Employee ${i}`,
        managerId: i % 2 ? o.m.id : o.admin.id,
      }))
    )
    for (const path of [
      "/dashboard/admin",
      "/dashboard/manager",
      "/dashboard/employee",
    ]) {
      const member = path.endsWith("admin")
        ? o.admin
        : path.endsWith("manager")
          ? o.m
          : o.e1
      await api.get(path, member.token) // warm up
      const started = performance.now()
      const response = await api.get<{ companyToday?: Today }>(
        path,
        member.token
      )
      const took = performance.now() - started
      expect(response.status).toBe(200)
      expect(took, `${path} took ${Math.round(took)} ms`).toBeLessThan(1000)
    }
    const admin = await api.get<{ companyToday: Today }>(
      "/dashboard/admin",
      o.admin.token
    )
    expect(admin.body.companyToday.expected).toBe(300)
  })
})
