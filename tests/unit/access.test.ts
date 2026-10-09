import { describe, expect, it } from "vitest"

import { PERMISSIONS, scopesFor } from "../../src/modules/identity/access.ts"
import {
  presentAvailability,
  type AvailabilityEntry,
  type AvailabilityViewer,
} from "../../src/modules/identity/availability.ts"

describe("permission matrix", () => {
  it("gives Employees their own personal data, Managers their team too, Admins the company", () => {
    for (const resource of [
      "employee",
      "attendance",
      "leave",
      "requests",
      "reports",
    ] as const) {
      expect(scopesFor("EMPLOYEE", resource, "view")).toEqual(["self"])
      expect(scopesFor("MANAGER", resource, "view")).toEqual(["self", "team"])
      expect(scopesFor("ADMIN", resource, "view")).toEqual(["company"])
    }
  })

  it("lets only Managers (team) and Admins (company) approve", () => {
    for (const resource of ["leave", "requests"] as const) {
      expect(scopesFor("EMPLOYEE", resource, "approve")).toEqual([])
      expect(scopesFor("MANAGER", resource, "approve")).toEqual(["team"])
      expect(scopesFor("ADMIN", resource, "approve")).toEqual(["company"])
    }
  })

  it("keeps company settings and user management to Admins", () => {
    expect(scopesFor("EMPLOYEE", "companySettings", "edit")).toEqual([])
    expect(scopesFor("MANAGER", "companySettings", "edit")).toEqual([])
    expect(scopesFor("ADMIN", "companySettings", "edit")).toEqual(["company"])
    expect(scopesFor("EMPLOYEE", "companySettings", "view")).toEqual([
      "company",
    ])
    for (const action of ["view", "create", "edit", "delete"] as const) {
      expect(scopesFor("MANAGER", "users", action)).toEqual([])
      expect(scopesFor("ADMIN", "users", action)).toEqual(["company"])
    }
  })

  it("never grants an action a resource doesn't list", () => {
    expect(PERMISSIONS.reports).not.toHaveProperty("edit")
    expect(scopesFor("ADMIN", "attendance", "approve" as never)).toEqual([])
  })
})

describe("colleague availability (field-level privacy)", () => {
  const entry = (
    kind: AvailabilityEntry["kind"],
    overrides: Partial<AvailabilityEntry> = {}
  ) => ({
    employeeId: "colleague",
    name: "Lina Haddad",
    departmentId: "sales",
    kind,
    leaveType: "SICK",
    reason: "flu",
    ...overrides,
  })
  const employeeInSales: AvailabilityViewer = {
    departmentId: "sales",
    leaveDetail: new Set(["me"]),
    requestDetail: new Set(["me"]),
  }

  it("shows a same-department colleague's leave as name + OUT, and WFH as name + WFH, nothing more", () => {
    expect(presentAvailability(employeeInSales, entry("LEAVE"))).toEqual({
      employeeId: "colleague",
      name: "Lina Haddad",
      status: "OUT",
    })
    expect(presentAvailability(employeeInSales, entry("WFH"))).toEqual({
      employeeId: "colleague",
      name: "Lina Haddad",
      status: "WFH",
    })
  })

  it("hides colleagues' business trips and permissions, and other departments entirely", () => {
    expect(
      presentAvailability(employeeInSales, entry("BUSINESS_TRIP"))
    ).toBeUndefined()
    expect(
      presentAvailability(employeeInSales, entry("PERMISSION"))
    ).toBeUndefined()
    for (const kind of ["LEAVE", "WFH"] as const) {
      expect(
        presentAvailability(
          employeeInSales,
          entry(kind, { departmentId: "finance" })
        )
      ).toBeUndefined()
      // No department on either side is not "the same department".
      expect(
        presentAvailability(
          { ...employeeInSales, departmentId: null },
          entry(kind, { departmentId: null })
        )
      ).toBeUndefined()
    }
  })

  it("gives full detail for your own entries, your direct reports' and (Admin) everyone's", () => {
    const own = entry("PERMISSION", { employeeId: "me" })
    expect(presentAvailability(employeeInSales, own)).toBe(own)

    const manager: AvailabilityViewer = {
      departmentId: "finance",
      leaveDetail: new Set(["me", "colleague"]),
      requestDetail: new Set(["me", "colleague"]),
    }
    const trip = entry("BUSINESS_TRIP")
    expect(presentAvailability(manager, trip)).toBe(trip)

    const admin: AvailabilityViewer = {
      departmentId: null,
      leaveDetail: "ALL",
      requestDetail: "ALL",
    }
    const sick = entry("LEAVE")
    expect(presentAvailability(admin, sick)).toBe(sick)
  })
})
