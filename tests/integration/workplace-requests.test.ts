import { describe, expect, it } from "vitest"

import { AttendanceDayModel } from "../../src/modules/attendance/attendance.model.ts"
import { runAttendanceClose } from "../../src/modules/attendance/close-job.ts"
import { UserModel } from "../../src/modules/identity/user.model.ts"
import { useApi, type Tokens } from "./api.ts"
import { useTestDatabase } from "./database.ts"
import { newCompany, type Member } from "./people.ts"

/** WFH, attendance correction, permission and business trip (Trello BE-11). */
useTestDatabase()
const api = useApi()
const silent = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  child: () => silent,
} as never

type Detail = { id: string; status: string; actions: string[] }
type Today = { status: string | null; flags: string[] }

const travelTo = (instant: string) =>
  api.clock.advance(new Date(instant).getTime() - api.clock.now().getTime())
const close = () => runAttendanceClose({ clock: api.clock, logger: silent })

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

/** Monday 12 October 2026, 08:00 in Dubai; working every day; work starts 09:00, no grace. */
async function org(name: string) {
  travelTo("2026-10-12T04:00:00Z")
  const company = await newCompany(api, name)
  const manager = await company.add("MANAGER", company.admin.id)
  const employee = await company.add("EMPLOYEE", manager.id)
  await api.patch(
    "/company/settings",
    {
      workingDays: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"],
      workStartTime: "09:00",
      workEndTime: "17:00",
      lateGraceMinutes: 0,
    },
    company.admin.token
  )
  const annual = (
    await api.get<{ items: { id: string; name: string }[] }>(
      "/leave/types",
      company.admin.token
    )
  ).body.items.find((t) => t.name === "Annual")!.id
  const relogAll = async () => {
    for (const m of [company.admin, manager, employee])
      await relogin(m, company.companyId)
  }
  return { ...company, manager, employee, annual, relogAll }
}

const submit = (member: Member, body: Record<string, unknown>) =>
  api.post<Detail>("/requests", body, member.token)
const approve = (member: Member, id: string) =>
  api.post<Detail>(`/requests/${id}/approve`, {}, member.token)
const stored = (companyId: string, employeeId: string, date: string) =>
  AttendanceDayModel.findOne({ companyId, employeeId, date }).lean()

describe("WFH", () => {
  it("makes a checked-in day WFH, not Present or Late (BE-11 AC)", async () => {
    const o = await org("Alpha")
    const wfh = await submit(o.employee, {
      type: "WFH",
      startDate: "2026-10-12",
    })
    expect(wfh.status).toBe(201)
    await approve(o.manager, wfh.body.id)
    travelTo("2026-10-12T07:30:00Z") // 11:30, late if it weren't WFH
    await o.relogAll()
    const today = await api.post<Today>(
      "/attendance/check-in",
      undefined,
      o.employee.token
    )
    expect(today.body.status).toBe("WFH")
  })

  it("closes an approved WFH day without a check-in as Absent, flagged (BE-11 AC)", async () => {
    const o = await org("Bravo")
    const wfh = await submit(o.employee, {
      type: "WFH",
      startDate: "2026-10-12",
    })
    await approve(o.manager, wfh.body.id)
    travelTo("2026-10-12T20:30:00Z")
    await close()
    expect(
      await stored(o.companyId, o.employee.id, "2026-10-12")
    ).toMatchObject({
      status: "ABSENT",
      flags: ["WFH_NO_CHECK_IN"],
    })
  })

  it("is refused on days with pending or approved leave, and twice for the same day (BE-11 AC)", async () => {
    const o = await org("Charlie")
    const leave = await submit(o.employee, {
      type: "LEAVE",
      startDate: "2026-11-05",
      endDate: "2026-11-05",
      data: { leaveTypeId: o.annual },
    })
    // Pending leave already blocks it…
    const onPending = await submit(o.employee, {
      type: "WFH",
      startDate: "2026-11-05",
    })
    expect(onPending.status).toBe(409)
    expect(onPending.body).toMatchObject({
      code: "REQUEST_OVERLAP",
      message:
        "You have leave from 2026-11-05 to 2026-11-05 on these days; withdraw or cancel it first",
    })
    // …and so does approved leave.
    await approve(o.manager, leave.body.id)
    expect(
      (
        await submit(o.employee, {
          type: "WFH",
          startDate: "2026-11-04",
          endDate: "2026-11-06",
        })
      ).status
    ).toBe(409)

    await submit(o.employee, { type: "WFH", startDate: "2026-11-10" })
    const twice = await submit(o.employee, {
      type: "WFH",
      startDate: "2026-11-10",
    })
    expect(twice.status).toBe(409)
    expect(twice.body).toMatchObject({
      code: "REQUEST_OVERLAP",
      message: expect.stringContaining("already asked for WFH"),
    })
  })
})

