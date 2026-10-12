import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/**
 * SQLite via Node's built-in driver keeps the MVP dependency-free. The SQL is plain enough to
 * move to Postgres (for UK-region hosting) without changing the service layer's logic.
 */

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clinics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL DEFAULT 'Europe/London',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','clinician','reception')),
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clinic_id TEXT NOT NULL,
  mfa_ok INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- clinic_id on consults and audit_log has no foreign key so a Phase 0 database can be upgraded in place.
CREATE TABLE IF NOT EXISTS consults (
  id TEXT PRIMARY KEY,
  clinic_id TEXT,
  patient_id TEXT,
  appointment_id TEXT,
  patient_label TEXT NOT NULL,
  pms_patient_id TEXT,
  practitioner TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created','consented','captured','drafted','approved')),
  consent_at TEXT,
  consent_method TEXT CHECK (consent_method IN ('verbal','written')),
  consent_recorded_by TEXT,
  consent_withdrawn_at TEXT,
  transcript TEXT,
  note_json TEXT,
  programme_json TEXT,
  draft_model TEXT,
  drafted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  consult_id TEXT NOT NULL UNIQUE REFERENCES consults(id) ON DELETE CASCADE,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  note_json TEXT NOT NULL,
  programme_json TEXT NOT NULL,
  content_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS patient_links (
  id TEXT PRIMARY KEY,
  consult_id TEXT NOT NULL REFERENCES consults(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS check_ins (
  id TEXT PRIMARY KEY,
  consult_id TEXT NOT NULL REFERENCES consults(id) ON DELETE CASCADE,
  link_id TEXT NOT NULL REFERENCES patient_links(id) ON DELETE CASCADE,
  adherence TEXT NOT NULL CHECK (adherence IN ('all','some','none')),
  pain_change TEXT NOT NULL CHECK (pain_change IN ('better','same','worse')),
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS writebacks (
  id TEXT PRIMARY KEY,
  consult_id TEXT NOT NULL REFERENCES consults(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed','needs_check')),
  external_id TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id TEXT,
  consult_id TEXT REFERENCES consults(id) ON DELETE CASCADE,
  entity TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  dob TEXT,
  email TEXT,
  phone TEXT,
  gp_name TEXT,
  gp_practice TEXT,
  address TEXT,
  postcode TEXT,
  sms_consent_at TEXT,
  email_consent_at TEXT,
  marketing_consent_at TEXT,
  merged_into TEXT,
  external_ref TEXT,
  import_batch TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS appointment_types (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  name TEXT NOT NULL,
  duration_min INTEGER NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
  buffer_min INTEGER NOT NULL DEFAULT 0 CHECK (buffer_min BETWEEN 0 AND 120),
  online_bookable INTEGER NOT NULL DEFAULT 1,
  colour TEXT NOT NULL DEFAULT 'blue',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS clinician_hours (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_min INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min INTEGER NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  CHECK (end_min > start_min)
);

-- hold_until is the end of the appointment plus its buffer; it is what other bookings must clear.
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  patient_id TEXT NOT NULL REFERENCES patients(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  type_id TEXT NOT NULL REFERENCES appointment_types(id),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  hold_until TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('booked','arrived','completed','cancelled','no_show')),
  cancel_reason TEXT,
  source TEXT NOT NULL CHECK (source IN ('staff','online','waitlist','import')),
  consult_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  import_batch TEXT,
  CHECK (end_at > start_at),
  CHECK (hold_until >= end_at)
);

CREATE TABLE IF NOT EXISTS forms (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('intake','consent')),
  fields_json TEXT NOT NULL,
  mandatory INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS form_requests (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  form_id TEXT NOT NULL REFERENCES forms(id),
  form_name TEXT NOT NULL,
  form_version INTEGER NOT NULL,
  mandatory INTEGER NOT NULL,
  fields_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','completed')),
  response_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (appointment_id, form_id)
);

CREATE TABLE IF NOT EXISTS portal_codes (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_sessions (
  token_hash TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  patient_id TEXT NOT NULL REFERENCES patients(id),
  type_id TEXT NOT NULL REFERENCES appointment_types(id),
  user_id TEXT REFERENCES users(id),
  earliest_date TEXT NOT NULL,
  latest_date TEXT NOT NULL,
  weekdays TEXT NOT NULL DEFAULT '1,2,3,4,5,6,7',
  status TEXT NOT NULL CHECK (status IN ('waiting','offered','booked','removed')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS waitlist_offers (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  waitlist_id TEXT NOT NULL REFERENCES waitlist(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','accepted','expired','taken')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email','sms')),
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  send_after TEXT NOT NULL,
  sent_at TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ical_tokens (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id),
  kind TEXT NOT NULL,
  filename TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  undone_at TEXT,
  counts_json TEXT NOT NULL
);

-- A clinician can never be in two places at once. Enforced by the database itself, so a bug or a
-- race in application code cannot double-book. (Postgres would use an exclusion constraint.)
CREATE TRIGGER IF NOT EXISTS appointments_no_overlap_insert
BEFORE INSERT ON appointments
WHEN NEW.status <> 'cancelled' AND EXISTS (
  SELECT 1 FROM appointments o
  WHERE o.user_id = NEW.user_id AND o.status <> 'cancelled' AND o.id <> NEW.id
    AND o.start_at < NEW.hold_until AND o.hold_until > NEW.start_at)
BEGIN SELECT RAISE(ABORT, 'appointment_overlap'); END;

CREATE TRIGGER IF NOT EXISTS appointments_no_overlap_update
BEFORE UPDATE OF user_id, start_at, hold_until, status ON appointments
WHEN NEW.status <> 'cancelled' AND EXISTS (
  SELECT 1 FROM appointments o
  WHERE o.user_id = NEW.user_id AND o.status <> 'cancelled' AND o.id <> NEW.id
    AND o.start_at < NEW.hold_until AND o.hold_until > NEW.start_at)
BEGIN SELECT RAISE(ABORT, 'appointment_overlap'); END;
`;

/** Indexes that refer to columns added by migrate() run afterwards, so they work on older files too. */
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_audit_consult ON audit_log(consult_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_clinic ON audit_log(clinic_id, id);
CREATE INDEX IF NOT EXISTS idx_checkins_consult ON check_ins(consult_id, created_at);
CREATE INDEX IF NOT EXISTS idx_links_consult ON patient_links(consult_id);
CREATE INDEX IF NOT EXISTS idx_consults_clinic ON consults(clinic_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_patients_clinic ON patients(clinic_id, last_name);
CREATE INDEX IF NOT EXISTS idx_patients_email ON patients(clinic_id, email);
CREATE INDEX IF NOT EXISTS idx_appt_clinic_time ON appointments(clinic_id, start_at);
CREATE INDEX IF NOT EXISTS idx_appt_user_time ON appointments(user_id, start_at);
CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments(patient_id, start_at);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, send_after);
CREATE INDEX IF NOT EXISTS idx_offers_waitlist ON waitlist_offers(waitlist_id, status);
CREATE INDEX IF NOT EXISTS idx_offers_slot ON waitlist_offers(user_id, start_at);
CREATE INDEX IF NOT EXISTS idx_form_requests_appt ON form_requests(appointment_id);
`;

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  return rows.some((r) => r.name === column);
}

/** Brings a database created by the Phase 0 MVP up to the Phase 1 shape. Safe to run every start. */
function migrate(db: Db) {
  const add = (table: string, column: string, ddl: string) => {
    if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  };
  add("consults", "clinic_id", "TEXT");
  add("consults", "patient_id", "TEXT");
  add("consults", "appointment_id", "TEXT");
  add("audit_log", "clinic_id", "TEXT");
  add("audit_log", "entity", "TEXT");
  add("appointments", "import_batch", "TEXT");
  add("patients", "address", "TEXT");
  add("patients", "postcode", "TEXT");
}

export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  db.exec(INDEXES);
  return db;
}

const globalForDb = globalThis as unknown as { __ctpDb?: Db };

export function getDb(): Db {
  globalForDb.__ctpDb ??= openDb(process.env.DATABASE_PATH ?? "./data/app.db");
  return globalForDb.__ctpDb;
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
