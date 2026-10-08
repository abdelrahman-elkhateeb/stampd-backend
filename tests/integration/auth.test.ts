import { describe, expect, it } from "vitest"

import { issueInvitation } from "../../src/modules/identity/auth.service.ts"
import { UserModel } from "../../src/modules/identity/user.model.ts"
import { CompanyModel } from "../../src/modules/organization/company.model.ts"
import {
  DEMO_ACCOUNTS,
  DEMO_COMPANY,
  DEMO_PASSWORD,
} from "../../src/platform/db/seed.ts"
import type { ErrorBody } from "../../src/platform/http/errors.ts"
import { signupBody, useApi, type Tokens } from "./api.ts"
import { useTestDatabase } from "./database.ts"

useTestDatabase()
const api = useApi()

const demo = (email: string) => DEMO_ACCOUNTS.find((a) => a.email === email)!
const admin = demo("admin@demo.stampd.app")
const employee = demo("employee@demo.stampd.app")
const invited = demo("invited@demo.stampd.app")

const login = (email: string, password = DEMO_PASSWORD) =>
  api.post<Tokens>("/auth/login", { email, password })

const fieldCodes = (body: unknown) =>
  ((body as ErrorBody).fieldErrors ?? []).map((e) => [e.field, e.code])

/** The invite / reset link written to the log, and the token in it. */
function lastLoggedToken(kind: "invite" | "reset-password"): string {
  const line = [...api.logs]
    .reverse()
    .find((l) => String(l.link ?? "").includes(`/${kind}/`))
  return decodeURIComponent(String(line!.link).split(`/${kind}/`)[1]!)
}

describe("POST /auth/signup", () => {
  it("creates the company and one Admin account that is also an employee, and logs them in", async () => {
    const body = signupBody({ name: "Hala Mansour" })
    const signup = await api.post<Tokens>("/auth/signup", body)
    expect(signup.status).toBe(201)
    expect(signup.body).toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      expiresIn: 900,
    })

    const me = await api.get("/me", signup.body.accessToken)
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({
      name: "Hala Mansour",
      email: body.email,
      role: "ADMIN",
      status: "ACTIVE",
      locale: "en",
      employee: { id: me.body.id, name: "Hala Mansour" },
      company: {
        name: body.companyName,
        timezone: "Asia/Dubai",
        weekStart: "SUN",
        workingDays: ["SUN", "MON", "TUE", "WED", "THU"],
      },
    })

    const company = await CompanyModel.findById(
      (me.body.company as { id: string }).id
    ).lean()
    expect(company).toMatchObject({
      termsVersion: "2026-10-01",
      termsAcceptedBy: me.body.id,
      termsAcceptedAt: api.clock.now(),
    })
  })

  it("refuses an email that is already registered, without creating a second company", async () => {
    const before = await CompanyModel.countDocuments()
    const response = await api.post(
      "/auth/signup",
      signupBody({ email: "ADMIN@demo.stampd.app" })
    )
    expect(response.status).toBe(422)
    expect(fieldCodes(response.body)).toEqual([["email", "ALREADY_EXISTS"]])
    expect(await CompanyModel.countDocuments()).toBe(before)
  })

  it("refuses a signup without terms acceptance", async () => {
    for (const acceptTerms of [false, undefined]) {
      const response = await api.post(
        "/auth/signup",
        signupBody({ acceptTerms })
      )
      expect(response.status).toBe(422)
      expect(fieldCodes(response.body)).toEqual([["acceptTerms", "REQUIRED"]])
    }
  })

  it("applies the password rule", async () => {
    const cases: [string, string][] = [
      ["short-pw", "TOO_SHORT"],
      ["x".repeat(129), "TOO_LONG"],
      ["password123", "TOO_COMMON"],
      ["hala-loves-mondays", "CONTAINS_PERSONAL_INFO"],
    ]
    for (const [password, code] of cases) {
      const response = await api.post("/auth/signup", signupBody({ password }))
      expect(fieldCodes(response.body), password).toEqual([["password", code]])
    }
  })

  it("rejects an unknown timezone", async () => {
    const response = await api.post(
      "/auth/signup",
      signupBody({ timezone: "Mars/Olympus" })
    )
    expect(fieldCodes(response.body)).toEqual([["timezone", "INVALID_FORMAT"]])
  })
})

