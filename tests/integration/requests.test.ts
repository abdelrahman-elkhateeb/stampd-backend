import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"

import { HistoryEntryModel } from "../../src/modules/history/history.model.ts"
import { registerRequestType } from "../../src/modules/requests/registry.ts"
import { RequestModel } from "../../src/modules/requests/request.model.ts"
import { apiErrors } from "../../src/platform/http/errors.ts"
import { useApi } from "./api.ts"
import { useTestDatabase } from "./database.ts"
import { newCompany, type Member } from "./people.ts"

/** The request & approval engine (Trello BE-09), with two test-only request types. */
useTestDatabase()
const api = useApi()

type View = {
  id: string
  type: string
  status: string
  requester: { id: string }
  decision: {
    by: { id: string }
    comment: string | null
    selfApproved: boolean
  } | null
  actions: string[]
  timeline: {
    status: string
    previousStatus: string | null
    reason: string | null
  }[]
}
type Page = { items: View[]; meta: { totalItems: number } }

/** What the types' effect hooks saw, in order. */
const calls: string[] = []
let cleanup: (() => void)[] = []

beforeAll(() => {
  cleanup = [
    // A new type, registered without touching the engine (BE-09 AC).
    registerRequestType({
      key: "TEST_TRIP",
      label: "Test trip",
      approverPolicy: "MANAGER_WITH_ADMIN_FALLBACK",
      dates: "RANGE",
      times: "NONE",
      reason: "OPTIONAL",
      data: z.object({ destination: z.string().min(1) }),
      colleagueVisibility: "HIDDEN",
      dayEffect: () => ({ kind: "BUSINESS_TRIP", fullDay: true }),
      onSubmit: async ({ request }) => void calls.push(`submit:${request.id}`),
      onApprove: async ({ request }) => {
        if (request.data.destination === "FAIL") {
          throw apiErrors.conflict("the effect refused")
        }
        calls.push(`approve:${request.id}`)
      },
      onReject: async ({ request }) => void calls.push(`reject:${request.id}`),
      onCancel: async ({ request, from }) =>
        void calls.push(`cancel:${request.id}:${from}`),
    }),
    registerRequestType({
      key: "TEST_ADMIN_ONLY",
      label: "Test admin-only",
      approverPolicy: "ADMIN_ONLY",
      dates: "SINGLE_DAY",
      times: "REQUIRED",
      reason: "REQUIRED",
      data: z.object({}),
      colleagueVisibility: "HIDDEN",
    }),
  ]
})
afterAll(() => cleanup.forEach((undo) => undo()))
beforeEach(() => {
  calls.length = 0
})

const travelTo = (instant: string) =>
  api.clock.advance(new Date(instant).getTime() - api.clock.now().getTime())

/** Admin → B (Manager) → C; D has no manager; E reports to another manager. */
async function org(name: string) {
  travelTo("2026-10-12T06:00:00Z")
  const company = await newCompany(api, name)
  const b = await company.add("MANAGER", company.admin.id)
  const c = await company.add("EMPLOYEE", b.id)
  const d = await company.add("EMPLOYEE")
  const otherManager = await company.add("MANAGER", company.admin.id)
  const e = await company.add("EMPLOYEE", otherManager.id)
  return { ...company, b, c, d, otherManager, e }
}

const trip = (member: Member, body: Record<string, unknown> = {}) =>
  api.post<View>(
    "/requests",
    {
      type: "TEST_TRIP",
      startDate: "2026-11-02",
      endDate: "2026-11-04",
      data: { destination: "Riyadh" },
      ...body,
    },
    member.token
  )
const act = (member: Member, id: string, action: string, body?: unknown) =>
  api.post<View>(`/requests/${id}/${action}`, body, member.token)
const approvals = async (member: Member, query = "") =>
  (
    await api.get<Page>(`/requests/approvals${query}`, member.token)
  ).body.items.map((r) => r.id)

