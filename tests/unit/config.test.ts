import { describe, expect, it } from "vitest"

import {
  ConfigError,
  loadConfig,
  vercelEnvironment,
} from "../../src/config/env.ts"

const valid = {
  APP_ENV: "local",
  MONGODB_URI: "mongodb://stampd:secret-pw@localhost:27017/stampd",
  AUTH_TOKEN_SECRET: "local-dev-secret-change-me-0123456789abcdef",
}

const deployed = {
  APP_ENV: "staging",
  MONGODB_URI: "mongodb+srv://u:p@cluster0.example.net/stampd",
  AUTH_TOKEN_SECRET: "Zr8w1Q2pLk9sXv4nHc7bTe3yUa6mJd5f",
  WEB_APP_URL: "https://staging.stampd.example/",
}

describe("loadConfig", () => {
  it("applies defaults for optional variables", () => {
    expect(loadConfig(valid)).toEqual({
      appEnv: "local",
      port: 4000,
      host: "0.0.0.0",
      mongodbUri: valid.MONGODB_URI,
      logLevel: "info",
      authTokenSecret: valid.AUTH_TOKEN_SECRET,
      webAppUrl: "http://localhost:3000",
      cronSecret: null,
      vercelEnv: null,
    })
  })

  it("reads the scheduled-job secret and the Vercel environment (serverless)", () => {
    const config = loadConfig({
      ...deployed,
      CRON_SECRET: "c".repeat(32),
      VERCEL_ENV: "production",
    })
    expect(config.cronSecret).toBe("c".repeat(32))
    expect(config.vercelEnv).toBe("production")
    expect(() => loadConfig({ ...valid, CRON_SECRET: "short" })).toThrow(
      /CRON_SECRET/
    )
    expect(() => loadConfig({ ...valid, VERCEL_ENV: "staging" })).toThrow(
      /VERCEL_ENV/
    )
  })

  it("coerces the port from a string", () => {
    expect(loadConfig({ ...valid, PORT: "8080" }).port).toBe(8080)
  })

  it("accepts a deployed configuration and trims the web app URL's trailing slash", () => {
    const config = loadConfig(deployed)
    expect(config.appEnv).toBe("staging")
    expect(config.webAppUrl).toBe("https://staging.stampd.example")
  })

  it("rejects missing required variables, naming each one", () => {
    expect(() => loadConfig({})).toThrow(ConfigError)
    expect(() => loadConfig({})).toThrow(
      /APP_ENV[\s\S]*MONGODB_URI[\s\S]*AUTH_TOKEN_SECRET/
    )
  })

  it("rejects unknown environments, non-MongoDB URIs and short secrets", () => {
    expect(() => loadConfig({ ...valid, APP_ENV: "dev" })).toThrow(/APP_ENV/)
    expect(() =>
      loadConfig({ ...valid, MONGODB_URI: "postgres://x@localhost/db" })
    ).toThrow(/MONGODB_URI/)
    expect(() => loadConfig({ ...valid, AUTH_TOKEN_SECRET: "short" })).toThrow(
      /AUTH_TOKEN_SECRET/
    )
  })

  it("refuses the example secret and a localhost web app URL in staging/production", () => {
    expect(() =>
      loadConfig({ ...deployed, AUTH_TOKEN_SECRET: valid.AUTH_TOKEN_SECRET })
    ).toThrow(/AUTH_TOKEN_SECRET/)
    expect(() =>
      loadConfig({
        ...deployed,
        APP_ENV: "production",
        WEB_APP_URL: "http://localhost:3000",
      })
    ).toThrow(/WEB_APP_URL/)
  })

  it("never puts a value in the error (URIs and secrets are sensitive)", () => {
    try {
      loadConfig({
        ...valid,
        PORT: "not-a-port",
        AUTH_TOKEN_SECRET: "tiny-secret",
      })
      expect.unreachable()
    } catch (error) {
      expect(String(error)).not.toContain("secret-pw")
      expect(String(error)).not.toContain("tiny-secret")
    }
  })

  it("returns a frozen object", () => {
    expect(Object.isFrozen(loadConfig(valid))).toBe(true)
  })
})

describe("vercelEnvironment", () => {
  it("reads only VERCEL_ENV, so the build can decide before other settings exist", () => {
    expect(vercelEnvironment({ VERCEL_ENV: "production" })).toBe("production")
    expect(vercelEnvironment({ VERCEL_ENV: "preview" })).toBe("preview")
    expect(vercelEnvironment({})).toBeNull()
    expect(vercelEnvironment({ VERCEL_ENV: "staging" })).toBeNull()
  })
})
