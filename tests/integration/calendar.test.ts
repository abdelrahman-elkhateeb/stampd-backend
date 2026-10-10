import { beforeAll, describe, expect, it } from "vitest"

import { useApi } from "./api.ts"
import { useTestDatabase } from "./database.ts"
import { newCompany, type Member } from "./people.ts"

/** Company calendar and availability (Trello BE-12). */
useTestDatabase()
const api = useApi()

type Event = {
  kind: string
  requestId?: string
  tentative?: boolean
  colleague?: true
  employee?: { id: string; name: string }
  name?: string
  startDate: string
  endDate: string
  leaveType?: { name: string } | null
  reason?: string | null
  destination?: string | null
}

/**
 *   Admin ── manager M ── e1 (Ops), e2 (Sales)
 *        └── manager OM ─ e3 (Ops)
 * November 2026 (Sun–Thu week), all recorded by the Admin as approved unless noted.
 */
let world: Awaited<ReturnType<typeof build>>
async function build() {
  api.clock.advance(
    new Date("2026-10-12T06:00:00Z").getTime() - api.clock.now().getTime()
  )
  const c = await newCompany(api, "Calendar Co")
  const m = await c.add("MANAGER", c.admin.id)
  const om = await c.add("MANAGER", c.admin.id)
  const e1 = await c.add("EMPLOYEE", m.id)
  const e2 = await c.add("EMPLOYEE", m.id)
  const e3 = await c.add("EMPLOYEE", om.id)
  const dept = async (name: string, members: Member[]) => {
    const d = await api.post<{ id: string }>(
      "/departments",
      { name },
      c.admin.token
    )
    for (const member of members) {
      await api.patch(
        `/employees/${member.id}`,
        { departmentId: d.body.id },
        c.admin.token
      )
    }
  }
  await dept("Ops", [e1, e3])
  await dept("Sales", [e2])
  const types = (
    await api.get<{ items: { id: string; name: string }[] }>(
      "/leave/types",
      c.admin.token
    )
  ).body.items
  const sick = types.find((t) => t.name === "Sick")!.id
  const annual = types.find((t) => t.name === "Annual")!.id

  const record = async (
    who: Member,
    body: Record<string, unknown>,
    approved = true
  ) =>
    (
      await api.post<{ id: string }>(
        "/requests",
        { employeeId: who.id, approved, ...body },
        c.admin.token
      )
    ).body.id
  const ids = {
    e1Sick: await record(e1, {
      type: "LEAVE",
      startDate: "2026-11-02",
      endDate: "2026-11-03",
      reason: "Flu",
      data: { leaveTypeId: sick },
    }),
    e2Wfh: await record(e2, { type: "WFH", startDate: "2026-11-04" }),
    e3Trip: await record(e3, {
      type: "BUSINESS_TRIP",
      startDate: "2026-11-05",
      data: { destination: "Doha", purpose: "Expo" },
    }),
    e3Leave: await record(e3, {
      type: "LEAVE",
      startDate: "2026-11-09",
      endDate: "2026-11-09",
      data: { leaveTypeId: annual },
    }),
    e1Permission: await record(e1, {
      type: "PERMISSION",
      startDate: "2026-11-10",
      startTime: "09:00",
      endTime: "10:00",
    }),
    e3Wfh: await record(e3, { type: "WFH", startDate: "2026-11-11" }),
    e2Pending: await record(
      e2,
      {
        type: "LEAVE",
        startDate: "2026-11-16",
        endDate: "2026-11-16",
        data: { leaveTypeId: annual },
      },
      false
    ),
  }
  // A rejected and a cancelled request: they must never show.
  const rejected = (
    await api.post<{ id: string }>(
      "/requests",
      { type: "WFH", startDate: "2026-11-11" },
      e1.token
    )
  ).body.id
  await api.post(
    `/requests/${rejected}/reject`,
    { reason: "Office day" },
    m.token
  )
  const cancelled = await record(e2, {
    type: "BUSINESS_TRIP",
    startDate: "2026-11-12",
    data: { destination: "Jeddah", purpose: "Audit" },
  })
  await api.post(
    `/requests/${cancelled}/cancel`,
    { reason: "Postponed" },
    c.admin.token
  )

  await api.post(
    "/company/holidays",
    { name: "Flag Day", startDate: "2026-11-18", endDate: "2026-11-18" },
    c.admin.token
  )
  return { ...c, m, om, e1, e2, e3, ids, rejected, cancelled }
}

beforeAll(async () => {
  world = await build()
})

const events = async (member: Member, query = "") => {
  const response = await api.get<{ events: Event[] }>(
    `/calendar/events?from=2026-11-01&to=2026-11-30${query}`,
    member.token
  )
  expect(response.status).toBe(200)
  return response.body.events
}
const requestIds = (list: Event[]) =>
  list.flatMap((e) => (e.requestId ? [e.requestId] : []))

