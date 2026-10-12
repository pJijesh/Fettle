import crypto from "node:crypto";
import type { Db } from "./db";

/**
 * Every email and text goes through this queue. Queuing is idempotent (the same key never queues twice),
 * so a retry, a double click or a worker restart cannot send a patient the same message twice.
 * The worker (`deliverDue`) hands queued rows to a `Mailer`; the default `DevMailer` sends nothing and
 * simply marks them as delivered so they can be read at /dev/outbox. Real email and SMS providers
 * implement `Mailer` and need contracts, sender domains and a UK data-processing agreement first.
 */

export interface OutboundMessage {
  id: string;
  clinicId: string;
  channel: "email" | "sms";
  to: string;
  subject: string;
  body: string;
  kind: string;
}

export interface Mailer {
  readonly name: string;
  readonly isReal: boolean;
  send(msg: OutboundMessage): Promise<void>;
}

export class DevMailer implements Mailer {
  readonly name = "dev";
  readonly isReal = false;
  async send(): Promise<void> {
    /* nothing leaves the machine */
  }
}

export interface QueueInput {
  clinicId: string;
  channel: "email" | "sms";
  to: string;
  subject?: string;
  body: string;
  kind: string;
  key: string;
  sendAfter?: Date;
}

const MAX_ATTEMPTS = 5;

export class Outbox {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  /** Returns true when queued, false when the same key was queued before. */
  queue(m: QueueInput): boolean {
    const now = this.now().toISOString();
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO outbox (id, clinic_id, channel, to_addr, subject, body, kind, status, attempts, send_after, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), m.clinicId, m.channel, m.to, m.subject ?? "", m.body, m.kind, (m.sendAfter ?? this.now()).toISOString(), m.key, now);
    return Number(res.changes) === 1;
  }

  /** Sends what is due. A failure is retried later with a growing delay and gives up after five tries. */
  async deliverDue(mailer: Mailer, limit = 50): Promise<{ sent: number; failed: number }> {
    const rows = this.db
      .prepare("SELECT * FROM outbox WHERE status = 'queued' AND send_after <= ? ORDER BY send_after LIMIT ?")
      .all(this.now().toISOString(), limit) as unknown as {
      id: string; clinic_id: string; channel: "email" | "sms"; to_addr: string; subject: string; body: string; kind: string; attempts: number;
    }[];
    let sent = 0;
    let failed = 0;
    for (const r of rows) {
      // Claim the row first so two workers never send the same message.
      const claim = this.db.prepare("UPDATE outbox SET attempts = attempts + 1 WHERE id = ? AND status = 'queued' AND attempts = ?").run(r.id, r.attempts);
      if (!Number(claim.changes)) continue;
      try {
        await mailer.send({ id: r.id, clinicId: r.clinic_id, channel: r.channel, to: r.to_addr, subject: r.subject, body: r.body, kind: r.kind });
        this.db.prepare("UPDATE outbox SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?").run(this.now().toISOString(), r.id);
        sent++;
      } catch (err) {
        failed++;
        const attempts = r.attempts + 1;
        const give = attempts >= MAX_ATTEMPTS;
        const next = new Date(this.now().getTime() + attempts * attempts * 60_000).toISOString();
        this.db
          .prepare("UPDATE outbox SET status = ?, error = ?, send_after = ? WHERE id = ?")
          .run(give ? "failed" : "queued", String(err instanceof Error ? err.message : err).slice(0, 300), next, r.id);
      }
    }
    return { sent, failed };
  }

  list(clinicId: string, limit = 100) {
    return this.db
      .prepare("SELECT id, channel, to_addr, subject, body, kind, status, attempts, error, send_after, sent_at FROM outbox WHERE clinic_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(clinicId, limit) as unknown as {
      id: string; channel: string; to_addr: string; subject: string; body: string; kind: string; status: string;
      attempts: number; error: string | null; send_after: string; sent_at: string | null;
    }[];
  }
}
