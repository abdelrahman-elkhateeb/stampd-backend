import { afterEach, describe, expect, it } from "vitest"

import {
  AttendanceDayModel,
  AttendanceSessionModel,
} from "../../src/modules/attendance/attendance.model.ts"
import { runAttendanceClose } from "../../src/modules/attendance/close-job.ts"
import { registerDayEffectsProvider } from "../../src/modules/attendance/day-effects.ts"
import { UserModel } from "../../src/modules/identity/user.model.ts"
import { useApi, type Tokens } from "./api.ts"
import { useTestDatabase } from "./database.ts"
import { newCompany, type Member } from "./people.ts"

/** Attendance (Trello BE-07). */
useTestDatabase()
const api = useApi()

type Today = {
  recordId: string | null
  date: string
  status: string | null
  flags: string[]
  workedMinutes: number
  openSession: { id: string; checkInAt: string } | null
  sessions: { id: string; checkInAt: string; checkOutAt: string | null }[]
}
type Detail = {
  day: {
    recordId: string | null
    status: string | null
    workedMinutes: number
    flags: string[]
  }
  sessions: { id: string; checkInAt: string; checkOutAt: string | null }[]
}

/** Moves the test clock to an exact instant. */
const travelTo = (instant: string) =>
  api.clock.advance(new Date(instant).getTime() - api.clock.now().getTime())

const ALL_WEEK = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]

async function org(
  name: string,
  settings: Record<string, unknown> = { workingDays: ALL_WEEK }
) {
  const company = await newCompany(api, name)
  const manager = await company.add("MANAGER", company.admin.id)
  const employee = await company.add("EMPLOYEE", manager.id)
  const colleague = await company.add("EMPLOYEE", company.admin.id)
  const changed = await api.patch(
    "/company/settings",
    settings,
    company.admin.token
  )
  expect(changed.status).toBe(200)
  return { ...company, manager, employee, colleague }
}

/** A fresh token after the clock moved past the 15-minute access token. */
async function relogin(member: Member, companyId: string): Promise<string> {
  const user = await UserModel.findOne(
    { _id: member.id, companyId },
    { email: 1 }
  ).lean()
  const login = await api.post<Tokens>("/auth/login", {
    email: user!.email,
    password: "blue-river-lantern",
  })
  member.token = login.body.accessToken
  return member.token
}

const checkIn = (member: Member) =>
  api.post<Today>("/attendance/check-in", undefined, member.token)
const checkOut = (member: Member) =>
  api.post<Today>("/attendance/check-out", undefined, member.token)
const close = () => runAttendanceClose({ clock: api.clock, logger: silent })
const silent = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  child: () => silent,
} as never

const storedDay = (companyId: string, employeeId: string, date: string) =>
  AttendanceDayModel.findOne({ companyId, employeeId, date }).lean()