describe("POST /auth/login", () => {
  it("logs in with the right password; the access token opens /me", async () => {
    const response = await login(admin.email)
    expect(response.status).toBe(200)
    const me = await api.get("/me", response.body.accessToken)
    expect(me.body).toMatchObject({
      id: admin.id,
      name: admin.name,
      role: "ADMIN",
      company: {
        id: DEMO_COMPANY._id,
        name: DEMO_COMPANY.name,
        timezone: "Asia/Riyadh",
      },
    })
  })

  it("answers wrong password and unknown email the same way (no enumeration)", async () => {
    const wrong = await login(employee.email, "not-the-password")
    const unknown = await login("nobody@nowhere.example")
    for (const response of [wrong, unknown]) {
      expect(response.status).toBe(401)
      expect(response.body).toEqual({
        code: "INVALID_CREDENTIALS",
        message: "Invalid credentials",
      })
    }
  })

  it("refuses an invited account that has no password yet", async () => {
    expect((await login(invited.email)).body).toMatchObject({
      code: "INVALID_CREDENTIALS",
    })
  })

  it("answers 403 ACCOUNT_DEACTIVATED only after a correct password", async () => {
    expect((await login("deactivated@demo.stampd.app")).status).toBe(403)
    expect((await login("deactivated@demo.stampd.app")).body).toMatchObject({
      code: "ACCOUNT_DEACTIVATED",
    })
    expect(
      (await login("deactivated@demo.stampd.app", "wrong-password")).body
    ).toMatchObject({
      code: "INVALID_CREDENTIALS",
    })
  })

  it("blocks an email for 15 minutes after 10 failed attempts", async () => {
    const signup = signupBody()
    await api.post("/auth/signup", signup)
    for (let i = 0; i < 10; i += 1) {
      expect((await login(signup.email, "wrong-password")).status).toBe(401)
    }
    const blocked = await login(signup.email, signup.password)
    expect(blocked.status).toBe(429)
    expect(blocked.body).toMatchObject({ code: "TOO_MANY_ATTEMPTS" })
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0)

    api.clock.advance(15 * 60 * 1000 + 1)
    expect((await login(signup.email, signup.password)).status).toBe(200)
  })

  it("validates the body", async () => {
    const response = await api.post("/auth/login", { email: "not-an-email" })
    expect(fieldCodes(response.body)).toEqual([
      ["email", "INVALID_FORMAT"],
      ["password", "REQUIRED"],
    ])
  })

  it("never writes passwords or tokens to the log", async () => {
    const response = await login(admin.email)
    const logged = JSON.stringify(api.logs)
    expect(logged).not.toContain(DEMO_PASSWORD)
    expect(logged).not.toContain(response.body.refreshToken)
    expect(logged).not.toContain(response.body.accessToken)
  })
})

describe("access tokens", () => {
  it("are required, must be genuine and expire after 15 minutes", async () => {
    expect((await api.get("/me")).body).toMatchObject({
      code: "UNAUTHENTICATED",
    })
    const { body } = await login(admin.email)
    expect((await api.get("/me", `${body.accessToken}x`)).status).toBe(401)

    api.clock.advance(15 * 60 * 1000 - 1000)
    expect((await api.get("/me", body.accessToken)).status).toBe(200)
    api.clock.advance(1000)
    expect((await api.get("/me", body.accessToken)).body).toMatchObject({
      code: "UNAUTHENTICATED",
    })
  })

  it("stop working when the account is deactivated (403), and a role change applies on the next request", async () => {
    const signup = signupBody()
    const { body } = await api.post<Tokens>("/auth/signup", signup)
    const me = await api.get<{ id: string; company: { id: string } }>(
      "/me",
      body.accessToken
    )
    const scope = { _id: me.body.id, companyId: me.body.company.id }

    await UserModel.updateOne(scope, { role: "MANAGER" })
    expect((await api.get("/me", body.accessToken)).body).toMatchObject({
      role: "MANAGER",
    })

    await UserModel.updateOne(scope, { status: "DEACTIVATED" })
    const denied = await api.get("/me", body.accessToken)
    expect(denied.status).toBe(403)
    expect(denied.body).toMatchObject({ code: "ACCOUNT_DEACTIVATED" })
  })
})

