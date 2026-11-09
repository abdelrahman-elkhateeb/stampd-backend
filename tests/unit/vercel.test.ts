import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("Vercel deployment", () => {
  it("sends every path to the single function", () => {
    const { rewrites } = JSON.parse(
      readFileSync(new URL("../../vercel.json", import.meta.url), "utf8")
    ) as { rewrites: unknown[] }
    expect(rewrites).toEqual([{ source: "/(.*)", destination: "/api/index" }])
    expect(readdirSync(new URL("../../api", import.meta.url))).toEqual([
      "index.js",
    ])
  })
})
