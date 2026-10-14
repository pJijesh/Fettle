import type { Db } from "./db";
import { formatLocal } from "./tz";
import { makeLink } from "./links";
import { Outbox } from "./outbox";
import type { AppointmentView } from "./scheduling";

/**
 * Builds and queues every patient message. Appointment emails are service messages (they need no marketing
 * consent). Texts go only to patients who have agreed to them. Each message has an idempotency key.
 */

interface Ctx {
  clinic: { id: string; name: string; timezone: string };
  patient: { id: string; firstName: string; email: string | null; phone: string | null; smsOk: boolean };
}

export class Notifier {
  constructor(
    private db: Db,
    private outbox: Outbox,
    private baseUrl: () => string,
    private now: () => Date = () => new Date(),
  ) {}

  private async ctx(clinicId: string, patientId: string): Promise<Ctx | null> {
    const c = await this.db.get<Ctx["clinic"]>("SELECT id, name, timezone FROM clinics WHERE id = ?", [clinicId]);
    const p = await this.db.get<{ id: string; first_name: string; email: string | null; phone: string | null; sms_consent_at: string | null }>(
      "SELECT id, first_name, email, phone, sms_consent_at FROM patients WHERE id = ? AND clinic_id = ?",
      [patientId, clinicId],
    );
    if (!c || !p) return null;
    return { clinic: c, patient: { id: p.id, firstName: p.first_name, email: p.email, phone: p.phone, smsOk: !!p.sms_consent_at && !!p.phone } };
  }

  private clinicianOf(a: AppointmentView) {
    return a.clinicianName;
  }

  manageUrl(appointmentId: string) {
    return `${this.baseUrl()}/manage/${makeLink("manage", appointmentId)}`;
  }

  formUrl(requestId: string) {
    return `${this.baseUrl()}/form/${makeLink("form", requestId)}`;
  }

  offerUrl(offerId: string) {
    return `${this.baseUrl()}/offer/${makeLink("offer", offerId)}`;
  }

  private pendingForms(appointmentId: string): Promise<{ id: string; name: string }[]> {
    return this.db.all<{ id: string; name: string }>("SELECT id, form_name AS name FROM form_requests WHERE appointment_id = ? AND status = 'pending' ORDER BY created_at, seq", [appointmentId]);
  }

  confirmation(clinicId: string, a: AppointmentView): Promise<void> {
    return this.db.scope(clinicId, () => this.confirmationNow(clinicId, a));
  }

  private async confirmationNow(clinicId: string, a: AppointmentView): Promise<void> {
    const x = await this.ctx(clinicId, a.patientId);
    if (!x?.patient.email) return;
    const when = formatLocal(a.startAt, x.clinic.timezone);
    const forms = await this.pendingForms(a.id);
    const lines = [
      `Hello ${x.patient.firstName},`,
      "",
      `Your ${a.typeName} at ${x.clinic.name} is booked for ${when} with ${this.clinicianOf(a)}.`,
      "",
      `To see, change or cancel it: ${this.manageUrl(a.id)}`,
    ];
    if (forms.length) {
      lines.push("", "Please fill in before you come:");
      for (const f of forms) lines.push(`- ${f.name}: ${this.formUrl(f.id)}`);
    }
    await this.outbox.queue({ clinicId, channel: "email", to: x.patient.email, subject: `Your appointment on ${when}`, body: lines.join("\n"), kind: "confirmation", key: `confirm:${a.id}:${a.startAt}` });
  }

  reminder(clinicId: string, a: AppointmentView): Promise<void> {
    return this.db.scope(clinicId, () => this.reminderNow(clinicId, a));
  }

  private async reminderNow(clinicId: string, a: AppointmentView): Promise<void> {
    const x = await this.ctx(clinicId, a.patientId);
    if (!x) return;
    const when = formatLocal(a.startAt, x.clinic.timezone);
    const key = `reminder:${a.id}:${a.startAt}`;
    const forms = await this.pendingForms(a.id);
    if (x.patient.email) {
      const lines = [`Hello ${x.patient.firstName},`, "", `A reminder of your ${a.typeName} at ${x.clinic.name} on ${when} with ${this.clinicianOf(a)}.`, "", `Change or cancel: ${this.manageUrl(a.id)}`];
      if (forms.length) lines.push("", "Forms still to fill in:", ...forms.map((f) => `- ${f.name}: ${this.formUrl(f.id)}`));
      await this.outbox.queue({ clinicId, channel: "email", to: x.patient.email, subject: `Reminder: appointment on ${when}`, body: lines.join("\n"), kind: "reminder", key: `${key}:email` });
    }
    if (x.patient.smsOk) {
      await this.outbox.queue({
        clinicId, channel: "sms", to: x.patient.phone!,
        body: `${x.clinic.name}: reminder of your appointment on ${when}. Change or cancel: ${this.manageUrl(a.id)}`,
        kind: "reminder", key: `${key}:sms`,
      });
    }
  }

