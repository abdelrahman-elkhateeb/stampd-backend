import { describe, expect, it } from "vitest"

import {
  deductApprovedDays,
  getBalance,
  releaseReservation,
  reserveDays,
  restoreDays,
  setEntitlement,
} from "../../src/modules/leave/balance.service.ts"
import {
  LeaveBalanceModel,
  LeaveLedgerEntryModel,
  LeaveYearRunModel,
} from "../../src/modules/leave/leave.model.ts"
import { runLeaveRollover } from "../../src/modules/leave/rollover-job.ts"
import { useApi } from "./api.ts"
import { useTestDatabase } from "./database.ts"
import { newCompany, type Member } from "./people.ts"

/** Leave types, policies and the balance ledger (Trello BE-08). */
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

type LeaveType = {
  id: string
  name: string
  tracksBalance: boolean
  inUse: boolean
  archived: boolean
}
type Balance = {
  balanceId: string | null
  leaveType: { id: string; name: string }
  year: number
  tracked: boolean
  proposedEntitlement: number | null
  entitlementSource: string | null
  entitlement: number | null
  adjustments: number | null
  used: number | null
  upcoming: number | null
  pending: number | null
  available: number | null
}

const travelTo = (instant: string) =>
  api.clock.advance(new Date(instant).getTime() - api.clock.now().getTime())

async function org(name: string) {
  const company = await newCompany(api, name)
  const manager = await company.add("MANAGER", company.admin.id)
  const employee = await company.add("EMPLOYEE", manager.id)
  const colleague = await company.add("EMPLOYEE", company.admin.id)
  const types = (
    await api.get<{ items: LeaveType[] }>("/leave/types", company.admin.token)
  ).body.items
  const type = (name: string) => types.find((t) => t.name === name)!
  return { ...company, manager, employee, colleague, type }
}

const balances = (member: Member, employeeId: string, query = "") =>
  api.get<{ year: number; items: Balance[] }>(
    `/leave/employees/${employeeId}/balances${query}`,
    member.token
  )
const balanceOf = async (
  member: Member,
  employeeId: string,
  typeName: string
) =>
  (await balances(member, employeeId)).body.items.find(
    (b) => b.leaveType.name === typeName
  )!

describe("leave types", () => {
  it("start with Annual, Sick, Emergency and Unpaid, readable by every role", async () => {
    travelTo("2026-10-10T08:00:00Z")
    const o = await org("Alpha")
    const list = await api.get<{ items: LeaveType[] }>(
      "/leave/types",
      o.employee.token
    )
    expect(list.status).toBe(200)
    expect(list.body.items.map((t) => t.name)).toEqual([
      "Annual",
      "Emergency",
      "Sick",
      "Unpaid",
    ])
    expect(o.type("Unpaid")).toMatchObject({
      tracksBalance: false,
      inUse: false,
    })
  })

  it("are added, changed and archived by the Admin only; names are unique", async () => {
    const o = await org("Bravo")
    const created = await api.post<LeaveType>(
      "/leave/types",
      {
        name: "Hajj",
        icon: "hajj",
        defaultAllowanceDays: 10,
        requiresReason: true,
      },
      o.admin.token
    )
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      name: "Hajj",
      icon: "hajj",
      paid: true,
      tracksBalance: true,
      defaultAllowanceDays: 10,
      halfDaysAllowed: true,
      archived: false,
    })
    const duplicate = await api.post(
      "/leave/types",
      { name: "hajj" },
      o.admin.token
    )
    expect(duplicate.body).toMatchObject({
      fieldErrors: [{ field: "name", code: "ALREADY_EXISTS" }],
    })
    const halfDay = await api.post(
      "/leave/types",
      { name: "Odd", defaultAllowanceDays: 2.3 },
      o.admin.token
    )
    expect(halfDay.status).toBe(422)

    for (const member of [o.employee, o.manager]) {
      expect(
        (await api.post("/leave/types", { name: "Mine" }, member.token)).status
      ).toBe(403)
    }

    const archived = await api.patch<LeaveType>(
      `/leave/types/${created.body.id}`,
      { archived: true },
      o.admin.token
    )
    expect(archived.body.archived).toBe(true)
    const visible = await api.get<{ items: LeaveType[] }>(
      "/leave/types",
      o.employee.token
    )
    expect(visible.body.items.map((t) => t.name)).not.toContain("Hajj")
    const all = await api.get<{ items: LeaveType[] }>(
      "/leave/types?includeArchived=true",
      o.admin.token
    )
    expect(all.body.items.map((t) => t.name)).toContain("Hajj")
  })

  it("can be deleted while unused; once used, deletion is refused and archive offered (BE-08 AC)", async () => {
    const o = await org("Charlie")
    const fresh = await api.post<LeaveType>(
      "/leave/types",
      { name: "Study", defaultAllowanceDays: 5 },
      o.admin.token
    )
    // Reading balances creates its (unused) entitlements; deletion is still fine.
    await balances(o.admin, o.employee.id)
    expect(
      (
        await api.request("DELETE", `/leave/types/${fresh.body.id}`, {
          token: o.admin.token,
        })
      ).status
    ).toBe(204)

    const annual = o.type("Annual")
    await reserveDays(
      {
        companyId: o.companyId,
        employeeId: o.employee.id,
        leaveTypeId: annual.id,
        requestId: "r-1",
        days: 1,
        actor: { type: "USER", userId: o.employee.id },
      },
      deps
    )
    const refused = await api.request("DELETE", `/leave/types/${annual.id}`, {
      token: o.admin.token,
    })
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ code: "LEAVE_TYPE_IN_USE" })
    const stopTracking = await api.patch(
      `/leave/types/${annual.id}`,
      { tracksBalance: false },
      o.admin.token
    )
    expect(stopTracking.status).toBe(409)
    expect(
      (
        await api.patch(
          `/leave/types/${annual.id}`,
          { archived: true },
          o.admin.token
        )
      ).status
    ).toBe(200)
  })
})

