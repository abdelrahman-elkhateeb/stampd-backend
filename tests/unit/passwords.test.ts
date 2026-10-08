import { describe, expect, it } from "vitest"

import {
  hashPassword,
  passwordProblem,
  verifyPassword,
} from "../../src/modules/identity/passwords.ts"

describe("password rule", () => {
  const person = { name: "Sara Al-Harbi", email: "sara.harbi@demo.stampd.app" }

  it("accepts a long, uncommon password without personal info", () => {
    expect(passwordProblem("blue-river-lantern", person)).toBeUndefined()
  })

  it("enforces 10 to 128 characters", () => {
    expect(passwordProblem("short-pw1", person)).toBe("TOO_SHORT")
    expect(passwordProblem("x".repeat(129), person)).toBe("TOO_LONG")
    expect(
      passwordProblem("x".repeat(128).replace(/^x{4}/, "blue"), person)
    ).toBeUndefined()
  })

  it("refuses common passwords, whatever the case", () => {
    expect(passwordProblem("password123", person)).toBe("TOO_COMMON")
    expect(passwordProblem("QwertyUIOP", person)).toBe("TOO_COMMON")
  })

  it("refuses passwords containing the person's name or email", () => {
    expect(passwordProblem("my-sara-password", person)).toBe(
      "CONTAINS_PERSONAL_INFO"
    )
    expect(passwordProblem("HARBI-is-great", person)).toBe(
      "CONTAINS_PERSONAL_INFO"
    )
    expect(passwordProblem("sara.harbi-2026!", person)).toBe(
      "CONTAINS_PERSONAL_INFO"
    )
    // Each word of the email's local part counts too.
    expect(
      passwordProblem("rania-new-password", {
        email: "rania.k2026@acme.example",
      })
    ).toBe("CONTAINS_PERSONAL_INFO")
    // Name parts shorter than 3 letters ("Al") don't count.
    expect(passwordProblem("totally-al-fine", person)).toBeUndefined()
  })

  it("works with Arabic names", () => {
    expect(passwordProblem("كلمةسارةالسرية", { name: "سارة الحربي" })).toBe(
      "CONTAINS_PERSONAL_INFO"
    )
  })
})

describe("password hashing (scrypt)", () => {
  it("verifies the right password and rejects others", async () => {
    const hash = await hashPassword("blue-river-lantern")
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/)
    expect(await verifyPassword("blue-river-lantern", hash)).toBe(true)
    expect(await verifyPassword("blue-river-lanterN", hash)).toBe(false)
  })

  it("salts every hash", async () => {
    expect(await hashPassword("same-password-twice")).not.toBe(
      await hashPassword("same-password-twice")
    )
  })

  it("rejects malformed stored values instead of throwing", async () => {
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false)
  })
})