describe("check-in and check-out", () => {
  it("creates a session and returns today's status (BE-07 AC)", async () => {
    travelTo("2026-10-11T05:00:00Z") // Sunday 09:00 in Dubai
    const o = await org("Alpha", {})
    const response = await checkIn(o.employee)
    expect(response.status).toBe(201)
    expect(response.body).toMatchObject({
      date: "2026-10-11",
      status: "PRESENT",
      openSession: { checkInAt: "2026-10-11T05:00:00.000Z" },
      recordId: expect.any(String),
    })
    const stored = await AttendanceSessionModel.findOne({
      companyId: o.companyId,
      employeeId: o.employee.id,
    }).lean()
    expect(stored).toMatchObject({ checkInIp: expect.any(String), open: true })
  })

  it("never opens a second session: double clicks and parallel tabs get the open one (BE-07 AC)", async () => {
    travelTo("2026-10-11T05:00:00Z")
    const o = await org("Bravo", {})
    const first = await checkIn(o.employee)
    const again = await checkIn(o.employee)
    expect(again.status).toBe(200)
    expect(again.body.openSession).toEqual(first.body.openSession)

    const parallel = await Promise.all(
      [1, 2, 3, 4].map(() => checkIn(o.colleague))
    )
    expect(parallel.filter((r) => r.status === 201)).toHaveLength(1)
    expect(parallel.every((r) => r.status === 200 || r.status === 201)).toBe(
      true
    )
    expect(
      await AttendanceSessionModel.countDocuments({
        companyId: o.companyId,
        employeeId: o.colleague.id,
      })
    ).toBe(1)
  })

  it("refuses a check-out without an open session (409 NO_OPEN_SESSION) (BE-07 AC)", async () => {
    travelTo("2026-10-11T05:00:00Z")
    const o = await org("Charlie", {})
    const refused = await checkOut(o.employee)
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ code: "NO_OPEN_SESSION" })

    await checkIn(o.employee)
    api.clock.advance(3 * 3600 * 1000 + 30 * 60 * 1000)
    await relogin(o.employee, o.companyId)
    const out = await checkOut(o.employee)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ workedMinutes: 210, openSession: null })
  })

  it("allows several sessions a day (lunch break) and sums them", async () => {
    travelTo("2026-10-11T04:00:00Z") // 08:00 Dubai
    const o = await org("Delta", {})
    await checkIn(o.employee)
    api.clock.advance(4 * 3600 * 1000)
    await relogin(o.employee, o.companyId)
    await checkOut(o.employee)
    api.clock.advance(3600 * 1000)
    await relogin(o.employee, o.companyId)
    await checkIn(o.employee)
    api.clock.advance(4 * 3600 * 1000)
    await relogin(o.employee, o.companyId)
    const day = await checkOut(o.employee)
    expect(day.body).toMatchObject({ status: "PRESENT", workedMinutes: 480 })
    expect(day.body.sessions).toHaveLength(2)
  })

  it("refuses employees whose attendance isn't tracked (409)", async () => {
    travelTo("2026-10-11T05:00:00Z")
    const o = await org("Echo", {})
    await api.patch(
      `/employees/${o.colleague.id}`,
      { tracksAttendance: false },
      o.admin.token
    )
    const response = await checkIn(o.colleague)
    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({ code: "ATTENDANCE_NOT_TRACKED" })
  })
})

describe("status", () => {
  it("start 09:00 + 10 min grace: 09:07 is Present, 09:12 is Late (BE-07 AC)", async () => {
    travelTo("2026-10-11T04:00:00Z")
    const o = await org("Foxtrot", {
      workStartTime: "09:00",
      lateGraceMinutes: 10,
    })
    travelTo("2026-10-11T05:07:00Z") // 09:07 Dubai
    await relogin(o.employee, o.companyId)
    expect((await checkIn(o.employee)).body.status).toBe("PRESENT")
    travelTo("2026-10-11T05:12:00Z") // 09:12 Dubai
    await relogin(o.colleague, o.companyId)
    expect((await checkIn(o.colleague)).body.status).toBe("LATE")
  })

  it("stores weekend and holiday check-ins flagged, never Late or Absent (BE-07 AC)", async () => {
    travelTo("2026-10-09T08:00:00Z") // Friday: weekend in a Sun–Thu company
    const o = await org("Golf", {
      workingDays: ["SUN", "MON", "TUE", "WED", "THU"],
      lateGraceMinutes: 0,
    })
    const weekend = await checkIn(o.employee)
    expect(weekend.body).toMatchObject({
      status: "WEEKEND",
      flags: ["WORKED_ON_NON_WORKING_DAY"],
    })

    await api.post(
      "/company/holidays",
      { name: "Founding Day", startDate: "2026-10-12", endDate: "2026-10-12" },
      o.admin.token
    )
    travelTo("2026-10-12T10:00:00Z") // Monday 14:00, a holiday
    await relogin(o.colleague, o.companyId)
    const holiday = await checkIn(o.colleague)
    expect(holiday.body).toMatchObject({
      status: "HOLIDAY",
      flags: ["WORKED_ON_NON_WORKING_DAY"],
    })

    travelTo("2026-10-12T20:30:00Z") // 00:30 the next day in Dubai
    await close()
    expect(
      (await storedDay(o.companyId, o.colleague.id, "2026-10-12"))?.status
    ).toBe("HOLIDAY")
    // Nobody is Absent on the holiday.
    expect(await storedDay(o.companyId, o.manager.id, "2026-10-12")).toBeNull()
  })
})