describe("entitlements", () => {
  it("21 days, January year, joining 1 July → proposed 10.5 days (BE-08 AC)", async () => {
    travelTo("2026-10-10T08:00:00Z")
    const o = await org("Delta")
    await api.patch(
      `/employees/${o.employee.id}`,
      { joiningDate: "2026-07-01" },
      o.admin.token
    )
    const annual = await balanceOf(o.admin, o.employee.id, "Annual")
    expect(annual).toMatchObject({
      year: 2026,
      tracked: true,
      proposedEntitlement: 10.5,
      entitlementSource: "PRORATED",
      entitlement: 10.5,
      available: 10.5,
    })
    // Someone who joined earlier gets the full allowance.
    expect(await balanceOf(o.admin, o.colleague.id, "Annual")).toMatchObject({
      entitlement: 21,
      entitlementSource: "DEFAULT",
    })
  })

  it("can be overridden by the Admin per employee", async () => {
    const o = await org("Echo")
    const response = await api.request<Balance>(
      "PUT",
      `/leave/employees/${o.employee.id}/balances/${o.type("Annual").id}/entitlement`,
      { token: o.admin.token, body: { days: 25, reason: "contract" } }
    )
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      entitlement: 25,
      entitlementSource: "OVERRIDE",
      proposedEntitlement: 21,
      available: 25,
    })
  })

  it("are opened for everyone by the rollover job, once per leave year, without carry-over", async () => {
    travelTo("2026-10-10T08:00:00Z")
    const o = await org("Foxtrot")
    await runLeaveRollover({ clock: api.clock, logger: silent })
    // 4 people × 3 tracked types
    expect(
      await LeaveBalanceModel.countDocuments({
        companyId: o.companyId,
        year: 2026,
      })
    ).toBe(12)
    expect(
      await LeaveYearRunModel.exists({ companyId: o.companyId, year: 2026 })
    ).toBeTruthy()

    const again = await runLeaveRollover({ clock: api.clock, logger: silent })
    expect(again.find((r) => r.companyId === o.companyId)).toBeUndefined()

    // A new leave year: fresh entitlements, the old balance is not carried over.
    await api.request(
      "POST",
      `/leave/employees/${o.employee.id}/balances/${o.type("Annual").id}/adjustments`,
      {
        token: o.admin.token,
        body: { days: 4, reason: "bonus" },
      }
    )
    travelTo("2027-01-01T08:00:00Z")
    const opened = await runLeaveRollover({ clock: api.clock, logger: silent })
    expect(opened).toContainEqual({
      companyId: o.companyId,
      year: 2027,
      created: 12,
    })
    const next = await setEntitlement(
      {
        companyId: o.companyId,
        employeeId: o.employee.id,
        leaveTypeId: o.type("Annual").id,
        year: 2027,
        days: 21,
        actor: { type: "USER", userId: o.admin.id },
      },
      deps
    )
    expect(next).toMatchObject({
      year: 2027,
      entitlement: 21,
      adjustments: 0,
      available: 21,
    })
    travelTo("2026-10-10T08:00:00Z")
  })
})

