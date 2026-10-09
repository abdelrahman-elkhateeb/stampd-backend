import { afterEach, describe, expect, it } from "vitest"

import { HistoryEntryModel } from "../../src/modules/history/history.model.ts"
import {
  timezoneAt,
  timezoneOn,
} from "../../src/modules/organization/calendar.ts"
import { CompanyModel } from "../../src/modules/organization/company.model.ts"
import { EmployeeModel } from "../../src/modules/organization/employee.model.ts"
import { registerAffectedRequestFinder } from "../../src/modules/organization/settings.service.ts"
import { StoredFileModel } from "../../src/platform/storage/files.ts"
import { addDays, plainDateInZone } from "../../src/platform/time/time.ts"
import { useApi } from "./api.ts"
import { useTestDatabase } from "./database.ts"
import { newCompany } from "./people.ts"

/** Company settings, work calendar, holidays and uploads (Trello BE-05). */
useTestDatabase()
const api = useApi()

const forbidden = { code: "FORBIDDEN", message: "Not allowed for this role" }

async function org(name: string) {
  const company = await newCompany(api, name)
  const manager = await company.add("MANAGER", company.admin.id)
  const employee = await company.add("EMPLOYEE", manager.id)
  return { ...company, manager, employee }
}

const historyOf = (companyId: string, entityId: string) =>
  HistoryEntryModel.find({ companyId, entityId }).sort({ at: 1 }).lean()

describe("company settings", () => {
  it("are readable by every role, with the defaults of a new company", async () => {
    const o = await org("Alpha")
    for (const member of [o.admin, o.manager, o.employee]) {
      const response = await api.get("/company/settings", member.token)
      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        name: "Alpha",
        logoUrl: null,
        timezone: "Asia/Dubai",
        timezoneEffectiveFrom: null,
        weekStart: "SUN",
        workingDays: ["SUN", "MON", "TUE", "WED", "THU"],
        workStartTime: "09:00",
        workEndTime: "17:00",
        lateGraceMinutes: 0,
        leaveYearStartMonth: 1,
      })
    }
  })

  it("can be changed by the Admin, and the change is recorded in history", async () => {
    const o = await org("Bravo")
    const response = await api.patch(
      "/company/settings",
      {
        workingDays: ["MON", "TUE", "WED", "THU", "FRI"],
        workStartTime: "08:30",
        lateGraceMinutes: 10,
        leaveYearStartMonth: 4,
      },
      o.admin.token
    )
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      workingDays: ["MON", "TUE", "WED", "THU", "FRI"],
      workStartTime: "08:30",
      workEndTime: "17:00",
      lateGraceMinutes: 10,
      leaveYearStartMonth: 4,
    })

    const [entry] = await historyOf(o.companyId, o.companyId)
    expect(entry).toMatchObject({
      action: "companySettings.changed",
      actorId: o.admin.id,
      oldValues: {
        workingDays: ["SUN", "MON", "TUE", "WED", "THU"],
        workStartTime: "09:00",
        lateGraceMinutes: 0,
        leaveYearStartMonth: 1,
      },
      newValues: {
        workingDays: ["MON", "TUE", "WED", "THU", "FRI"],
        workStartTime: "08:30",
        lateGraceMinutes: 10,
        leaveYearStartMonth: 4,
      },
    })
    // Readable through the BE-04 history endpoint.
    const history = await api.get<{ items: unknown[] }>(
      `/history/company-settings/${o.companyId}`,
      o.employee.token
    )
    expect(history.body.items).toHaveLength(1)
  })

  it("refuse Employees and Managers (403), and nothing changes", async () => {
    const o = await org("Charlie")
    for (const member of [o.employee, o.manager]) {
      const response = await api.patch(
        "/company/settings",
        { name: "Hijacked" },
        member.token
      )
      expect(response.status).toBe(403)
      expect(response.body).toEqual(forbidden)
    }
    expect((await CompanyModel.findById(o.companyId).lean())?.name).toBe(
      "Charlie"
    )
    expect(await historyOf(o.companyId, o.companyId)).toHaveLength(0)
  })

  it("validate every field, and work end after work start", async () => {
    const o = await org("Delta")
    const invalid = await api.patch(
      "/company/settings",
      {
        timezone: "Mars/Olympus",
        workingDays: [],
        workStartTime: "25:00",
        lateGraceMinutes: -1,
        leaveYearStartMonth: 13,
      },
      o.admin.token
    )
    expect(invalid.status).toBe(422)
    expect(
      (invalid.body as { fieldErrors: { field: string }[] }).fieldErrors
        .map((error) => error.field)
        .sort()
    ).toEqual([
      "lateGraceMinutes",
      "leaveYearStartMonth",
      "timezone",
      "workStartTime",
      "workingDays",
    ])

    const backwards = await api.patch(
      "/company/settings",
      { workStartTime: "18:00" },
      o.admin.token
    )
    expect(backwards.status).toBe(422)
    expect(backwards.body).toMatchObject({
      fieldErrors: [{ field: "workEndTime", code: "OUT_OF_RANGE" }],
    })
    expect(
      (await CompanyModel.findById(o.companyId).lean())?.workStartTime
    ).toBe("09:00")
  })

  it("apply a timezone change from the next day, with history (BE-05 AC)", async () => {
    const o = await org("Echo")
    const now = api.clock.now()
    const today = plainDateInZone(now, "Asia/Dubai")

    const response = await api.patch(
      "/company/settings",
      { timezone: "Asia/Riyadh" },
      o.admin.token
    )
    expect(response.body).toMatchObject({
      timezone: "Asia/Riyadh",
      timezoneEffectiveFrom: addDays(today, 1),
    })

    const company = (await CompanyModel.findById(o.companyId).lean())!
    expect(timezoneOn(company, today)).toBe("Asia/Dubai")
    expect(timezoneOn(company, addDays(today, 1))).toBe("Asia/Riyadh")
    expect(timezoneAt(company, now)).toBe("Asia/Dubai")

    // A second change the same day replaces the newest value only.
    await api.patch(
      "/company/settings",
      { timezone: "Asia/Kuwait" },
      o.admin.token
    )
    const again = (await CompanyModel.findById(o.companyId).lean())!
    expect(again.timezoneHistory).toEqual([
      { timezone: "Asia/Dubai", until: today },
    ])
    expect(timezoneOn(again, addDays(today, 1))).toBe("Asia/Kuwait")

    const entries = await historyOf(o.companyId, o.companyId)
    expect(entries.map((e) => e.newValues)).toEqual([
      { timezone: "Asia/Riyadh" },
      { timezone: "Asia/Kuwait" },
    ])
  })
})

