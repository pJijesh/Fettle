import crypto from "node:crypto";
import type { Db } from "./db";
import { DomainError } from "./errors";
import { makeLink, readLink } from "./links";
import { randomCode, randomToken, sha256 } from "./crypto";
import { utcToZoned } from "./tz";
import type { AppointmentView, Clinic, Scheduling, Slot } from "./scheduling";
import type { Forms, FormRequestView } from "./forms";
import type { Notifier } from "./notify";

/** Online booking (E1.3) and the client portal (E1.4). Nothing here trusts a client-supplied clinic or patient id. */

export const ONLINE_LEAD_MINUTES = 120;
export const PATIENT_CHANGE_NOTICE_HOURS = 24;
const CODE_MINUTES = 15;
const CODE_MAX_ATTEMPTS = 5;
const CODES_PER_HOUR = 5;
const PORTAL_HOURS = 2;

export interface OnlineBookingInput {
  typeId: string;
  /** Empty means "any clinician". */
  userId?: string;
  startAt: string;
  firstName: string;
  lastName: string;
  dob: string;
  email: string;
  phone?: string;
  smsConsent?: boolean;
}

export interface ManageView {
  appointment: AppointmentView;
  clinic: Clinic;
  canChange: boolean;
  cannotChangeReason: string | null;
  forms: { id: string; name: string; status: string; mandatory: boolean; token: string }[];
}

export class Booking {
  constructor(
    private db: Db,
    private scheduling: Scheduling,
    private forms: Forms,
    private notifier: Notifier,
    private now: () => Date = () => new Date(),
  ) {}

  private ts() {
    return this.now().toISOString();
  }

  private audit(clinicId: string, by: string, action: string, detail: unknown, entity = "appointment") {
    this.db.prepare("INSERT INTO audit_log (clinic_id, actor, action, detail, at, entity) VALUES (?, ?, ?, ?, ?, ?)").run(clinicId, by, action, JSON.stringify(detail), this.ts(), entity);
  }

  publicInfo(slug: string) {
    const clinic = this.scheduling.clinicBySlug(slug);
    if (!clinic) return null;
    return { clinic, types: this.scheduling.listTypes(clinic.id, { onlyActive: true, onlineOnly: true }), clinicians: this.scheduling.clinicians(clinic.id) };
  }

  /** Free times for online booking. With no clinician chosen, each start time appears once, with a free clinician. */
  availability(slug: string, opts: { typeId: string; userId?: string; fromDate: string; toDate: string }): { clinic: Clinic; slots: Slot[] } {
    const clinic = this.scheduling.clinicBySlug(slug);
    if (!clinic) throw new DomainError("not_found", "Clinic not found");
    const type = this.scheduling.getType(clinic.id, opts.typeId);
    if (!type.onlineBookable || !type.active) throw new DomainError("invalid_state", "This appointment type cannot be booked online");
    const all = this.scheduling.slots(clinic.id, { ...opts, userId: opts.userId || undefined, leadMinutes: ONLINE_LEAD_MINUTES });
    if (opts.userId) return { clinic, slots: all };
    const seen = new Set<string>();
    return { clinic, slots: all.filter((s) => (seen.has(s.startAt) ? false : (seen.add(s.startAt), true))) };
  }

  private findOrCreatePatient(clinicId: string, i: OnlineBookingInput): string {
    const email = i.email.trim().toLowerCase();
    const match = this.db
      .prepare("SELECT id FROM patients WHERE clinic_id = ? AND merged_into IS NULL AND email = ? AND lower(last_name) = lower(?) AND dob = ?")
      .get(clinicId, email, i.lastName.trim(), i.dob.trim()) as { id: string } | undefined;
    if (match) return match.id;
    return this.scheduling.createPatient(clinicId, "online", {
      firstName: i.firstName, lastName: i.lastName, dob: i.dob, email, phone: i.phone, smsConsent: !!i.smsConsent && !!i.phone?.trim(), emailConsent: true,
    });
  }

  book(slug: string, input: OnlineBookingInput): { appointmentId: string; manageToken: string } {
    const clinic = this.scheduling.clinicBySlug(slug);
    if (!clinic) throw new DomainError("not_found", "Clinic not found");
    const issues: { path: string; message: string }[] = [];
    if (!input.dob?.trim()) issues.push({ path: "dob", message: "Enter your date of birth" });
    if (!input.email?.trim()) issues.push({ path: "email", message: "Enter your email address so we can confirm" });
    if (issues.length) throw new DomainError("validation", "Check your details", issues);
    const start = new Date(input.startAt);
    if (Number.isNaN(start.getTime())) throw new DomainError("validation", "Choose a time", [{ path: "startAt", message: "Choose a time" }]);
    if (start.getTime() < this.now().getTime() + ONLINE_LEAD_MINUTES * 60_000) {
      throw new DomainError("validation", "That time is too soon to book online. Please phone the clinic.", [{ path: "startAt", message: "Too soon to book online" }]);
    }
    // Validate the patient's details before touching the diary, and pick a clinician for "any".
    let userId = input.userId || "";
    if (!userId) {
      const day = utcToZoned(start, clinic.timezone).date;
      const free = this.scheduling.slots(clinic.id, { typeId: input.typeId, fromDate: day, toDate: day, leadMinutes: ONLINE_LEAD_MINUTES }).find((s) => s.startAt === start.toISOString());
      if (!free) throw new DomainError("conflict", "That time is no longer free. Please choose another.");
      userId = free.userId;
    }
    const patientId = this.findOrCreatePatient(clinic.id, input);
    const appointmentId = this.scheduling.createAppointment(clinic.id, "online", { patientId, userId, typeId: input.typeId, startAt: start.toISOString(), source: "online" });
    this.audit(clinic.id, "online", "booking.online", { appointmentId });
    return { appointmentId, manageToken: makeLink("manage", appointmentId) };
  }