describe("end-of-day close", () => {
  let unregister: (() => void) | undefined
  afterEach(() => unregister?.())

  it("marks an open session Missing Checkout without counting it, and no-shows Absent (BE-07 AC)", async () => {
    travelTo("2026-10-13T04:00:00Z") // Tuesday 08:00 Dubai
    const o = await org("Hotel")
    await checkIn(o.employee)
    api.clock.advance(4 * 3600 * 1000)
    await relogin(o.employee, o.companyId)
    await checkOut(o.employee)
    api.clock.advance(3600 * 1000)
    await relogin(o.employee, o.companyId)
    await checkIn(o.employee) // never checks out

    travelTo("2026-10-13T20:05:00Z") // 00:05 Wednesday in Dubai
    const closed = await close()
    expect(closed).toContainEqual({
      companyId: o.companyId,
      date: "2026-10-13",
    })

    expect(
      await storedDay(o.companyId, o.employee.id, "2026-10-13")
    ).toMatchObject({
      status: "MISSING_CHECKOUT",
      workedMinutes: 240,
    })
    expect(
      await storedDay(o.companyId, o.colleague.id, "2026-10-13")
    ).toMatchObject({
      status: "ABSENT",
    })

    // The history says the system did it.
    const record = await storedDay(o.companyId, o.colleague.id, "2026-10-13")
    const history = await api.get<{
      items: { actor: unknown; newValues: unknown }[]
    }>(
      `/history/attendance-days/${record!._id}`,
      await relogin(o.admin, o.companyId)
    )
    expect(history.body.items[0]).toMatchObject({
      actor: { type: "SYSTEM", job: "attendance.nightlyClose" },
      newValues: { status: "ABSENT" },
    })

    // The next morning a new session starts normally.
    await relogin(o.employee, o.companyId)
    expect((await checkIn(o.employee)).status).toBe(201)
    // Running the job again closes nothing twice.
    expect((await close()).filter((c) => c.companyId === o.companyId)).toEqual(
      []
    )
  })

  // An approved WFH day without a check-in IS Absent (BE-11): see workplace-requests.test.ts.
  it("never marks Absent a day covered by approved leave or a business trip", async () => {
    travelTo("2026-10-14T04:00:00Z")
    const o = await org("India")
    unregister = registerDayEffectsProvider(async ({ companyId }) =>
      companyId === o.companyId
        ? [
            {
              employeeId: o.colleague.id,
              date: "2026-10-14",
              kind: "BUSINESS_TRIP",
              fullDay: true,
            },
          ]
        : []
    )
    travelTo("2026-10-14T20:30:00Z")
    await close()
    expect(
      await storedDay(o.companyId, o.colleague.id, "2026-10-14")
    ).toBeNull()
    expect(
      (await storedDay(o.companyId, o.employee.id, "2026-10-14"))?.status
    ).toBe("ABSENT")
    const view = await api.get<{
      items: { employee: { id: string }; days: { status: string }[] }[]
    }>(
      `/attendance/days?date=2026-10-14&employeeId=${o.colleague.id}`,
      await relogin(o.admin, o.companyId)
    )
    expect(view.body.items[0]!.days[0]!.status).toBe("BUSINESS_TRIP")
  })

  it("doesn't expect attendance before the joining date or for untracked employees", async () => {
    travelTo("2026-10-15T04:00:00Z")
    const o = await org("Juliett")
    await api.patch(
      `/employees/${o.employee.id}`,
      { joiningDate: "2026-11-01" },
      o.admin.token
    )
    await api.patch(
      `/employees/${o.colleague.id}`,
      { tracksAttendance: false },
      o.admin.token
    )
    travelTo("2026-10-15T20:30:00Z")
    await close()
    expect(await storedDay(o.companyId, o.employee.id, "2026-10-15")).toBeNull()
    expect(
      await storedDay(o.companyId, o.colleague.id, "2026-10-15")
    ).toBeNull()
    expect(
      (await storedDay(o.companyId, o.manager.id, "2026-10-15"))?.status
    ).toBe("ABSENT")
  })

  it("uses each company's own timezone: UTC+4 and UTC−5 (BE-07 AC)", async () => {
    travelTo("2026-10-16T14:00:00Z")
    const dubai = await org("Kilo")
    const bogota = await org("Lima", {
      workingDays: ALL_WEEK,
      timezone: "America/Bogota",
    })
    // The timezone change applies from the next day.
    travelTo("2026-10-17T21:00:00Z") // Dubai: Oct 18 01:00. Bogotá: Oct 17 16:00.
    await relogin(dubai.employee, dubai.companyId)
    await relogin(bogota.employee, bogota.companyId)
    expect((await checkIn(dubai.employee)).body.date).toBe("2026-10-18")
    expect((await checkIn(bogota.employee)).body.date).toBe("2026-10-17")

    await close()
    expect(
      await storedDay(dubai.companyId, dubai.manager.id, "2026-10-17")
    ).toMatchObject({
      status: "ABSENT",
    })
    // Bogotá's Oct 17 isn't over: nothing closed for it yet.
    expect(
      await storedDay(bogota.companyId, bogota.manager.id, "2026-10-17")
    ).toBeNull()

    travelTo("2026-10-18T05:30:00Z") // Bogotá: Oct 18 00:30
    await close()
    expect(
      await storedDay(bogota.companyId, bogota.manager.id, "2026-10-17")
    ).toMatchObject({
      status: "ABSENT",
    })
    expect(
      await storedDay(bogota.companyId, bogota.employee.id, "2026-10-17")
    ).toMatchObject({
      status: "MISSING_CHECKOUT",
    })
  })
})

