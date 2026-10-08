import { Router } from "express"
import { describe, expect, it } from "vitest"
import { z } from "zod"

import {
  getAuth,
  requireAuth,
} from "../../src/modules/identity/authenticate.ts"
import { MODULES } from "../../src/modules/index.ts"
import type { AppModule } from "../../src/modules/module.ts"
import { EmployeeModel } from "../../src/modules/organization/employee.model.ts"
import {
  TenantScopeError,
  withoutTenantScope,
} from "../../src/platform/db/tenant.ts"
import { apiErrors } from "../../src/platform/http/errors.ts"
import { route } from "../../src/platform/http/validation.ts"
import { signupBody, useApi, type Tokens } from "./api.ts"
import { useTestDatabase } from "./database.ts"

/**
 * The cross-tenant suite (Trello BE-02: a release gate). The pattern every
 * later ticket copies for its own endpoints:
 *   1. sign up two companies;
 *   2. call the endpoint as company A with an id from company B;
 *   3. expect 404 NOT_FOUND and no data (not 403: existence isn't revealed).
 */
useTestDatabase()

/** A stand-in endpoint written the way real ones must be: scoped by req.auth.companyId. */
const probe: AppModule = {
  name: "probe",
  routes: (deps) => {
    const router = Router()
    router.get(
      "/probe/employees/:id",
      requireAuth({ secret: deps.config.authTokenSecret, clock: deps.clock }),
      route({ params: z.object({ id: z.uuid() }) }, async ({ params, req }) => {
        const { companyId } = getAuth(req)
        const employee = await EmployeeModel.findOne({
          _id: params.id,
          companyId,
        }).lean()
        if (!employee) throw apiErrors.notFound("Employee not found")
        return { status: 200, body: { id: employee._id, name: employee.name } }
      })
    )
    return router
  },
}

const api = useApi({ modules: [...MODULES, probe] })

async function newCompany(name: string) {
  const tokens = (
    await api.post<Tokens>(
      "/auth/signup",
      signupBody({ companyName: name, name: `${name} Owner` })
    )
  ).body
  const me = (
    await api.get<{ id: string; company: { id: string; name: string } }>(
      "/me",
      tokens.accessToken
    )
  ).body
  return { tokens, userId: me.id, company: me.company }
}

describe("tenant isolation", () => {
  it("returns 404 (not 403) for another company's record, and the record for your own", async () => {
    const a = await newCompany("Alpha")
    const b = await newCompany("Bravo")

    const own = await api.get(
      `/probe/employees/${a.userId}`,
      a.tokens.accessToken
    )
    expect(own.status).toBe(200)

    const foreign = await api.get(
      `/probe/employees/${b.userId}`,
      a.tokens.accessToken
    )
    expect(foreign.status).toBe(404)
    expect(foreign.body).toEqual({
      code: "NOT_FOUND",
      message: "Employee not found",
    })
  })

  it("/me only ever shows the caller's own company", async () => {
    const a = await newCompany("Charlie")
    const b = await newCompany("Delta")
    expect((await api.get("/me", a.tokens.accessToken)).body).toMatchObject({
      company: { name: "Charlie" },
    })
    expect((await api.get("/me", b.tokens.accessToken)).body).toMatchObject({
      company: { name: "Delta" },
    })
  })

  it("refuses any query on tenant data that is not scoped to a company", async () => {
    await expect(EmployeeModel.find({})).rejects.toThrow(TenantScopeError)
    await expect(EmployeeModel.findById("anything")).rejects.toThrow(
      TenantScopeError
    )
    await expect(EmployeeModel.updateMany({}, { name: "x" })).rejects.toThrow(
      TenantScopeError
    )
    await expect(EmployeeModel.deleteOne({ name: "x" })).rejects.toThrow(
      TenantScopeError
    )
    await expect(EmployeeModel.countDocuments()).rejects.toThrow(
      TenantScopeError
    )
    await expect(
      EmployeeModel.aggregate([{ $group: { _id: null } }])
    ).rejects.toThrow(TenantScopeError)
  })

  it("allows scoped queries, and unscoped ones only through the explicit escape hatch", async () => {
    const a = await newCompany("Echo")
    expect(
      await EmployeeModel.countDocuments({ companyId: a.company.id })
    ).toBe(1)
    const everyone = await withoutTenantScope(EmployeeModel.find({}))
    expect(everyone.length).toBeGreaterThan(1)
  })
})
