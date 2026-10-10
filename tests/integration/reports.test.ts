import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"

import { UserModel } from "../../src/modules/identity/user.model.ts"
import { EmployeeModel } from "../../src/modules/organization/employee.model.ts"
import { parseCsv } from "../../src/platform/csv.ts"
import { useApi, type Tokens } from "./api.ts"
import { useTestDatabase } from "./database.ts"
import { newCompany, type Member } from "./people.ts"

/** Reports and CSV export (Trello BE-14). */
useTestDatabase()
const api = useApi()

type Row = Record<string, unknown> & {
  employee: { id: string; name: string; employeeCode: string | null }
}
type Page = {
  from?: string
  to?: string
  scope: string
  timezone: string
  totals?: Record<string, number>
  items: Row[]
  meta: {
    page: number
    pageSize: number
    totalItems: number
    totalPages: number
  }
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

/** A CSV download: status, headers, and the rows parsed back. */
async function csv(path: string, token: string) {
  const response = await fetch(`${api.url()}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const bytes = new Uint8Array(await response.arrayBuffer())
  // Keep the byte-order mark (text() would drop it).
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)
  return {
    status: response.status,
    headers: response.headers,
    text,
    rows: response.ok ? parseCsv(text).map((r) => r.cells) : [],
  }
}

/**
 * Dubai, Sunday–Thursday, work from 09:00 with no grace. March 2026 has 23
 * working days (1 March is a Sunday). Admin ── M ── e1, e2; Admin ── e3.
 *
 *  2 Mar  e1 in 08:30–17:00 (Present), e2 in 09:30–17:30 (Late)
 *  3 Mar  e2 forgot: the Admin adds 09:00–17:00 (Present, corrected)
 *  4 Mar  e1 approved WFH, checked in 09:00–11:00
 *  5–8 Mar e2 approved Unpaid leave (Thu 5 and Sun 8: 2 working days)
 *  9 Mar  e3 approved Annual leave
 *  10 Mar e1 Annual leave, still pending
 *  11 Mar e2 WFH, rejected by M
 *  e3's last working day is 15 March.
 *  Today is Monday 20 April.
 */
async function org(name: string) {
  travelTo("2026-03-01T04:00:00Z") // Sunday 08:00 in Dubai
  const c = await newCompany(api, name)
  const m = await c.add("MANAGER", c.admin.id)
  const e1 = await c.add("EMPLOYEE", m.id)
  const e2 = await c.add("EMPLOYEE", m.id)
  const e3 = await c.add("EMPLOYEE", c.admin.id)
  await api.patch(
    "/company/settings",
    { workStartTime: "09:00", lateGraceMinutes: 0 },
    c.admin.token
  )
  const types = (
    await api.get<{ items: { id: string; name: string }[] }>(
      "/leave/types",
      c.admin.token
    )
  ).body.items
  const typeId = (n: string) => types.find((t) => t.name === n)!.id
  const record = async (who: Member, body: Record<string, unknown>) => {
    const response = await api.post(
      "/requests",
      { employeeId: who.id, approved: true, ...body },
      c.admin.token
    )
    expect(response.status, JSON.stringify(response.body)).toBe(201)
  }
  await record(e1, { type: "WFH", startDate: "2026-03-04" })
  await record(e2, {
    type: "LEAVE",
    startDate: "2026-03-05",
    endDate: "2026-03-08",
    reason: "Family matter",
    data: { leaveTypeId: typeId("Unpaid") },
  })
  await record(e3, {
    type: "LEAVE",
    startDate: "2026-03-09",
    endDate: "2026-03-09",
    data: { leaveTypeId: typeId("Annual") },
  })
  await relogin(e1, c.companyId)
  await relogin(e2, c.companyId)
  const pending = await api.post(
    "/requests",
    {
      type: "LEAVE",
      startDate: "2026-03-10",
      endDate: "2026-03-10",
      data: { leaveTypeId: typeId("Annual") },
    },
    e1.token
  )
  expect(pending.status).toBe(201)
  const wfh = await api.post<{ id: string }>(
    "/requests",
    { type: "WFH", startDate: "2026-03-11" },
    e2.token
  )
  expect(wfh.status).toBe(201)
  await relogin(m, c.companyId)
  expect(
    (
      await api.post(
        `/requests/${wfh.body.id}/reject`,
        { reason: "Team day" },
        m.token
      )
    ).status
  ).toBe(200)

  const session = async (who: Member, inAt: string, outAt: string) => {
    travelTo(inAt)
    await relogin(who, c.companyId)
    expect(
      (await api.post("/attendance/check-in", undefined, who.token)).status
    ).toBe(201)
    travelTo(outAt)
    await relogin(who, c.companyId)
    expect(
      (await api.post("/attendance/check-out", undefined, who.token)).status
    ).toBe(200)
  }
  await session(e1, "2026-03-02T04:30:00Z", "2026-03-02T13:00:00Z")
  await session(e2, "2026-03-02T05:30:00Z", "2026-03-02T13:30:00Z")
  await session(e1, "2026-03-04T05:00:00Z", "2026-03-04T07:00:00Z")

  travelTo("2026-04-20T06:00:00Z") // Monday 20 April, 10:00
  await relogin(c.admin, c.companyId)
  const corrected = await api.post(
    `/attendance/employees/${e2.id}/days/2026-03-03/sessions`,
    {
      checkInAt: "2026-03-03T05:00:00Z",
      checkOutAt: "2026-03-03T13:00:00Z",
      reason: "Forgot to check in",
    },
    c.admin.token
  )
  expect(corrected.status).toBe(201)
  // Offboarded: last working day 15 March.
  await UserModel.updateOne(
    { _id: e3.id, companyId: c.companyId },
    { $set: { status: "DEACTIVATED", lastWorkingDay: "2026-03-15" } }
  )
  for (const member of [m, e1, e2]) await relogin(member, c.companyId)
  return { ...c, m, e1, e2, e3, typeId }
}

const MARCH = "from=2026-03-01&to=2026-03-31"
const row = (page: Page, member: Member) =>
  page.items.find((r) => r.employee.id === member.id)

const ADDS_UP = [
  "present",
  "late",
  "absent",
  "wfh",
  "onLeave",
  "businessTrip",
  "missingCheckouts",
  "notYetRecorded",
] as const

describe("attendance summary", () => {
  it("has one row per employee active in March, and the CSV matches the screen (BE-14 AC)", async () => {
    const o = await org("Alpha")
    const screen = await api.get<Page>(
      `/reports/attendance/summary?${MARCH}&pageSize=100`,
      o.admin.token
    )
    expect(screen.status).toBe(200)
    expect(screen.body).toMatchObject({
      from: "2026-03-01",
      to: "2026-03-31",
      scope: "company",
      timezone: "Asia/Dubai",
      meta: { totalItems: 5 },
    })
    expect(row(screen.body, o.e1)).toMatchObject({
      workingDays: 23,
      present: 1,
      late: 0,
      wfh: 1,
      absent: 21,
      onLeave: 0,
      unpaidLeaveDays: 0,
      workedMinutes: 630,
      workedHours: 10.5,
      corrections: 0,
    })
    expect(row(screen.body, o.e2)).toMatchObject({
      workingDays: 23,
      present: 1,
      late: 1,
      onLeave: 2,
      unpaidLeaveDays: 2,
      absent: 19,
      workedMinutes: 960,
      workedHours: 16,
      corrections: 1,
    })
    // Deactivated on 15 March: in the March report for the days they worked.
    expect(row(screen.body, o.e3)).toMatchObject({
      workingDays: 11,
      onLeave: 1,
      absent: 10,
    })
    for (const r of screen.body.items) {
      const sum = ADDS_UP.reduce((s, c) => s + (r[c] as number), 0)
      expect(sum, r.employee.name).toBe(r.workingDays)
    }
    expect(screen.body.totals).toMatchObject({
      workingDays: 23 * 4 + 11,
      unpaidLeaveDays: 2,
      corrections: 1,
      workedHours: 26.5,
    })

    const file = await csv(
      `/reports/attendance/summary?${MARCH}&format=csv`,
      o.admin.token
    )
    expect(file.status).toBe(200)
    expect(file.headers.get("content-type")).toBe("text/csv; charset=utf-8")
    expect(file.headers.get("content-disposition")).toBe(
      'attachment; filename="attendance-summary_2026-03-01_2026-03-31_Asia-Dubai.csv"'
    )
    expect(file.text.charCodeAt(0)).toBe(0xfeff)
    const [header, ...rows] = file.rows
    expect(header).toEqual([
      "Employee",
      "Employee code",
      "Department",
      "Working days",
      "Present",
      "Late",
      "Absent",
      "WFH",
      "On leave",
      "Unpaid leave days",
      "Business trip",
      "Missing checkouts",
      "Not yet recorded",
      "Holidays",
      "Worked hours",
      "Corrections",
    ])
    expect(rows).toHaveLength(5)
    expect(rows.map((r) => r[0])).toEqual(
      screen.body.items.map((r) => r.employee.name)
    )
    // Every column's sum equals the on-screen total.
    const columns = [
      "workingDays",
      "present",
      "late",
      "absent",
      "wfh",
      "onLeave",
      "unpaidLeaveDays",
      "businessTrip",
      "missingCheckouts",
      "notYetRecorded",
      "holidays",
      "workedHours",
      "corrections",
    ]
    columns.forEach((column, i) => {
      const sum = rows.reduce((s, r) => s + Number(r[i + 3]), 0)
      expect(sum, column).toBeCloseTo(screen.body.totals![column]!, 5)
    })
  })

  it("keeps a deactivated employee in March but not in April (BE-14 AC)", async () => {
    const o = await org("Bravo")
    const april = await api.get<Page>(
      "/reports/attendance/summary?from=2026-04-01&to=2026-04-30&pageSize=100",
      o.admin.token
    )
    expect(april.status).toBe(200)
    expect(row(april.body, o.e3)).toBeUndefined()
    expect(april.body.meta.totalItems).toBe(4)
    // Today (the 20th) before check-in and the days after it aren't recorded yet.
    const e1 = row(april.body, o.e1)!
    expect(e1).toMatchObject({ workingDays: 22, absent: 13, notYetRecorded: 9 })

    const preset = await api.get<Page>(
      "/reports/attendance/summary?preset=LAST_MONTH",
      o.admin.token
    )
    expect(preset.body).toMatchObject({ from: "2026-03-01", to: "2026-03-31" })
    expect(row(preset.body, o.e3)).toBeDefined()
  })

  it("sorts by a column and pages through the rows", async () => {
    const o = await org("Charlie")
    const page = await api.get<Page>(
      `/reports/attendance/summary?${MARCH}&sort=-workedMinutes&pageSize=2`,
      o.admin.token
    )
    expect(page.body.items.map((r) => r.employee.id)).toEqual([
      o.e2.id,
      o.e1.id,
    ])
    expect(page.body.meta).toEqual({
      page: 1,
      pageSize: 2,
      totalItems: 5,
      totalPages: 3,
    })
    // Totals are for every row, not just the page.
    expect(page.body.totals!.workingDays).toBe(103)
    const bad = await api.get(
      `/reports/attendance/summary?${MARCH}&sort=salary`,
      o.admin.token
    )
    expect(bad.status).toBe(422)
  })
})

describe("attendance detail", () => {
  it("shows corrected = yes in the export, with company-time check-ins (BE-14 AC)", async () => {
    const o = await org("Delta")
    const file = await csv(
      `/reports/attendance/detail?${MARCH}&employeeId=${o.e2.id}&format=csv`,
      o.admin.token
    )
    expect(file.status).toBe(200)
    const [header, ...rows] = file.rows
    expect(header).toEqual([
      "Employee",
      "Employee code",
      "Department",
      "Date",
      "Weekday",
      "Status",
      "First in",
      "Last out",
      "Worked hours",
      "Flags",
      "Corrected",
    ])
    expect(rows).toHaveLength(31)
    const day = (date: string) => rows.find((r) => r[3] === date)!
    expect(day("2026-03-03").slice(3)).toEqual([
      "2026-03-03",
      "TUE",
      "Present",
      "09:00",
      "17:00",
      "8",
      "Corrected",
      "yes",
    ])
    expect(day("2026-03-02").slice(5)).toEqual([
      "Late",
      "09:30",
      "17:30",
      "8",
      "",
      "no",
    ])
    expect(day("2026-03-05")[5]).toBe("On Leave")
    expect(day("2026-03-06")[5]).toBe("Weekend")

    const screen = await api.get<Page>(
      `/reports/attendance/detail?${MARCH}&employeeId=${o.e2.id}&pageSize=100`,
      o.admin.token
    )
    expect(
      screen.body.items.find((r) => r.date === "2026-03-03")
    ).toMatchObject({
      status: "PRESENT",
      flags: ["CORRECTED"],
      corrected: true,
      firstCheckInAt: "2026-03-03T05:00:00.000Z",
      lastCheckOutAt: "2026-03-03T13:00:00.000Z",
      workedMinutes: 480,
    })
  })

  it("pages employee × day rows across people, the same rows as the file", async () => {
    const o = await org("Echo")
    const file = await csv(
      `/reports/attendance/detail?${MARCH}&format=csv`,
      o.admin.token
    )
    const rows = file.rows.slice(1)
    // 4 people × 31 days + e3's 15 days.
    expect(rows).toHaveLength(4 * 31 + 15)
    const seen: string[] = []
    for (let page = 1; ; page += 1) {
      const response = await api.get<Page>(
        `/reports/attendance/detail?${MARCH}&pageSize=17&page=${page}`,
        o.admin.token
      )
      expect(response.body.meta.totalItems).toBe(rows.length)
      seen.push(
        ...response.body.items.map((r) => `${r.employee.name}|${r.date}`)
      )
      if (page >= response.body.meta.totalPages) break
    }
    expect(seen).toEqual(rows.map((r) => `${r[0]}|${r[3]}`))
  })
})

describe("scope", () => {
  it("gives a Manager's leave register only their direct reports' requests (BE-14 AC)", async () => {
    const o = await org("Foxtrot")
    const manager = await api.get<Page>(
      `/reports/leave/register?${MARCH}`,
      o.m.token
    )
    expect(manager.status).toBe(200)
    expect(manager.body.scope).toBe("team")
    expect(manager.body.items.map((r) => r.employee.id).sort()).toEqual(
      [o.e1.id, o.e2.id].sort()
    )
    const file = await csv(
      `/reports/leave/register?${MARCH}&format=csv`,
      o.m.token
    )
    expect(
      file.rows
        .slice(1)
        .map((r) => r[1])
        .sort()
    ).toEqual([o.e1.name, o.e2.name].sort())
    const admin = await api.get<Page>(
      `/reports/leave/register?${MARCH}`,
      o.admin.token
    )
    expect(admin.body.items).toHaveLength(3)
    // A Manager's own data, and nobody outside the team.
    expect(
      (
        await api.get<Page>(
          `/reports/leave/register?${MARCH}&scope=self`,
          o.m.token
        )
      ).body.items
    ).toEqual([])
    expect(
      (
        await api.get(
          `/reports/leave/register?${MARCH}&scope=company`,
          o.m.token
        )
      ).status
    ).toBe(403)
    expect(
      (
        await api.get(
          `/reports/leave/register?${MARCH}&employeeId=${o.e3.id}`,
          o.m.token
        )
      ).status
    ).toBe(404)
  })

  it("refuses company-wide reports to an Employee, who still sees their own (BE-14 AC)", async () => {
    const o = await org("Golf")
    for (const query of [
      "scope=company",
      "scope=team",
      `employeeId=${o.e2.id}`,
      `departmentId=${randomUUID()}`,
      `managerId=${o.m.id}`,
      "employeeStatus=ACTIVE",
    ]) {
      for (const view of [
        "attendance/summary",
        "attendance/detail",
        "leave/register",
        "wfh/summary",
        "wfh/register",
      ]) {
        const response = await api.get(
          `/reports/${view}?${MARCH}&${query}`,
          o.e1.token
        )
        expect(response.status, `${view}?${query}`).toBe(403)
        expect(response.body).toMatchObject({ code: "FORBIDDEN" })
      }
      expect(
        (await api.get(`/reports/leave/balances?${query}`, o.e1.token)).status
      ).toBe(403)
    }
    const own = await api.get<Page>(
      `/reports/attendance/summary?${MARCH}`,
      o.e1.token
    )
    expect(own.status).toBe(200)
    expect(own.body.scope).toBe("self")
    expect(own.body.items.map((r) => r.employee.id)).toEqual([o.e1.id])
    const ownFile = await csv(
      `/reports/attendance/summary?${MARCH}&employeeId=${o.e1.id}&format=csv`,
      o.e1.token
    )
    expect(ownFile.rows).toHaveLength(2)
  })
})

describe("range", () => {
  it("refuses more than 13 months and accepts exactly 13 (BE-14 AC)", async () => {
    const o = await org("Hotel")
    const tooLong = await api.get(
      "/reports/attendance/summary?from=2026-01-01&to=2027-02-28",
      o.admin.token
    )
    expect(tooLong.status).toBe(422)
    expect(tooLong.body).toMatchObject({
      code: "VALIDATION_FAILED",
      fieldErrors: [{ field: "to", code: "OUT_OF_RANGE" }],
    })
    const exportTooLong = await csv(
      "/reports/leave/register?from=2026-01-01&to=2027-02-01&format=csv",
      o.admin.token
    )
    expect(exportTooLong.status).toBe(422)
    expect(
      (
        await api.get(
          "/reports/attendance/summary?from=2026-01-01&to=2027-01-31",
          o.admin.token
        )
      ).status
    ).toBe(200)
    const backwards = await api.get(
      "/reports/wfh/summary?from=2026-03-31&to=2026-03-01",
      o.admin.token
    )
    expect(backwards.body).toMatchObject({
      fieldErrors: [{ field: "to", code: "OUT_OF_RANGE" }],
    })
    const missing = await api.get("/reports/wfh/summary", o.admin.token)
    expect(missing.status).toBe(422)
    expect(missing.body).toMatchObject({
      fieldErrors: [
        { field: "from", code: "REQUIRED" },
        { field: "to", code: "REQUIRED" },
      ],
    })
    const both = await api.get(
      `/reports/wfh/summary?preset=THIS_MONTH&${MARCH}`,
      o.admin.token
    )
    expect(both.body).toMatchObject({ fieldErrors: [{ field: "preset" }] })
    const year = await api.get<Page>(
      "/reports/wfh/summary?preset=THIS_LEAVE_YEAR",
      o.admin.token
    )
    expect(year.body).toMatchObject({ from: "2026-01-01", to: "2026-12-31" })
  })
})

describe("leave", () => {
  it("shows balances per employee and type, including Unpaid days taken", async () => {
    const o = await org("India")
    const balances = await api.get<Page & { year: number }>(
      `/reports/leave/balances?employeeId=${o.e1.id}&pageSize=100`,
      o.admin.token
    )
    expect(balances.status).toBe(200)
    expect(balances.body).toMatchObject({
      year: 2026,
      period: { start: "2026-01-01", end: "2026-12-31" },
    })
    const annual = balances.body.items.find(
      (r) => (r.leaveType as { name: string }).name === "Annual"
    )
    expect(annual).toMatchObject({
      entitlement: 21,
      adjustments: 0,
      used: 0,
      upcoming: 0,
      pending: 1,
      available: 20,
    })
    const unpaid = await api.get<Page>(
      `/reports/leave/balances?employeeId=${o.e2.id}&leaveTypeId=${o.typeId("Unpaid")}`,
      o.admin.token
    )
    expect(unpaid.body.items).toEqual([
      expect.objectContaining({
        leaveType: expect.objectContaining({
          name: "Unpaid",
          paid: false,
          tracksBalance: false,
        }),
        entitlement: null,
        adjustments: null,
        used: 2,
        upcoming: 0,
        pending: 0,
        available: null,
      }),
    ])
    // Looking doesn't create balance records for anyone.
    const file = await csv("/reports/leave/balances?format=csv", o.admin.token)
    expect(file.headers.get("content-disposition")).toContain(
      "leave-balances_2026_Asia-Dubai.csv"
    )
    expect(file.rows[0]).toEqual([
      "Employee",
      "Employee code",
      "Department",
      "Leave type",
      "Paid",
      "Balance tracked",
      "Leave year",
      "Entitlement",
      "Adjustments",
      "Used",
      "Upcoming",
      "Pending",
      "Available",
    ])
  })

  it("lists leave requests with days in the range, type and approver", async () => {
    const o = await org("Juliet")
    const register = await api.get<Page>(
      `/reports/leave/register?from=2026-03-01&to=2026-03-06`,
      o.admin.token
    )
    expect(register.body.items).toEqual([
      expect.objectContaining({
        employee: expect.objectContaining({ id: o.e2.id }),
        leaveType: {
          id: o.typeId("Unpaid"),
          name: "Unpaid",
          paid: false,
        },
        startDate: "2026-03-05",
        endDate: "2026-03-08",
        days: 2,
        daysInRange: 1,
        status: "APPROVED",
        approver: { id: o.admin.id, name: o.admin.name },
      }),
    ])
    const pending = await api.get<Page>(
      `/reports/leave/register?${MARCH}&status=PENDING`,
      o.admin.token
    )
    expect(pending.body.items.map((r) => r.employee.id)).toEqual([o.e1.id])
  })
})

describe("WFH", () => {
  it("counts approved WFH days and approved/rejected requests per employee", async () => {
    const o = await org("Kilo")
    const summary = await api.get<Page>(
      `/reports/wfh/summary?${MARCH}&pageSize=100`,
      o.admin.token
    )
    expect(row(summary.body, o.e1)).toMatchObject({
      wfhDays: 1,
      approved: 1,
      rejected: 0,
      pending: 0,
    })
    expect(row(summary.body, o.e2)).toMatchObject({
      wfhDays: 0,
      approved: 0,
      rejected: 1,
    })
    expect(summary.body.totals).toEqual({
      wfhDays: 1,
      approved: 1,
      rejected: 1,
      pending: 0,
    })
    const register = await csv(
      `/reports/wfh/register?${MARCH}&format=csv`,
      o.admin.token
    )
    expect(register.rows.slice(1).map((r) => [r[1], r[2], r[9]])).toEqual([
      ["WFH", o.e1.name, "Approved"],
      ["WFH", o.e2.name, "Rejected"],
    ])
    const trips = await api.get<Page>(
      `/reports/wfh/register?${MARCH}&type=BUSINESS_TRIP`,
      o.admin.token
    )
    expect(trips.body.items).toEqual([])
  })
})

describe("speed", () => {
  it("exports a one-month attendance summary for 300 employees in under 10 seconds (BE-14 AC)", async () => {
    const o = await org("Big Co")
    const ids = Array.from({ length: 295 }, () => randomUUID())
    await UserModel.insertMany(
      ids.map((id, i) => ({
        _id: id,
        companyId: o.companyId,
        email: `bulk${i}.${Date.now()}@big.example`,
        role: "EMPLOYEE",
        status: "ACTIVE",
      }))
    )
    await EmployeeModel.insertMany(
      ids.map((id, i) => ({
        _id: id,
        companyId: o.companyId,
        name: `Employee ${i}`,
        managerId: o.admin.id,
      }))
    )
    const started = performance.now()
    const file = await csv(
      `/reports/attendance/summary?${MARCH}&format=csv`,
      o.admin.token
    )
    const took = performance.now() - started
    expect(file.status).toBe(200)
    expect(file.rows).toHaveLength(1 + 300)
    expect(took, `took ${Math.round(took)} ms`).toBeLessThan(10_000)
  })
})
