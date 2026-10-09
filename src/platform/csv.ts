/**
 * A small CSV reader (RFC 4180): comma-separated, fields may be quoted with
 * "…", a quote inside a quoted field is written "", and quoted fields may
 * contain commas and line breaks. Accepts CRLF or LF line endings and the
 * byte-order mark Excel adds. Blank lines are skipped.
 *
 * Returns each row with its line number in the file (1 = first line), so
 * errors can point at the line people see in their spreadsheet.
 */
export class CsvError extends Error {
  override readonly name = "CsvError"
}

export type CsvRow = { line: number; cells: string[] }

export function parseCsv(text: string): CsvRow[] {
  const input = text.startsWith("﻿") ? text.slice(1) : text
  const rows: CsvRow[] = []
  let cells: string[] = []
  let cell = ""
  let quoted = false
  let line = 1
  let rowLine = 1

  const endRow = () => {
    cells.push(cell)
    if (cells.length > 1 || cells[0] !== "") rows.push({ line: rowLine, cells })
    cells = []
    cell = ""
  }

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          cell += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        if (char === "\n") line += 1
        cell += char
      }
      continue
    }
    if (char === '"') {
      if (cell !== "") {
        throw new CsvError(`line ${line}: a quote may only start a field`)
      }
      quoted = true
    } else if (char === ",") {
      cells.push(cell)
      cell = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i += 1
      endRow()
      line += 1
      rowLine = line
    } else {
      cell += char
    }
  }
  if (quoted) throw new CsvError(`line ${rowLine}: a quoted field never ends`)
  endRow()
  return rows
}
