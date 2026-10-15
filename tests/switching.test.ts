import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/csv";
import { parseDate } from "@/lib/importer";
import { platformSetup } from "./platform.helpers";

const MON_9 = "2026-10-19T08:00:00.000Z";

describe("csv", () => {
  it("handles quotes, commas and newlines inside fields, BOM, CRLF and semicolons", async () => {
    expect(parseCsv('﻿a,b\r\n"x, y","line1\nline2"\r\n"he said ""hi""",z\r\n')).toEqual([["a", "b"], ["x, y", "line1\nline2"], ['he said "hi"', "z"]]);
    expect(parseCsv("a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a,b\n\n,\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });
  it("reads UK dates day-first and rejects impossible ones", async () => {
    expect(parseDate("04/03/1980")).toBe("1980-03-04");
    expect(parseDate("1980-03-04")).toBe("1980-03-04");
    expect(parseDate("31/02/1980")).toBeNull();
    expect(parseDate("4 March 1980")).toBeNull();
  });
});

describe("switching import", () => {
  const patientsCsv = [
    "Patient ID,First Name,Last Name,Date of Birth,Email,Mobile,Notes",
    "C-1,Ann,Able,04/03/1980,ann@example.com,07700 900001,ignored",
    'C-2,Ben,"Baker, Jr",1975-12-31,,07700 900002,',
    "C-3,Cat,Cole,31/02/1990,cat@example.com,,",
    "C-4,,,,,,",
  ].join("\n");

  it("dry run reports exactly what the real run does and writes nothing", async () => {
    const s = await platformSetup();
    const dry = await s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "cliniko", filename: "p.csv", text: patientsCsv, dryRun: true });
    expect(dry.created).toBe(2);
    expect(dry.rejected.map((r) => r.row)).toEqual([4, 5]);
    expect(dry.rejected[0].reason).toMatch(/Date of birth/);
    expect(dry.ignored).toContain("Notes");
    expect((await s.q.get("SELECT COUNT(*) AS n FROM patients WHERE import_batch IS NOT NULL"))).toEqual({ n: 0 });
    expect((await s.q.get("SELECT COUNT(*) AS n FROM import_batches"))).toEqual({ n: 0 });
    const real = await s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "cliniko", filename: "p.csv", text: patientsCsv, dryRun: false });
    expect(real.created).toBe(dry.created);
    expect(real.rejected).toEqual(dry.rejected);
    expect((await s.q.get("SELECT COUNT(*) AS n FROM patients WHERE import_batch = ?", [real.batchId]))).toEqual({ n: 2 });
  });

  it("importing the same file twice does not duplicate patients", async () => {
    const s = await platformSetup();
    await s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "other", filename: "p.csv", text: patientsCsv, dryRun: false });
    const again = await s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "other", filename: "p.csv", text: patientsCsv, dryRun: false });
    expect(again.created).toBe(0);
    expect(again.existing).toBe(2); // Ann and Ben match on name + date of birth; the two bad rows are rejected again
  });

  it("imports appointments against imported patients, maps statuses, and reports overlaps and unknowns", async () => {
    const s = await platformSetup();
    await s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "tm3", filename: "p.csv", text: patientsCsv, dryRun: false });
    const csv = [
      "Client ID,Date,Time,Practitioner,Appointment Type,Status",
      "C-1,20/10/2026,09:00,Olive Owner,Follow-up,",
      "C-2,20/10/2026,09:15,Olive Owner,Follow-up,",
      "C-1,01/09/2026,10:00,Olive Owner,Follow-up,Attended",
      "C-1,02/09/2026,10:00,Olive Owner,Follow-up,Cancelled",
      "C-2,03/09/2026,10:00,Olive Owner,Follow-up,DNA",
      "C-9,21/10/2026,10:00,Olive Owner,Follow-up,",
      "C-1,21/10/2026,10:00,Nobody,Follow-up,",
      "C-1,21/10/2026,10:00,Olive Owner,Massage,",
    ].join("\n");
    const rep = await s.p.importer.run(s.clinicId, "u", { kind: "appointments", source: "tm3", filename: "a.csv", text: csv, dryRun: false });
    expect(rep.created).toBe(4);
    expect(rep.rejected.map((r) => r.reason)).toEqual([
      expect.stringMatching(/Overlaps/),
      expect.stringMatching(/No matching patient/),
      expect.stringMatching(/No clinician called/),
      expect.stringMatching(/No appointment type called/),
    ]);
    const statuses = ((await s.q.all("SELECT status FROM appointments WHERE source = 'import' ORDER BY start_at")) as { status: string }[]).map((r) => r.status);
    expect(statuses).toEqual(["completed", "cancelled", "no_show", "booked"]);
  });

  it("undo removes the batch within seven days, keeps patients that have since been used, and refuses after that", async () => {
    const s = await platformSetup();
    const rep = await s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "other", filename: "p.csv", text: patientsCsv, dryRun: false });
    const ann = (await s.q.get("SELECT id FROM patients WHERE first_name = 'Ann'")) as { id: string };
    await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: ann.id, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    const res = await s.p.importer.undo(s.clinicId, "u", rep.batchId!);
    expect(res).toEqual({ removedAppointments: 0, removedPatients: 1, keptPatients: 1 });
    await expect(s.p.importer.undo(s.clinicId, "u", rep.batchId!)).rejects.toThrowError(/already/);
    const late = await s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "other", filename: "q.csv", text: "First Name,Last Name\nZed,Zulu", dryRun: false });
    s.clock.now = new Date(s.clock.now.getTime() + 8 * 86_400_000);
    await expect(s.p.importer.undo(s.clinicId, "u", late.batchId!)).rejects.toThrowError(/7 days/);
  });

  it("a dry run on a file with no usable columns reports the problem; saving it is refused; another clinic's batch is out of reach", async () => {
    const s = await platformSetup();
    const dry = await s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "other", filename: "x.csv", text: "foo,bar\n1,2", dryRun: true });
    expect(dry.problems[0]).toMatch(/first name/i);
    expect(dry.created).toBe(0);
    expect(dry.columns.map((c) => c.field)).toEqual([null, null]);
    await expect(s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "other", filename: "x.csv", text: "foo,bar\n1,2", dryRun: false })).rejects.toThrowError(/first name/i);
    const rep = await s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "other", filename: "q.csv", text: "First Name,Last Name\nZed,Zulu", dryRun: false });
    await expect(s.p.importer.undo("other-clinic", "u", rep.batchId!)).rejects.toThrowError(/not found/i);
  });
});