describe("submitting", () => {
  it("is Pending at once and shows in the manager's and the Admins' approvals (BE-09 AC)", async () => {
    const o = await org("Alpha")
    const submitted = await trip(o.c)
    expect(submitted.status).toBe(201)
    expect(submitted.body).toMatchObject({
      type: "TEST_TRIP",
      status: "PENDING",
      requester: { id: o.c.id },
      decision: null,
      actions: ["WITHDRAW"],
    })
    const id = submitted.body.id
    expect(calls).toEqual([`submit:${id}`])

    expect(await approvals(o.b)).toEqual([id])
    expect(await approvals(o.admin)).toContain(id)
    expect(await approvals(o.otherManager)).toEqual([])
    expect((await api.get("/requests/approvals", o.c.token)).status).toBe(403)
    expect(
      (await api.get<Page>("/requests/mine", o.c.token)).body.items.map(
        (r) => r.id
      )
    ).toEqual([id])
  })

  it("goes to the Admins when the requester has no manager (BE-09 AC)", async () => {
    const o = await org("Bravo")
    const id = (await trip(o.d)).body.id
    expect(await approvals(o.admin)).toContain(id)
    expect(await approvals(o.b)).not.toContain(id)
  })

  it("validates the type, dates, times, reason and the type's own fields", async () => {
    const o = await org("Charlie")
    const unknown = await api.post(
      "/requests",
      { type: "NOPE", startDate: "2026-11-02" },
      o.c.token
    )
    expect(unknown.body).toMatchObject({
      fieldErrors: [{ field: "type", code: "UNKNOWN_REFERENCE" }],
    })

    const bad = await trip(o.c, {
      endDate: "2026-11-01",
      data: { destination: "" },
    })
    expect(bad.status).toBe(422)
    expect(
      (bad.body as unknown as { fieldErrors: { field: string }[] }).fieldErrors
        .map((e) => e.field)
        .sort()
    ).toEqual(["data.destination", "endDate"])

    const adminOnly = await api.post(
      "/requests",
      {
        type: "TEST_ADMIN_ONLY",
        startDate: "2026-11-02",
        endDate: "2026-11-03",
        startTime: "10:00",
      },
      o.c.token
    )
    expect(
      (adminOnly.body as { fieldErrors: { field: string }[] }).fieldErrors
        .map((e) => e.field)
        .sort()
    ).toEqual(["endDate", "endTime", "reason"])
  })
})

describe("deciding", () => {
  it("refuses approving your own request (BE-09 AC)", async () => {
    const o = await org("Delta")
    const own = await trip(o.b)
    expect(own.body.actions).not.toContain("APPROVE")
    const response = await act(o.b, own.body.id, "approve")
    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ code: "SELF_APPROVAL" })
    // B's own manager (the Admin) can.
    expect((await act(o.admin, own.body.id, "approve")).body.status).toBe(
      "APPROVED"
    )
  })

  it("needs a reason to reject; the reason is stored (BE-09 AC)", async () => {
    const o = await org("Echo")
    const id = (await trip(o.c)).body.id
    const noReason = await act(o.b, id, "reject", {})
    expect(noReason.status).toBe(422)
    expect(noReason.body).toMatchObject({
      fieldErrors: [{ field: "reason", code: "REQUIRED" }],
    })

    const rejected = await act(o.b, id, "reject", { reason: "Budget freeze" })
    expect(rejected.body).toMatchObject({
      status: "REJECTED",
      decision: {
        by: { id: o.b.id },
        comment: "Budget freeze",
        selfApproved: false,
      },
    })
    expect(calls).toContain(`reject:${id}`)
  })

  it("lets only the first of two simultaneous decisions win; history shows one (BE-09 AC)", async () => {
    const o = await org("Foxtrot")
    const id = (await trip(o.c)).body.id
    const [byManager, byAdmin] = await Promise.all([
      act(o.b, id, "approve"),
      act(o.admin, id, "approve"),
    ])
    const statuses = [byManager.status, byAdmin.status].sort()
    expect(statuses).toEqual([200, 409])
    const loser = byManager.status === 409 ? byManager : byAdmin
    expect(loser.body).toMatchObject({ code: "REQUEST_STATUS_CONFLICT" })

    const decisions = await HistoryEntryModel.find({
      companyId: o.companyId,
      entityId: id,
      "newValues.status": "APPROVED",
    }).lean()
    expect(decisions).toHaveLength(1)
    expect(calls.filter((c) => c.startsWith("approve:"))).toHaveLength(1)
  })

  it("rolls the decision back when the type's effect refuses it", async () => {
    const o = await org("Golf")
    const id = (await trip(o.c, { data: { destination: "FAIL" } })).body.id
    expect((await act(o.b, id, "approve")).status).toBe(409)
    expect(
      (await RequestModel.findOne({ _id: id, companyId: o.companyId }).lean())
        ?.status
    ).toBe("PENDING")
  })

  it("keeps Admin-only types away from managers", async () => {
    const o = await org("Hotel")
    const id = (
      await api.post<View>(
        "/requests",
        {
          type: "TEST_ADMIN_ONLY",
          startDate: "2026-11-02",
          startTime: "09:00",
          endTime: "11:00",
          reason: "Doctor",
        },
        o.c.token
      )
    ).body.id
    expect(await approvals(o.b)).not.toContain(id)
    expect((await act(o.b, id, "approve")).status).toBe(403)
    expect((await act(o.admin, id, "approve")).body.status).toBe("APPROVED")
  })

  it("lets the company's only Admin approve their own request, labelled self-approved", async () => {
    const o = await org("India")
    const own = await trip(o.admin)
    expect(own.body.actions).toContain("APPROVE")
    const approved = await act(o.admin, own.body.id, "approve")
    expect(approved.body.decision).toMatchObject({
      selfApproved: true,
      by: { id: o.admin.id },
    })

    // With a second Admin, self-approval is refused again.
    await api.patch(
      `/employees/${o.otherManager.id}`,
      { role: "ADMIN" },
      o.admin.token
    )
    const second = await trip(o.admin)
    expect((await act(o.admin, second.body.id, "approve")).body).toMatchObject({
      code: "SELF_APPROVAL",
    })
  })
})