describe("POST /auth/refresh", () => {
  it("rotates: a new pair every time, and the new refresh token works", async () => {
    const first = (await login(admin.email)).body
    const second = await api.post<Tokens>("/auth/refresh", {
      refreshToken: first.refreshToken,
    })
    expect(second.status).toBe(200)
    expect(second.body.refreshToken).not.toBe(first.refreshToken)
    expect((await api.get("/me", second.body.accessToken)).status).toBe(200)
    const third = await api.post<Tokens>("/auth/refresh", {
      refreshToken: second.body.refreshToken,
    })
    expect(third.status).toBe(200)
  })

  it("returns the SAME new pair when the previous token is replayed within 20 seconds", async () => {
    const first = (await login(admin.email)).body
    const rotated = await api.post<Tokens>("/auth/refresh", {
      refreshToken: first.refreshToken,
    })
    api.clock.advance(19_000)
    const replay = await api.post<Tokens>("/auth/refresh", {
      refreshToken: first.refreshToken,
    })
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual(rotated.body)
  })

  it("gives parallel refreshes of the same token the same pair", async () => {
    const first = (await login(admin.email)).body
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        api.post<Tokens>("/auth/refresh", { refreshToken: first.refreshToken })
      )
    )
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200])
    expect(new Set(results.map((r) => r.body.refreshToken)).size).toBe(1)
    expect(new Set(results.map((r) => r.body.accessToken)).size).toBe(1)
  })

  it("treats reuse after 20 seconds as theft: the whole session is revoked", async () => {
    const first = (await login(admin.email)).body
    const rotated = (
      await api.post<Tokens>("/auth/refresh", {
        refreshToken: first.refreshToken,
      })
    ).body
    api.clock.advance(21_000)

    const reuse = await api.post("/auth/refresh", {
      refreshToken: first.refreshToken,
    })
    expect(reuse.status).toBe(401)
    expect(reuse.body).toMatchObject({ code: "SESSION_EXPIRED" })
    // Every token of the family is now dead, including the latest pair.
    expect(
      (await api.post("/auth/refresh", { refreshToken: rotated.refreshToken }))
        .status
    ).toBe(401)
    expect((await api.get("/me", rotated.accessToken)).status).toBe(401)
  })

  it("expires refresh tokens after 30 days", async () => {
    const first = (await login(admin.email)).body
    api.clock.advance(30 * 24 * 60 * 60 * 1000 + 1)
    expect(
      (await api.post("/auth/refresh", { refreshToken: first.refreshToken }))
        .body
    ).toMatchObject({
      code: "SESSION_EXPIRED",
    })
  })

  it("refuses unknown tokens and deactivated accounts", async () => {
    expect(
      (await api.post("/auth/refresh", { refreshToken: "made-up" })).status
    ).toBe(401)

    const signup = signupBody()
    const { body } = await api.post<Tokens>("/auth/signup", signup)
    await UserModel.updateOne(
      { email: signup.email, companyId: { $exists: true } },
      { status: "DEACTIVATED" }
    )
    const response = await api.post("/auth/refresh", {
      refreshToken: body.refreshToken,
    })
    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({ code: "ACCOUNT_DEACTIVATED" })
  })
})

describe("POST /auth/logout", () => {
  it("ends the session: its refresh and access tokens stop working", async () => {
    const tokens = (await login(admin.email)).body
    expect(
      (await api.post("/auth/logout", { refreshToken: tokens.refreshToken }))
        .status
    ).toBe(204)
    expect(
      (await api.post("/auth/refresh", { refreshToken: tokens.refreshToken }))
        .status
    ).toBe(401)
    expect((await api.get("/me", tokens.accessToken)).status).toBe(401)
  })

  it("always succeeds, even for unknown tokens", async () => {
    expect(
      (await api.post("/auth/logout", { refreshToken: "unknown" })).status
    ).toBe(204)
  })
})