describe("the balance through a request's life (BE-08 AC)", () => {
  async function tenDays(name: string) {
    travelTo("2026-10-10T08:00:00Z")
    const o = await org(name)
    const key = {
      companyId: o.companyId,
      employeeId: o.employee.id,
      leaveTypeId: o.type("Annual").id,
      actor: { type: "USER", userId: o.employee.id } as const,
    }
    await setEntitlement(
      { ...key, days: 10, actor: { type: "USER", userId: o.admin.id } },
      deps
    )
    return { o, key }
  }
  const november = [
    { date: "2026-11-02", days: 1 },
    { date: "2026-11-03", days: 1 },
    { date: "2026-11-04", days: 1 },
  ]

  it("pending reserves; rejecting or withdrawing releases", async () => {
    const { o, key } = await tenDays("Golf")
    await reserveDays({ ...key, requestId: "r-1", days: 3 }, deps)
    expect(await balanceOf(o.employee, o.employee.id, "Annual")).toMatchObject({
      available: 7,
      pending: 3,
    })
    await releaseReservation({ ...key, requestId: "r-1" }, deps)
    expect(await balanceOf(o.employee, o.employee.id, "Annual")).toMatchObject({
      available: 10,
      pending: 0,
    })
    // Releasing twice changes nothing.
    await releaseReservation({ ...key, requestId: "r-1" }, deps)
    expect(
      (await balanceOf(o.employee, o.employee.id, "Annual")).available
    ).toBe(10)
  })

  it("approved: available stays 7; pending → upcoming → used as the dates pass; cancelling restores", async () => {
    const { o, key } = await tenDays("Hotel")
    await reserveDays({ ...key, requestId: "r-2", days: 3 }, deps)
    await deductApprovedDays(
      { ...key, requestId: "r-2", breakdown: november },
      deps
    )
    expect(await balanceOf(o.employee, o.employee.id, "Annual")).toMatchObject({
      available: 7,
      pending: 0,
      upcoming: 3,
      used: 0,
    })

    // Once the dates have passed (read through the service: tokens expire).
    travelTo("2026-11-05T08:00:00Z")
    expect(await getBalance(key, deps)).toMatchObject({
      used: 3,
      upcoming: 0,
      available: 7,
    })
    travelTo("2026-10-10T08:00:00Z")

    // Another approved future request, then cancelled: restored in full.
    await reserveDays({ ...key, requestId: "r-3", days: 2 }, deps)
    await deductApprovedDays(
      {
        ...key,
        requestId: "r-3",
        breakdown: [
          { date: "2026-12-01", days: 1 },
          { date: "2026-12-02", days: 1 },
        ],
      },
      deps
    )
    expect((await getBalance(key, deps)).available).toBe(5)
    const restored = await restoreDays({ ...key, requestId: "r-3" }, deps)
    expect(restored).toMatchObject({ available: 7, upcoming: 3 })
    const restoration = await LeaveLedgerEntryModel.findOne({
      companyId: o.companyId,
      requestId: "r-3",
      type: "RESTORATION",
    }).lean()
    expect(restoration).toMatchObject({ days: 2 })
  })

  it("refuses more than available (409 INSUFFICIENT_BALANCE) unless negative balances are allowed", async () => {
    const { o, key } = await tenDays("India")
    await expect(
      reserveDays({ ...key, requestId: "r-4", days: 11 }, deps)
    ).rejects.toMatchObject({
      status: 409,
      code: "INSUFFICIENT_BALANCE",
    })
    await api.patch(
      `/leave/types/${key.leaveTypeId}`,
      { allowNegativeBalance: true },
      o.admin.token
    )
    const negative = await reserveDays(
      { ...key, requestId: "r-4", days: 11 },
      deps
    )
    expect(negative.available).toBe(-1)
  })

  it("never lets two requests spend the same days", async () => {
    const { key } = await tenDays("Juliett")
    // The type is already in use, as it normally is: only the balance lock
    // can keep the two apart.
    await reserveDays({ ...key, requestId: "warm-up", days: 1 }, deps)
    await releaseReservation({ ...key, requestId: "warm-up" }, deps)
    // Six parallel 3-day requests against 10 available days: at most three fit.
    const results = await Promise.allSettled(
      ["a", "b", "c", "d", "e", "f"].map((requestId) =>
        reserveDays({ ...key, requestId, days: 3 }, deps)
      )
    )
    const accepted = results.filter((r) => r.status === "fulfilled")
    expect(accepted).toHaveLength(3)
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({
        code: "INSUFFICIENT_BALANCE",
      })
    }
    expect((await getBalance(key, deps)).available).toBe(1)
  })

  it("keeps no balance and never limits an untracked type (BE-08 AC)", async () => {
    const { o } = await tenDays("Kilo")
    const unpaid = o.type("Unpaid")
    const key = {
      companyId: o.companyId,
      employeeId: o.employee.id,
      leaveTypeId: unpaid.id,
      actor: { type: "USER", userId: o.employee.id } as const,
    }
    const result = await reserveDays(
      { ...key, requestId: "u-1", days: 40 },
      deps
    )
    expect(result).toMatchObject({
      tracked: false,
      available: null,
      pending: null,
      balanceId: null,
    })
    expect(
      await LeaveLedgerEntryModel.countDocuments({
        companyId: o.companyId,
        leaveTypeId: unpaid.id,
      })
    ).toBe(0)
    expect(await balanceOf(o.employee, o.employee.id, "Unpaid")).toMatchObject({
      tracked: false,
      entitlement: null,
      available: null,
    })
  })
})