describe("business trip", () => {
  const trip = (startDate: string, endDate: string) => ({
    type: "BUSINESS_TRIP",
    startDate,
    endDate,
    data: { destination: "Riyadh", purpose: "Client workshop" },
  })

  it("shows Business Trip, not Absent, on days closed without check-ins (BE-11 AC)", async () => {
    const o = await org("Delta")
    const request = await submit(o.employee, trip("2026-10-12", "2026-10-14"))
    expect(request.status).toBe(201)
    await approve(o.manager, request.body.id)
    travelTo("2026-10-14T20:30:00Z")
    await close()
    for (const date of ["2026-10-12", "2026-10-13", "2026-10-14"]) {
      expect((await stored(o.companyId, o.employee.id, date))?.status).not.toBe(
        "ABSENT"
      )
    }
    await o.relogAll()
    const month = await api.get<{
      items: { days: { date: string; status: string }[] }[]
    }>(
      `/attendance/days?date=2026-10-13&employeeId=${o.employee.id}`,
      o.admin.token
    )
    expect(month.body.items[0]!.days[0]!.status).toBe("BUSINESS_TRIP")
  })

  it("needs a destination and purpose, and is refused on leave days", async () => {
    const o = await org("Echo")
    const missing = await submit(o.employee, {
      type: "BUSINESS_TRIP",
      startDate: "2026-11-02",
    })
    expect(
      (
        missing.body as unknown as { fieldErrors: { field: string }[] }
      ).fieldErrors
        .map((e) => e.field)
        .sort()
    ).toEqual(["data.destination", "data.purpose"])

    await submit(o.employee, {
      type: "LEAVE",
      startDate: "2026-11-03",
      endDate: "2026-11-03",
      data: { leaveTypeId: o.annual },
    })
    const onLeave = await submit(o.employee, trip("2026-11-02", "2026-11-04"))
    expect(onLeave.body).toMatchObject({ code: "REQUEST_OVERLAP" })
  })
})

describe("permission", () => {
  it("excuses arriving inside the window: 09:00–11:00, check-in 10:45 is not Late (BE-11 AC)", async () => {
    const o = await org("Foxtrot")
    const request = await submit(o.employee, {
      type: "PERMISSION",
      startDate: "2026-10-12",
      startTime: "09:00",
      endTime: "11:00",
      reason: "Doctor",
    })
    expect(request.status).toBe(201)
    await approve(o.manager, request.body.id)
    travelTo("2026-10-12T06:45:00Z") // 10:45 in Dubai
    await o.relogAll()
    const today = await api.post<Today>(
      "/attendance/check-in",
      undefined,
      o.employee.token
    )
    expect(today.body.status).toBe("PRESENT")
  })

  it("must be within working hours on a working day", async () => {
    const o = await org("Golf")
    const outside = await submit(o.employee, {
      type: "PERMISSION",
      startDate: "2026-10-13",
      startTime: "07:00",
      endTime: "18:00",
    })
    expect(
      (
        outside.body as unknown as {
          fieldErrors: { field: string; code: string }[]
        }
      ).fieldErrors
    ).toEqual([
      expect.objectContaining({ field: "startTime", code: "OUT_OF_RANGE" }),
      expect.objectContaining({ field: "endTime", code: "OUT_OF_RANGE" }),
    ])
    const twoDays = await submit(o.employee, {
      type: "PERMISSION",
      startDate: "2026-10-13",
      endDate: "2026-10-14",
      startTime: "09:00",
      endTime: "10:00",
    })
    expect(twoDays.status).toBe(422)
  })
})