  // ---------------------------------------------------------------- manage link

  private apptFromToken(token: string): { clinicId: string; id: string } {
    const id = readLink("manage", token);
    const row = id ? (this.db.prepare("SELECT clinic_id FROM appointments WHERE id = ?").get(id) as { clinic_id: string } | undefined) : undefined;
    if (!id || !row) throw new DomainError("not_found", "This link is not valid");
    return { clinicId: row.clinic_id, id };
  }

  manage(token: string): ManageView {
    const { clinicId, id } = this.apptFromToken(token);
    const appointment = this.scheduling.getAppointment(clinicId, id);
    const reason = this.changeBlock(appointment);
    return {
      appointment,
      clinic: this.scheduling.clinic(clinicId),
      canChange: reason === null,
      cannotChangeReason: reason,
      forms: this.forms.forAppointment(id).map((f) => ({ id: f.id, name: f.formName, status: f.status, mandatory: f.mandatory, token: makeLink("form", f.id) })),
    };
  }

  private changeBlock(a: AppointmentView): string | null {
    if (a.status !== "booked") return a.status === "cancelled" ? "This appointment has been cancelled." : "This appointment can no longer be changed online.";
    const hoursAway = (new Date(a.startAt).getTime() - this.now().getTime()) / 3_600_000;
    if (hoursAway < PATIENT_CHANGE_NOTICE_HOURS) return `Changes online need ${PATIENT_CHANGE_NOTICE_HOURS} hours' notice. Please phone the clinic.`;
    return null;
  }

  cancelByPatient(token: string) {
    const { clinicId, id } = this.apptFromToken(token);
    const a = this.scheduling.getAppointment(clinicId, id);
    const block = this.changeBlock(a);
    if (block) throw new DomainError("invalid_state", block);
    this.scheduling.cancelAppointment(clinicId, "patient", id, "Cancelled by patient", { byPatient: true });
  }

  rescheduleSlots(token: string, fromDate: string, toDate: string): Slot[] {
    const { clinicId, id } = this.apptFromToken(token);
    const a = this.scheduling.getAppointment(clinicId, id);
    if (this.changeBlock(a)) return [];
    return this.scheduling.slots(clinicId, { typeId: a.typeId, userId: a.userId, fromDate, toDate, leadMinutes: PATIENT_CHANGE_NOTICE_HOURS * 60 });
  }

  rescheduleByPatient(token: string, startAt: string) {
    const { clinicId, id } = this.apptFromToken(token);
    const a = this.scheduling.getAppointment(clinicId, id);
    const block = this.changeBlock(a);
    if (block) throw new DomainError("invalid_state", block);
    const start = new Date(startAt);
    if (Number.isNaN(start.getTime())) throw new DomainError("validation", "Choose a time");
    const tz = this.scheduling.clinic(clinicId).timezone;
    const day = utcToZoned(start, tz).date;
    const ok = this.scheduling
      .slots(clinicId, { typeId: a.typeId, userId: a.userId, fromDate: day, toDate: day, leadMinutes: PATIENT_CHANGE_NOTICE_HOURS * 60 })
      .some((s) => s.startAt === start.toISOString());
    if (!ok) throw new DomainError("conflict", "That time is not available. Please choose another.");
    this.scheduling.moveAppointment(clinicId, "patient", id, { startAt: start.toISOString() });
  }

  // ---------------------------------------------------------------- forms by link

  formByToken(token: string): { request: FormRequestView; clinicName: string; patientFirstName: string } {
    const id = readLink("form", token);
    const row = id ? (this.db.prepare("SELECT clinic_id, patient_id FROM form_requests WHERE id = ?").get(id) as { clinic_id: string; patient_id: string } | undefined) : undefined;
    if (!id || !row) throw new DomainError("not_found", "This link is not valid");
    const clinic = this.scheduling.clinic(row.clinic_id);
    const patient = this.scheduling.getPatient(row.clinic_id, row.patient_id);
    return { request: this.forms.request(id), clinicName: clinic.name, patientFirstName: patient.firstName };
  }