  cancelled(clinicId: string, a: AppointmentView, byPatient: boolean): Promise<void> {
    return this.db.scope(clinicId, () => this.cancelledNow(clinicId, a, byPatient));
  }

  private async cancelledNow(clinicId: string, a: AppointmentView, byPatient: boolean): Promise<void> {
    const x = await this.ctx(clinicId, a.patientId);
    if (!x?.patient.email) return;
    const when = formatLocal(a.startAt, x.clinic.timezone);
    const body = byPatient
      ? `Hello ${x.patient.firstName},\n\nYour ${a.typeName} on ${when} at ${x.clinic.name} has been cancelled, as you asked.`
      : `Hello ${x.patient.firstName},\n\n${x.clinic.name} has cancelled your ${a.typeName} on ${when}${a.cancelReason ? ` (${a.cancelReason})` : ""}. Please contact the clinic to rearrange.`;
    await this.outbox.queue({ clinicId, channel: "email", to: x.patient.email, subject: `Appointment cancelled: ${when}`, body, kind: "cancellation", key: `cancel:${a.id}` });
  }

  moved(clinicId: string, a: AppointmentView, previousStartAt: string): Promise<void> {
    return this.db.scope(clinicId, () => this.movedNow(clinicId, a, previousStartAt));
  }

  private async movedNow(clinicId: string, a: AppointmentView, previousStartAt: string): Promise<void> {
    const x = await this.ctx(clinicId, a.patientId);
    if (!x?.patient.email) return;
    const was = formatLocal(previousStartAt, x.clinic.timezone);
    const now = formatLocal(a.startAt, x.clinic.timezone);
    await this.outbox.queue({
      clinicId, channel: "email", to: x.patient.email, subject: `Appointment moved to ${now}`,
      body: `Hello ${x.patient.firstName},\n\nYour ${a.typeName} at ${x.clinic.name} has moved from ${was} to ${now} with ${this.clinicianOf(a)}.\n\nChange or cancel: ${this.manageUrl(a.id)}`,
      kind: "moved", key: `moved:${a.id}:${a.startAt}`,
    });
  }

  offer(clinicId: string, o: { id: string; patientId: string; typeName: string; startAt: string; expiresAt: string }): Promise<boolean> {
    return this.db.scope(clinicId, () => this.offerNow(clinicId, o));
  }

  private async offerNow(clinicId: string, o: { id: string; patientId: string; typeName: string; startAt: string; expiresAt: string }): Promise<boolean> {
    const x = await this.ctx(clinicId, o.patientId);
    if (!x) return false;
    const when = formatLocal(o.startAt, x.clinic.timezone);
    const until = formatLocal(o.expiresAt, x.clinic.timezone, "time");
    const url = this.offerUrl(o.id);
    let sent = false;
    if (x.patient.smsOk) {
      sent = (await this.outbox.queue({ clinicId, channel: "sms", to: x.patient.phone!, body: `${x.clinic.name}: an earlier ${o.typeName} slot is free on ${when}. Take it until ${until}: ${url}`, kind: "offer", key: `offer:${o.id}:sms` })) || sent;
    }
    if (x.patient.email) {
      sent = (await this.outbox.queue({
        clinicId, channel: "email", to: x.patient.email, subject: `An earlier appointment is free: ${when}`,
        body: `Hello ${x.patient.firstName},\n\nA ${o.typeName} slot has opened at ${x.clinic.name} on ${when}.\n\nIt is offered to a few people on the waiting list and goes to whoever accepts first. This offer ends at ${until}.\n\nTake it: ${url}`,
        kind: "offer", key: `offer:${o.id}:email`,
      })) || sent;
    }
    return sent;
  }

  portalCode(clinicId: string, patientId: string, code: string): Promise<void> {
    return this.db.scope(clinicId, () => this.portalCodeNow(clinicId, patientId, code));
  }

  private async portalCodeNow(clinicId: string, patientId: string, code: string): Promise<void> {
    const x = await this.ctx(clinicId, patientId);
    if (!x?.patient.email) return;
    await this.outbox.queue({
      clinicId, channel: "email", to: x.patient.email, subject: `Your sign-in code: ${code}`,
      body: `Hello ${x.patient.firstName},\n\nYour code for ${x.clinic.name} is ${code}. It works for 15 minutes. If you did not ask for it, ignore this message.`,
      kind: "portal_code", key: `portal:${patientId}:${this.now().getTime()}`,
    });
  }
}
