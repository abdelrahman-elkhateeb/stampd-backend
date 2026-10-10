import { describe, expect, it } from "vitest"

import { CsvError, parseCsv, toCsv } from "../../src/platform/csv.ts"

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

describe("toCsv", () => {
  it("writes a byte-order mark, one header row and CRLF lines", () => {
    expect(
      toCsv(
        ["name", "days"],
        [
          ["سارة", 2.5],
          ["Zoë", 0],
        ]
      )
    ).toBe("﻿name,days\r\nسارة,2.5\r\nZoë,0\r\n")
  })

  it("quotes commas, quotes and line breaks; empty cells for null; yes/no", () => {
    expect(
      toCsv(
        ["a", "b", "c", "d"],
        [['Haddad, "Lina"', "two\nlines", null, true]]
      )
    ).toBe('﻿a,b,c,d\r\n"Haddad, ""Lina""","two\nlines",,yes\r\n')
  })

  it("keeps text from running as a spreadsheet formula, but not numbers", () => {
    expect(toCsv(["x"], [["=SUM(A1)"], ["-5"], ["@cmd"], [-5]])).toBe(
      "﻿x\r\n'=SUM(A1)\r\n'-5\r\n'@cmd\r\n-5\r\n"
    )
  })

  it("reads back with parseCsv", () => {
    const rows = [["Haddad, Lina", 'Lead "Ops"', "سارة"]]
    expect(parseCsv(toCsv(["a", "b", "c"], rows)).map((r) => r.cells)).toEqual([
      ["a", "b", "c"],
      ...rows,
    ])
  })
})
