import { readSheet } from "read-excel-file/node";
import { DomainError } from "./errors";
import { parseCsv } from "./csv";

const pad = (n: number) => String(n).padStart(2, "0");

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    // Spreadsheet dates carry no zone; the reader gives the wall-clock time as UTC fields.
    const d = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
    const hasTime = v.getUTCHours() !== 0 || v.getUTCMinutes() !== 0;
    return hasTime ? `${d} ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}` : d;
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v).trim();
}

/** Text from a CSV file. Excel in the UK often saves CSV as Windows-1252, so fall back to that when it is not valid UTF-8. */
export function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export const isExcelName = (name: string) => /\.xlsx$/i.test(name);

/** A CSV or Excel (.xlsx) file as rows of text. Excel: the first sheet is read. */
export async function readTable(name: string, bytes: Uint8Array): Promise<string[][]> {
  if (isExcelName(name)) {
    try {
      const rows = (await readSheet(Buffer.from(bytes))) as unknown[][];
      return rows.map((r) => r.map(cell)).filter((r) => r.some((v) => v !== ""));
    } catch {
      throw new DomainError("validation", "That Excel file could not be read. Save it as .xlsx (not .xls) or as CSV and try again.");
    }
  }
  if (/\.xls$/i.test(name)) throw new DomainError("validation", "Old .xls files are not supported. Open it in Excel and save as .xlsx or CSV.");
  return parseCsv(decodeCsv(bytes));
}