describe("import options: column mapping, Excel, templates", () => {
  const odd = "Surname,Forename,DoB (UK),Home,Street,Post code\nAble,Ann,04/03/1980,07700 900001,1 High St,tw13 4ab\nBaker,Ben,1975-12-31,07700 900002,2 Low Rd,TW1 1AA";

  it("columns with unfamiliar headings can be mapped by hand, and the dry run then matches the real run", async () => {
    const s = await platformSetup();
    const first = await s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "tm3", filename: "t.csv", text: odd, dryRun: true });
    expect(first.columns.find((c) => c.header === "Home")?.field).toBeNull();
    expect(first.created).toBe(2);
    const mapping = ["lastName", "firstName", "dob", "phone", "address", "postcode"];
    const dry = await s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "tm3", filename: "t.csv", text: odd, mapping, dryRun: true });
    expect(dry.columns.map((c) => c.field)).toEqual(mapping);
    expect(dry.created).toBe(2);
    expect((await s.q.get("SELECT COUNT(*) AS n FROM patients WHERE import_batch IS NOT NULL"))).toEqual({ n: 0 });
    const real = await s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "tm3", filename: "t.csv", text: odd, mapping, dryRun: false });
    expect(real.created).toBe(2);
    const row = (await s.q.get("SELECT first_name, last_name, dob, phone, address, postcode FROM patients WHERE last_name = 'Able' AND import_batch IS NOT NULL"));
    expect(row).toMatchObject({ first_name: "Ann", last_name: "Able", dob: "1980-03-04", phone: "07700 900001", address: "1 High St", postcode: "TW13 4AB" });
  });

  it("a corrected mapping can swap columns and leave columns out; a field is only filled once", async () => {
    const s = await platformSetup();
    const text = "A,B,C\nAble,Ann,x\n";
    const rep = await s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "other", filename: "t.csv", text, mapping: ["lastName", "firstName", null], dryRun: false });
    expect((await s.q.get("SELECT first_name, last_name FROM patients WHERE import_batch = ?", [rep.batchId]))).toEqual({ first_name: "Ann", last_name: "Able" });
    const twice = await s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "other", filename: "t.csv", text, mapping: ["firstName", "firstName", "lastName"], dryRun: true });
    expect(twice.columns.map((c) => c.field)).toEqual(["firstName", null, "lastName"]);
  });

  it("an appointments file with no patient column reports it so the person can choose one", async () => {
    const s = await platformSetup();
    const dry = await s.p.importer.run(s.clinicId, "u", { kind: "appointments", source: "tm3", filename: "a.csv", text: "When,Who\n04/11/2026 10:00,Ann Able", dryRun: true });
    expect(dry.problems.length).toBe(2);
    const fixed = await s.p.importer.run(s.clinicId, "u", { kind: "appointments", source: "tm3", filename: "a.csv", text: "When,Who\n04/11/2026 10:00,Ann Able", mapping: ["start", "patientName"], dryRun: true });
    expect(fixed.problems).toEqual([]);
  });

  it("the downloadable templates are read back with every column recognised", async () => {
    const { FIELDS } = await import("@/lib/import-meta");
    const s = await platformSetup();
    for (const kind of ["patients", "appointments"] as const) {
      const fields = FIELDS[kind].filter((f) => f.key !== "fullName" && f.key !== "date" && f.key !== "time");
      const rows = [fields.map((f) => f.header), fields.map((f) => f.example)];
      const rep = await s.p.importer.run(s.clinicId, "u", { kind, source: "other", filename: "t.csv", rows, dryRun: true });
      expect(rep.columns.map((c) => c.field)).toEqual(fields.map((f) => f.key));
      expect(rep.problems).toEqual([]);
    }
  });

  it("reads an Excel file (dates, numbers and the first sheet only) and old Windows-1252 CSV", async () => {
    const { default: writeExcelFile } = await import("write-excel-file/node");
    const { readTable, decodeCsv } = await import("@/lib/sheet");
    const buf = await writeExcelFile([
      ["First name", "Last name", "Date of birth", "Patient ID"],
      ["Ann", "Able", { value: new Date(Date.UTC(1980, 2, 4)), type: Date, format: "dd/mm/yyyy" }, 10482],
    ]).toBuffer();
    const rows = await readTable("patients.xlsx", new Uint8Array(buf));
    expect(rows).toEqual([["First name", "Last name", "Date of birth", "Patient ID"], ["Ann", "Able", "1980-03-04", "10482"]]);
    const s = await platformSetup();
    const rep = await s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "writeupp", filename: "patients.xlsx", rows, dryRun: false });
    expect(rep.created).toBe(1);
    expect((await s.q.get("SELECT dob, external_ref FROM patients WHERE import_batch = ?", [rep.batchId]))).toEqual({ dob: "1980-03-04", external_ref: "10482" });
    await expect(readTable("old.xls", new Uint8Array([1]))).rejects.toThrowError(/\.xls/);
    await expect(readTable("broken.xlsx", new Uint8Array([1, 2, 3]))).rejects.toThrowError(/could not be read/);
    expect(decodeCsv(new Uint8Array([0x4f, 0x27, 0x42, 0x72, 0x69, 0x65, 0x6e, 0x2c, 0xa3]))).toBe("O'Brien,£");
    expect(decodeCsv(new TextEncoder().encode("José"))).toBe("José");
  });

  it("consent is never imported: the patient has to agree again", async () => {
    const s = await platformSetup();
    await s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "tm3", filename: "t.csv", text: "First Name,Last Name,Email,SMS consent,Marketing\nAnn,Able,ann@example.com,yes,yes", dryRun: false });
    expect((await s.q.get("SELECT sms_consent_at, email_consent_at, marketing_consent_at FROM patients WHERE last_name = 'Able' AND import_batch IS NOT NULL"))).toEqual({ sms_consent_at: null, email_consent_at: null, marketing_consent_at: null });
  });
});

