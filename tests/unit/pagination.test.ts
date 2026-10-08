import { describe, expect, it } from "vitest"
import { z } from "zod"

import {
  listQuery,
  multiValue,
  toPage,
  toPageRequest,
} from "../../src/platform/http/pagination.ts"
import { toFieldErrors } from "../../src/platform/http/validation.ts"

const query = listQuery({
  sortFields: ["name", "joinedOn"],
  defaultSort: "name",
})

describe("listQuery", () => {
  it("defaults to page 1 of 20 with the default sort", () => {
    expect(query.parse({})).toEqual({ page: 1, pageSize: 20, sort: "name" })
  })

  it("coerces query strings", () => {
    expect(
      query.parse({ page: "3", pageSize: "50", sort: "-joinedOn" })
    ).toEqual({
      page: 3,
      pageSize: 50,
      sort: "-joinedOn",
    })
  })

  it("maps bad values to the agreed field codes", () => {
    const result = query.safeParse(
      { page: "0", pageSize: "500", sort: "salary" },
      { reportInput: true }
    )
    expect(result.success).toBe(false)
    expect(toFieldErrors(result.error!.issues, "query")).toEqual([
      expect.objectContaining({ field: "page", code: "OUT_OF_RANGE" }),
      expect.objectContaining({ field: "pageSize", code: "OUT_OF_RANGE" }),
      expect.objectContaining({ field: "sort", code: "INVALID_FORMAT" }),
    ])
  })
})

describe("toPageRequest", () => {
  it("computes skip/limit and a stable Mongo sort ('-field' = descending)", () => {
    expect(toPageRequest({ page: 3, pageSize: 10, sort: "-joinedOn" })).toEqual(
      {
        page: 3,
        pageSize: 10,
        skip: 20,
        limit: 10,
        sort: { field: "joinedOn", direction: "desc" },
        mongoSort: { joinedOn: -1, _id: 1 },
      }
    )
  })
})

describe("toPage", () => {
  it("builds { items, meta }", () => {
    expect(toPage(["a", "b"], 42, { page: 2, pageSize: 20 })).toEqual({
      items: ["a", "b"],
      meta: { page: 2, pageSize: 20, totalItems: 42, totalPages: 3 },
    })
  })

  it("reports one page for an empty result", () => {
    expect(toPage([], 0, { page: 1, pageSize: 20 }).meta.totalPages).toBe(1)
  })
})

describe("multiValue", () => {
  const status = multiValue(z.enum(["ACTIVE", "INVITED"])).optional()

  it("turns a single value or repeated values into an array", () => {
    expect(status.parse("ACTIVE")).toEqual(["ACTIVE"])
    expect(status.parse(["ACTIVE", "INVITED"])).toEqual(["ACTIVE", "INVITED"])
    expect(status.parse(undefined)).toBeUndefined()
  })

  it("rejects unknown values", () => {
    expect(status.safeParse(["ACTIVE", "FIRED"]).success).toBe(false)
  })
})