describe("holidays", () => {
  let unregister: (() => void) | undefined
  afterEach(() => unregister?.())

  it("are managed by the Admin with start and end dates, and listed per year for everyone", async () => {
    const o = await org("Foxtrot")
    const created = await api.post<{
      holiday: { id: string }
      affectedRequests: unknown[]
    }>(
      "/company/holidays",
      { name: "New Year", startDate: "2026-12-31", endDate: "2027-01-02" },
      o.admin.token
    )
    expect(created.status).toBe(201)
    expect(created.body).toEqual({
      holiday: {
        id: expect.any(String),
        name: "New Year",
        startDate: "2026-12-31",
        endDate: "2027-01-02",
      },
      affectedRequests: [],
    })
    await api.post(
      "/company/holidays",
      { name: "National Day", startDate: "2026-12-02", endDate: "2026-12-03" },
      o.admin.token
    )

    // A holiday belongs to every year it touches.
    const in2026 = await api.get<{ year: number; items: { name: string }[] }>(
      "/company/holidays?year=2026",
      o.employee.token
    )
    expect(in2026.body.year).toBe(2026)
    expect(in2026.body.items.map((h) => h.name)).toEqual([
      "National Day",
      "New Year",
    ])
    const in2027 = await api.get<{ items: { name: string }[] }>(
      "/company/holidays?year=2027",
      o.employee.token
    )
    expect(in2027.body.items.map((h) => h.name)).toEqual(["New Year"])
    // Without ?year, the company's current year.
    expect(
      (await api.get<{ year: number }>("/company/holidays", o.employee.token))
        .body.year
    ).toBe(2026)

    const id = created.body.holiday.id
    const changed = await api.patch(
      `/company/holidays/${id}`,
      { endDate: "2027-01-01" },
      o.admin.token
    )
    expect(changed.status).toBe(200)
    expect(changed.body).toMatchObject({
      holiday: { startDate: "2026-12-31", endDate: "2027-01-01" },
    })

    const removed = await api.request("DELETE", `/company/holidays/${id}`, {
      token: o.admin.token,
    })
    expect(removed.status).toBe(204)
    expect(
      (
        await api.request("DELETE", `/company/holidays/${id}`, {
          token: o.admin.token,
        })
      ).status
    ).toBe(404)

    const actions = (await historyOf(o.companyId, o.companyId)).map(
      (e) => e.action
    )
    expect(actions).toEqual([
      "holiday.added",
      "holiday.added",
      "holiday.changed",
      "holiday.removed",
    ])
  })

  it("refuse Employees and Managers (403)", async () => {
    const o = await org("Golf")
    for (const member of [o.employee, o.manager]) {
      const response = await api.post(
        "/company/holidays",
        { name: "Day off", startDate: "2026-11-01", endDate: "2026-11-01" },
        member.token
      )
      expect(response.status).toBe(403)
    }
  })

  it("validate the range: end on or after start, at most 31 days", async () => {
    const o = await org("Hotel")
    const backwards = await api.post(
      "/company/holidays",
      { name: "X", startDate: "2026-11-05", endDate: "2026-11-04" },
      o.admin.token
    )
    expect(backwards.status).toBe(422)
    expect(backwards.body).toMatchObject({
      fieldErrors: [{ field: "endDate", code: "OUT_OF_RANGE" }],
    })
    const tooLong = await api.post(
      "/company/holidays",
      { name: "X", startDate: "2026-11-01", endDate: "2026-12-02" },
      o.admin.token
    )
    expect(tooLong.status).toBe(422)
    const badDate = await api.post(
      "/company/holidays",
      { name: "X", startDate: "2026-02-30", endDate: "2026-03-01" },
      o.admin.token
    )
    expect(badDate.body).toMatchObject({
      fieldErrors: [{ field: "startDate", code: "INVALID_FORMAT" }],
    })
  })

  it("return the approved requests on the holiday's dates, without changing them (BE-05 AC)", async () => {
    const o = await org("India")
    const asked: unknown[] = []
    unregister = registerAffectedRequestFinder(async (input) => {
      asked.push(input)
      return [
        {
          requestId: "r-1",
          employeeId: o.employee.id,
          employeeName: o.employee.name,
          type: "LEAVE",
          startDate: "2026-11-02",
          endDate: "2026-11-04",
        },
      ]
    })
    const response = await api.post<{ affectedRequests: unknown[] }>(
      "/company/holidays",
      { name: "Flag Day", startDate: "2026-11-03", endDate: "2026-11-03" },
      o.admin.token
    )
    expect(response.body.affectedRequests).toEqual([
      expect.objectContaining({ requestId: "r-1", type: "LEAVE" }),
    ])
    expect(asked).toEqual([
      {
        companyId: o.companyId,
        startDate: "2026-11-03",
        endDate: "2026-11-03",
      },
    ])
  })

  it("of another company can't be changed or deleted (404)", async () => {
    const a = await org("Juliett")
    const b = await org("Kilo")
    const created = await api.post<{ holiday: { id: string } }>(
      "/company/holidays",
      { name: "B's day", startDate: "2026-11-10", endDate: "2026-11-10" },
      b.admin.token
    )
    const path = `/company/holidays/${created.body.holiday.id}`
    expect(
      (await api.patch(path, { name: "Mine" }, a.admin.token)).status
    ).toBe(404)
    expect(
      (await api.request("DELETE", path, { token: a.admin.token })).status
    ).toBe(404)
    expect(
      (
        await api.get<{ items: unknown[] }>(
          "/company/holidays?year=2026",
          a.admin.token
        )
      ).body.items
    ).toEqual([])
  })
})

