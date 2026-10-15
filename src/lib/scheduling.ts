import crypto from "node:crypto";
import { isOverlap, type Db } from "./db";
import { DomainError } from "./errors";
import { addDays, dayBounds, isDate, utcToZoned, weekdayOf, zonedToUtc } from "./tz";

export type ApptStatus = "booked" | "arrived" | "completed" | "cancelled" | "no_show";
export type ApptSource = "staff" | "online" | "waitlist" | "import";

export interface Clinic {
  id: string;
  name: string;
  slug: string;
  timezone: string;
}

export interface Patient {
  id: string;
  firstName: string;
  lastName: string;
  dob: string | null;
  email: string | null;
  phone: string | null;
  gpName: string | null;
  gpPractice: string | null;
  address: string | null;
  postcode: string | null;
  smsConsentAt: string | null;
  emailConsentAt: string | null;
  marketingConsentAt: string | null;
  mergedInto: string | null;
}

export interface PatientInput {
  firstName: string;
  lastName: string;
  dob?: string | null;
  email?: string | null;
  phone?: string | null;
  gpName?: string | null;
  gpPractice?: string | null;
  address?: string | null;
  postcode?: string | null;
  smsConsent?: boolean;
  emailConsent?: boolean;
  marketingConsent?: boolean;
}

export interface AppointmentType {
  id: string;
  name: string;
  durationMin: number;
  bufferMin: number;
  onlineBookable: boolean;
  colour: string;
  active: boolean;
}

export interface Slot {
  userId: string;
  userName: string;
  startAt: string;
  endAt: string;
}

export interface AppointmentView {
  id: string;
  patientId: string;
  patientName: string;
  userId: string;
  clinicianName: string;
  typeId: string;
  typeName: string;
  typeColour: string;
  startAt: string;
  endAt: string;
  status: ApptStatus;
  source: ApptSource;
  cancelReason: string | null;
  consultId: string | null;
  formsPending: number;
  formsTotal: number;
}

export interface Hooks {
  /** A new appointment exists (any source). Used to create intake forms and queue the confirmation. */
  afterBooked?: (a: AppointmentView) => void | Promise<void>;
  /** A future appointment was cancelled or moved away, so its time is free again. */
  slotFreed?: (slot: { clinicId: string; userId: string; typeId: string; startAt: string; endAt: string }) => void | Promise<unknown>;
  /** An appointment moved to a new time (for telling the patient). */
  afterMoved?: (a: AppointmentView, previousStartAt: string) => void | Promise<void>;
  /** An appointment was cancelled by staff or by the patient. */
  afterCancelled?: (a: AppointmentView, byPatient: boolean) => void | Promise<void>;
}

const COLOURS = ["blue", "green", "amber", "red", "purple", "grey"] as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LEAD_DAYS = 90;

function clean(v: string | null | undefined, max = 120): string | null {
  const t = (v ?? "").trim();
  return t ? t.slice(0, max) : null;
}

function issue(path: string, message: string) {
  return { path, message };
}