describe("calendar feed", () => {
  it("shows initials only, folds long lines, and stops working when revoked or replaced", async () => {
    const s = await platformSetup();
    await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    const cancelled = await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.followUp.id, startAt: "2026-10-19T10:00:00.000Z", source: "staff" });
    await s.p.scheduling.cancelAppointment(s.clinicId, "u", cancelled, "x");
    const token = await s.p.ical.createToken(s.clinicId, s.owner.id);
    const feed = (await s.p.ical.feed(token))!;
    expect(feed).toContain("DTSTART:20261019T080000Z");
    expect(feed).toContain("SUMMARY:P.J. Initial assessment");
    expect(feed).not.toContain("Pat");
    expect(feed.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(feed.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    expect(await s.p.ical.feed(token + "x")).toBeNull();
    const second = await s.p.ical.createToken(s.clinicId, s.owner.id);
    expect(await s.p.ical.feed(token)).toBeNull();
    expect(await s.p.ical.feed(second)).not.toBeNull();
    await s.p.ical.revoke(s.clinicId, s.owner.id);
    expect(await s.p.ical.feed(second)).toBeNull();
  });
  it("only stores a hash of the token", async () => {
    const s = await platformSetup();
    const token = await s.p.ical.createToken(s.clinicId, s.owner.id);
    const rows = (await s.q.all("SELECT token_hash FROM ical_tokens")) as { token_hash: string }[];
    expect(rows.every((r) => !r.token_hash.includes(token))).toBe(true);
  });
});

describe("first-run seeding", () => {
  it("gives a new clinic default appointment types, hours and a starter intake form,", async () => {
    const s = await platformSetup();
    expect((await s.p.scheduling.listTypes(s.clinicId)).length).toBe(3);
    const hours = await s.p.scheduling.getHours(s.clinicId, s.owner.id);
    expect(hours).toHaveLength(5);
    expect(await s.q.get("SELECT count(*)::int AS n FROM forms WHERE clinic_id = ?", [s.clinicId])).toEqual({ n: 1 });
  });
});