describe("work calendar endpoint", () => {
  it("lists each day with working / holiday, and counts working days", async () => {
    const o = await org("Lima")
    await api.post(
      "/company/holidays",
      { name: "Founding Day", startDate: "2026-10-14", endDate: "2026-10-14" },
      o.admin.token
    )
    const response = await api.get<{
      workingDayCount: number
      days: { date: string; working: boolean; holiday: unknown }[]
    }>(
      "/company/calendar?from=2026-10-08&to=2026-10-14&halfDayEnd=true",
      o.employee.token
    )
    expect(response.status).toBe(200)
    // Thu 8, Sun 11, Mon 12, Tue 13 work; Wed 14 is a holiday; Fri/Sat off.
    expect(response.body.workingDayCount).toBe(4)
    expect(response.body.days).toHaveLength(7)
    expect(response.body.days[0]).toEqual({
      date: "2026-10-08",
      weekday: "THU",
      working: true,
      holiday: null,
    })
    expect(response.body.days[6]).toEqual({
      date: "2026-10-14",
      weekday: "WED",
      working: false,
      holiday: { id: expect.any(String), name: "Founding Day" },
    })
  })

  it("refuses reversed and over-long ranges", async () => {
    const o = await org("Mike")
    expect(
      (
        await api.get(
          "/company/calendar?from=2026-10-09&to=2026-10-08",
          o.employee.token
        )
      ).status
    ).toBe(422)
    expect(
      (
        await api.get(
          "/company/calendar?from=2026-01-01&to=2027-01-02",
          o.employee.token
        )
      ).status
    ).toBe(422)
  })
})