export class Scheduling {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
    private hooks: Hooks = {},
  ) {}

  setHooks(h: Hooks) {
    this.hooks = h;
  }

  private ts() {
    return this.now().toISOString();
  }

  async audit(clinicId: string, by: string, action: string, entity: string, detail?: unknown): Promise<void> {
    await this.db.run("INSERT INTO audit_log (clinic_id, actor, action, detail, at, entity) VALUES (?, ?, ?, ?, ?, ?)", [
      clinicId, by, action, detail === undefined ? null : JSON.stringify(detail), this.ts(), entity,
    ]);
  }

  // ---------------------------------------------------------------- clinic

  async clinic(clinicId: string): Promise<Clinic> {
    return this.db.scope(clinicId, async () => {
      const r = await this.db.get<Clinic>("SELECT id, name, slug, timezone FROM clinics WHERE id = ?", [clinicId]);
      if (!r) throw new DomainError("not_found", "Clinic not found");
      return r;
    });
  }

  /** Public: the booking and portal pages are addressed by slug. Clinic names and time zones are not private. */
  async clinicBySlug(slug: string): Promise<Clinic | null> {
    return this.db.system(async () => (await this.db.get<Clinic>("SELECT id, name, slug, timezone FROM clinics WHERE slug = ?", [slug])) ?? null);
  }

  /** Every clinic, for the background worker to visit one at a time. */
  async clinicIds(): Promise<string[]> {
    return this.db.system(async () => (await this.db.all<{ id: string }>("SELECT id FROM clinics ORDER BY created_at")).map((r) => r.id));
  }

  async clinicians(clinicId: string): Promise<{ id: string; name: string }[]> {
    return this.db.scope(clinicId, () =>
      this.db.all<{ id: string; name: string }>("SELECT id, name FROM users WHERE clinic_id = ? AND active = 1 AND role IN ('clinician','owner') ORDER BY name", [clinicId]),
    );
  }

  // ---------------------------------------------------------------- patients (E1.8)

  private patientIssues(i: PatientInput) {
    const issues = [];
    if (!i.firstName?.trim()) issues.push(issue("firstName", "Enter a first name"));
    if (!i.lastName?.trim()) issues.push(issue("lastName", "Enter a last name"));
    if ((i.firstName ?? "").length > 80 || (i.lastName ?? "").length > 80) issues.push(issue("lastName", "Keep names under 80 characters"));
    const email = clean(i.email);
    if (email && !EMAIL.test(email)) issues.push(issue("email", "Enter a valid email address"));
    const phone = clean(i.phone, 30);
    if (phone && !/^[+\d][\d\s()-]{6,24}$/.test(phone)) issues.push(issue("phone", "Enter a valid phone number"));
    const dob = clean(i.dob, 10);
    if (dob) {
      if (!isDate(dob)) issues.push(issue("dob", "Enter the date of birth as year-month-day"));
      else if (dob > this.ts().slice(0, 10) || dob < "1900-01-01") issues.push(issue("dob", "Check the date of birth"));
    }
    if (i.smsConsent && !phone) issues.push(issue("phone", "A phone number is needed to send texts"));
    if ((i.emailConsent || i.marketingConsent) && !email) issues.push(issue("email", "An email address is needed to send email"));
    return issues;
  }

  async createPatient(clinicId: string, by: string, input: PatientInput): Promise<string> {
    const issues = this.patientIssues(input);
    if (issues.length) throw new DomainError("validation", "Check the patient's details", issues);
    return this.db.scope(clinicId, async () => {
      const id = crypto.randomUUID();
      const now = this.ts();
      await this.db.run(
        `INSERT INTO patients (id, clinic_id, first_name, last_name, dob, email, phone, gp_name, gp_practice, address, postcode,
           sms_consent_at, email_consent_at, marketing_consent_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, clinicId, input.firstName.trim(), input.lastName.trim(), clean(input.dob, 10), clean(input.email)?.toLowerCase() ?? null,
          clean(input.phone, 30), clean(input.gpName), clean(input.gpPractice), clean(input.address, 200), clean(input.postcode, 12)?.toUpperCase() ?? null,
          input.smsConsent ? now : null, input.emailConsent ? now : null, input.marketingConsent ? now : null, now, now,
        ],
      );
      await this.audit(clinicId, by, "patient.created", "patient", { patientId: id });
      return id;
    });
  }

  private toPatient(r: Record<string, unknown>): Patient {
    return {
      id: r.id as string,
      firstName: r.first_name as string,
      lastName: r.last_name as string,
      dob: (r.dob as string) ?? null,
      email: (r.email as string) ?? null,
      phone: (r.phone as string) ?? null,
      gpName: (r.gp_name as string) ?? null,
      gpPractice: (r.gp_practice as string) ?? null,
      address: (r.address as string) ?? null,
      postcode: (r.postcode as string) ?? null,
      smsConsentAt: (r.sms_consent_at as string) ?? null,
      emailConsentAt: (r.email_consent_at as string) ?? null,
      marketingConsentAt: (r.marketing_consent_at as string) ?? null,
      mergedInto: (r.merged_into as string) ?? null,
    };
  }

  async getPatient(clinicId: string, id: string): Promise<Patient> {
    return this.db.scope(clinicId, async () => {
      const r = await this.db.get("SELECT * FROM patients WHERE id = ? AND clinic_id = ?", [id, clinicId]);
      if (!r) throw new DomainError("not_found", "Patient not found");
      return this.toPatient(r);
    });
  }

  /** Reading a record is itself recorded. */
  async viewPatient(clinicId: string, by: string, id: string): Promise<Patient> {
    return this.db.scope(clinicId, async () => {
      const p = await this.getPatient(clinicId, id);
      await this.audit(clinicId, by, "patient.viewed", "patient", { patientId: id });
      return p;
    });
  }

  async updatePatient(clinicId: string, by: string, id: string, input: PatientInput): Promise<void> {
    return this.db.scope(clinicId, async () => {
      const existing = await this.getPatient(clinicId, id);
      if (existing.mergedInto) throw new DomainError("invalid_state", "This record was merged into another one");
      const issues = this.patientIssues(input);
      if (issues.length) throw new DomainError("validation", "Check the patient's details", issues);
      const now = this.ts();
      const keepOrSet = (flag: boolean | undefined, current: string | null) => (flag ? (current ?? now) : null);
      await this.db.run(
        `UPDATE patients SET first_name=?, last_name=?, dob=?, email=?, phone=?, gp_name=?, gp_practice=?, address=?, postcode=?,
           sms_consent_at=?, email_consent_at=?, marketing_consent_at=?, updated_at=? WHERE id=? AND clinic_id=?`,
        [
          input.firstName.trim(), input.lastName.trim(), clean(input.dob, 10), clean(input.email)?.toLowerCase() ?? null,
          clean(input.phone, 30), clean(input.gpName), clean(input.gpPractice), clean(input.address, 200), clean(input.postcode, 12)?.toUpperCase() ?? null,
          keepOrSet(input.smsConsent, existing.smsConsentAt), keepOrSet(input.emailConsent, existing.emailConsentAt),
          keepOrSet(input.marketingConsent, existing.marketingConsentAt), now, id, clinicId,
        ],
      );
      await this.audit(clinicId, by, "patient.updated", "patient", { patientId: id });
    });
  }

  async searchPatients(clinicId: string, q: string, limit = 25): Promise<Patient[]> {
    const terms = q.trim().split(/\s+/).filter(Boolean).slice(0, 4);
    const where = ["clinic_id = ?", "merged_into IS NULL"];
    const params: (string | number)[] = [clinicId];
    for (const t of terms) {
      const like = `%${t.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
      where.push("(first_name ILIKE ? ESCAPE '\\' OR last_name ILIKE ? ESCAPE '\\' OR email ILIKE ? ESCAPE '\\' OR phone ILIKE ? ESCAPE '\\')");
      params.push(like, like, like, like);
    }
    params.push(limit);
    return this.db.scope(clinicId, async () =>
      (await this.db.all(`SELECT * FROM patients WHERE ${where.join(" AND ")} ORDER BY last_name, first_name LIMIT ?`, params)).map((r) => this.toPatient(r)),
    );
  }

  async findDuplicates(clinicId: string, p: { firstName: string; lastName: string; dob?: string | null; email?: string | null }, exceptId?: string): Promise<Patient[]> {
    return this.db.scope(clinicId, async () => {
      const rows = await this.db.all(
        `SELECT * FROM patients WHERE clinic_id = ? AND merged_into IS NULL AND id <> ? AND (
           (lower(last_name) = lower(?) AND lower(first_name) = lower(?) AND (dob IS NOT NULL AND dob = ?))
           OR (email IS NOT NULL AND email = ?))
         LIMIT 10`,
        [clinicId, exceptId ?? "", p.lastName.trim(), p.firstName.trim(), clean(p.dob, 10) ?? "", clean(p.email)?.toLowerCase() ?? ""],
      );
      return rows.map((r) => this.toPatient(r));
    });
  }

  /** Folds `removeId` into `keepId`. Everything attached moves across; both audit trails stay. */
  async mergePatients(clinicId: string, by: string, keepId: string, removeId: string): Promise<void> {
    if (keepId === removeId) throw new DomainError("validation", "Choose two different records");
    return this.db.scope(clinicId, async () => {
      const keep = await this.getPatient(clinicId, keepId);
      const gone = await this.getPatient(clinicId, removeId);
      if (keep.mergedInto || gone.mergedInto) throw new DomainError("invalid_state", "One of these records was already merged");
      for (const table of ["appointments", "form_requests", "waitlist"]) {
        await this.db.run(`UPDATE ${table} SET patient_id = ? WHERE patient_id = ?`, [keepId, removeId]);
      }
      await this.db.run("UPDATE consults SET patient_id = ? WHERE patient_id = ? AND clinic_id = ?", [keepId, removeId, clinicId]);
      await this.db.run(
        `UPDATE patients SET
           dob = COALESCE(dob, ?), email = COALESCE(email, ?), phone = COALESCE(phone, ?),
           gp_name = COALESCE(gp_name, ?), gp_practice = COALESCE(gp_practice, ?),
           sms_consent_at = COALESCE(sms_consent_at, ?::timestamptz), email_consent_at = COALESCE(email_consent_at, ?::timestamptz),
           marketing_consent_at = COALESCE(marketing_consent_at, ?::timestamptz), updated_at = ? WHERE id = ?`,
        [gone.dob, gone.email, gone.phone, gone.gpName, gone.gpPractice, gone.smsConsentAt, gone.emailConsentAt, gone.marketingConsentAt, this.ts(), keepId],
      );
      await this.db.run("UPDATE patients SET merged_into = ?, updated_at = ? WHERE id = ?", [keepId, this.ts(), removeId]);
      await this.audit(clinicId, by, "patient.merged", "patient", { kept: keepId, merged: removeId });
    });
  }

  // ---------------------------------------------------------------- appointment types, hours

  private toType(r: Record<string, unknown>): AppointmentType {
    return {
      id: r.id as string,
      name: r.name as string,
      durationMin: Number(r.duration_min),
      bufferMin: Number(r.buffer_min),
      onlineBookable: !!r.online_bookable,
      colour: r.colour as string,
      active: !!r.active,
    };
  }

  async listTypes(clinicId: string, opts: { onlyActive?: boolean; onlineOnly?: boolean } = {}): Promise<AppointmentType[]> {
    return this.db.scope(clinicId, async () =>
      (
        await this.db.all(
          `SELECT * FROM appointment_types WHERE clinic_id = ? ${opts.onlyActive ? "AND active = 1" : ""} ${opts.onlineOnly ? "AND online_bookable = 1" : ""} ORDER BY name`,
          [clinicId],
        )
      ).map((r) => this.toType(r)),
    );
  }

  async getType(clinicId: string, id: string): Promise<AppointmentType> {
    return this.db.scope(clinicId, async () => {
      const r = await this.db.get("SELECT * FROM appointment_types WHERE id = ? AND clinic_id = ?", [id, clinicId]);
      if (!r) throw new DomainError("not_found", "Appointment type not found");
      return this.toType(r);
    });
  }

  private typeIssues(i: { name: string; durationMin: number; bufferMin: number; colour: string }) {
    const issues = [];
    if (!i.name.trim()) issues.push(issue("name", "Enter a name"));
    if (!Number.isInteger(i.durationMin) || i.durationMin < 5 || i.durationMin > 480) issues.push(issue("durationMin", "Duration must be 5 to 480 minutes"));
    if (!Number.isInteger(i.bufferMin) || i.bufferMin < 0 || i.bufferMin > 120) issues.push(issue("bufferMin", "Buffer must be 0 to 120 minutes"));
    if (!(COLOURS as readonly string[]).includes(i.colour)) issues.push(issue("colour", "Choose a colour"));
    return issues;
  }

  saveType(
    clinicId: string,
    by: string,
    input: { id?: string; name: string; durationMin: number; bufferMin: number; onlineBookable: boolean; colour: string; active?: boolean },
  ): Promise<string> {
    const issues = this.typeIssues(input);
    if (issues.length) throw new DomainError("validation", "Check the appointment type", issues);
    return this.db.scope(clinicId, async () => {
      if (input.id) {
        await this.getType(clinicId, input.id);
        await this.db.run("UPDATE appointment_types SET name=?, duration_min=?, buffer_min=?, online_bookable=?, colour=?, active=? WHERE id=? AND clinic_id=?", [
          input.name.trim(), input.durationMin, input.bufferMin, input.onlineBookable ? 1 : 0, input.colour, input.active === false ? 0 : 1, input.id, clinicId,
        ]);
        await this.audit(clinicId, by, "appointment_type.updated", "appointment_type", { id: input.id });
        return input.id;
      }
      const id = crypto.randomUUID();
      await this.db.run("INSERT INTO appointment_types (id, clinic_id, name, duration_min, buffer_min, online_bookable, colour, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)", [
        id, clinicId, input.name.trim(), input.durationMin, input.bufferMin, input.onlineBookable ? 1 : 0, input.colour,
      ]);
      await this.audit(clinicId, by, "appointment_type.created", "appointment_type", { id });
      return id;
    });
  }

  async getHours(clinicId: string, userId: string): Promise<{ weekday: number; startMin: number; endMin: number }[]> {
    return this.db.scope(clinicId, async () =>
      (
        await this.db.all<{ weekday: number; start_min: number; end_min: number }>(
          "SELECT weekday, start_min, end_min FROM clinician_hours WHERE clinic_id = ? AND user_id = ? ORDER BY weekday, start_min",
          [clinicId, userId],
        )
      ).map((r) => ({ weekday: r.weekday, startMin: r.start_min, endMin: r.end_min })),
    );
  }

  async setHours(clinicId: string, by: string, userId: string, rows: { weekday: number; startMin: number; endMin: number }[]): Promise<void> {
    return this.db.scope(clinicId, async () => {
      const u = await this.db.get("SELECT 1 FROM users WHERE id = ? AND clinic_id = ?", [userId, clinicId]);
      if (!u) throw new DomainError("not_found", "Staff member not found");
      for (const r of rows) {
        if (!(r.weekday >= 1 && r.weekday <= 7) || !(r.startMin >= 0 && r.endMin <= 1440 && r.endMin > r.startMin)) {
          throw new DomainError("validation", "Check the working hours", [issue("hours", "Each block needs a weekday and an end after its start")]);
        }
      }
      const sorted = [...rows].sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].weekday === sorted[i - 1].weekday && sorted[i].startMin < sorted[i - 1].endMin) {
          throw new DomainError("validation", "Working hours overlap", [issue("hours", "Two blocks on the same day overlap")]);
        }
      }
      await this.db.run("DELETE FROM clinician_hours WHERE clinic_id = ? AND user_id = ?", [clinicId, userId]);
      for (const r of sorted) {
        await this.db.run("INSERT INTO clinician_hours (id, clinic_id, user_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?, ?, ?)", [
          crypto.randomUUID(), clinicId, userId, r.weekday, r.startMin, r.endMin,
        ]);
      }
      await this.audit(clinicId, by, "hours.set", "user", { userId, blocks: sorted.length });
    });
  }

  // ---------------------------------------------------------------- availability (E1.3)

  /** Free start times for a type, in each clinician's working hours, clear of bookings and held offers. */
  slots(
    clinicId: string,
    opts: { typeId: string; userId?: string; fromDate: string; toDate: string; leadMinutes?: number; stepMin?: number; ignoreBatchId?: string },
  ): Promise<Slot[]> {
    return this.db.scope(clinicId, async () => {
      const clinic = await this.clinic(clinicId);
      const type = await this.getType(clinicId, opts.typeId);
      if (!type.active) return [];
      if (!isDate(opts.fromDate) || !isDate(opts.toDate) || opts.toDate < opts.fromDate) return [];
      const step = opts.stepMin ?? 15;
      const now = this.now();
      const earliest = now.getTime() + (opts.leadMinutes ?? 0) * 60_000;
      const horizon = addDays(utcToZoned(now, clinic.timezone).date, MAX_LEAD_DAYS);
      const toDate = opts.toDate > horizon ? horizon : opts.toDate;
      const lastDate = addDays(opts.fromDate, 30) < toDate ? addDays(opts.fromDate, 30) : toDate;

      const people = (await this.clinicians(clinicId)).filter((c) => !opts.userId || c.id === opts.userId);
      const out: Slot[] = [];
      const rangeStart = dayBounds(opts.fromDate, clinic.timezone).start.toISOString();
      const rangeEnd = dayBounds(lastDate, clinic.timezone).end.toISOString();

      for (const person of people) {
        const hours = await this.getHours(clinicId, person.id);
        if (!hours.length) continue;
        const busy = await this.db.all<{ start_at: string; hold_until: string }>(
          "SELECT start_at, hold_until FROM appointments WHERE user_id = ? AND status <> 'cancelled' AND start_at < ? AND hold_until > ?",
          [person.id, rangeEnd, rangeStart],
        );
        const held = await this.db.all<{ start_at: string; end_at: string }>(
          `SELECT start_at, end_at FROM waitlist_offers WHERE user_id = ? AND status = 'sent' AND expires_at > ? AND start_at < ? AND end_at > ?
           ${opts.ignoreBatchId ? "AND batch_id <> ?" : ""}`,
          [person.id, now.toISOString(), rangeEnd, rangeStart, ...(opts.ignoreBatchId ? [opts.ignoreBatchId] : [])],
        );
        const blocks = [...busy.map((b) => [b.start_at, b.hold_until]), ...held.map((h) => [h.start_at, h.end_at])];

        for (let date = opts.fromDate; date <= lastDate; date = addDays(date, 1)) {
          for (const h of hours.filter((x) => x.weekday === weekdayOf(date))) {
            for (let m = h.startMin; m + type.durationMin <= h.endMin; m += step) {
              const start = zonedToUtc(date, m, clinic.timezone);
              const end = zonedToUtc(date, m + type.durationMin, clinic.timezone) ?? (start ? new Date(start.getTime() + type.durationMin * 60_000) : null);
              if (!start || !end || start.getTime() < earliest) continue;
              const s = start.toISOString();
              const holdEnd = new Date(end.getTime() + type.bufferMin * 60_000).toISOString();
              if (blocks.some(([bs, be]) => bs < holdEnd && be > s)) continue;
              out.push({ userId: person.id, userName: person.name, startAt: s, endAt: end.toISOString() });
            }
          }
        }
      }
      return out.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.userName.localeCompare(b.userName));
    });
  }

  // ---------------------------------------------------------------- appointments (E1.2)

  private viewSql = `
    SELECT a.id, a.patient_id, p.first_name || ' ' || p.last_name AS patient_name, a.user_id, u.name AS clinician_name,
           a.type_id, t.name AS type_name, t.colour AS type_colour, a.start_at, a.end_at, a.status, a.source,
           a.cancel_reason, a.consult_id,
           COALESCE(f.pending, 0) AS forms_pending, COALESCE(f.total, 0) AS forms_total
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN users u ON u.id = a.user_id
    JOIN appointment_types t ON t.id = a.type_id
    LEFT JOIN (SELECT appointment_id, SUM(CASE WHEN status = 'pending' AND mandatory = 1 THEN 1 ELSE 0 END) AS pending, COUNT(*) AS total
               FROM form_requests GROUP BY appointment_id) f ON f.appointment_id = a.id`;

  private toView(r: Record<string, unknown>): AppointmentView {
    return {
      id: r.id as string,
      patientId: r.patient_id as string,
      patientName: r.patient_name as string,
      userId: r.user_id as string,
      clinicianName: r.clinician_name as string,
      typeId: r.type_id as string,
      typeName: r.type_name as string,
      typeColour: r.type_colour as string,
      startAt: r.start_at as string,
      endAt: r.end_at as string,
      status: r.status as ApptStatus,
      source: r.source as ApptSource,
      cancelReason: (r.cancel_reason as string) ?? null,
      consultId: (r.consult_id as string) ?? null,
      formsPending: Number(r.forms_pending),
      formsTotal: Number(r.forms_total),
    };
  }

  async getAppointment(clinicId: string, id: string): Promise<AppointmentView> {
    return this.db.scope(clinicId, async () => {
      const r = await this.db.get(`${this.viewSql} WHERE a.id = ? AND a.clinic_id = ?`, [id, clinicId]);
      if (!r) throw new DomainError("not_found", "Appointment not found");
      return this.toView(r);
    });
  }

  async listAppointments(clinicId: string, opts: { fromUtc: string; toUtc: string; userId?: string; patientId?: string; includeCancelled?: boolean }): Promise<AppointmentView[]> {
    const where = ["a.clinic_id = ?", "a.start_at < ?", "a.end_at > ?"];
    const params: string[] = [clinicId, opts.toUtc, opts.fromUtc];
    if (opts.userId) {
      where.push("a.user_id = ?");
      params.push(opts.userId);
    }
    if (opts.patientId) {
      where.push("a.patient_id = ?");
      params.push(opts.patientId);
    }
    if (!opts.includeCancelled) where.push("a.status <> 'cancelled'");
    return this.db.scope(clinicId, async () =>
      (await this.db.all(`${this.viewSql} WHERE ${where.join(" AND ")} ORDER BY a.start_at`, params)).map((r) => this.toView(r)),
    );
  }

  private async withinHours(clinicId: string, userId: string, startIso: string, endIso: string): Promise<boolean> {
    const tz = (await this.clinic(clinicId)).timezone;
    const s = utcToZoned(new Date(startIso), tz);
    const e = utcToZoned(new Date(endIso), tz);
    if (s.date !== e.date) return false;
    return (await this.getHours(clinicId, userId)).some((h) => h.weekday === s.weekday && s.minutes >= h.startMin && e.minutes <= h.endMin);
  }

  private async requireClinician(clinicId: string, userId: string) {
    const ok = await this.db.get("SELECT 1 FROM users WHERE id = ? AND clinic_id = ? AND active = 1 AND role IN ('clinician','owner')", [userId, clinicId]);
    if (!ok) throw new DomainError("not_found", "Clinician not found");
  }

  createAppointment(
    clinicId: string,
    by: string,
    input: { patientId: string; userId: string; typeId: string; startAt: string; source: ApptSource; enforceHours?: boolean; ignoreBatchId?: string; allowPast?: boolean; importBatch?: string },
  ): Promise<string> {
    return this.db.scope(clinicId, async () => {
      const start = new Date(input.startAt);
      if (Number.isNaN(start.getTime())) throw new DomainError("validation", "Choose a start time", [issue("startAt", "Invalid time")]);
      const patient = await this.getPatient(clinicId, input.patientId);
      if (patient.mergedInto) throw new DomainError("invalid_state", "This patient record was merged into another one");
      await this.requireClinician(clinicId, input.userId);
      const type = await this.getType(clinicId, input.typeId);
      if (!type.active) throw new DomainError("invalid_state", "This appointment type is no longer offered");
      if (input.source !== "staff" && input.source !== "import" && !type.onlineBookable) {
        throw new DomainError("invalid_state", "This appointment type cannot be booked online");
      }
      if (!input.allowPast && start.getTime() < this.now().getTime() - 60_000) {
        throw new DomainError("validation", "Choose a time in the future", [issue("startAt", "That time has passed")]);
      }
      const end = new Date(start.getTime() + type.durationMin * 60_000);
      const hold = new Date(end.getTime() + type.bufferMin * 60_000);
      if (input.enforceHours !== false && input.source !== "staff" && input.source !== "import" && !(await this.withinHours(clinicId, input.userId, start.toISOString(), end.toISOString()))) {
        throw new DomainError("conflict", "That time is outside this clinician's working hours");
      }
      const id = crypto.randomUUID();
      // Bookings and offers for one clinician take turns, so the check below and the insert cannot interleave with another's.
      await this.db.lock(`clinician:${input.userId}`);
      const heldByOffer = await this.db.get(
        `SELECT 1 FROM waitlist_offers WHERE user_id = ? AND status = 'sent' AND expires_at > ? AND start_at < ? AND end_at > ?
         ${input.ignoreBatchId ? "AND batch_id <> ?" : ""}`,
        [input.userId, this.ts(), hold.toISOString(), start.toISOString(), ...(input.ignoreBatchId ? [input.ignoreBatchId] : [])],
      );
      if (heldByOffer) throw new DomainError("conflict", "That time is no longer free");
      try {
        await this.db.attempt(() =>
          this.db.run(
            `INSERT INTO appointments (id, clinic_id, patient_id, user_id, type_id, start_at, end_at, hold_until, status, source, created_by, created_at, updated_at, import_batch)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?, ?, ?, ?)`,
            [id, clinicId, input.patientId, input.userId, input.typeId, start.toISOString(), end.toISOString(), hold.toISOString(), input.source, by, this.ts(), this.ts(), input.importBatch ?? null],
          ),
        );
      } catch (err) {
        if (isOverlap(err)) throw new DomainError("conflict", "That time is no longer free");
        throw err;
      }
      await this.audit(clinicId, by, "appointment.created", "appointment", { appointmentId: id, source: input.source });
      await this.hooks.afterBooked?.(await this.getAppointment(clinicId, id));
      return id;
    });
  }

  /** Moves a booked appointment to a new start (and optionally another clinician). */
  async moveAppointment(clinicId: string, by: string, id: string, input: { startAt: string; userId?: string }): Promise<void> {
    return this.db.scope(clinicId, async () => {
      const appt = await this.getAppointment(clinicId, id);
      if (appt.status !== "booked") throw new DomainError("invalid_state", "Only a booked appointment can be moved");
      const userId = input.userId ?? appt.userId;
      await this.requireClinician(clinicId, userId);
      const start = new Date(input.startAt);
      if (Number.isNaN(start.getTime())) throw new DomainError("validation", "Choose a start time", [issue("startAt", "Invalid time")]);
      if (start.getTime() < this.now().getTime() - 60_000) throw new DomainError("validation", "Choose a time in the future", [issue("startAt", "That time has passed")]);
      const type = await this.getType(clinicId, appt.typeId);
      const end = new Date(start.getTime() + type.durationMin * 60_000);
      const hold = new Date(end.getTime() + type.bufferMin * 60_000);
      const before = { clinicId, userId: appt.userId, typeId: appt.typeId, startAt: appt.startAt, endAt: appt.endAt };
      await this.db.lock(`clinician:${userId}`);
      const heldByOffer = await this.db.get("SELECT 1 FROM waitlist_offers WHERE user_id = ? AND status = 'sent' AND expires_at > ? AND start_at < ? AND end_at > ?", [
        userId, this.ts(), hold.toISOString(), start.toISOString(),
      ]);
      if (heldByOffer) throw new DomainError("conflict", "That time is held for a waitlist offer");
      try {
        await this.db.attempt(() =>
          this.db.run("UPDATE appointments SET user_id = ?, start_at = ?, end_at = ?, hold_until = ?, updated_at = ? WHERE id = ? AND clinic_id = ?", [
            userId, start.toISOString(), end.toISOString(), hold.toISOString(), this.ts(), id, clinicId,
          ]),
        );
      } catch (err) {
        if (isOverlap(err)) throw new DomainError("conflict", "That time is already taken");
        throw err;
      }
      await this.audit(clinicId, by, "appointment.moved", "appointment", { appointmentId: id, from: appt.startAt, to: start.toISOString() });
      await this.hooks.slotFreed?.(before);
      await this.hooks.afterMoved?.(await this.getAppointment(clinicId, id), appt.startAt);
    });
  }

  async cancelAppointment(clinicId: string, by: string, id: string, reason: string, opts: { byPatient?: boolean } = {}): Promise<void> {
    return this.db.scope(clinicId, async () => {
      const appt = await this.getAppointment(clinicId, id);
      if (appt.status !== "booked" && appt.status !== "arrived") throw new DomainError("invalid_state", "This appointment cannot be cancelled");
      const text = reason.trim() || (opts.byPatient ? "Cancelled by patient" : "");
      if (!text) throw new DomainError("validation", "Give a reason for the cancellation", [issue("reason", "A reason is required")]);
      await this.db.run("UPDATE appointments SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ? AND clinic_id = ?", [text.slice(0, 200), this.ts(), id, clinicId]);
      await this.audit(clinicId, by, "appointment.cancelled", "appointment", { appointmentId: id, byPatient: !!opts.byPatient });
      if (new Date(appt.startAt).getTime() > this.now().getTime()) {
        await this.hooks.slotFreed?.({ clinicId, userId: appt.userId, typeId: appt.typeId, startAt: appt.startAt, endAt: appt.endAt });
      }
      await this.hooks.afterCancelled?.(await this.getAppointment(clinicId, id), !!opts.byPatient);
    });
  }

  /** Arrived. Unfinished mandatory forms block it unless the person gives a reason to override. */
  async markArrived(clinicId: string, by: string, id: string, overrideReason?: string): Promise<void> {
    return this.db.scope(clinicId, async () => {
      const appt = await this.getAppointment(clinicId, id);
      if (appt.status !== "booked") throw new DomainError("invalid_state", "Only a booked appointment can be marked as arrived");
      if (appt.formsPending > 0) {
        const reason = overrideReason?.trim();
        if (!reason) {
          const names = await this.db.all<{ form_name: string }>("SELECT form_name FROM form_requests WHERE appointment_id = ? AND status = 'pending' AND mandatory = 1", [id]);
          throw new DomainError(
            "invalid_state",
            "Required forms are not finished",
            names.map((n) => issue("forms", `${n.form_name} is not completed`)),
          );
        }
        await this.audit(clinicId, by, "appointment.arrival_override", "appointment", { appointmentId: id, reason: reason.slice(0, 200), pending: appt.formsPending });
      }
      await this.db.run("UPDATE appointments SET status = 'arrived', updated_at = ? WHERE id = ? AND clinic_id = ?", [this.ts(), id, clinicId]);
      await this.audit(clinicId, by, "appointment.arrived", "appointment", { appointmentId: id });
    });
  }

  async markCompleted(clinicId: string, by: string, id: string): Promise<void> {
    return this.db.scope(clinicId, async () => {
      const appt = await this.getAppointment(clinicId, id);
      if (appt.status !== "arrived" && appt.status !== "booked") throw new DomainError("invalid_state", "This appointment cannot be completed");
      await this.db.run("UPDATE appointments SET status = 'completed', updated_at = ? WHERE id = ? AND clinic_id = ?", [this.ts(), id, clinicId]);
      await this.audit(clinicId, by, "appointment.completed", "appointment", { appointmentId: id });
    });
  }

  async markNoShow(clinicId: string, by: string, id: string): Promise<void> {
    return this.db.scope(clinicId, async () => {
      const appt = await this.getAppointment(clinicId, id);
      if (appt.status !== "booked") throw new DomainError("invalid_state", "Only a booked appointment can be a no-show");
      if (new Date(appt.startAt).getTime() > this.now().getTime()) throw new DomainError("invalid_state", "The appointment has not started yet");
      await this.db.run("UPDATE appointments SET status = 'no_show', updated_at = ? WHERE id = ? AND clinic_id = ?", [this.ts(), id, clinicId]);
      await this.audit(clinicId, by, "appointment.no_show", "appointment", { appointmentId: id });
    });
  }

  async attachConsult(clinicId: string, appointmentId: string, consultId: string): Promise<void> {
    return this.db.scope(clinicId, async () => {
      await this.db.run("UPDATE appointments SET consult_id = ? WHERE id = ? AND clinic_id = ?", [consultId, appointmentId, clinicId]);
    });
  }

  consultsForPatient(clinicId: string, patientId: string) {
    return this.db.scope(clinicId, () =>
      this.db.all<{ id: string; status: string; updated_at: string }>(
        "SELECT id, status, updated_at FROM consults WHERE clinic_id = ? AND patient_id = ? ORDER BY updated_at DESC LIMIT 20",
        [clinicId, patientId],
      ),
    );
  }

  // ---------------------------------------------------------------- calendar layers (E1.1)

  /** The product's own markers: notes awaiting approval, programme reviews falling due, and patients reporting worse pain. */
  markers(clinicId: string, fromDate: string, toDate: string) {
    return this.db.scope(clinicId, async () => {
      const tz = (await this.clinic(clinicId)).timezone;
      const approvals = await this.db.all<{ consult_id: string; patient_label: string; patient_id: string | null; approved_at: string; programme_json: string }>(
        `SELECT c.id AS consult_id, c.patient_label, c.patient_id, a.approved_at, a.programme_json
         FROM consults c JOIN approvals a ON a.consult_id = c.id WHERE c.clinic_id = ?`,
        [clinicId],
      );
      const reviews: { date: string; consultId: string; patientLabel: string; patientId: string | null }[] = [];
      for (const r of approvals) {
        let weeks: number | null = null;
        try {
          weeks = (JSON.parse(r.programme_json) as { reviewInWeeks: number | null }).reviewInWeeks;
        } catch {
          weeks = null;
        }
        if (!weeks) continue;
        const due = utcToZoned(new Date(new Date(r.approved_at).getTime() + weeks * 7 * 86_400_000), tz).date;
        if (due >= fromDate && due <= toDate) reviews.push({ date: due, consultId: r.consult_id, patientLabel: r.patient_label, patientId: r.patient_id });
      }
      const since = new Date(this.now().getTime() - 14 * 86_400_000).toISOString();
      const worse = await this.db.all<{ consult_id: string; patient_label: string; at: string }>(
        `SELECT c.id AS consult_id, c.patient_label, MAX(k.created_at) AS at
         FROM check_ins k JOIN consults c ON c.id = k.consult_id
         WHERE c.clinic_id = ? AND k.pain_change = 'worse' AND k.created_at > ? GROUP BY c.id, c.patient_label`,
        [clinicId, since],
      );
      const awaiting = await this.db.all<{ consult_id: string; appointment_id: string; patient_label: string }>(
        "SELECT id AS consult_id, appointment_id, patient_label FROM consults WHERE clinic_id = ? AND status IN ('captured','drafted') AND appointment_id IS NOT NULL",
        [clinicId],
      );
      return {
        reviewsDue: reviews.sort((a, b) => a.date.localeCompare(b.date)),
        worsePain: worse.map((w) => ({ consultId: w.consult_id, patientLabel: w.patient_label, at: w.at })),
        awaitingApproval: awaiting.map((a) => ({ consultId: a.consult_id, appointmentId: a.appointment_id, patientLabel: a.patient_label })),
      };
    });
  }
}