describe("Admin corrections", () => {
  it("refuse an edit without a reason; with one, the status recalculates and history shows old and new (BE-07 AC)", async () => {
    travelTo("2026-10-20T05:00:00Z") // Tuesday 09:00 Dubai
    const o = await org("Mike", { workingDays: ALL_WEEK, lateGraceMinutes: 0 })
    const session = (await checkIn(o.employee)).body.openSession!
    travelTo("2026-10-20T20:30:00Z")
    await close()
    api.clock.advance(60_000) // the correction comes after the close
    const admin = await relogin(o.admin, o.companyId)

    const noReason = await api.patch(
      `/attendance/sessions/${session.id}`,
      { checkOutAt: "2026-10-20T13:00:00Z" },
      admin
    )
    expect(noReason.status).toBe(422)
    expect(noReason.body).toMatchObject({
      fieldErrors: [{ field: "reason", code: "REQUIRED" }],
    })
    expect(
      (await storedDay(o.companyId, o.employee.id, "2026-10-20"))?.status
    ).toBe("MISSING_CHECKOUT")

    const fixed = await api.patch<Detail>(
      `/attendance/sessions/${session.id}`,
      { checkOutAt: "2026-10-20T13:00:00Z", reason: "Forgot to check out" },
      admin
    )
    expect(fixed.status).toBe(200)
    expect(fixed.body.day).toMatchObject({
      status: "PRESENT",
      workedMinutes: 480,
      flags: ["CORRECTED"],
    })
    const history = await api.get<{
      items: {
        action: string
        reason: string
        oldValues: Record<string, unknown>
        newValues: Record<string, unknown>
      }[]
    }>(`/history/attendance-days/${fixed.body.day.recordId}`, admin)
    expect(history.body.items[0]).toMatchObject({
      action: "attendance.corrected",
      reason: "Forgot to check out",
      oldValues: {
        status: "MISSING_CHECKOUT",
        workedMinutes: 0,
        sessions: [{ checkInAt: "2026-10-20T05:00:00.000Z", checkOutAt: null }],
      },
      newValues: {
        status: "PRESENT",
        workedMinutes: 480,
        sessions: [
          {
            checkInAt: "2026-10-20T05:00:00.000Z",
            checkOutAt: "2026-10-20T13:00:00.000Z",
          },
        ],
      },
    })
  })

  it("adds and removes sessions, and refuses bad times", async () => {
    travelTo("2026-10-21T10:00:00Z")
    const o = await org("November")
    const path = `/attendance/employees/${o.colleague.id}/days/2026-10-21/sessions`
    const added = await api.post<Detail>(
      path,
      {
        checkInAt: "2026-10-21T05:00:00Z",
        checkOutAt: "2026-10-21T07:00:00Z",
        reason: "paper sheet",
      },
      o.admin.token
    )
    expect(added.status).toBe(201)
    expect(added.body.day).toMatchObject({ workedMinutes: 120 })

    const bad = async (body: Record<string, unknown>, field: string) => {
      const response = await api.post(
        path,
        { reason: "x", ...body },
        o.admin.token
      )
      expect(response.status, JSON.stringify(body)).toBe(422)
      expect(response.body).toMatchObject({ fieldErrors: [{ field }] })
    }
    await bad(
      { checkInAt: "2026-10-21T08:00:00Z", checkOutAt: "2026-10-21T07:30:00Z" },
      "checkOutAt"
    )
    await bad(
      { checkInAt: "2026-10-21T19:00:00Z", checkOutAt: "2026-10-21T21:00:00Z" },
      "checkOutAt"
    ) // past Dubai midnight
    await bad(
      { checkInAt: "2026-10-21T06:00:00Z", checkOutAt: "2026-10-21T08:00:00Z" },
      "checkInAt"
    ) // overlaps
    await bad(
      { checkInAt: "2026-10-21T09:00:00Z", checkOutAt: "2026-10-21T11:00:00Z" },
      "checkOutAt"
    ) // future

    const removed = await api.request<Detail>(
      "DELETE",
      `/attendance/sessions/${added.body.sessions[0]!.id}`,
      { token: o.admin.token, body: { reason: "duplicate entry" } }
    )
    expect(removed.status).toBe(200)
    expect(removed.body.sessions).toEqual([])
  })

  it("are refused to Employees and Managers (403), and to other companies (404) (BE-07 AC)", async () => {
    travelTo("2026-10-22T06:00:00Z")
    const o = await org("Oscar")
    const other = await org("Papa")
    const session = (await checkIn(o.employee)).body.openSession!
    for (const member of [o.employee, o.manager]) {
      const response = await api.patch(
        `/attendance/sessions/${session.id}`,
        { checkOutAt: "2026-10-22T06:01:00Z", reason: "mine" },
        member.token
      )
      expect(response.status).toBe(403)
    }
    expect(
      (
        await api.patch(
          `/attendance/sessions/${session.id}`,
          { checkOutAt: "2026-10-22T06:01:00Z", reason: "x" },
          other.admin.token
        )
      ).status
    ).toBe(404)
  })
})

