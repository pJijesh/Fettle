import crypto from "node:crypto";
import type { Db } from "./db";
import { DomainError } from "./errors";
import { parseCsv } from "./csv";
import { FIELDS, type FieldDef, type ImportKind, type ImportSource } from "./import-meta";
import { isDate, utcToZoned, zonedToUtc } from "./tz";
import type { Scheduling } from "./scheduling";

/**
 * Switching import (E1.11): patients and appointments from a CSV export.
 *
 * Column names are matched loosely (case, spaces and punctuation ignored) against the names these systems
 * commonly use. They have NOT been checked against real Cliniko, TM3 or WriteUpp exports, so the dry run
 * shows which columns were recognised and which ignored, and nothing is written until the owner confirms.
 * The dry run executes the real import inside a transaction and rolls it back, so it cannot disagree with the real run.
 */

export type { ImportKind, ImportSource };

const MAX_BYTES = 5_000_000;
const MAX_ROWS = 20_000;
export const UNDO_DAYS = 7;

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

const PATIENT_ALIASES: Record<string, string[]> = {
  firstName: ["firstname", "first", "givenname", "forename", "givennames"],
  lastName: ["lastname", "last", "surname", "familyname"],
  fullName: ["name", "fullname", "patientname", "clientname", "patient", "client"],
  dob: ["dob", "dateofbirth", "birthdate", "birthday", "dateofbirthdd"],
  email: ["email", "emailaddress", "patientemail", "clientemail"],
  phone: ["mobile", "mobilenumber", "phone", "phonenumber", "cell", "cellphone", "telephone", "mobilephone"],
  gpName: ["gp", "gpname", "doctor", "referrer"],
  gpPractice: ["gppractice", "surgery", "practice"],
  ref: ["id", "patientid", "clientid", "reference", "ref", "patientnumber", "clientnumber", "externalid"],
  address: ["address", "addressline1", "address1", "streetaddress", "homeaddress", "street"],
  postcode: ["postcode", "postalcode", "zip", "zipcode", "postcodezip"],
};

const APPT_ALIASES: Record<string, string[]> = {
  patientRef: ["patientid", "clientid", "patientnumber", "clientnumber"],
  patientEmail: ["patientemail", "clientemail", "email"],
  patientName: ["patient", "patientname", "client", "clientname", "name"],
  start: ["start", "starttime", "startat", "appointmentstart", "datetime", "appointmenttime", "begins"],
  date: ["date", "appointmentdate", "day"],
  time: ["time", "starttimeonly", "appointmenttimeonly"],
  end: ["end", "endtime", "endat", "appointmentend"],
  clinician: ["clinician", "practitioner", "therapist", "physio", "staff", "user", "provider"],
  type: ["type", "appointmenttype", "service", "treatment", "appointmentservice"],
  status: ["status", "appointmentstatus", "outcome"],
};

function missingRequired(kind: ImportKind, col: Record<string, number>): string[] {
  if (kind === "patients") {
    return ("firstName" in col && "lastName" in col) || "fullName" in col ? [] : ["Choose which column holds the first name and which the last name (or one column with the full name)."];
  }
  const out: string[] = [];
  if (!("start" in col) && !("date" in col && "time" in col)) out.push("Choose the column with the appointment start (or separate date and time columns).");
  if (!("patientRef" in col || "patientEmail" in col || "patientName" in col)) out.push("Choose a column that identifies the patient: name, email or id.");
  return out;
}

export interface ColumnInfo {
  index: number;
  header: string;
  /** The field this column fills, or null when it is ignored. */
  field: string | null;
  sample: string[];
}

export interface ImportReport {
  kind: ImportKind;
  source: ImportSource;
  /** Every column in the file with what it was matched to, so a person can correct it. */
  columns: ColumnInfo[];
  fields: FieldDef[];
  /** Reasons the file cannot be imported yet (for example no name column). Empty when it can. */
  problems: string[];
  dryRun: boolean;
  batchId: string | null;
  rows: number;
  recognised: string[];
  ignored: string[];
  created: number;
  existing: number;
  rejected: { row: number; reason: string }[];
  preview: string[];
}

