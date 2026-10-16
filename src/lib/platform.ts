import type { Db } from "./db";
import { logError } from "./log";
import { createMailer } from "./mail";
import { Accounts } from "./accounts";
import { Booking } from "./booking";
import { Forms } from "./forms";
import { Ical } from "./ical";
import { Importer } from "./importer";
import { Notifier } from "./notify";
import { Outbox, type Mailer } from "./outbox";
import { Billing } from "./billing";
import { Records } from "./records";
import { Reports } from "./reports";
import { Scheduling } from "./scheduling";
import { Waitlist } from "./waitlist";

/** Wires the diary, forms, messaging and waiting list together. One per process. */
export function createPlatform(db: Db, opts: { now?: () => Date; baseUrl?: () => string; mailer?: Mailer } = {}) {
  const now = opts.now ?? (() => new Date());
  const baseUrl = opts.baseUrl ?? (() => (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""));
  const mailer = opts.mailer ?? createMailer();

  const accounts = new Accounts(db, now);
  const outbox = new Outbox(db, now);
  const notifier = new Notifier(db, outbox, baseUrl, now);
  const forms = new Forms(db, now);
  const scheduling = new Scheduling(db, now);
  const waitlist = new Waitlist(db, scheduling, notifier, now);
  const booking = new Booking(db, scheduling, forms, notifier, now);
  const ical = new Ical(db, now);
  const importer = new Importer(db, scheduling, now);
  const reports = new Reports(db, now);
  const billing = new Billing(db, scheduling, now);
  const records = new Records(db, scheduling, now);

  accounts.setResetHook((m) => notifier.passwordReset(m.clinicId, m.to, m.name, m.token).then(() => undefined));

  // Hooks run inside the transaction of the booking, move or cancellation that triggered them, so the
  // appointment, its intake forms, its message and any waiting-list offers are saved together or not at all.
  scheduling.setHooks({
    afterBooked: async (a) => {
      const clinicId = await clinicIdOf(a.id);
      await forms.requestForAppointment(a, clinicId);
      await notifier.confirmation(clinicId, a);
    },
    afterCancelled: async (a, byPatient) => notifier.cancelled(await clinicIdOf(a.id), a, byPatient),
    afterMoved: async (a, prev) => notifier.moved(await clinicIdOf(a.id), a, prev),
    slotFreed: (slot) => waitlist.offerSlot(slot),
  });

  /** The hooks run inside the booking's own clinic scope, so the appointment's clinic is simply that scope's. */
  async function clinicIdOf(appointmentId: string): Promise<string> {
    const current = db.currentClinic();
    if (current) return current;
    throw new Error(`No clinic scope for appointment ${appointmentId}`);
  }

  /** Reminders go 24 hours ahead. A booking made inside that window already got its confirmation, so it gets no reminder. */
  async function queueReminders(clinicId: string): Promise<number> {
    return db.scope(clinicId, async () => {
      const t = now();
      const rows = await db.all<{ id: string; clinic_id: string; created_at: string }>(
        `SELECT id, clinic_id, created_at FROM appointments WHERE clinic_id = ? AND status = 'booked' AND start_at > ? AND start_at <= ?`,
        [clinicId, t.toISOString(), new Date(t.getTime() + 24 * 3_600_000).toISOString()],
      );
      let n = 0;
      for (const r of rows) {
        const a = await scheduling.getAppointment(r.clinic_id, r.id);
        if (new Date(r.created_at).getTime() > new Date(a.startAt).getTime() - 24 * 3_600_000) continue;
        await notifier.reminder(r.clinic_id, a);
        n++;
      }
      return n;
    });
  }

  /**
   * One pass of background work, one clinic at a time (each in that clinic's own transaction, so a failure in
   * one clinic cannot stop the others). Safe to run as often as you like and from more than one place.
   */
  async function tick() {
    const total = { reminders: 0, expired: 0, reoffered: 0, sent: 0, failed: 0, purged: 0, errors: 0 };
    const transcriptDays = Number(process.env.TRANSCRIPT_RETENTION_DAYS ?? 30);
    for (const clinicId of await scheduling.clinicIds()) {
      try {
        total.reminders += await queueReminders(clinicId);
        const offers = await waitlist.expireOffers(clinicId);
        total.expired += offers.expired;
        total.reoffered += offers.reoffered;
        const delivered = await outbox.deliverDue(clinicId, mailer);
        total.sent += delivered.sent;
        total.failed += delivered.failed;
        total.purged += await records.purgeTranscripts(clinicId, transcriptDays);
      } catch (err) {
        total.errors++;
        logError(`tick:${clinicId}`, err);
      }
    }
    return total;
  }

  return { db, now, accounts, scheduling, forms, booking, waitlist, outbox, notifier, ical, importer, reports, billing, records, mailer, tick, baseUrl };
}

export type Platform = ReturnType<typeof createPlatform>;
