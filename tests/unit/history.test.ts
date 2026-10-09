import { describe, expect, it } from "vitest"

import {
  assertReason,
  changedValues,
} from "../../src/modules/history/history.service.ts"

describe("history: changed values", () => {
  it("keeps only the fields that changed", () => {
    expect(
      changedValues(
        { managerId: "a", departmentId: "d", name: "Lina" },
        { managerId: "b", departmentId: "d", name: "Lina" }
      )
    ).toEqual({ oldValues: { managerId: "a" }, newValues: { managerId: "b" } })
  })

  it("treats a missing field as null, and compares nested values by content", () => {
    expect(changedValues({}, { status: "ACTIVE" })).toEqual({
      oldValues: { status: null },
      newValues: { status: "ACTIVE" },
    })
    expect(changedValues({ a: null }, {})).toEqual({
      oldValues: {},
      newValues: {},
    })
    expect(
      changedValues({ days: ["SUN", "MON"] }, { days: ["SUN", "MON"] })
    ).toEqual({ oldValues: {}, newValues: {} })
  })
})

describe("history: reason rule", () => {
  it("refuses a missing or blank reason where one is required", () => {
    for (const reason of [undefined, null, "", "   "]) {
      expect(() => assertReason("attendance.corrected", reason)).toThrow(
        expect.objectContaining({
          status: 422,
          fieldErrors: [
            expect.objectContaining({ field: "reason", code: "REQUIRED" }),
          ],
        })
      )
    }
    expect(() =>
      assertReason("attendance.corrected", "forgot to clock out")
    ).not.toThrow()
    expect(() => assertReason("attendance.recorded", undefined)).not.toThrow()
  })
})

describe("history ids", () => {
  it("are UUIDs that sort in creation order, even within one millisecond", async () => {
    const { uuidV7 } = await import("../../src/platform/db/schema.ts")
    const ids = Array.from({ length: 50 }, () => uuidV7(1_700_000_000_000))
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(50)
    for (const id of ids) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      )
    }
    expect(uuidV7(1_700_000_000_001) > ids.at(-1)!).toBe(true)
  })
})