describe("views", () => {
  it("show Employees themselves, Managers their team, Admins everyone; others' days are 404", async () => {
    travelTo("2026-10-25T06:00:00Z")
    const o = await org("Quebec")
    const ids = async (member: Member) =>
      (
        await api.get<{ items: { employee: { id: string } }[] }>(
          "/attendance/days?date=2026-10-25",
          member.token
        )
      ).body.items
        .map((i) => i.employee.id)
        .sort()
    expect(await ids(o.employee)).toEqual([o.employee.id])
    expect(await ids(o.manager)).toEqual([o.employee.id, o.manager.id].sort())
    expect(await ids(o.admin)).toHaveLength(4)

    const month = await api.get<{
      items: { days: unknown[] }[]
      from: string
      to: string
    }>("/attendance/month?month=2026-02", o.employee.token)
    expect(month.body).toMatchObject({ from: "2026-02-01", to: "2026-02-28" })
    expect(month.body.items[0]!.days).toHaveLength(28)

    expect(
      (
        await api.get(
          `/attendance/employees/${o.colleague.id}/days/2026-10-25`,
          o.employee.token
        )
      ).status
    ).toBe(404)
    expect(
      (
        await api.get(
          `/attendance/employees/${o.employee.id}/days/2026-10-25`,
          o.manager.token
        )
      ).status
    ).toBe(200)
  })

  it("lists exceptions for the Admin only", async () => {
    travelTo("2026-10-26T06:00:00Z")
    const o = await org("Romeo")
    travelTo("2026-10-26T20:30:00Z")
    await close()
    const admin = await relogin(o.admin, o.companyId)
    const list = await api.get<{
      items: { status: string }[]
      meta: { totalItems: number }
    }>(
      "/attendance/exceptions?from=2026-10-26&to=2026-10-26&type=ABSENT",
      admin
    )
    expect(list.status).toBe(200)
    expect(list.body.meta.totalItems).toBe(4)
    expect(
      (
        await api.get(
          "/attendance/exceptions?from=2026-10-26&to=2026-10-26",
          await relogin(o.manager, o.companyId)
        )
      ).status
    ).toBe(403)
  })
})