describe("attendance correction", () => {
  it("is applied when an Admin approves: new times, recalculated status, history with the request (BE-11 AC)", async () => {
    const o = await org("Hotel")
    travelTo("2026-10-12T05:00:00Z") // 09:00
    await o.relogAll()
    await api.post("/attendance/check-in", undefined, o.employee.token) // never checks out
    travelTo("2026-10-12T20:30:00Z")
    await close()
    expect(
      (await stored(o.companyId, o.employee.id, "2026-10-12"))?.status
    ).toBe("MISSING_CHECKOUT")

    travelTo("2026-10-13T05:00:00Z")
    await o.relogAll()
    const request = await submit(o.employee, {
      type: "ATTENDANCE_CORRECTION",
      startDate: "2026-10-12",
      reason: "Forgot to check out",
      data: { checkOutTime: "17:00" },
    })
    expect(request.status).toBe(201)

    // Admin-only: the manager can't approve it.
    const byManager = await approve(o.manager, request.body.id)
    expect(byManager.status).toBe(403)
    expect(
      (
        await api.get<{ items: { id: string }[] }>(
          "/requests/approvals",
          o.manager.token
        )
      ).body.items.map((r) => r.id)
    ).not.toContain(request.body.id)

    expect((await approve(o.admin, request.body.id)).body.status).toBe(
      "APPROVED"
    )
    const day = await stored(o.companyId, o.employee.id, "2026-10-12")
    expect(day).toMatchObject({
      status: "PRESENT",
      workedMinutes: 480,
      flags: ["CORRECTED"],
    })
    expect(day!.lastCheckOutAt!.toISOString()).toBe("2026-10-12T13:00:00.000Z") // 17:00 Dubai

    const history = await api.get<{
      items: {
        action: string
        reason: string
        source: string
        oldValues: Record<string, unknown>
        newValues: Record<string, unknown>
      }[]
    }>(`/history/attendance-days/${day!._id}`, o.admin.token)
    expect(history.body.items[0]).toMatchObject({
      action: "attendance.corrected",
      source: "APPROVAL",
      reason: "Forgot to check out",
      oldValues: { status: "MISSING_CHECKOUT" },
      newValues: { status: "PRESENT", requestId: request.body.id },
    })
  })

  it("creates the session when nothing was recorded (both times needed)", async () => {
    const o = await org("India")
    travelTo("2026-10-13T05:00:00Z")
    await o.relogAll()
    const onlyOne = await submit(o.employee, {
      type: "ATTENDANCE_CORRECTION",
      startDate: "2026-10-12",
      reason: "Forgot my phone",
      data: { checkInTime: "09:00" },
    })
    expect(onlyOne.body).toMatchObject({
      fieldErrors: [{ field: "data.checkOutTime", code: "REQUIRED" }],
    })
    const both = await submit(o.employee, {
      type: "ATTENDANCE_CORRECTION",
      startDate: "2026-10-12",
      reason: "Forgot my phone",
      data: { checkInTime: "09:00", checkOutTime: "17:30" },
    })
    await approve(o.admin, both.body.id)
    expect(
      await stored(o.companyId, o.employee.id, "2026-10-12")
    ).toMatchObject({
      status: "PRESENT",
      workedMinutes: 510,
    })
  })

  it("needs a reason, a past day within 30 days, and a time", async () => {
    const o = await org("Juliett")
    const errorsOf = async (body: Record<string, unknown>) =>
      (await submit(o.employee, { type: "ATTENDANCE_CORRECTION", ...body }))
        .body as unknown as {
        code: string
        fieldErrors?: { field: string; code: string }[]
      }
    expect(
      (
        await errorsOf({
          startDate: "2026-10-11",
          data: { checkInTime: "09:00" },
        })
      ).fieldErrors
    ).toEqual([expect.objectContaining({ field: "reason", code: "REQUIRED" })])
    expect(
      (
        await errorsOf({
          startDate: "2026-09-01",
          reason: "x",
          data: { checkInTime: "09:00", checkOutTime: "10:00" },
        })
      ).fieldErrors
    ).toEqual([
      expect.objectContaining({ field: "startDate", code: "OUT_OF_RANGE" }),
    ])
    expect(
      (
        await errorsOf({
          startDate: "2026-10-20",
          reason: "x",
          data: { checkInTime: "09:00", checkOutTime: "10:00" },
        })
      ).fieldErrors
    ).toEqual([
      expect.objectContaining({ field: "startDate", code: "OUT_OF_RANGE" }),
    ])
    expect(
      (await errorsOf({ startDate: "2026-10-11", reason: "x", data: {} }))
        .fieldErrors
    ).toEqual([expect.objectContaining({ field: "data.checkInTime" })])
  })
})

