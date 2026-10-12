import crypto from "node:crypto";
import { transaction, type Db } from "./db";
import { DomainError } from "./errors";
import { readLink } from "./links";
import { addDays, isDate, utcToZoned, weekdayOf } from "./tz";
import type { Scheduling } from "./scheduling";
import type { Notifier } from "./notify";

/**
 * Waitlist (E1.6). When a time is freed, the top five matching people are offered it for 15 minutes.
 * The first to accept gets it; the claim is a single conditional UPDATE, so two people accepting at the
 * same moment cannot both win. Offers also hold the time against ordinary bookings while they are live.
 */

export const MAX_OFFERS = 5;
export const OFFER_MINUTES = 15;

export interface WaitlistEntry {
  id: string;
  patientId: string;
  patientName: string;
  typeId: string;
  typeName: string;
  userId: string | null;
  clinicianName: string | null;
  earliestDate: string;
  latestDate: string;
  weekdays: number[];
  status: "waiting" | "offered" | "booked" | "removed";
  createdAt: string;
}

export interface FreedSlot {
  clinicId: string;
  userId: string;
  typeId: string;
  startAt: string;
  endAt: string;
}

export interface OfferView {
  id: string;
  clinicId: string;
  clinicName: string;
  typeName: string;
  clinicianName: string;
  startAt: string;
  endAt: string;
  expiresAt: string;
  status: "sent" | "accepted" | "expired" | "taken";
  timezone: string;
}

export class Waitlist {
  constructor(
    private db: Db,
    private scheduling: Scheduling,
    private notifier: Notifier,
    private now: () => Date = () => new Date(),
  ) {}

  private ts() {
    return this.now().toISOString();
  }

  private audit(clinicId: string, by: string, action: string, detail: unknown) {
    this.db.prepare("INSERT INTO audit_log (clinic_id, actor, action, detail, at, entity) VALUES (?, ?, ?, ?, ?, 'waitlist')").run(clinicId, by, action, JSON.stringify(detail), this.ts());
  }

  add(
    clinicId: string,
    by: string,
    input: { patientId: string; typeId: string; userId?: string | null; earliestDate: string; latestDate: string; weekdays?: number[] },
  ): string {
    const issues: { path: string; message: string }[] = [];
    const tz = this.scheduling.clinic(clinicId).timezone;
    const today = utcToZoned(this.now(), tz).date;
    if (!isDate(input.earliestDate)) issues.push({ path: "earliestDate", message: "Enter the earliest date" });
    if (!isDate(input.latestDate)) issues.push({ path: "latestDate", message: "Enter the latest date" });
    if (isDate(input.earliestDate) && isDate(input.latestDate)) {
      if (input.latestDate < input.earliestDate) issues.push({ path: "latestDate", message: "The latest date must not be before the earliest" });
      if (input.latestDate < today) issues.push({ path: "latestDate", message: "The latest date has passed" });
      if (input.latestDate > addDays(today, 180)) issues.push({ path: "latestDate", message: "Choose a date within the next 180 days" });
    }
    const weekdays = (input.weekdays?.length ? input.weekdays : [1, 2, 3, 4, 5, 6, 7]).filter((d) => d >= 1 && d <= 7);
    if (!weekdays.length) issues.push({ path: "weekdays", message: "Choose at least one weekday" });
    if (issues.length) throw new DomainError("validation", "Check the waiting-list details", issues);
    const patient = this.scheduling.getPatient(clinicId, input.patientId);
    if (patient.mergedInto) throw new DomainError("invalid_state", "This patient record was merged into another one");
    if (!patient.email && !(patient.phone && patient.smsConsentAt)) {
      throw new DomainError("validation", "This patient cannot be contacted", [{ path: "patientId", message: "Add an email address, or a phone number with text consent, so offers can reach them" }]);
    }
    this.scheduling.getType(clinicId, input.typeId);
    if (input.userId) {
      if (!this.scheduling.clinicians(clinicId).some((c) => c.id === input.userId)) throw new DomainError("not_found", "Clinician not found");
    }
    const dup = this.db
      .prepare("SELECT 1 FROM waitlist WHERE clinic_id = ? AND patient_id = ? AND type_id = ? AND status IN ('waiting','offered')")
      .get(clinicId, input.patientId, input.typeId);
    if (dup) throw new DomainError("conflict", "This patient is already on the waiting list for that appointment type");
    const id = crypto.randomUUID();
    this.db
      .prepare("INSERT INTO waitlist (id, clinic_id, patient_id, type_id, user_id, earliest_date, latest_date, weekdays, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)")
      .run(id, clinicId, input.patientId, input.typeId, input.userId || null, input.earliestDate, input.latestDate, weekdays.sort().join(","), this.ts());
    this.audit(clinicId, by, "waitlist.added", { id, patientId: input.patientId });
    return id;
  }