describe("calendar events", () => {
  it("give a Manager their direct reports in detail plus holidays, nothing about other teams (BE-12 AC)", async () => {
    const list = await events(world.m)
    expect(requestIds(list).sort()).toEqual(
      [world.ids.e1Sick, world.ids.e2Wfh, world.ids.e1Permission].sort()
    )
    expect(list.find((e) => e.requestId === world.ids.e1Sick)).toMatchObject({
      kind: "LEAVE",
      tentative: false,
      employee: { id: world.e1.id },
      leaveType: { name: "Sick" },
      reason: "Flu",
    })
    expect(list).toContainEqual(
      expect.objectContaining({
        kind: "HOLIDAY",
        name: "Flag Day",
        startDate: "2026-11-18",
      })
    )
    expect(list.some((e) => e.employee?.id === world.e3.id)).toBe(false)
  })

  it("show an Employee same-department colleagues' leave as Out and WFH as WFH, nothing more (BE-12 AC)", async () => {
    const list = await events(world.e1)
    const colleague = list.filter((e) => e.colleague)
    expect(colleague).toEqual([
      {
        kind: "OUT",
        colleague: true,
        employee: { id: world.e3.id, name: world.e3.name },
        startDate: "2026-11-09",
        endDate: "2026-11-09",
      },
      {
        kind: "WFH",
        colleague: true,
        employee: { id: world.e3.id, name: world.e3.name },
        startDate: "2026-11-11",
        endDate: "2026-11-11",
      },
    ])
    // The colleague's business trip, and anyone in another department (e2), never.
    expect(list.some((e) => e.kind === "BUSINESS_TRIP")).toBe(false)
    expect(list.some((e) => e.employee?.id === world.e2.id)).toBe(false)
    // Their own events in full.
    expect(list.find((e) => e.requestId === world.ids.e1Sick)).toMatchObject({
      leaveType: { name: "Sick" },
      reason: "Flu",
    })
    expect(
      list.find((e) => e.requestId === world.ids.e1Permission)
    ).toMatchObject({ kind: "PERMISSION" })
  })

  it("add pending requests as tentative for approvers (BE-12 AC)", async () => {
    expect(requestIds(await events(world.m))).not.toContain(world.ids.e2Pending)
    const withPending = await events(world.m, "&includePending=true")
    expect(
      withPending.find((e) => e.requestId === world.ids.e2Pending)
    ).toMatchObject({
      kind: "LEAVE",
      tentative: true,
    })
    // A colleague's pending request never reaches an Employee.
    expect(
      requestIds(await events(world.e1, "&includePending=true"))
    ).not.toContain(world.ids.e2Pending)
  })

  it("never show rejected or cancelled requests (BE-12 AC)", async () => {
    const all = requestIds(await events(world.admin, "&includePending=true"))
    expect(all).not.toContain(world.rejected)
    expect(all).not.toContain(world.cancelled)
    expect(all).toContain(world.ids.e3Trip)
  })

  it("refuse more than 3 months (BE-12 AC)", async () => {
    const tooLong = await api.get(
      "/calendar/events?from=2026-11-01&to=2027-02-15",
      world.admin.token
    )
    expect(tooLong.status).toBe(422)
    expect(tooLong.body).toMatchObject({
      fieldErrors: [{ field: "to", code: "OUT_OF_RANGE" }],
    })
  })

  it("never return another company's events (BE-12 AC)", async () => {
    const other = await newCompany(api, "Elsewhere")
    const list = await events(other.admin)
    expect(list).toEqual([])
  })

  it("filter by type, team, department and employee", async () => {
    expect(
      (await events(world.admin, "&type=HOLIDAY")).map((e) => e.kind)
    ).toEqual(["HOLIDAY"])
    // The Admin's direct reports are the two managers: none of them has events.
    expect(requestIds(await events(world.admin, "&team=true"))).toEqual([])
    expect(requestIds(await events(world.m, "&team=true")).sort()).toEqual(
      [world.ids.e1Sick, world.ids.e2Wfh, world.ids.e1Permission].sort()
    )
    expect(
      requestIds(await events(world.admin, `&employeeId=${world.e3.id}`)).sort()
    ).toEqual([world.ids.e3Trip, world.ids.e3Leave, world.ids.e3Wfh].sort())
    // A Manager filtering on someone outside their team sees nothing about them.
    expect(
      requestIds(await events(world.m, `&employeeId=${world.e3.id}`))
    ).toEqual([])
  })
})

describe("availability", () => {
  it("counts out / WFH / in-office per day for the caller's scope", async () => {
    const response = await api.get<{
      days: {
        date: string
        working: boolean
        holiday: string | null
        total: number
        out: number
        wfh: number
        inOffice: number
      }[]
    }>(
      "/calendar/availability?from=2026-11-02&to=2026-11-07",
      world.admin.token
    )
    const day = (date: string) =>
      response.body.days.find((d) => d.date === date)!
    // Admin + 2 managers + 3 employees = 6 people.
    expect(day("2026-11-02")).toEqual({
      date: "2026-11-02",
      working: true,
      holiday: null,
      total: 6,
      out: 1,
      wfh: 0,
      inOffice: 5,
    })
    expect(day("2026-11-04")).toMatchObject({ out: 0, wfh: 1, inOffice: 5 })
    expect(day("2026-11-05")).toMatchObject({ out: 1 }) // e3's business trip
    expect(day("2026-11-06")).toMatchObject({ working: false, total: 0 }) // Friday
  })

  it("never reveals a colleague's trip to an Employee: they count as in the office", async () => {
    const response = await api.get<{
      days: { date: string; out: number; inOffice: number; total: number }[]
    }>("/calendar/availability?from=2026-11-05&to=2026-11-05", world.e1.token)
    // e1 sees themselves and e3 (same department).
    expect(response.body.days[0]).toMatchObject({
      total: 2,
      out: 0,
      inOffice: 2,
    })
  })
})
