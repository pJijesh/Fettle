import { requireUser } from "@/lib/auth";
import { FIELDS, type ImportKind } from "@/lib/import-meta";

export const dynamic = "force-dynamic";

const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** An empty template with one example row. Opens in Excel. */
export async function GET(req: Request) {
  await requireUser(["owner"]);
  const kind: ImportKind = new URL(req.url).searchParams.get("kind") === "appointments" ? "appointments" : "patients";
  const fields = FIELDS[kind].filter((f) => f.key !== "fullName" && f.key !== "date" && f.key !== "time");
  const body = `${fields.map((f) => q(f.header)).join(",")}\r\n${fields.map((f) => q(f.example)).join(",")}\r\n`;
  return new Response("﻿" + body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${kind}-template.csv"`,
      "cache-control": "no-store",
    },
  });
}
