import { describe, expect, it } from "vitest"

import { CsvError, parseCsv } from "../../src/platform/csv.ts"

describe("parseCsv", () => {
  it("reads rows and cells with their line numbers", () => {
    expect(parseCsv("name,email\nLina,lina@x.com\nOmar,omar@x.com")).toEqual([
      { line: 1, cells: ["name", "email"] },
      { line: 2, cells: ["Lina", "lina@x.com"] },
      { line: 3, cells: ["Omar", "omar@x.com"] },
    ])
  })

  it("handles quotes, commas and line breaks inside quotes, and doubled quotes", () => {
    expect(
      parseCsv('name,title\n"Haddad, Lina","Lead ""Ops""\nGCC"\nOmar,')
    ).toEqual([
      { line: 1, cells: ["name", "title"] },
      { line: 2, cells: ["Haddad, Lina", 'Lead "Ops"\nGCC'] },
      { line: 4, cells: ["Omar", ""] },
    ])
  })

  it("accepts CRLF, Excel's byte-order mark and blank lines", () => {
    expect(parseCsv("﻿name\r\nسارة\r\n\r\nOmar\r\n")).toEqual([
      { line: 1, cells: ["name"] },
      { line: 2, cells: ["سارة"] },
      { line: 4, cells: ["Omar"] },
    ])
  })

  it("rejects broken quoting", () => {
    expect(() => parseCsv('name\n"never closed')).toThrow(CsvError)
    expect(() => parseCsv('name\nab"c"')).toThrow(CsvError)
  })
})