  remove(clinicId: string, by: string, id: string) {
    const res = this.db.prepare("UPDATE waitlist SET status = 'removed' WHERE id = ? AND clinic_id = ? AND status IN ('waiting','offered')").run(id, clinicId);
    if (!Number(res.changes)) throw new DomainError("not_found", "Waiting-list entry not found");
    this.db.prepare("UPDATE waitlist_offers SET status = 'expired' WHERE waitlist_id = ? AND status = 'sent'").run(id);
    this.audit(clinicId, by, "waitlist.removed", { id });
  }

  list(clinicId: string, includeClosed = false): WaitlistEntry[] {
    const rows = this.db
      .prepare(
        `SELECT w.*, p.first_name || ' ' || p.last_name AS patient_name, t.name AS type_name, u.name AS clinician_name
         FROM waitlist w JOIN patients p ON p.id = w.patient_id JOIN appointment_types t ON t.id = w.type_id LEFT JOIN users u ON u.id = w.user_id
         WHERE w.clinic_id = ? ${includeClosed ? "" : "AND w.status IN ('waiting','offered')"} ORDER BY w.created_at, w.rowid`,
      )
      .all(clinicId) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      patientId: r.patient_id as string,
      patientName: r.patient_name as string,
      typeId: r.type_id as string,
      typeName: r.type_name as string,
      userId: (r.user_id as string) ?? null,
      clinicianName: (r.clinician_name as string) ?? null,
      earliestDate: r.earliest_date as string,
      latestDate: r.latest_date as string,
      weekdays: (r.weekdays as string).split(",").map(Number),
      status: r.status as WaitlistEntry["status"],
      createdAt: r.created_at as string,
    }));
  }

  private slotIsFree(slot: FreedSlot): boolean {
    if (new Date(slot.startAt).getTime() <= this.now().getTime()) return false;
    const busy = this.db
      .prepare("SELECT 1 FROM appointments WHERE user_id = ? AND status <> 'cancelled' AND start_at < ? AND hold_until > ?")
      .get(slot.userId, slot.endAt, slot.startAt);
    if (busy) return false;
    const held = this.db
      .prepare("SELECT 1 FROM waitlist_offers WHERE user_id = ? AND status IN ('sent','accepted') AND expires_at > ? AND start_at < ? AND end_at > ?")
      .get(slot.userId, this.ts(), slot.endAt, slot.startAt);
    return !held;
  }

  /** Offers a free slot to up to five matching people who have not already been offered it. Returns how many were offered. */
  offerSlot(slot: FreedSlot): number {
    if (!this.slotIsFree(slot)) return 0;
    const tz = this.scheduling.clinic(slot.clinicId).timezone;
    const local = utcToZoned(new Date(slot.startAt), tz);
    const already = new Set(
      (this.db.prepare("SELECT waitlist_id FROM waitlist_offers WHERE user_id = ? AND start_at = ?").all(slot.userId, slot.startAt) as unknown as { waitlist_id: string }[]).map((r) => r.waitlist_id),
    );
    const candidates = (
      this.db
        .prepare(
          `SELECT w.id, w.patient_id, w.weekdays, w.earliest_date, w.latest_date FROM waitlist w JOIN patients p ON p.id = w.patient_id
           WHERE w.clinic_id = ? AND w.status = 'waiting' AND w.type_id = ? AND (w.user_id IS NULL OR w.user_id = ?)
             AND w.earliest_date <= ? AND w.latest_date >= ? AND p.merged_into IS NULL
           ORDER BY w.created_at, w.rowid`,
        )
        .all(slot.clinicId, slot.typeId, slot.userId, local.date, local.date) as unknown as { id: string; patient_id: string; weekdays: string }[]
    )
      .filter((c) => c.weekdays.split(",").map(Number).includes(local.weekday) && weekdayOf(local.date) === local.weekday && !already.has(c.id))
      .slice(0, MAX_OFFERS);
    if (!candidates.length) return 0;

    const type = this.scheduling.getType(slot.clinicId, slot.typeId);
    const batch = crypto.randomUUID();
    const expires = new Date(this.now().getTime() + OFFER_MINUTES * 60_000).toISOString();
    const made: { id: string; patientId: string }[] = [];
    transaction(this.db, () => {
      for (const c of candidates) {
        const id = crypto.randomUUID();
        this.db
          .prepare("INSERT INTO waitlist_offers (id, clinic_id, waitlist_id, batch_id, type_id, user_id, start_at, end_at, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)")
          .run(id, slot.clinicId, c.id, batch, slot.typeId, slot.userId, slot.startAt, slot.endAt, expires, this.ts());
        this.db.prepare("UPDATE waitlist SET status = 'offered' WHERE id = ?").run(c.id);
        made.push({ id, patientId: c.patient_id });
      }
      this.audit(slot.clinicId, "system", "waitlist.offered", { batch, count: made.length, startAt: slot.startAt });
    });
    for (const m of made) this.notifier.offer(slot.clinicId, { id: m.id, patientId: m.patientId, typeName: type.name, startAt: slot.startAt, expiresAt: expires });
    return made.length;
  }

  offerByToken(token: string): OfferView | null {
    const id = readLink("offer", token);
    if (!id) return null;
    const r = this.db
      .prepare(
        `SELECT o.*, c.name AS clinic_name, c.timezone, t.name AS type_name, u.name AS clinician_name
         FROM waitlist_offers o JOIN clinics c ON c.id = o.clinic_id JOIN appointment_types t ON t.id = o.type_id JOIN users u ON u.id = o.user_id WHERE o.id = ?`,
      )
      .get(id) as unknown as Record<string, unknown> | undefined;
    if (!r) return null;
    let status = r.status as OfferView["status"];
    if (status === "sent" && (r.expires_at as string) <= this.ts()) status = "expired";
    return {
      id: r.id as string, clinicId: r.clinic_id as string, clinicName: r.clinic_name as string, typeName: r.type_name as string,
      clinicianName: r.clinician_name as string, startAt: r.start_at as string, endAt: r.end_at as string,
      expiresAt: r.expires_at as string, status, timezone: r.timezone as string,
    };
  }

  /** The patient takes the offered time. Exactly one person per slot can succeed. */
  accept(token: string): { appointmentId: string } {
    const offer = this.offerByToken(token);
    if (!offer) throw new DomainError("not_found", "This link is not valid");
    if (offer.status === "accepted") throw new DomainError("invalid_state", "You have already taken this appointment");
    if (offer.status === "taken") throw new DomainError("conflict", "Sorry, someone else took this time first");
    if (offer.status === "expired") throw new DomainError("invalid_state", "This offer has ended");

    const claim = this.db.prepare("UPDATE waitlist_offers SET status = 'accepted' WHERE id = ? AND status = 'sent' AND expires_at > ?").run(offer.id, this.ts());
    if (Number(claim.changes) !== 1) throw new DomainError("conflict", "Sorry, someone else took this time first");

    const row = this.db.prepare("SELECT waitlist_id, batch_id FROM waitlist_offers WHERE id = ?").get(offer.id) as { waitlist_id: string; batch_id: string };
    const entry = this.db.prepare("SELECT patient_id, type_id FROM waitlist WHERE id = ?").get(row.waitlist_id) as { patient_id: string; type_id: string };
    const offerRow = this.db.prepare("SELECT user_id FROM waitlist_offers WHERE id = ?").get(offer.id) as { user_id: string };
    let appointmentId: string;
    try {
      appointmentId = this.scheduling.createAppointment(offer.clinicId, "patient", {
        patientId: entry.patient_id, userId: offerRow.user_id, typeId: entry.type_id, startAt: offer.startAt,
        source: "waitlist", enforceHours: false, ignoreBatchId: row.batch_id,
      });
    } catch (err) {
      const conflict = err instanceof DomainError && err.code === "conflict";
      this.db.prepare("UPDATE waitlist_offers SET status = ? WHERE id = ?").run(conflict ? "taken" : "sent", offer.id);
      if (conflict) throw new DomainError("conflict", "Sorry, that time was taken a moment ago");
      throw err;
    }
    transaction(this.db, () => {
      const others = this.db.prepare("SELECT waitlist_id FROM waitlist_offers WHERE batch_id = ? AND id <> ? AND status = 'sent'").all(row.batch_id, offer.id) as unknown as { waitlist_id: string }[];
      this.db.prepare("UPDATE waitlist_offers SET status = 'taken' WHERE batch_id = ? AND id <> ? AND status = 'sent'").run(row.batch_id, offer.id);
      for (const o of others) this.db.prepare("UPDATE waitlist SET status = 'waiting' WHERE id = ? AND status = 'offered'").run(o.waitlist_id);
      this.db.prepare("UPDATE waitlist SET status = 'booked' WHERE id = ?").run(row.waitlist_id);
      this.audit(offer.clinicId, "patient", "waitlist.accepted", { offerId: offer.id, appointmentId });
    });
    return { appointmentId };
  }

  /** Worker step: ends offers nobody answered, returns people to the list, and offers the slot to the next five. */
  expireOffers(): { expired: number; reoffered: number } {
    const due = this.db
      .prepare("SELECT id, clinic_id, waitlist_id, batch_id, type_id, user_id, start_at, end_at FROM waitlist_offers WHERE status = 'sent' AND expires_at <= ?")
      .all(this.ts()) as unknown as { id: string; clinic_id: string; waitlist_id: string; batch_id: string; type_id: string; user_id: string; start_at: string; end_at: string }[];
    if (!due.length) return { expired: 0, reoffered: 0 };
    transaction(this.db, () => {
      for (const o of due) {
        this.db.prepare("UPDATE waitlist_offers SET status = 'expired' WHERE id = ? AND status = 'sent'").run(o.id);
        this.db.prepare("UPDATE waitlist SET status = 'waiting' WHERE id = ? AND status = 'offered'").run(o.waitlist_id);
      }
    });
    let reoffered = 0;
    const slots = new Map<string, FreedSlot>();
    for (const o of due) slots.set(`${o.user_id}|${o.start_at}`, { clinicId: o.clinic_id, userId: o.user_id, typeId: o.type_id, startAt: o.start_at, endAt: o.end_at });
    for (const s of slots.values()) reoffered += this.offerSlot(s);
    return { expired: due.length, reoffered };
  }
}
