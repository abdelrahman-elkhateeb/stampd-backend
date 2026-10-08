import { describe, expect, it } from "vitest"

import {
  ACCESS_TOKEN_TTL_SECONDS,
  hashToken,
  randomToken,
  rotatedRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from "../../src/modules/identity/tokens.ts"

const secret = "test-secret-0123456789abcdefghijklmnopqrstuv"
const issuedAt = Date.UTC(2026, 9, 9, 8, 0, 0) / 1000
const claims = {
  sub: "user-1",
  cid: "company-1",
  sid: "session-1",
  iat: issuedAt,
  exp: issuedAt + ACCESS_TOKEN_TTL_SECONDS,
}
const at = (secondsAfterIssue: number) =>
  new Date((issuedAt + secondsAfterIssue) * 1000)

describe("access tokens (JWT, HS256)", () => {
  it("are standard three-part JWTs that verify with the same secret", () => {
    const token = signAccessToken(claims, secret)
    expect(token.split(".")).toHaveLength(3)
    expect(verifyAccessToken(token, secret, at(60))).toEqual(claims)
  })

  it("last 15 minutes", () => {
    const token = signAccessToken(claims, secret)
    expect(verifyAccessToken(token, secret, at(899))).toBeDefined()
    expect(verifyAccessToken(token, secret, at(900))).toBeUndefined()
  })

  it("reject another secret, a changed payload and garbage", () => {
    const token = signAccessToken(claims, secret)
    expect(verifyAccessToken(token, `${secret}x`, at(1))).toBeUndefined()

    const [header, , signature] = token.split(".")
    const forged = Buffer.from(
      JSON.stringify({ ...claims, cid: "company-2" })
    ).toString("base64url")
    expect(
      verifyAccessToken(`${header}.${forged}.${signature}`, secret, at(1))
    ).toBeUndefined()

    expect(verifyAccessToken("not.a.token", secret, at(1))).toBeUndefined()
    expect(verifyAccessToken("", secret, at(1))).toBeUndefined()
  })

  it("are deterministic: same claims, same token (the grace window relies on it)", () => {
    expect(signAccessToken(claims, secret)).toBe(
      signAccessToken(claims, secret)
    )
  })
})

describe("refresh tokens", () => {
  it("are random, and only their hash is stored", () => {
    const a = randomToken()
    expect(a).not.toBe(randomToken())
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken(a)).not.toContain(a)
  })

  it("rotate to a token derived from the previous one, the next id and the secret", () => {
    const previous = randomToken()
    const next = rotatedRefreshToken(previous, "next-id", secret)
    expect(next).toBe(rotatedRefreshToken(previous, "next-id", secret))
    expect(next).not.toBe(rotatedRefreshToken(previous, "other-id", secret))
    expect(next).not.toBe(
      rotatedRefreshToken(previous, "next-id", `${secret}x`)
    )
    expect(next).not.toBe(previous)
  })
})