describe("Admin adjustments", () => {
  it("need a reason; with one, available grows and the entry is listed (BE-08 AC)", async () => {
    travelTo("2026-10-10T08:00:00Z")
    const o = await org("Lima")
    const path = `/leave/employees/${o.employee.id}/balances/${o.type("Annual").id}`
    const noReason = await api.post(
      `${path}/adjustments`,
      { days: 2 },
      o.admin.token
    )
    expect(noReason.status).toBe(422)
    expect(noReason.body).toMatchObject({
      fieldErrors: [{ field: "reason", code: "REQUIRED" }],
    })
    expect((await balanceOf(o.admin, o.employee.id, "Annual")).available).toBe(
      21
    )

    const adjusted = await api.post<Balance>(
      `${path}/adjustments`,
      { days: 2, reason: "Carry-over from 2025" },
      o.admin.token
    )
    expect(adjusted.status).toBe(201)
    expect(adjusted.body).toMatchObject({ adjustments: 2, available: 23 })

    const entries = await api.get<{
      balance: Balance
      items: {
        type: string
        days: number
        reason: string | null
        actor: unknown
      }[]
    }>(`${path}/entries`, o.employee.token)
    expect(entries.body.items).toEqual([
      expect.objectContaining({
        type: "ALLOWANCE",
        days: 21,
        actor: { type: "SYSTEM", job: "leave.entitlement" },
      }),
      expect.objectContaining({
        type: "ADJUSTMENT",
        days: 2,
        reason: "Carry-over from 2025",
        actor: { type: "USER", id: o.admin.id, name: o.admin.name },
      }),
    ])
    const history = await api.get<{
      items: { action: string; reason: string }[]
    }>(`/history/leave-balances/${adjusted.body.balanceId}`, o.employee.token)
    expect(history.body.items[0]).toMatchObject({
      action: "leaveBalance.adjusted",
      reason: "Carry-over from 2025",
    })
  })

  it("are refused to Employees and Managers (403), and to other companies (404)", async () => {
    const o = await org("Mike")
    const other = await org("November")
    const path = (employeeId: string, typeId: string) =>
      `/leave/employees/${employeeId}/balances/${typeId}/adjustments`
    for (const member of [o.employee, o.manager]) {
      const response = await api.post(
        path(o.employee.id, o.type("Annual").id),
        { days: 5, reason: "me" },
        member.token
      )
      expect(response.status).toBe(403)
    }
    expect(
      (
        await api.post(
          path(other.employee.id, other.type("Annual").id),
          { days: 5, reason: "x" },
          o.admin.token
        )
      ).status
    ).toBe(404)
  })
})

describe("who sees balances", () => {
  it("self, a Manager's direct reports and Admins; others get 404", async () => {
    const o = await org("Oscar")
    expect((await balances(o.employee, o.employee.id)).status).toBe(200)
    expect((await balances(o.manager, o.employee.id)).status).toBe(200)
    expect((await balances(o.admin, o.colleague.id)).status).toBe(200)
    expect((await balances(o.employee, o.colleague.id)).status).toBe(404)
    expect((await balances(o.manager, o.colleague.id)).status).toBe(404)
  })
})