describe("turning types off and the type list", () => {
  it("hides a disabled type and refuses new requests; existing ones stay visible (BE-11 AC)", async () => {
    const o = await org("Kilo")
    const existing = await submit(o.employee, {
      type: "BUSINESS_TRIP",
      startDate: "2026-11-02",
      data: { destination: "Doha", purpose: "Expo" },
    })
    const changed = await api.patch<{ disabledRequestTypes: string[] }>(
      "/company/settings",
      { disabledRequestTypes: ["BUSINESS_TRIP"] },
      o.admin.token
    )
    expect(changed.body.disabledRequestTypes).toEqual(["BUSINESS_TRIP"])

    const keys = async (member: Member, query = "") =>
      (
        await api.get<{ items: { key: string; enabled: boolean }[] }>(
          `/requests/types${query}`,
          member.token
        )
      ).body.items
    expect((await keys(o.employee)).map((t) => t.key)).not.toContain(
      "BUSINESS_TRIP"
    )
    expect(
      (await keys(o.admin, "?includeDisabled=true")).find(
        (t) => t.key === "BUSINESS_TRIP"
      )
    ).toMatchObject({
      enabled: false,
    })

    const refused = await submit(o.employee, {
      type: "BUSINESS_TRIP",
      startDate: "2026-11-09",
      data: { destination: "Doha", purpose: "Expo" },
    })
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ code: "REQUEST_TYPE_DISABLED" })
    expect(
      (await api.get<Detail>(`/requests/${existing.body.id}`, o.employee.token))
        .status
    ).toBe(200)
  })

  it("describes each type's form fields", async () => {
    const o = await org("Lima")
    const types = (
      await api.get<{
        items: {
          key: string
          times: string
          reason: string
          approverPolicy: string
          fields: { name: string; kind: string; required: boolean }[]
        }[]
      }>("/requests/types", o.employee.token)
    ).body.items
    const byKey = new Map(types.map((t) => [t.key, t]))
    expect([...byKey.keys()].sort()).toEqual([
      "ATTENDANCE_CORRECTION",
      "BUSINESS_TRIP",
      "LEAVE",
      "PERMISSION",
      "WFH",
    ])
    expect(byKey.get("BUSINESS_TRIP")!.fields.map((f) => f.name)).toEqual([
      "destination",
      "purpose",
    ])
    expect(byKey.get("ATTENDANCE_CORRECTION")).toMatchObject({
      approverPolicy: "ADMIN_ONLY",
      reason: "REQUIRED",
    })
    expect(byKey.get("PERMISSION")).toMatchObject({ times: "REQUIRED" })
    expect(byKey.get("LEAVE")!.fields[0]).toMatchObject({
      name: "leaveTypeId",
      kind: "leaveType",
      required: true,
    })
  })
})