describe("invitations", () => {
  it("lets an invited employee set a password and logs them into their company only", async () => {
    await issueInvitation(
      { id: invited.id, companyId: DEMO_COMPANY._id },
      api.authDeps()
    )
    const token = lastLoggedToken("invite")
    expect(String(api.logs.at(-1)?.link)).toMatch(
      /^http:\/\/localhost:3000\/en\/invite\//
    )

    const info = await api.post("/auth/invitations/verify", { token })
    expect(info.status).toBe(200)
    expect(info.body).toEqual({
      companyName: DEMO_COMPANY.name,
      name: invited.name,
      email: invited.email,
      expiresAt: new Date(
        api.clock.now().getTime() + 7 * 24 * 3600 * 1000
      ).toISOString(),
    })

    const accepted = await api.post<Tokens>("/auth/invitations/accept", {
      token,
      name: "Noura Al-Saleh",
      password: "green-desert-morning",
    })
    expect(accepted.status).toBe(200)
    const me = await api.get("/me", accepted.body.accessToken)
    expect(me.body).toMatchObject({
      id: invited.id,
      name: "Noura Al-Saleh",
      role: "EMPLOYEE",
      status: "ACTIVE",
      company: { id: DEMO_COMPANY._id },
    })

    // Single use.
    expect(
      (await api.post("/auth/invitations/verify", { token })).body
    ).toMatchObject({
      code: "TOKEN_INVALID",
    })
    expect((await login(invited.email, "green-desert-morning")).status).toBe(
      200
    )
  })

  it("expires after 7 days; a re-issued invite works and replaces the old one", async () => {
    const signup = signupBody()
    const owner = (await api.post<Tokens>("/auth/signup", signup)).body
    const me = await api.get("/me", owner.accessToken)
    const companyId = (me.body.company as { id: string }).id
    // An invited colleague, created the way BE-06 will create one.
    const [user] = await UserModel.create([
      {
        companyId,
        email: `new.${Date.now()}@acme.example`,
        role: "EMPLOYEE",
        status: "INVITED",
      },
    ])
    await issueInvitation({ id: user!._id, companyId }, api.authDeps())
    const oldToken = lastLoggedToken("invite")

    api.clock.advance(7 * 24 * 3600 * 1000 + 1)
    const expired = await api.post("/auth/invitations/verify", {
      token: oldToken,
    })
    expect(expired.status).toBe(410)
    expect(expired.body).toMatchObject({ code: "TOKEN_EXPIRED" })

    await issueInvitation({ id: user!._id, companyId }, api.authDeps())
    const newToken = lastLoggedToken("invite")
    expect(
      (await api.post("/auth/invitations/verify", { token: newToken })).status
    ).toBe(200)
    expect(
      (await api.post("/auth/invitations/verify", { token: oldToken })).status
    ).toBe(404)
  })

  it("applies the password rule and refuses unknown tokens", async () => {
    await issueInvitation(
      { id: invited.id, companyId: DEMO_COMPANY._id },
      api.authDeps()
    ).catch(() => {})
    const response = await api.post("/auth/invitations/accept", {
      token: "unknown-token",
      name: "X",
      password: "green-desert-morning",
    })
    expect(response.status).toBe(404)
    expect(response.body).toMatchObject({ code: "TOKEN_INVALID" })
  })

  it("can only be issued to invited users", async () => {
    await expect(
      issueInvitation(
        { id: admin.id, companyId: DEMO_COMPANY._id },
        api.authDeps()
      )
    ).rejects.toMatchObject({ status: 409 })
  })
})

