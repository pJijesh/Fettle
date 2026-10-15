import crypto from "node:crypto";
import { clinicOf, Fail, type Db } from "./db";
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

  private async audit(clinicId: string, by: string, action: string, detail: unknown, entity = "appointment") {
    await this.db.run("INSERT INTO audit_log (clinic_id, actor, action, detail, at, entity) VALUES (?, ?, ?, ?, ?, ?)", [clinicId, by, action, JSON.stringify(detail), this.ts(), entity]);
  }

  async publicInfo(slug: string) {
    const clinic = await this.scheduling.clinicBySlug(slug);
    if (!clinic) return null;
    return this.db.scope(clinic.id, async () => ({
      clinic,
      types: await this.scheduling.listTypes(clinic.id, { onlyActive: true, onlineOnly: true }),
      clinicians: await this.scheduling.clinicians(clinic.id),
    }));
  }

  /** Free times for online booking. With no clinician chosen, each start time appears once, with a free clinician. */
  async availability(slug: string, opts: { typeId: string; userId?: string; fromDate: string; toDate: string }): Promise<{ clinic: Clinic; slots: Slot[] }> {
    const clinic = await this.scheduling.clinicBySlug(slug);
    if (!clinic) throw new DomainError("not_found", "Clinic not found");
    return this.db.scope(clinic.id, async () => {
      const type = await this.scheduling.getType(clinic.id, opts.typeId);
      if (!type.onlineBookable || !type.active) throw new DomainError("invalid_state", "This appointment type cannot be booked online");
      const all = await this.scheduling.slots(clinic.id, { ...opts, userId: opts.userId || undefined, leadMinutes: ONLINE_LEAD_MINUTES });
      if (opts.userId) return { clinic, slots: all };
      const seen = new Set<string>();
      return { clinic, slots: all.filter((s) => (seen.has(s.startAt) ? false : (seen.add(s.startAt), true))) };
    });
  }

  private async findOrCreatePatient(clinicId: string, i: OnlineBookingInput): Promise<string> {
    const email = i.email.trim().toLowerCase();
    const match = await this.db.get<{ id: string }>("SELECT id FROM patients WHERE clinic_id = ? AND merged_into IS NULL AND email = ? AND lower(last_name) = lower(?) AND dob = ?", [
      clinicId, email, i.lastName.trim(), i.dob.trim(),
    ]);
    if (match) return match.id;
    return this.scheduling.createPatient(clinicId, "online", {
      firstName: i.firstName, lastName: i.lastName, dob: i.dob, email, phone: i.phone, smsConsent: !!i.smsConsent && !!i.phone?.trim(), emailConsent: true,
    });
  }

  async book(slug: string, input: OnlineBookingInput): Promise<{ appointmentId: string; manageToken: string }> {
    const clinic = await this.scheduling.clinicBySlug(slug);
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
    // One transaction: the patient record, the appointment, its forms and the confirmation all happen or none do.
    return this.db.scope(clinic.id, async () => {
      // Pick a clinician for "any".
      let userId = input.userId || "";
      if (!userId) {
        const day = utcToZoned(start, clinic.timezone).date;
        const free = (await this.scheduling.slots(clinic.id, { typeId: input.typeId, fromDate: day, toDate: day, leadMinutes: ONLINE_LEAD_MINUTES })).find((s) => s.startAt === start.toISOString());
        if (!free) throw new DomainError("conflict", "That time is no longer free. Please choose another.");
        userId = free.userId;
      }
      const patientId = await this.findOrCreatePatient(clinic.id, input);
      const appointmentId = await this.scheduling.createAppointment(clinic.id, "online", { patientId, userId, typeId: input.typeId, startAt: start.toISOString(), source: "online" });
      await this.audit(clinic.id, "online", "booking.online", { appointmentId });
      return { appointmentId, manageToken: makeLink("manage", appointmentId) };
    });
  }

  // ---------------------------------------------------------------- manage link

  /** Checks the link's signature, then finds the clinic it belongs to. */
  private async apptFromToken(token: string): Promise<{ clinicId: string; id: string }> {
    const id = readLink("manage", token);
    const clinicId = id ? await clinicOf(this.db, "appointment", id) : null;
    if (!id || !clinicId) throw new DomainError("not_found", "This link is not valid");
    return { clinicId, id };
  }

  async manage(token: string): Promise<ManageView> {
    const { clinicId, id } = await this.apptFromToken(token);
    return this.db.scope(clinicId, async () => {
      const appointment = await this.scheduling.getAppointment(clinicId, id);
      const reason = this.changeBlock(appointment);
      return {
        appointment,
        clinic: await this.scheduling.clinic(clinicId),
        canChange: reason === null,
        cannotChangeReason: reason,
        forms: (await this.forms.forAppointment(id)).map((f) => ({ id: f.id, name: f.formName, status: f.status, mandatory: f.mandatory, token: makeLink("form", f.id) })),
      };
    });
  }

  private changeBlock(a: AppointmentView): string | null {
    if (a.status !== "booked") return a.status === "cancelled" ? "This appointment has been cancelled." : "This appointment can no longer be changed online.";
    const hoursAway = (new Date(a.startAt).getTime() - this.now().getTime()) / 3_600_000;
    if (hoursAway < PATIENT_CHANGE_NOTICE_HOURS) return `Changes online need ${PATIENT_CHANGE_NOTICE_HOURS} hours' notice. Please phone the clinic.`;
    return null;
  }

  async cancelByPatient(token: string): Promise<void> {
    const { clinicId, id } = await this.apptFromToken(token);
    await this.db.scope(clinicId, async () => {
      const a = await this.scheduling.getAppointment(clinicId, id);
      const block = this.changeBlock(a);
      if (block) throw new DomainError("invalid_state", block);
      await this.scheduling.cancelAppointment(clinicId, "patient", id, "Cancelled by patient", { byPatient: true });
    });
  }

  async rescheduleSlots(token: string, fromDate: string, toDate: string): Promise<Slot[]> {
    const { clinicId, id } = await this.apptFromToken(token);
    return this.db.scope(clinicId, async () => {
      const a = await this.scheduling.getAppointment(clinicId, id);
      if (this.changeBlock(a)) return [];
      return this.scheduling.slots(clinicId, { typeId: a.typeId, userId: a.userId, fromDate, toDate, leadMinutes: PATIENT_CHANGE_NOTICE_HOURS * 60 });
    });
  }

  async rescheduleByPatient(token: string, startAt: string): Promise<void> {
    const { clinicId, id } = await this.apptFromToken(token);
    await this.db.scope(clinicId, async () => {
      const a = await this.scheduling.getAppointment(clinicId, id);
      const block = this.changeBlock(a);
      if (block) throw new DomainError("invalid_state", block);
      const start = new Date(startAt);
      if (Number.isNaN(start.getTime())) throw new DomainError("validation", "Choose a time");
      const tz = (await this.scheduling.clinic(clinicId)).timezone;
      const day = utcToZoned(start, tz).date;
      const ok = (await this.scheduling.slots(clinicId, { typeId: a.typeId, userId: a.userId, fromDate: day, toDate: day, leadMinutes: PATIENT_CHANGE_NOTICE_HOURS * 60 })).some(
        (s) => s.startAt === start.toISOString(),
      );
      if (!ok) throw new DomainError("conflict", "That time is not available. Please choose another.");
      await this.scheduling.moveAppointment(clinicId, "patient", id, { startAt: start.toISOString() });
    });
  }

  // ---------------------------------------------------------------- forms by link

  private async formScope<T>(token: string, fn: (id: string, clinicId: string) => Promise<T>): Promise<T> {
    const id = readLink("form", token);
    const clinicId = id ? await clinicOf(this.db, "form_request", id) : null;
    if (!id || !clinicId) throw new DomainError("not_found", "This link is not valid");
    return this.db.scope(clinicId, () => fn(id, clinicId));
  }

  async formByToken(token: string): Promise<{ request: FormRequestView; clinicName: string; patientFirstName: string }> {
    return this.formScope(token, async (id, clinicId) => {
      const request = await this.forms.request(id);
      const clinic = await this.scheduling.clinic(clinicId);
      const patient = await this.scheduling.getPatient(clinicId, request.patientId);
      return { request, clinicName: clinic.name, patientFirstName: patient.firstName };
    });
  }

  async submitForm(token: string, answers: Record<string, string>): Promise<void> {
    return this.formScope(token, async (id, clinicId) => {
      const request = await this.forms.request(id);
      await this.forms.complete(id, answers);
      await this.audit(clinicId, "patient", "form.completed", { requestId: id, appointmentId: request.appointmentId }, "form");
    });
  }

  // ---------------------------------------------------------------- portal sign-in (one-time code)

  private async patientByEmail(clinicId: string, email: string) {
    return this.db.get<{ id: string }>("SELECT id FROM patients WHERE clinic_id = ? AND merged_into IS NULL AND email = ? ORDER BY created_at LIMIT 1", [clinicId, email.trim().toLowerCase()]);
  }

  /** Always looks the same from outside, so it cannot be used to find out who is a patient. */
  async requestCode(slug: string, email: string): Promise<void> {
    const clinic = await this.scheduling.clinicBySlug(slug);
    if (!clinic) return;
    await this.db.scope(clinic.id, async () => {
      const patient = await this.patientByEmail(clinic.id, email);
      if (!patient) return;
      const recent = await this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM portal_codes WHERE patient_id = ? AND created_at > ?", [patient.id, new Date(this.now().getTime() - 3_600_000).toISOString()]);
      if ((recent?.n ?? 0) >= CODES_PER_HOUR) return;
      await this.db.run("UPDATE portal_codes SET used_at = ? WHERE patient_id = ? AND used_at IS NULL", [this.ts(), patient.id]);
      const code = randomCode();
      await this.db.run("INSERT INTO portal_codes (id, clinic_id, patient_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
        crypto.randomUUID(), clinic.id, patient.id, sha256(code), new Date(this.now().getTime() + CODE_MINUTES * 60_000).toISOString(), this.ts(),
      ]);
      await this.notifier.portalCode(clinic.id, patient.id, code);
    });
  }

  async verifyCode(slug: string, email: string, code: string): Promise<{ token: string }> {
    const bad = new DomainError("unauthenticated", "That code is not right or has expired. Ask for a new one.");
    const clinic = await this.scheduling.clinicBySlug(slug);
    if (!clinic) throw bad;
    // A wrong guess must stay counted, so refusals are returned (and committed) rather than thrown from inside.
    return this.db.scopeOrFail(clinic.id, async () => {
      const patient = await this.patientByEmail(clinic.id, email);
      if (!patient) return new Fail(bad);
      const row = await this.db.get<{ id: string; code_hash: string; attempts: number }>(
        "SELECT id, code_hash, attempts FROM portal_codes WHERE patient_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC, seq DESC LIMIT 1 FOR UPDATE",
        [patient.id, this.ts()],
      );
      if (!row || row.attempts >= CODE_MAX_ATTEMPTS) return new Fail(bad);
      await this.db.run("UPDATE portal_codes SET attempts = attempts + 1 WHERE id = ?", [row.id]);
      const given = Buffer.from(sha256(code.trim()));
      const want = Buffer.from(row.code_hash);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return new Fail(bad);
      await this.db.run("UPDATE portal_codes SET used_at = ? WHERE id = ?", [this.ts(), row.id]);
      const token = randomToken(32);
      await this.db.run("INSERT INTO portal_sessions (token_hash, clinic_id, patient_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)", [
        sha256(token), clinic.id, patient.id, this.ts(), new Date(this.now().getTime() + PORTAL_HOURS * 3_600_000).toISOString(),
      ]);
      await this.audit(clinic.id, "patient", "portal.signed_in", { patientId: patient.id }, "patient");
      return { token };
    });
  }

  async portalSession(token: string | undefined): Promise<{ clinicId: string; patientId: string } | null> {
    if (!token || token.length > 128) return null;
    const hash = sha256(token);
    const clinicId = await clinicOf(this.db, "portal_session", hash);
    if (!clinicId) return null;
    return this.db.scope(clinicId, async () => {
      const r = await this.db.get<{ clinic_id: string; patient_id: string; expires_at: string }>("SELECT clinic_id, patient_id, expires_at FROM portal_sessions WHERE token_hash = ?", [hash]);
      if (!r || new Date(r.expires_at).getTime() <= this.now().getTime()) return null;
      return { clinicId: r.clinic_id, patientId: r.patient_id };
    });
  }

  async portalSignOut(token: string | undefined): Promise<void> {
    if (!token) return;
    const hash = sha256(token);
    const clinicId = await clinicOf(this.db, "portal_session", hash);
    if (clinicId) await this.db.scope(clinicId, async () => void (await this.db.run("DELETE FROM portal_sessions WHERE token_hash = ?", [hash])));
  }

  portalHome(session: { clinicId: string; patientId: string }) {
    return this.db.scope(session.clinicId, async () => {
      const patient = await this.scheduling.getPatient(session.clinicId, session.patientId);
      const clinic = await this.scheduling.clinic(session.clinicId);
      const all = await this.scheduling.listAppointments(session.clinicId, {
        patientId: session.patientId, fromUtc: new Date(this.now().getTime() - 90 * 86_400_000).toISOString(), toUtc: new Date(this.now().getTime() + 365 * 86_400_000).toISOString(),
      });
      const upcoming = all.filter((a) => new Date(a.endAt) > this.now() && (a.status === "booked" || a.status === "arrived"));
      const past = all.filter((a) => !upcoming.includes(a)).reverse().slice(0, 10);
      const pendingForms: { id: string; name: string; token: string; appointmentId: string }[] = [];
      for (const a of upcoming) {
        for (const f of (await this.forms.forAppointment(a.id)).filter((x) => x.status === "pending")) {
          pendingForms.push({ id: f.id, name: f.formName, token: makeLink("form", f.id), appointmentId: a.id });
        }
      }
      return {
        patient, clinic,
        upcoming: upcoming.map((a) => ({ ...a, manageToken: makeLink("manage", a.id) })),
        past, pendingForms,
      };
    });
  }
}