interface Mapped {
  col: Record<string, number>;
  recognised: string[];
  ignored: string[];
  columns: ColumnInfo[];
}

/**
 * Works out which column fills which field. By default this is a loose match on the heading. When the person has
 * corrected the mapping, `override` (one field key or null per column) is used exactly as given.
 */
function mapHeaders(table: string[][], aliases: Record<string, string[]>, override?: (string | null)[]): Mapped {
  const header = table[0];
  const col: Record<string, number> = {};
  const fieldOf: (string | null)[] = header.map(() => null);
  if (override) {
    header.forEach((_, i) => {
      const k = override[i];
      if (k && k in aliases && !(k in col)) {
        col[k] = i;
        fieldOf[i] = k;
      }
    });
  } else {
    header.forEach((h, i) => {
      const n = norm(h);
      const key = Object.keys(aliases).find((k) => !(k in col) && aliases[k].includes(n));
      if (key) {
        col[key] = i;
        fieldOf[i] = key;
      }
    });
  }
  const sampleRows = table.slice(1, 4);
  const columns = header.map((h, i) => ({ index: i, header: h.trim(), field: fieldOf[i], sample: sampleRows.map((r) => (r[i] ?? "").trim()).filter(Boolean).slice(0, 3) }));
  const recognised = columns.filter((c) => c.field).map((c) => `${c.header} → ${c.field}`);
  const ignored = columns.filter((c) => !c.field && c.header).map((c) => c.header);
  return { col, recognised, ignored, columns };
}

/** UK order: day first. Accepts 2026-03-04, 04/03/2026, 4-3-2026, 04.03.2026. */
export function parseDate(text: string): string | null {
  const t = text.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(t))) [d, mo, y] = [+m[1], +m[2], +m[3]];
  else return null;
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isDate(iso) ? iso : null;
}

function parseClock(text: string): number | null {
  const m = /^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(am|pm)?$/i.exec(text.trim());
  if (!m) return null;
  let h = +m[1];
  const min = +m[2];
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
  }
  return h > 23 || min > 59 ? null : h * 60 + min;
}

/** A full date-time: ISO with a zone is taken as written; anything else is clinic-local time. */
function parseDateTime(text: string, tz: string): Date | null {
  const t = text.trim();
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/i.test(t)) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = /^(.+?)[T\s]+(\d{1,2}[:.]\d{2}(?::\d{2})?\s*(?:am|pm)?)$/i.exec(t);
  if (!m) return null;
  const date = parseDate(m[1]);
  const clock = parseClock(m[2]);
  return date && clock !== null ? zonedToUtc(date, clock, tz) : null;
}

function splitName(full: string): [string, string] {
  const t = full.trim();
  if (t.includes(",")) {
    const [last, first] = t.split(",", 2);
    return [first.trim(), last.trim()];
  }
  const i = t.lastIndexOf(" ");
  return i < 0 ? [t, ""] : [t.slice(0, i).trim(), t.slice(i + 1).trim()];
}

export class Importer {
  constructor(
    private db: Db,
    private scheduling: Scheduling,
    private now: () => Date = () => new Date(),
  ) {}

  private ts() {
    return this.now().toISOString();
  }