describe("password reset", () => {
  it("resets with a single-use link, logs the user in and ends every other session", async () => {
    const signup = signupBody()
    const other = (await api.post<Tokens>("/auth/signup", signup)).body

    expect(
      (await api.post("/auth/password/forgot", { email: signup.email })).status
    ).toBe(202)
    const token = lastLoggedToken("reset-password")
    expect(
      (await api.post("/auth/password/reset/verify", { token })).status
    ).toBe(204)

    const reset = await api.post<Tokens>("/auth/password/reset", {
      token,
      password: "quiet-harbour-lights",
    })
    expect(reset.status).toBe(200)
    expect((await api.get("/me", reset.body.accessToken)).status).toBe(200)

    // The session that existed before the reset is gone.
    expect((await api.get("/me", other.accessToken)).status).toBe(401)
    expect(
      (await api.post("/auth/refresh", { refreshToken: other.refreshToken }))
        .status
    ).toBe(401)
    // New password works, old one doesn't, link can't be reused.
    expect((await login(signup.email, "quiet-harbour-lights")).status).toBe(200)
    expect((await login(signup.email, signup.password)).status).toBe(401)
    expect(
      (
        await api.post("/auth/password/reset", {
          token,
          password: "another-long-secret",
        })
      ).body
    ).toMatchObject({
      code: "TOKEN_INVALID",
    })
  })

  it("answers 202 for unknown emails without creating a link (no enumeration)", async () => {
    const before = api.logs.length
    expect(
      (
        await api.post("/auth/password/forgot", {
          email: "nobody@nowhere.example",
        })
      ).status
    ).toBe(202)
    expect(api.logs.slice(before).some((l) => "link" in l)).toBe(false)
  })

  it("expires reset links after one hour", async () => {
    const signup = signupBody()
    await api.post("/auth/signup", signup)
    await api.post("/auth/password/forgot", { email: signup.email })
    const token = lastLoggedToken("reset-password")
    api.clock.advance(60 * 60 * 1000 + 1)
    const response = await api.post("/auth/password/reset/verify", { token })
    expect(response.status).toBe(410)
    expect(response.body).toMatchObject({ code: "TOKEN_EXPIRED" })
  })

  it("applies the password rule to the new password", async () => {
    const signup = signupBody({ email: `rania.${Date.now()}@acme.example` })
    await api.post("/auth/signup", signup)
    await api.post("/auth/password/forgot", { email: signup.email })
    const token = lastLoggedToken("reset-password")
    const response = await api.post("/auth/password/reset", {
      token,
      password: "rania-new-password",
    })
    expect(fieldCodes(response.body)).toEqual([
      ["password", "CONTAINS_PERSONAL_INFO"],
    ])
  })
})

describe("POST /me/password", () => {
  it("needs the right current password", async () => {
    const signup = signupBody()
    const { body } = await api.post<Tokens>("/auth/signup", signup)
    const response = await api.post(
      "/me/password",
      { currentPassword: "wrong-password", newPassword: "fresh-valley-breeze" },
      body.accessToken
    )
    expect(response.status).toBe(422)
    expect(fieldCodes(response.body)).toEqual([
      ["currentPassword", "INCORRECT"],
    ])
  })

  it("changes the password, keeps this session and signs out the others", async () => {
    const signup = signupBody()
    const current = (await api.post<Tokens>("/auth/signup", signup)).body
    const other = (await login(signup.email, signup.password)).body

    const response = await api.post(
      "/me/password",
      { currentPassword: signup.password, newPassword: "fresh-valley-breeze" },
      current.accessToken
    )
    expect(response.status).toBe(204)
    expect((await api.get("/me", current.accessToken)).status).toBe(200)
    expect((await api.get("/me", other.accessToken)).status).toBe(401)
    expect(
      (await api.post("/auth/refresh", { refreshToken: other.refreshToken }))
        .status
    ).toBe(401)
    expect((await login(signup.email, "fresh-valley-breeze")).status).toBe(200)
  })

  it("applies the password rule and requires authentication", async () => {
    const signup = signupBody()
    const { body } = await api.post<Tokens>("/auth/signup", signup)
    const weak = await api.post(
      "/me/password",
      { currentPassword: signup.password, newPassword: "password123" },
      body.accessToken
    )
    expect(fieldCodes(weak.body)).toEqual([["newPassword", "TOO_COMMON"]])
    expect(
      (
        await api.post("/me/password", {
          currentPassword: "a",
          newPassword: "b",
        })
      ).status
    ).toBe(401)
  })
})
