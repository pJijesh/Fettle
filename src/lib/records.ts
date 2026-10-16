import type { SessionUser } from "./accounts";
import type { Db } from "./db";
import { DomainError } from "./errors";
import type { Scheduling } from "./scheduling";

const SAFE_PRESENT = "Anonymised";
const MIN_REASON = 10;
/** Children's records are kept until they reach this age (NHS records guidance). */
const CHILD_RECORD_AGE = 25;

interface Row {
  [k: string]: unknown;
}

export interface RetentionRow {
  patientId: string;
  name: string;
  lastActivity: string;
  retainUntil: string;
  due: boolean;
}

/** Adds whole years in UTC without overflowing (29 Feb + 1 year is 28 Feb). */
function addYears(d: Date, years: number): Date {
  const out = new Date(d.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCFullYear(out.getUTCFullYear() + years);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

/**
 * When a patient's record may first be considered for deletion: the clinic's retention period after the last
 * thing that happened (an appointment, consultation, invoice or payment), or, for someone who was under 18 at
 * that point, their 25th birthday if that is later.
 */
export function retainUntil(lastActivity: Date, dob: string | null, years: number): Date {
  let until = addYears(lastActivity, years);
  if (dob && /^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    const born = new Date(`${dob}T00:00:00Z`);
    if (!Number.isNaN(born.getTime())) {
      const adultAt = addYears(born, 18);
      if (lastActivity < adultAt) {
        const childLimit = addYears(born, CHILD_RECORD_AGE);
        if (childLimit > until) until = childLimit;
      }
    }
  }
  return until;
}

/**
 * Answering a patient's request for their data, and removing a patient's identity when the retention period has
 * passed. Clinical and financial records are kept for the retention period because the law requires it; after
 * that, or earlier on a documented decision by the owner, the person is made unidentifiable.
 */
export class Records {
  constructor(
    private db: Db,
    private scheduling: Scheduling,
    private now: () => Date = () => new Date(),
  ) {}

  private requireOwner(actor: SessionUser) {
    if (actor.role !== "owner") throw new DomainError("forbidden", "Only the clinic owner can export or anonymise patient records");
  }

  // ---------------------------------------------------------------- retention

  async getRetentionYears(clinicId: string): Promise<number> {
    return this.db.scope(clinicId, async () => Number((await this.db.get<{ n: number }>("SELECT retention_years AS n FROM clinics WHERE id = ?", [clinicId]))?.n ?? 8));
  }

  async setRetentionYears(actor: SessionUser, years: number): Promise<void> {
    this.requireOwner(actor);
    if (!Number.isInteger(years) || years < 1 || years > 30) {
      throw new DomainError("validation", "Enter a whole number of years from 1 to 30", [{ path: "retentionYears", message: "Enter 1 to 30" }]);
    }
    await this.db.scope(actor.clinicId, async () => {
      await this.db.run("UPDATE clinics SET retention_years = ? WHERE id = ?", [years, actor.clinicId]);
      await this.scheduling.audit(actor.clinicId, actor.email, "clinic.retention_changed", "clinic", { years });
    });
  }

  private static readonly ACTIVITY_SQL = `
    SELECT p.id, p.first_name, p.last_name, p.dob,
      GREATEST(p.created_at, a.m, c.m, i.m, y.m) AS last_at
    FROM patients p
    LEFT JOIN (SELECT patient_id, MAX(start_at) AS m FROM appointments WHERE clinic_id = ? GROUP BY patient_id) a ON a.patient_id = p.id
    LEFT JOIN (SELECT patient_id, MAX(updated_at) AS m FROM consults WHERE clinic_id = ? AND patient_id IS NOT NULL GROUP BY patient_id) c ON c.patient_id = p.id
    LEFT JOIN (SELECT patient_id, MAX(issued_at) AS m FROM invoices WHERE clinic_id = ? GROUP BY patient_id) i ON i.patient_id = p.id
    LEFT JOIN (SELECT v.patient_id, MAX(x.received_at) AS m FROM payments x JOIN invoices v ON v.id = x.invoice_id AND v.clinic_id = x.clinic_id WHERE x.clinic_id = ? GROUP BY v.patient_id) y ON y.patient_id = p.id
    WHERE p.clinic_id = ? AND p.merged_into IS NULL AND p.anonymised_at IS NULL`;

  private async activity(clinicId: string, patientId?: string): Promise<Row[]> {
    return this.db.all<Row>(`${Records.ACTIVITY_SQL}${patientId ? " AND p.id = ?" : ""}`, [clinicId, clinicId, clinicId, clinicId, clinicId, ...(patientId ? [patientId] : [])]);
  }

  private toRetention(r: Row, years: number): RetentionRow {
    const last = new Date(r.last_at as string);
    const until = retainUntil(last, (r.dob as string) ?? null, years);
    return {
      patientId: r.id as string,
      name: `${r.first_name} ${r.last_name}`,
      lastActivity: last.toISOString(),
      retainUntil: until.toISOString(),
      due: until.getTime() <= this.now().getTime(),
    };
  }

  /** Patients whose retention period has ended, oldest first. A person decides what happens to each. */
  async dueForReview(clinicId: string, limit = 200): Promise<RetentionRow[]> {
    return this.db.scope(clinicId, async () => {
      const years = await this.getRetentionYears(clinicId);
      return (await this.activity(clinicId))
        .map((r) => this.toRetention(r, years))
        .filter((r) => r.due)
        .sort((a, b) => a.retainUntil.localeCompare(b.retainUntil))
        .slice(0, limit);
    });
  }

  /**
   * A transcript is only the source the draft was made from. Once the note is approved the approved record is what
   * matters, so old transcripts are cleared. Returns how many were cleared. Zero days switches this off.
   */
  async purgeTranscripts(clinicId: string, olderThanDays: number): Promise<number> {
    if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) return 0;
    return this.db.scope(clinicId, async () => {
      const cutoff = new Date(this.now().getTime() - olderThanDays * 86_400_000).toISOString();
      const n = await this.db.run(
        `UPDATE consults SET transcript = NULL WHERE clinic_id = ? AND transcript IS NOT NULL AND status = 'approved'
           AND id IN (SELECT consult_id FROM approvals WHERE clinic_id = ? AND approved_at < ?)`,
        [clinicId, clinicId, cutoff],
      );
      if (n > 0) await this.scheduling.audit(clinicId, "system", "transcripts.purged", "consult", { count: n, olderThanDays });
      return n;
    });
  }

  // ---------------------------------------------------------------- export

  /**
   * Everything held about one patient, as structured data a person can be given a copy of. The export is itself
   * recorded in the audit trail.
   */
  async exportPatient(actor: SessionUser, patientId: string): Promise<Record<string, unknown>> {
    this.requireOwner(actor);
    return this.db.scope(actor.clinicId, async () => {
      const c = actor.clinicId;
      const p = await this.db.get<Row>("SELECT * FROM patients WHERE id = ? AND clinic_id = ?", [patientId, c]);
      if (!p) throw new DomainError("not_found", "Patient not found");
      const clinic = await this.scheduling.clinic(c);
      const parse = (v: unknown) => {
        if (typeof v !== "string") return null;
        try {
          return JSON.parse(v);
        } catch {
          return v;
        }
      };

      const appointments = (
        await this.db.all<Row>(
          `SELECT a.id, a.start_at, a.end_at, a.status, a.source, a.cancel_reason, t.name AS type, u.name AS clinician
           FROM appointments a JOIN appointment_types t ON t.id = a.type_id JOIN users u ON u.id = a.user_id
           WHERE a.clinic_id = ? AND a.patient_id = ? ORDER BY a.start_at`,
          [c, patientId],
        )
      ).map((r) => ({ id: r.id, startAt: r.start_at, endAt: r.end_at, status: r.status, source: r.source, cancelReason: r.cancel_reason, type: r.type, clinician: r.clinician }));

      const forms = (
        await this.db.all<Row>("SELECT form_name, form_version, status, response_json, completed_at FROM form_requests WHERE clinic_id = ? AND patient_id = ? ORDER BY created_at", [c, patientId])
      ).map((r) => ({ form: r.form_name, version: r.form_version, status: r.status, completedAt: r.completed_at, responses: parse(r.response_json) }));

      const consultRows = await this.db.all<Row>("SELECT * FROM consults WHERE clinic_id = ? AND patient_id = ? ORDER BY created_at", [c, patientId]);
      const consultations = [];
      for (const k of consultRows) {
        const ap = await this.db.get<Row>("SELECT * FROM approvals WHERE consult_id = ?", [k.id]);
        const checkIns = (await this.db.all<Row>("SELECT adherence, pain_change, comment, created_at FROM check_ins WHERE consult_id = ? ORDER BY created_at", [k.id])).map((x) => ({
          adherence: x.adherence,
          symptomChange: x.pain_change,
          comment: x.comment,
          at: x.created_at,
        }));
        consultations.push({
          id: k.id,
          discipline: k.discipline,
          practitioner: k.practitioner,
          status: k.status,
          createdAt: k.created_at,
          consent: k.consent_at ? { at: k.consent_at, method: k.consent_method, recordedBy: k.consent_recorded_by } : null,
          consentWithdrawnAt: k.consent_withdrawn_at,
          approved: ap ? { by: ap.approved_by, at: ap.approved_at, hash: ap.content_hash, record: parse(ap.note_json), plan: parse(ap.programme_json) } : null,
          // Anything not yet approved is still held, so it is included and labelled as a draft.
          draft: ap ? null : { record: parse(k.note_json), plan: parse(k.programme_json) },
          transcript: k.transcript ?? null,
          checkIns,
          documents: (await this.db.all<Row>("SELECT kind, status, subject, body, language, draft_model, created_by, created_at, finalised_by, finalised_at FROM documents WHERE clinic_id = ? AND consult_id = ? ORDER BY created_at", [c, k.id])).map((d) => ({
            kind: d.kind, status: d.status, subject: d.subject, body: d.body, language: d.language, draftedBy: d.draft_model, createdBy: d.created_by, createdAt: d.created_at, finalisedBy: d.finalised_by, finalisedAt: d.finalised_at,
          })),
        });
      }

      const invoiceRows = await this.db.all<Row>("SELECT * FROM invoices WHERE clinic_id = ? AND patient_id = ? ORDER BY issued_at, number", [c, patientId]);
      const invoices = [];
      for (const i of invoiceRows) {
        const lines = (await this.db.all<Row>("SELECT position, description, quantity, unit_pence, net_pence, vat_pence FROM invoice_lines WHERE invoice_id = ? ORDER BY position", [i.id])).map((l) => ({
          description: l.description, quantity: l.quantity, unitPence: l.unit_pence, netPence: l.net_pence, vatPence: l.vat_pence,
        }));
        const payments = (await this.db.all<Row>("SELECT amount_pence, method, received_at, reference FROM payments WHERE invoice_id = ? ORDER BY received_at, created_at", [i.id])).map((x) => ({
          amountPence: x.amount_pence, method: x.method, receivedAt: x.received_at, reference: x.reference,
        }));
        invoices.push({ number: i.number, kind: i.kind, issuedAt: i.issued_at, dueAt: i.due_at, payer: i.payer_type === "insurer" ? i.payer_name : "patient", totalPence: i.total_pence, lines, payments });
      }

      const waiting = (await this.db.all<Row>("SELECT status, earliest_date, latest_date, created_at FROM waitlist WHERE clinic_id = ? AND patient_id = ? ORDER BY created_at", [c, patientId])).map((w) => ({
        status: w.status, earliestDate: w.earliest_date, latestDate: w.latest_date, createdAt: w.created_at,
      }));

      const addrs = [p.email, p.phone].filter((x): x is string => typeof x === "string" && x.length > 0);
      const messages = addrs.length
        ? (await this.db.all<Row>(`SELECT channel, kind, status, subject, body, sent_at, created_at FROM outbox WHERE clinic_id = ? AND to_addr IN (${addrs.map(() => "?").join(",")}) ORDER BY created_at`, [c, ...addrs])).map((m) => ({
            channel: m.channel, kind: m.kind, status: m.status, subject: m.subject, body: m.body, sentAt: m.sent_at, createdAt: m.created_at,
          }))
        : [];

      const access = (await this.db.all<Row>("SELECT at, actor, action FROM audit_log WHERE clinic_id = ? AND entity = 'patient' AND detail LIKE ? ORDER BY at", [c, `%"patientId":"${patientId}"%`])).map((a) => ({
        at: a.at, by: a.actor, action: a.action,
      }));

      await this.scheduling.audit(c, actor.email, "patient.exported", "patient", { patientId });
      return {
        exportedAt: this.now().toISOString(),
        exportedBy: actor.email,
        clinic: clinic.name,
        patient: {
          id: p.id, firstName: p.first_name, lastName: p.last_name, dateOfBirth: p.dob, email: p.email, phone: p.phone, gpName: p.gp_name, gpPractice: p.gp_practice,
          address: p.address, postcode: p.postcode, smsConsentAt: p.sms_consent_at, emailConsentAt: p.email_consent_at, marketingConsentAt: p.marketing_consent_at,
          createdAt: p.created_at, anonymisedAt: p.anonymised_at,
        },
        appointments,
        forms,
        consultations,
        invoices,
        waitingList: waiting,
        messages,
        recordAccessLog: access,
      };
    });
  }

  // ---------------------------------------------------------------- anonymise

  /**
   * Removes the person's identity: name, contact details, GP, address, date of birth, consent marks, sign-in
   * codes and links, and the transcripts of their consultations. Appointments, consultation records and invoices
   * stay (the law requires clinical and financial records to be kept) but no longer say who they belong to.
   *
   * Before the retention period has ended this is refused unless the owner confirms and gives a reason, which is
   * recorded. Free text a practitioner typed into a note is not searched for names; that stays as written.
   */
  async anonymise(actor: SessionUser, patientId: string, opts: { override?: boolean; reason?: string } = {}): Promise<void> {
    this.requireOwner(actor);
    return this.db.scope(actor.clinicId, async () => {
      const c = actor.clinicId;
      await this.db.lock(`patient:${patientId}`);
      const p = await this.db.get<Row>("SELECT * FROM patients WHERE id = ? AND clinic_id = ?", [patientId, c]);
      if (!p) throw new DomainError("not_found", "Patient not found");
      if (p.anonymised_at) throw new DomainError("conflict", "This patient has already been anonymised");
      if (p.merged_into) throw new DomainError("invalid_state", "This record was merged into another one. Anonymise the current record.");

      const upcoming = await this.db.get("SELECT 1 FROM appointments WHERE clinic_id = ? AND patient_id = ? AND status IN ('booked','arrived') AND end_at > ?", [c, patientId, this.now().toISOString()]);
      if (upcoming) throw new DomainError("invalid_state", "This patient has an appointment coming up. Cancel it first.");

      const years = await this.getRetentionYears(c);
      const row = (await this.activity(c, patientId))[0];
      const info = this.toRetention(row, years);
      const reason = (opts.reason ?? "").trim();
      if (!info.due) {
        if (!opts.override) {
          throw new DomainError(
            "invalid_state",
            `This record should be kept until ${info.retainUntil.slice(0, 10)} (${years} years after the last appointment, longer for a child). If the patient has asked for erasure and you have taken advice that it can go sooner, confirm that and give a reason.`,
          );
        }
        if (reason.length < MIN_REASON) throw new DomainError("validation", "Say why this is being done before the retention period ends", [{ path: "reason", message: `Give a reason of at least ${MIN_REASON} characters` }]);
      }

      const now = this.now().toISOString();
      const addrs = [p.email, p.phone].filter((x): x is string => typeof x === "string" && x.length > 0);
      await this.db.run(
        `UPDATE patients SET first_name = ?, last_name = 'patient', dob = NULL, email = NULL, phone = NULL, gp_name = NULL, gp_practice = NULL, address = NULL, postcode = NULL,
           sms_consent_at = NULL, email_consent_at = NULL, marketing_consent_at = NULL, external_ref = NULL, anonymised_at = ?, updated_at = ? WHERE id = ? AND clinic_id = ?`,
        [SAFE_PRESENT, now, now, patientId, c],
      );
      await this.db.run("UPDATE consults SET patient_label = 'Anonymised patient', transcript = NULL, pms_patient_id = NULL, updated_at = ? WHERE clinic_id = ? AND patient_id = ?", [now, c, patientId]);
      // Letters and summaries are copies of the record written for a named person, and a practitioner may have typed that name into them.
      await this.db.run("DELETE FROM documents WHERE clinic_id = ? AND consult_id IN (SELECT id FROM consults WHERE clinic_id = ? AND patient_id = ?)", [c, c, patientId]);
      await this.db.run(
        "UPDATE patient_links SET revoked_at = COALESCE(revoked_at, ?) WHERE clinic_id = ? AND consult_id IN (SELECT id FROM consults WHERE clinic_id = ? AND patient_id = ?)",
        [now, c, c, patientId],
      );
      await this.db.run("DELETE FROM portal_codes WHERE clinic_id = ? AND patient_id = ?", [c, patientId]);
      await this.db.run("DELETE FROM portal_sessions WHERE clinic_id = ? AND patient_id = ?", [c, patientId]);
      await this.db.run("UPDATE waitlist SET status = 'removed' WHERE clinic_id = ? AND patient_id = ? AND status IN ('waiting','offered')", [c, patientId]);
      if (addrs.length) {
        const marks = addrs.map(() => "?").join(",");
        await this.db.run(`UPDATE outbox SET to_addr = '', subject = '', body = '[removed]', status = CASE WHEN status = 'queued' THEN 'failed' ELSE status END, error = CASE WHEN status = 'queued' THEN 'Patient anonymised' ELSE NULL END WHERE clinic_id = ? AND to_addr IN (${marks})`, [c, ...addrs]);
      }
      await this.scheduling.audit(c, actor.email, "patient.anonymised", "patient", { patientId, beforeRetentionEnd: !info.due, reason: reason || undefined });
    });
  }
}
