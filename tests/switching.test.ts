import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/csv";
import { parseDate } from "@/lib/importer";
import { openDb } from "@/lib/db";
import { createPlatform } from "@/lib/platform";
import { seedClinic } from "@/lib/seed";
import { platformSetup } from "./platform.helpers";

const MON_9 = "2026-10-19T08:00:00.000Z";

describe("csv", () => {
  it("handles quotes, commas and newlines inside fields, BOM, CRLF and semicolons", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","line1\nline2"\r\n"he said ""hi""",z\r\n')).toEqual([["a", "b"], ["x, y", "line1\nline2"], ['he said "hi"', "z"]]);
    expect(parseCsv("a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a,b\n\n,\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });
  it("reads UK dates day-first and rejects impossible ones", () => {
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

  it("dry run reports exactly what the real run does and writes nothing", () => {
    const s = platformSetup();
    const dry = s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "cliniko", filename: "p.csv", text: patientsCsv, dryRun: true });
    expect(dry.created).toBe(2);
    expect(dry.rejected.map((r) => r.row)).toEqual([4, 5]);
    expect(dry.rejected[0].reason).toMatch(/Date of birth/);
    expect(dry.ignored).toContain("Notes");
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM patients WHERE import_batch IS NOT NULL").get()).toEqual({ n: 0 });
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM import_batches").get()).toEqual({ n: 0 });
    const real = s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "cliniko", filename: "p.csv", text: patientsCsv, dryRun: false });
    expect(real.created).toBe(dry.created);
    expect(real.rejected).toEqual(dry.rejected);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM patients WHERE import_batch = ?").get(real.batchId)).toEqual({ n: 2 });
  });

  it("importing the same file twice does not duplicate patients", () => {
    const s = platformSetup();
    s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "other", filename: "p.csv", text: patientsCsv, dryRun: false });
    const again = s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "other", filename: "p.csv", text: patientsCsv, dryRun: false });
    expect(again.created).toBe(0);
    expect(again.existing).toBe(2); // Ann and Ben match on name + date of birth; the two bad rows are rejected again
  });

  it("imports appointments against imported patients, maps statuses, and reports overlaps and unknowns", () => {
    const s = platformSetup();
    s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "tm3", filename: "p.csv", text: patientsCsv, dryRun: false });
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
    const rep = s.p.importer.run(s.clinicId, "u", { kind: "appointments", source: "tm3", filename: "a.csv", text: csv, dryRun: false });
    expect(rep.created).toBe(4);
    expect(rep.rejected.map((r) => r.reason)).toEqual([
      expect.stringMatching(/Overlaps/),
      expect.stringMatching(/No matching patient/),
      expect.stringMatching(/No clinician called/),
      expect.stringMatching(/No appointment type called/),
    ]);
    const statuses = (s.db.prepare("SELECT status FROM appointments WHERE source = 'import' ORDER BY start_at").all() as { status: string }[]).map((r) => r.status);
    expect(statuses).toEqual(["completed", "cancelled", "no_show", "booked"]);
  });

  it("undo removes the batch within seven days, keeps patients that have since been used, and refuses after that", () => {
    const s = platformSetup();
    const rep = s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "other", filename: "p.csv", text: patientsCsv, dryRun: false });
    const ann = s.db.prepare("SELECT id FROM patients WHERE first_name = 'Ann'").get() as { id: string };
    s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: ann.id, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    const res = s.p.importer.undo(s.clinicId, "u", rep.batchId!);
    expect(res).toEqual({ removedAppointments: 0, removedPatients: 1, keptPatients: 1 });
    expect(() => s.p.importer.undo(s.clinicId, "u", rep.batchId!)).toThrowError(/already/);
    const late = s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "other", filename: "q.csv", text: "First Name,Last Name\nZed,Zulu", dryRun: false });
    s.clock.now = new Date(s.clock.now.getTime() + 8 * 86_400_000);
    expect(() => s.p.importer.undo(s.clinicId, "u", late.batchId!)).toThrowError(/7 days/);
  });

  it("a dry run on a file with no usable columns reports the problem; saving it is refused; another clinic's batch is out of reach", () => {
    const s = platformSetup();
    const dry = s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "other", filename: "x.csv", text: "foo,bar\n1,2", dryRun: true });
    expect(dry.problems[0]).toMatch(/first name/i);
    expect(dry.created).toBe(0);
    expect(dry.columns.map((c) => c.field)).toEqual([null, null]);
    expect(() => s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "other", filename: "x.csv", text: "foo,bar\n1,2", dryRun: false })).toThrowError(/first name/i);
    const rep = s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "other", filename: "q.csv", text: "First Name,Last Name\nZed,Zulu", dryRun: false });
    expect(() => s.p.importer.undo("other-clinic", "u", rep.batchId!)).toThrowError(/not found/i);
  });
});

describe("import options: column mapping, Excel, templates", () => {
  const odd = "Surname,Forename,DoB (UK),Home,Street,Post code\nAble,Ann,04/03/1980,07700 900001,1 High St,tw13 4ab\nBaker,Ben,1975-12-31,07700 900002,2 Low Rd,TW1 1AA";

  it("columns with unfamiliar headings can be mapped by hand, and the dry run then matches the real run", () => {
    const s = platformSetup();
    const first = s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "tm3", filename: "t.csv", text: odd, dryRun: true });
    expect(first.columns.find((c) => c.header === "Home")?.field).toBeNull();
    expect(first.created).toBe(2);
    const mapping = ["lastName", "firstName", "dob", "phone", "address", "postcode"];
    const dry = s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "tm3", filename: "t.csv", text: odd, mapping, dryRun: true });
    expect(dry.columns.map((c) => c.field)).toEqual(mapping);
    expect(dry.created).toBe(2);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM patients WHERE import_batch IS NOT NULL").get()).toEqual({ n: 0 });
    const real = s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "tm3", filename: "t.csv", text: odd, mapping, dryRun: false });
    expect(real.created).toBe(2);
    const row = s.db.prepare("SELECT first_name, last_name, dob, phone, address, postcode FROM patients WHERE last_name = 'Able' AND import_batch IS NOT NULL").get();
    expect(row).toMatchObject({ first_name: "Ann", last_name: "Able", dob: "1980-03-04", phone: "07700 900001", address: "1 High St", postcode: "TW13 4AB" });
  });

  it("a corrected mapping can swap columns and leave columns out; a field is only filled once", () => {
    const s = platformSetup();
    const text = "A,B,C\nAble,Ann,x\n";
    const rep = s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "other", filename: "t.csv", text, mapping: ["lastName", "firstName", null], dryRun: false });
    expect(s.db.prepare("SELECT first_name, last_name FROM patients WHERE import_batch = ?").get(rep.batchId)).toEqual({ first_name: "Ann", last_name: "Able" });
    const twice = s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "other", filename: "t.csv", text, mapping: ["firstName", "firstName", "lastName"], dryRun: true });
    expect(twice.columns.map((c) => c.field)).toEqual(["firstName", null, "lastName"]);
  });

  it("an appointments file with no patient column reports it so the person can choose one", () => {
    const s = platformSetup();
    const dry = s.p.importer.run(s.clinicId, "u", { kind: "appointments", source: "tm3", filename: "a.csv", text: "When,Who\n04/11/2026 10:00,Ann Able", dryRun: true });
    expect(dry.problems.length).toBe(2);
    const fixed = s.p.importer.run(s.clinicId, "u", { kind: "appointments", source: "tm3", filename: "a.csv", text: "When,Who\n04/11/2026 10:00,Ann Able", mapping: ["start", "patientName"], dryRun: true });
    expect(fixed.problems).toEqual([]);
  });

  it("the downloadable templates are read back with every column recognised", async () => {
    const { FIELDS } = await import("@/lib/import-meta");
    const s = platformSetup();
    for (const kind of ["patients", "appointments"] as const) {
      const fields = FIELDS[kind].filter((f) => f.key !== "fullName" && f.key !== "date" && f.key !== "time");
      const rows = [fields.map((f) => f.header), fields.map((f) => f.example)];
      const rep = s.p.importer.run(s.clinicId, "u", { kind, source: "other", filename: "t.csv", rows, dryRun: true });
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
    const s = platformSetup();
    const rep = s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "writeupp", filename: "patients.xlsx", rows, dryRun: false });
    expect(rep.created).toBe(1);
    expect(s.db.prepare("SELECT dob, external_ref FROM patients WHERE import_batch = ?").get(rep.batchId)).toEqual({ dob: "1980-03-04", external_ref: "10482" });
    await expect(readTable("old.xls", new Uint8Array([1]))).rejects.toThrowError(/\.xls/);
    await expect(readTable("broken.xlsx", new Uint8Array([1, 2, 3]))).rejects.toThrowError(/could not be read/);
    expect(decodeCsv(new Uint8Array([0x4f, 0x27, 0x42, 0x72, 0x69, 0x65, 0x6e, 0x2c, 0xa3]))).toBe("O'Brien,£");
    expect(decodeCsv(new TextEncoder().encode("José"))).toBe("José");
  });

  it("consent is never imported: the patient has to agree again", () => {
    const s = platformSetup();
    s.p.importer.run(s.clinicId, "u", { kind: "patients", source: "tm3", filename: "t.csv", text: "First Name,Last Name,Email,SMS consent,Marketing\nAnn,Able,ann@example.com,yes,yes", dryRun: false });
    expect(s.db.prepare("SELECT sms_consent_at, email_consent_at, marketing_consent_at FROM patients WHERE last_name = 'Able' AND import_batch IS NOT NULL").get()).toEqual({ sms_consent_at: null, email_consent_at: null, marketing_consent_at: null });
  });
});

describe("calendar feed", () => {
  it("shows initials only, folds long lines, and stops working when revoked or replaced", () => {
    const s = platformSetup();
    s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    const cancelled = s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.followUp.id, startAt: "2026-10-19T10:00:00.000Z", source: "staff" });
    s.p.scheduling.cancelAppointment(s.clinicId, "u", cancelled, "x");
    const token = s.p.ical.createToken(s.clinicId, s.owner.id);
    const feed = s.p.ical.feed(token)!;
    expect(feed).toContain("DTSTART:20261019T080000Z");
    expect(feed).toContain("SUMMARY:P.J. Initial assessment");
    expect(feed).not.toContain("Pat");
    expect(feed.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(feed.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    expect(s.p.ical.feed(token + "x")).toBeNull();
    const second = s.p.ical.createToken(s.clinicId, s.owner.id);
    expect(s.p.ical.feed(token)).toBeNull();
    expect(s.p.ical.feed(second)).not.toBeNull();
    s.p.ical.revoke(s.clinicId, s.owner.id);
    expect(s.p.ical.feed(second)).toBeNull();
  });
  it("only stores a hash of the token", () => {
    const s = platformSetup();
    const token = s.p.ical.createToken(s.clinicId, s.owner.id);
    const rows = s.db.prepare("SELECT token_hash FROM ical_tokens").all() as { token_hash: string }[];
    expect(rows.every((r) => !r.token_hash.includes(token))).toBe(true);
  });
});

describe("first-run seeding", () => {
  it("adopts consultations made before accounts existed", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO consults (id, patient_label, practitioner, status, created_at, updated_at) VALUES ('old', 'J.B.', 'Sam', 'created', 'n', 'n')").run();
    const p = createPlatform(db);
    const { clinicId, userId } = p.accounts.bootstrap({ clinicName: "Adopt Physio", ownerName: "Olive", email: "o@example.com", password: "correct horse battery" });
    expect(seedClinic(db, clinicId, userId).adopted).toBe(1);
    expect(db.prepare("SELECT clinic_id FROM consults WHERE id = 'old'").get()).toEqual({ clinic_id: clinicId });
    expect(p.scheduling.listTypes(clinicId).length).toBe(3);
  });
  it("upgrades a real Phase 0 database file in place and keeps its data", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctp-"));
    const file = path.join(dir, "old.db");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE consults (id TEXT PRIMARY KEY, patient_label TEXT NOT NULL, pms_patient_id TEXT, practitioner TEXT NOT NULL,
        status TEXT NOT NULL, consent_at TEXT, consent_method TEXT, consent_recorded_by TEXT, consent_withdrawn_at TEXT, transcript TEXT,
        note_json TEXT, programme_json TEXT, draft_model TEXT, drafted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, consult_id TEXT REFERENCES consults(id) ON DELETE CASCADE, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT, at TEXT NOT NULL);
      INSERT INTO consults (id, patient_label, practitioner, status, created_at, updated_at) VALUES ('c1', 'J.B.', 'Sam', 'approved', 'n', 'n');
      INSERT INTO audit_log (consult_id, actor, action, at) VALUES ('c1', 'sam', 'consult.created', 'n');
    `);
    old.close();
    const db = openDb(file);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols("consults")).toEqual(expect.arrayContaining(["clinic_id", "patient_id", "appointment_id"]));
    expect(cols("audit_log")).toEqual(expect.arrayContaining(["clinic_id", "entity"]));
    expect(db.prepare("SELECT patient_label FROM consults WHERE id = 'c1'").get()).toEqual({ patient_label: "J.B." });
    openDb(file); // a second start changes nothing and does not fail
    const p = createPlatform(db);
    const { clinicId, userId } = p.accounts.bootstrap({ clinicName: "Old Clinic", ownerName: "Olive", email: "o@example.com", password: "correct horse battery" });
    expect(seedClinic(db, clinicId, userId).adopted).toBe(1);
    expect(db.prepare("SELECT clinic_id FROM consults WHERE id = 'c1'").get()).toEqual({ clinic_id: clinicId });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