describe("withdrawing and cancelling", () => {
  it("withdraws a pending request and runs the on-cancel effects (BE-09 AC)", async () => {
    const o = await org("Juliett")
    const id = (await trip(o.c)).body.id
    expect((await act(o.b, id, "withdraw")).status).toBe(403)
    const withdrawn = await act(o.c, id, "withdraw")
    expect(withdrawn.body.status).toBe("WITHDRAWN")
    expect(calls).toContain(`cancel:${id}:PENDING`)
    expect((await act(o.c, id, "withdraw")).body).toMatchObject({
      code: "REQUEST_STATUS_CONFLICT",
    })
  })

  it("asks to cancel an approved future request; it waits for the approver (BE-09 AC)", async () => {
    const o = await org("Kilo")
    const id = (await trip(o.c)).body.id
    await act(o.b, id, "approve")

    const asked = await act(o.c, id, "cancellation", {
      reason: "Plans changed",
    })
    expect(asked.body.status).toBe("CANCELLATION_REQUESTED")
    expect(asked.body.actions).not.toContain("APPROVE_CANCELLATION")
    expect(await approvals(o.b)).toContain(id)

    expect((await act(o.b, id, "cancellation/decline")).body.status).toBe(
      "APPROVED"
    )
    await act(o.c, id, "cancellation")
    const cancelled = await act(o.b, id, "cancellation/approve")
    expect(cancelled.body.status).toBe("CANCELLED")
    expect(calls).toContain(`cancel:${id}:CANCELLATION_REQUESTED`)
    expect(cancelled.body.timeline.map((t) => t.status)).toEqual([
      "PENDING",
      "APPROVED",
      "CANCELLATION_REQUESTED",
      "APPROVED",
      "CANCELLATION_REQUESTED",
      "CANCELLED",
    ])
  })

  it("leaves started requests to an Admin, who cancels with a reason", async () => {
    const o = await org("Lima")
    const id = (
      await trip(o.c, { startDate: "2026-10-12", endDate: "2026-10-14" })
    ).body.id
    await act(o.b, id, "approve")
    const started = await act(o.c, id, "cancellation")
    expect(started.status).toBe(409)
    expect(started.body).toMatchObject({ code: "REQUEST_STARTED" })

    expect((await act(o.b, id, "cancel", { reason: "x" })).status).toBe(403)
    expect((await act(o.admin, id, "cancel", {})).status).toBe(422)
    const cancelled = await act(o.admin, id, "cancel", {
      reason: "Trip called off",
    })
    expect(cancelled.body.status).toBe("CANCELLED")
    expect(calls).toContain(`cancel:${id}:APPROVED`)
  })
})

