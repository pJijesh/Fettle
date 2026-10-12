import type { Db } from "./db";
import { Accounts } from "./accounts";
import { Booking } from "./booking";
import { Forms } from "./forms";
import { Ical } from "./ical";
import { Importer } from "./importer";
import { Notifier } from "./notify";
import { DevMailer, Outbox, type Mailer } from "./outbox";
import { Scheduling } from "./scheduling";
import { Waitlist } from "./waitlist";

/** Wires the diary, forms, messaging and waiting list together. One per process. */
export function createPlatform(db: Db, opts: { now?: () => Date; baseUrl?: () => string; mailer?: Mailer } = {}) {
  const now = opts.now ?? (() => new Date());
  const baseUrl = opts.baseUrl ?? (() => (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""));
  const mailer = opts.mailer ?? new DevMailer();

  const accounts = new Accounts(db, now);
  const outbox = new Outbox(db, now);
  const notifier = new Notifier(db, outbox, baseUrl, now);
  const forms = new Forms(db, now);
  const scheduling = new Scheduling(db, now);
  const waitlist = new Waitlist(db, scheduling, notifier, now);
  const booking = new Booking(db, scheduling, forms, notifier, now);
  const ical = new Ical(db, now);
  const importer = new Importer(db, scheduling, now);

  const clinicOf = (appointmentId: string) =>
    (db.prepare("SELECT clinic_id FROM appointments WHERE id = ?").get(appointmentId) as { clinic_id: string }).clinic_id;

  scheduling.setHooks({
    afterBooked: (a) => {
      const clinicId = clinicOf(a.id);
      forms.requestForAppointment(a, clinicId);
      notifier.confirmation(clinicId, a);
    },
    afterCancelled: (a, byPatient) => notifier.cancelled(clinicOf(a.id), a, byPatient),
    afterMoved: (a, prev) => notifier.moved(clinicOf(a.id), a, prev),
    slotFreed: (slot) => {
      waitlist.offerSlot(slot);
    },
  });

  /** Reminders go 24 hours ahead. A booking made inside that window already got its confirmation, so it gets no reminder. */
  function queueReminders(): number {
    const t = now();
    const rows = db
      .prepare(
        `SELECT id, clinic_id FROM appointments WHERE status = 'booked' AND start_at > ? AND start_at <= ?`,
      )
      .all(t.toISOString(), new Date(t.getTime() + 24 * 3_600_000).toISOString()) as unknown as { id: string; clinic_id: string }[];
    let n = 0;
    for (const r of rows) {
      const a = scheduling.getAppointment(r.clinic_id, r.id);
      const created = (db.prepare("SELECT created_at FROM appointments WHERE id = ?").get(r.id) as { created_at: string }).created_at;
      if (new Date(created).getTime() > new Date(a.startAt).getTime() - 24 * 3_600_000) continue;
      notifier.reminder(r.clinic_id, a);
      n++;
    }
    return n;
  }

  /** One pass of background work. Safe to run as often as you like and from more than one place. */
  async function tick() {
    const reminders = queueReminders();
    const offers = waitlist.expireOffers();
    const delivered = await outbox.deliverDue(mailer);
    return { reminders, ...offers, ...delivered };
  }

  return { db, now, accounts, scheduling, forms, booking, waitlist, outbox, notifier, ical, importer, mailer, tick, baseUrl };
}

export type Platform = ReturnType<typeof createPlatform>;