  /**
   * `rows` is a file already read into text (CSV or Excel); `text` is raw CSV. `mapping` is one field key (or null) per
   * column, as corrected by the person; without it columns are matched by heading.
   */
  run(
    clinicId: string,
    by: string,
    input: { kind: ImportKind; source: ImportSource; filename: string; text?: string; rows?: string[][]; mapping?: (string | null)[]; dryRun: boolean },
  ): ImportReport {
    if (input.text !== undefined && Buffer.byteLength(input.text) > MAX_BYTES) throw new DomainError("validation", "That file is too large. Split it into files under 5 MB.");
    const table = input.rows ?? parseCsv(input.text ?? "");
    if (table.length < 2) throw new DomainError("validation", "The file has no rows to import. It needs a header row and at least one row of data.");
    if (table.length - 1 > MAX_ROWS) throw new DomainError("validation", `Too many rows. Import at most ${MAX_ROWS.toLocaleString("en-GB")} at a time.`);

    const aliases = input.kind === "patients" ? PATIENT_ALIASES : APPT_ALIASES;
    const mapped = mapHeaders(table, aliases, input.mapping);
    const problems = missingRequired(input.kind, mapped.col);
    const base = (): ImportReport => ({
      kind: input.kind, source: input.source, columns: mapped.columns, fields: FIELDS[input.kind], problems, dryRun: input.dryRun, batchId: null,
      rows: table.length - 1, recognised: mapped.recognised, ignored: mapped.ignored, created: 0, existing: 0, rejected: [], preview: [],
    });
    if (problems.length) {
      // A dry run reports this so the person can fix the columns; saving is refused.
      if (input.dryRun) return base();
      throw new DomainError("validation", problems[0], problems.map((message) => ({ path: "file", message })));
    }

    const batchId = crypto.randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const report = input.kind === "patients" ? this.patients(clinicId, by, batchId, table, mapped, base()) : this.appointments(clinicId, by, batchId, table, mapped, base());
      report.dryRun = input.dryRun;
      if (input.dryRun) {
        this.db.exec("ROLLBACK");
        report.batchId = null;
      } else {
        this.db
          .prepare("INSERT INTO import_batches (id, clinic_id, kind, filename, created_by, created_at, counts_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(batchId, clinicId, `${input.kind}:${input.source}`, input.filename.slice(0, 120), by, this.ts(), JSON.stringify({ created: report.created, existing: report.existing, rejected: report.rejected.length }));
        this.db.prepare("INSERT INTO audit_log (clinic_id, actor, action, detail, at, entity) VALUES (?, ?, 'import.committed', ?, ?, 'import')").run(clinicId, by, JSON.stringify({ batchId, kind: input.kind, created: report.created }), this.ts());
        this.db.exec("COMMIT");
        report.batchId = batchId;
      }
      return report;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  }

  private patients(clinicId: string, by: string, batchId: string, table: string[][], { col }: Mapped, report: ImportReport): ImportReport {
    report.batchId = batchId;
    const get = (r: string[], k: string) => (k in col ? (r[col[k]] ?? "").trim() : "");
    for (let i = 1; i < table.length; i++) {
      const r = table[i];
      let first = get(r, "firstName");
      let last = get(r, "lastName");
      if (!first && !last && get(r, "fullName")) [first, last] = splitName(get(r, "fullName"));
      const dobRaw = get(r, "dob");
      const dob = dobRaw ? parseDate(dobRaw) : null;
      if (dobRaw && !dob) {
        report.rejected.push({ row: i + 1, reason: `Date of birth “${dobRaw}” is not a date (use day/month/year or year-month-day)` });
        continue;
      }
      const email = get(r, "email").toLowerCase();
      const dup = this.scheduling.findDuplicates(clinicId, { firstName: first, lastName: last, dob, email: email || null });
      if (dup.length) {
        report.existing++;
        continue;
      }
      try {
        const id = this.scheduling.createPatient(clinicId, by, { firstName: first, lastName: last, dob, email: email || null, phone: get(r, "phone") || null, gpName: get(r, "gpName") || null, gpPractice: get(r, "gpPractice") || null, address: get(r, "address") || null, postcode: get(r, "postcode") || null });
        this.db.prepare("UPDATE patients SET external_ref = ?, import_batch = ? WHERE id = ?").run(get(r, "ref") || null, batchId, id);
        report.created++;
        if (report.preview.length < 5) report.preview.push(`${first} ${last}${dob ? `, born ${dob}` : ""}`);
      } catch (err) {
        if (err instanceof DomainError) report.rejected.push({ row: i + 1, reason: err.issues.map((x) => x.message).join("; ") || err.message });
        else throw err;
      }
    }
    return report;
  }

  private appointments(clinicId: string, by: string, batchId: string, table: string[][], { col }: Mapped, report: ImportReport): ImportReport {
    report.batchId = batchId;
    const tz = this.scheduling.clinic(clinicId).timezone;
    const types = this.scheduling.listTypes(clinicId);
    const people = this.scheduling.clinicians(clinicId);
    const get = (r: string[], k: string) => (k in col ? (r[col[k]] ?? "").trim() : "");
    const nowIso = this.ts();

    for (let i = 1; i < table.length; i++) {
      const r = table[i];
      const reject = (reason: string) => report.rejected.push({ row: i + 1, reason });
      const startRaw = "start" in col ? get(r, "start") : `${get(r, "date")} ${get(r, "time")}`;
      const start = parseDateTime(startRaw, tz);
      if (!start) {
        reject(`Start time “${startRaw.trim()}” is not a date and time`);
        continue;
      }
      // patient
      let patient: { id: string } | undefined;
      if (get(r, "patientRef")) patient = this.db.prepare("SELECT id FROM patients WHERE clinic_id = ? AND external_ref = ? AND merged_into IS NULL").get(clinicId, get(r, "patientRef")) as { id: string } | undefined;
      if (!patient && get(r, "patientEmail")) patient = this.db.prepare("SELECT id FROM patients WHERE clinic_id = ? AND email = ? AND merged_into IS NULL ORDER BY created_at LIMIT 1").get(clinicId, get(r, "patientEmail").toLowerCase()) as { id: string } | undefined;
      if (!patient && get(r, "patientName")) {
        const [f, l] = splitName(get(r, "patientName"));
        const rows = this.db.prepare("SELECT id FROM patients WHERE clinic_id = ? AND merged_into IS NULL AND lower(first_name) = lower(?) AND lower(last_name) = lower(?)").all(clinicId, f, l) as unknown as { id: string }[];
        if (rows.length > 1) {
          reject(`More than one patient is called “${get(r, "patientName")}”; add an email or id column`);
          continue;
        }
        patient = rows[0];
      }
      if (!patient) {
        reject("No matching patient. Import the patients file first");
        continue;
      }
      // clinician and type
      const cName = get(r, "clinician");
      const clinician = cName ? people.find((p) => p.name.toLowerCase() === cName.toLowerCase()) : people.length === 1 ? people[0] : undefined;
      if (!clinician) {
        reject(cName ? `No clinician called “${cName}”. Add them under Staff first` : "No clinician given and the clinic has more than one");
        continue;
      }
      const tName = get(r, "type");
      const type = tName ? types.find((t) => t.name.toLowerCase() === tName.toLowerCase()) : types.length === 1 ? types[0] : undefined;
      if (!type) {
        reject(tName ? `No appointment type called “${tName}”. Add it under Settings first` : "No appointment type given");
        continue;
      }
      let end = new Date(start.getTime() + type.durationMin * 60_000);
      if (get(r, "end")) {
        const e = parseDateTime("start" in col ? get(r, "end") : `${get(r, "date")} ${get(r, "end")}`, tz);
        if (e && e > start) end = e;
      }
      const hold = new Date(end.getTime() + type.bufferMin * 60_000);
      const statusText = get(r, "status").toLowerCase();
      const status = /cancel/.test(statusText) ? "cancelled" : /dna|no.?show|did not attend/.test(statusText) ? "no_show" : start.toISOString() < nowIso ? "completed" : "booked";
      const reasonText = status === "cancelled" ? "Cancelled in previous system" : null;
      // Skip an exact repeat so importing the same file twice does not double up.
      const same = this.db.prepare("SELECT 1 FROM appointments WHERE user_id = ? AND patient_id = ? AND start_at = ? AND status <> 'cancelled'").get(clinician.id, patient.id, start.toISOString());
      if (same && status !== "cancelled") {
        report.existing++;
        continue;
      }
      try {
        this.db
          .prepare(
            `INSERT INTO appointments (id, clinic_id, patient_id, user_id, type_id, start_at, end_at, hold_until, status, cancel_reason, source, created_by, created_at, updated_at, import_batch)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, ?, ?)`,
          )
          .run(crypto.randomUUID(), clinicId, patient.id, clinician.id, type.id, start.toISOString(), end.toISOString(), hold.toISOString(), status, reasonText, by, nowIso, nowIso, batchId);
        report.created++;
        if (report.preview.length < 5) report.preview.push(`${utcToZoned(start, tz).date} ${type.name} with ${clinician.name} (${status})`);
      } catch (err) {
        if (String(err).includes("appointment_overlap")) reject(`Overlaps another appointment for ${clinician.name}`);
        else throw err;
      }
    }
    return report;
  }

  list(clinicId: string) {
    return (
      this.db.prepare("SELECT id, kind, filename, created_by, created_at, undone_at, counts_json FROM import_batches WHERE clinic_id = ? ORDER BY created_at DESC LIMIT 30").all(clinicId) as unknown as {
        id: string; kind: string; filename: string; created_by: string; created_at: string; undone_at: string | null; counts_json: string;
      }[]
    ).map((b) => ({
      ...b,
      counts: JSON.parse(b.counts_json) as { created: number; existing: number; rejected: number },
      canUndo: !b.undone_at && this.now().getTime() - new Date(b.created_at).getTime() <= UNDO_DAYS * 86_400_000,
    }));
  }

  /** Removes what a batch added, within seven days. Patients who have since been given other records are kept. */
  undo(clinicId: string, by: string, batchId: string): { removedAppointments: number; removedPatients: number; keptPatients: number } {
    const b = this.db.prepare("SELECT created_at, undone_at FROM import_batches WHERE id = ? AND clinic_id = ?").get(batchId, clinicId) as { created_at: string; undone_at: string | null } | undefined;
    if (!b) throw new DomainError("not_found", "Import not found");
    if (b.undone_at) throw new DomainError("invalid_state", "This import was already undone");
    if (this.now().getTime() - new Date(b.created_at).getTime() > UNDO_DAYS * 86_400_000) throw new DomainError("invalid_state", `Imports can only be undone within ${UNDO_DAYS} days`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const a = this.db.prepare("DELETE FROM appointments WHERE clinic_id = ? AND import_batch = ?").run(clinicId, batchId);
      const candidates = this.db.prepare("SELECT id FROM patients WHERE clinic_id = ? AND import_batch = ?").all(clinicId, batchId) as unknown as { id: string }[];
      let removed = 0;
      let kept = 0;
      for (const p of candidates) {
        const used =
          this.db.prepare("SELECT 1 FROM appointments WHERE patient_id = ?").get(p.id) ||
          this.db.prepare("SELECT 1 FROM consults WHERE patient_id = ?").get(p.id) ||
          this.db.prepare("SELECT 1 FROM waitlist WHERE patient_id = ?").get(p.id) ||
          this.db.prepare("SELECT 1 FROM patients WHERE merged_into = ?").get(p.id);
        if (used) kept++;
        else {
          this.db.prepare("DELETE FROM patients WHERE id = ?").run(p.id);
          removed++;
        }
      }
      this.db.prepare("UPDATE import_batches SET undone_at = ? WHERE id = ?").run(this.ts(), batchId);
      this.db.prepare("INSERT INTO audit_log (clinic_id, actor, action, detail, at, entity) VALUES (?, ?, 'import.undone', ?, ?, 'import')").run(clinicId, by, JSON.stringify({ batchId, appointments: Number(a.changes), patients: removed, kept }), this.ts());
      this.db.exec("COMMIT");
      return { removedAppointments: Number(a.changes), removedPatients: removed, keptPatients: kept };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