  submitForm(token: string, answers: Record<string, string>) {
    const { request } = this.formByToken(token);
    this.forms.complete(request.id, answers);
    const row = this.db.prepare("SELECT clinic_id FROM form_requests WHERE id = ?").get(request.id) as { clinic_id: string };
    this.audit(row.clinic_id, "patient", "form.completed", { requestId: request.id, appointmentId: request.appointmentId }, "form");
  }

  // ---------------------------------------------------------------- portal sign-in (one-time code)

  /** Always looks the same from outside, so it cannot be used to find out who is a patient. */
  requestCode(slug: string, email: string): void {
    const clinic = this.scheduling.clinicBySlug(slug);
    if (!clinic) return;
    const patient = this.db
      .prepare("SELECT id FROM patients WHERE clinic_id = ? AND merged_into IS NULL AND email = ? ORDER BY created_at LIMIT 1")
      .get(clinic.id, email.trim().toLowerCase()) as { id: string } | undefined;
    if (!patient) return;
    const recent = this.db
      .prepare("SELECT COUNT(*) AS n FROM portal_codes WHERE patient_id = ? AND created_at > ?")
      .get(patient.id, new Date(this.now().getTime() - 3_600_000).toISOString()) as { n: number };
    if (recent.n >= CODES_PER_HOUR) return;
    this.db.prepare("UPDATE portal_codes SET used_at = ? WHERE patient_id = ? AND used_at IS NULL").run(this.ts(), patient.id);
    const code = randomCode();
    this.db
      .prepare("INSERT INTO portal_codes (id, clinic_id, patient_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), clinic.id, patient.id, sha256(code), new Date(this.now().getTime() + CODE_MINUTES * 60_000).toISOString(), this.ts());
    this.notifier.portalCode(clinic.id, patient.id, code);
  }

  verifyCode(slug: string, email: string, code: string): { token: string } {
    const bad = new DomainError("unauthenticated", "That code is not right or has expired. Ask for a new one.");
    const clinic = this.scheduling.clinicBySlug(slug);
    if (!clinic) throw bad;
    const patient = this.db
      .prepare("SELECT id FROM patients WHERE clinic_id = ? AND merged_into IS NULL AND email = ? ORDER BY created_at LIMIT 1")
      .get(clinic.id, email.trim().toLowerCase()) as { id: string } | undefined;
    if (!patient) throw bad;
    const row = this.db
      .prepare("SELECT id, code_hash, attempts FROM portal_codes WHERE patient_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(patient.id, this.ts()) as { id: string; code_hash: string; attempts: number } | undefined;
    if (!row || row.attempts >= CODE_MAX_ATTEMPTS) throw bad;
    this.db.prepare("UPDATE portal_codes SET attempts = attempts + 1 WHERE id = ?").run(row.id);
    const given = Buffer.from(sha256(code.trim()));
    const want = Buffer.from(row.code_hash);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw bad;
    this.db.prepare("UPDATE portal_codes SET used_at = ? WHERE id = ?").run(this.ts(), row.id);
    const token = randomToken(32);
    this.db
      .prepare("INSERT INTO portal_sessions (token_hash, clinic_id, patient_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(sha256(token), clinic.id, patient.id, this.ts(), new Date(this.now().getTime() + PORTAL_HOURS * 3_600_000).toISOString());
    this.audit(clinic.id, "patient", "portal.signed_in", { patientId: patient.id }, "patient");
    return { token };
  }

  portalSession(token: string | undefined): { clinicId: string; patientId: string } | null {
    if (!token || token.length > 128) return null;
    const r = this.db.prepare("SELECT clinic_id, patient_id, expires_at FROM portal_sessions WHERE token_hash = ?").get(sha256(token)) as
      | { clinic_id: string; patient_id: string; expires_at: string }
      | undefined;
    if (!r || r.expires_at <= this.ts()) return null;
    return { clinicId: r.clinic_id, patientId: r.patient_id };
  }

  portalSignOut(token: string | undefined) {
    if (token) this.db.prepare("DELETE FROM portal_sessions WHERE token_hash = ?").run(sha256(token));
  }

  portalHome(session: { clinicId: string; patientId: string }) {
    const patient = this.scheduling.getPatient(session.clinicId, session.patientId);
    const clinic = this.scheduling.clinic(session.clinicId);
    const all = this.scheduling.listAppointments(session.clinicId, {
      patientId: session.patientId, fromUtc: new Date(this.now().getTime() - 90 * 86_400_000).toISOString(), toUtc: new Date(this.now().getTime() + 365 * 86_400_000).toISOString(),
    });
    const upcoming = all.filter((a) => new Date(a.endAt) > this.now() && (a.status === "booked" || a.status === "arrived"));
    const past = all.filter((a) => !upcoming.includes(a)).reverse().slice(0, 10);
    const pendingForms = upcoming.flatMap((a) =>
      this.forms.forAppointment(a.id).filter((f) => f.status === "pending").map((f) => ({ id: f.id, name: f.formName, token: makeLink("form", f.id), appointmentId: a.id })),
    );
    return {
      patient, clinic,
      upcoming: upcoming.map((a) => ({ ...a, manageToken: makeLink("manage", a.id) })),
      past, pendingForms,
    };
  }
}