describe("uploads", () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(100, 1),
  ])
  const upload = (
    path: string,
    token: string,
    bytes: Uint8Array = png,
    contentType = "image/png"
  ) =>
    api.request<{ logoUrl?: string; photoUrl?: string }>("PUT", path, {
      token,
      raw: { bytes, contentType },
    })
  const download = (url: string) => fetch(`${api.url()}${url}`)

  it("lets the Admin set the company logo, served by a signed URL", async () => {
    const o = await org("November")
    const response = await upload("/company/logo", o.admin.token)
    expect(response.status).toBe(200)
    const logoUrl = response.body.logoUrl!
    expect(logoUrl).toMatch(/^\/files\/[0-9a-f-]{36}\?expires=\d+&signature=/)

    const file = await download(logoUrl)
    expect(file.status).toBe(200)
    expect(file.headers.get("content-type")).toBe("image/png")
    expect(Buffer.from(await file.arrayBuffer())).toEqual(png)

    expect(
      (
        await api.get<{ logoUrl: string }>(
          "/company/settings",
          o.employee.token
        )
      ).body.logoUrl
    ).toMatch(/^\/files\//)
    const [entry] = await historyOf(o.companyId, o.companyId)
    expect(entry).toMatchObject({
      action: "companySettings.changed",
      oldValues: { logoFileId: null },
    })
  })

  it("replaces the old file on a new upload, and removes it on delete", async () => {
    const o = await org("Oscar")
    await upload("/company/logo", o.admin.token)
    await upload("/company/logo", o.admin.token)
    expect(
      await StoredFileModel.countDocuments({ companyId: o.companyId })
    ).toBe(1)
    const removed = await api.request("DELETE", "/company/logo", {
      token: o.admin.token,
    })
    expect(removed.status).toBe(204)
    expect(
      await StoredFileModel.countDocuments({ companyId: o.companyId })
    ).toBe(0)
    expect(
      (await api.get("/company/settings", o.admin.token)).body.logoUrl
    ).toBeNull()
  })

  it("refuses the logo to Employees and Managers (403)", async () => {
    const o = await org("Papa")
    for (const member of [o.employee, o.manager]) {
      const response = await upload("/company/logo", member.token)
      expect(response.status).toBe(403)
    }
    expect(
      await StoredFileModel.countDocuments({ companyId: o.companyId })
    ).toBe(0)
  })

  it("refuses files over 2 MB and anything that isn't PNG, JPEG or WebP (BE-05 AC)", async () => {
    const o = await org("Quebec")
    const big = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)])
    const tooBig = await upload("/company/logo", o.admin.token, big)
    expect(tooBig.status).toBe(422)
    expect(tooBig.body).toMatchObject({
      fieldErrors: [{ field: "file", code: "FILE_TOO_LARGE" }],
    })

    for (const [bytes, contentType] of [
      [
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        "image/svg+xml",
      ],
      [Buffer.from("%PDF-1.7 ..."), "image/png"], // lying Content-Type
      [Buffer.from("GIF89a......"), "image/gif"],
    ] as const) {
      const response = await upload(
        "/company/logo",
        o.admin.token,
        bytes,
        contentType
      )
      expect(response.status).toBe(422)
      expect(response.body).toMatchObject({
        fieldErrors: [{ field: "file", code: "UNSUPPORTED_FILE_TYPE" }],
      })
    }
    const empty = await upload("/company/logo", o.admin.token, Buffer.alloc(0))
    expect(empty.body).toMatchObject({
      fieldErrors: [{ field: "file", code: "REQUIRED" }],
    })
    expect(
      await StoredFileModel.countDocuments({ companyId: o.companyId })
    ).toBe(0)
  })

  it("lets employees set their own photo and the Admin anyone's; others get 404", async () => {
    const o = await org("Romeo")
    const own = await upload(
      `/employees/${o.employee.id}/photo`,
      o.employee.token
    )
    expect(own.status).toBe(200)
    expect(own.body.photoUrl).toMatch(/^\/files\//)
    expect(
      (await upload(`/employees/${o.employee.id}/photo`, o.admin.token)).status
    ).toBe(200)

    // Not even the employee's manager can change it.
    expect(
      (await upload(`/employees/${o.employee.id}/photo`, o.manager.token))
        .status
    ).toBe(404)
    expect(
      (await upload(`/employees/${o.manager.id}/photo`, o.employee.token))
        .status
    ).toBe(404)

    const entries = await historyOf(o.companyId, o.employee.id)
    expect(
      entries.filter((e) => e.action === "employee.photoChanged")
    ).toHaveLength(2)
  })

  it("keeps another company's files out of reach (BE-05 AC)", async () => {
    const a = await org("Sierra")
    const b = await org("Tango")
    const bPhoto = await upload(
      `/employees/${b.employee.id}/photo`,
      b.employee.token
    )

    // Can't replace B's photo, even as A's Admin.
    expect(
      (await upload(`/employees/${b.employee.id}/photo`, a.admin.token)).status
    ).toBe(404)
    expect(
      (
        await api.request("DELETE", `/employees/${b.employee.id}/photo`, {
          token: a.admin.token,
        })
      ).status
    ).toBe(404)

    // Can't read it without the signed URL: the bare id, a token or a
    // forged or expired signature all give 404.
    const url = new URL(bPhoto.body.photoUrl!, "http://x")
    const id = url.pathname.split("/").at(-1)!
    const expires = url.searchParams.get("expires")!
    const fileFetch = (path: string, token?: string) =>
      fetch(`${api.url()}${path}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
    expect((await fileFetch(`/files/${id}`, a.admin.token)).status).toBe(422)
    expect(
      (await fileFetch(`/files/${id}?expires=${expires}&signature=forged`))
        .status
    ).toBe(404)
    const aLogo = await upload("/company/logo", a.admin.token)
    const aSig = new URL(aLogo.body.logoUrl!, "http://x").searchParams.get(
      "signature"
    )
    expect(
      (await fileFetch(`/files/${id}?expires=${expires}&signature=${aSig}`))
        .status
    ).toBe(404)

    api.clock.advance(49 * 3600 * 1000)
    expect((await fileFetch(bPhoto.body.photoUrl!)).status).toBe(404)
    api.clock.advance(-49 * 3600 * 1000)
    expect((await fileFetch(bPhoto.body.photoUrl!)).status).toBe(200)

    expect(
      (
        await EmployeeModel.findOne({
          _id: b.employee.id,
          companyId: b.companyId,
        }).lean()
      )?.photoFileId
    ).toBe(id)
  })
})
