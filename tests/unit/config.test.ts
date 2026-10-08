import { describe, expect, it } from "vitest"

import { ConfigError, loadConfig } from "../../src/config/env.ts"

const valid = {
  APP_ENV: "local",
  MONGODB_URI: "mongodb://stampd:secret-pw@localhost:27017/stampd",
}

describe("loadConfig", () => {
  it("applies defaults for optional variables", () => {
    expect(loadConfig(valid)).toEqual({
      appEnv: "local",
      port: 4000,
      host: "0.0.0.0",
      mongodbUri: valid.MONGODB_URI,
      logLevel: "info",
    })
  })

  it("coerces the port from a string", () => {
    expect(loadConfig({ ...valid, PORT: "8080" }).port).toBe(8080)
  })

  it("accepts mongodb+srv URIs (Atlas)", () => {
    expect(() =>
      loadConfig({
        ...valid,
        MONGODB_URI: "mongodb+srv://u:p@cluster0.example.net/stampd",
      })
    ).not.toThrow()
  })

  it("rejects missing required variables, naming each one", () => {
    expect(() => loadConfig({})).toThrow(ConfigError)
    expect(() => loadConfig({})).toThrow(/APP_ENV[\s\S]*MONGODB_URI/)
  })

  it("rejects unknown environments and non-MongoDB URIs", () => {
    expect(() => loadConfig({ ...valid, APP_ENV: "dev" })).toThrow(/APP_ENV/)
    expect(() =>
      loadConfig({ ...valid, MONGODB_URI: "postgres://x@localhost/db" })
    ).toThrow(/MONGODB_URI/)
  })

  it("never puts a value in the error (the URI can hold a password)", () => {
    try {
      loadConfig({ ...valid, PORT: "not-a-port", LOG_LEVEL: "loud" })
      expect.unreachable()
    } catch (error) {
      expect(String(error)).not.toContain("secret-pw")
    }
  })

  it("returns a frozen object", () => {
    expect(Object.isFrozen(loadConfig(valid))).toBe(true)
  })
})