describe("Admins on behalf of employees", () => {
  it("submit for an employee, optionally already approved", async () => {
    const o = await org("Mike")
    const approved = await trip(o.admin, { employeeId: o.c.id, approved: true })
    expect(approved.status).toBe(201)
    expect(approved.body).toMatchObject({
      status: "APPROVED",
      requester: { id: o.c.id },
      decision: { by: { id: o.admin.id } },
    })
    expect(calls).toEqual([
      `submit:${approved.body.id}`,
      `approve:${approved.body.id}`,
    ])

    expect((await trip(o.b, { employeeId: o.c.id })).status).toBe(403)
  })
})

describe("lists and visibility", () => {
  it("give a Manager only their direct reports' requests (BE-09 AC)", async () => {
    const o = await org("November")
    const fromC = (await trip(o.c)).body.id
    await trip(o.e)
    await trip(o.d)
    await trip(o.b) // the manager's own
    expect(await approvals(o.b)).toEqual([fromC])
    expect(await approvals(o.b, "?status=APPROVED")).toEqual([])
  })

  it("hide other people's requests (404), including other companies'", async () => {
    const o = await org("Oscar")
    const other = await org("Papa")
    const id = (await trip(o.c)).body.id
    expect((await api.get(`/requests/${id}`, o.e.token)).status).toBe(404)
    expect(
      (await api.get(`/requests/${id}`, o.otherManager.token)).status
    ).toBe(404)
    expect((await api.get(`/requests/${id}`, other.admin.token)).status).toBe(
      404
    )
    expect((await act(other.admin, id, "approve")).status).toBe(404)
    expect((await api.get(`/requests/${id}`, o.b.token)).status).toBe(200)
  })

  it("list the registered types", async () => {
    const o = await org("Quebec")
    const types = await api.get<{ items: { key: string }[] }>(
      "/requests/types",
      o.c.token
    )
    expect(types.body.items.map((t) => t.key)).toEqual(
      expect.arrayContaining(["TEST_TRIP", "TEST_ADMIN_ONLY"])
    )
  })
})

describe("with attendance, holidays and offboarding", () => {
  it("shows an approved request on attendance days and in a new holiday's affected requests", async () => {
    const o = await org("Romeo")
    const id = (await trip(o.c)).body.id
    await act(o.b, id, "approve")
    const day = await api.get<{ items: { days: { status: string }[] }[] }>(
      `/attendance/days?date=2026-11-03&employeeId=${o.c.id}`,
      o.admin.token
    )
    expect(day.body.items[0]!.days[0]!.status).toBe("BUSINESS_TRIP")

    const holiday = await api.post<{
      affectedRequests: { requestId: string }[]
    }>(
      "/company/holidays",
      { name: "Flag Day", startDate: "2026-11-03", endDate: "2026-11-03" },
      o.admin.token
    )
    expect(holiday.body.affectedRequests).toEqual([
      expect.objectContaining({
        requestId: id,
        employeeId: o.c.id,
        type: "TEST_TRIP",
      }),
    ])
  })

  it("withdraws pending and cancels future approved requests when an employee is offboarded", async () => {
    const o = await org("Sierra")
    const pending = (
      await trip(o.c, { startDate: "2026-12-01", endDate: "2026-12-01" })
    ).body.id
    const future = (
      await trip(o.c, { startDate: "2026-11-20", endDate: "2026-11-22" })
    ).body.id
    await act(o.b, future, "approve")

    const preview = await api.post<{
      pendingRequests: { id: string }[]
      futureApprovedTimeOff: { id: string }[]
    }>(
      `/employees/${o.c.id}/deactivation/preview`,
      { lastWorkingDay: "2026-10-31" },
      o.admin.token
    )
    expect(preview.body.pendingRequests.map((r) => r.id)).toEqual([pending])
    expect(preview.body.futureApprovedTimeOff.map((r) => r.id)).toEqual([
      future,
    ])

    calls.length = 0
    const deactivated = await api.post(
      `/employees/${o.c.id}/deactivation`,
      { lastWorkingDay: "2026-10-31" },
      o.admin.token
    )
    expect(deactivated.body).toMatchObject({ status: "ACTIVE" })
    const status = async (id: string) =>
      (await RequestModel.findOne({ _id: id, companyId: o.companyId }).lean())
        ?.status
    expect(await status(pending)).toBe("WITHDRAWN")
    expect(await status(future)).toBe("CANCELLED")
    expect(calls.sort()).toEqual(
      [`cancel:${future}:APPROVED`, `cancel:${pending}:PENDING`].sort()
    )
  })
})
