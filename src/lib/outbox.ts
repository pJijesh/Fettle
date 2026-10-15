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
  async queue(m: QueueInput): Promise<boolean> {
    return this.db.scope(m.clinicId, async () => {
      const n = await this.db.run(
        `INSERT INTO outbox (id, clinic_id, channel, to_addr, subject, body, kind, status, attempts, send_after, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [crypto.randomUUID(), m.clinicId, m.channel, m.to, m.subject ?? "", m.body, m.kind, (m.sendAfter ?? this.now()).toISOString(), m.key, this.now().toISOString()],
      );
      return n === 1;
    });
  }

  /**
   * Sends what is due for one clinic. A failure is retried later with a growing delay and gives up after five tries.
   * Three steps, so a database connection is never held open while a provider is being called: claim the rows,
   * send them, record the results.
   */
  async deliverDue(clinicId: string, mailer: Mailer, limit = 50): Promise<{ sent: number; failed: number }> {
    type Due = { id: string; clinic_id: string; channel: "email" | "sms"; to_addr: string; subject: string; body: string; kind: string; attempts: number };
    const claimed = await this.db.scope(clinicId, async () => {
      const rows = await this.db.all<Due>("SELECT * FROM outbox WHERE status = 'queued' AND send_after <= ? ORDER BY send_after, seq LIMIT ? FOR UPDATE SKIP LOCKED", [
        this.now().toISOString(),
        limit,
      ]);
      const mine: Due[] = [];
      for (const r of rows) {
        // Count the attempt before sending, so a crash mid-send is counted and retried, never forgotten.
        const n = await this.db.run("UPDATE outbox SET attempts = attempts + 1 WHERE id = ? AND status = 'queued' AND attempts = ?", [r.id, r.attempts]);
        if (n) mine.push(r);
      }
      return mine;
    });

    const results: { r: Due; error: string | null }[] = [];
    for (const r of claimed) {
      try {
        await mailer.send({ id: r.id, clinicId: r.clinic_id, channel: r.channel, to: r.to_addr, subject: r.subject, body: r.body, kind: r.kind });
        results.push({ r, error: null });
      } catch (err) {
        results.push({ r, error: String(err instanceof Error ? err.message : err).slice(0, 300) });
      }
    }

    let sent = 0;
    let failed = 0;
    await this.db.scope(clinicId, async () => {
      for (const { r, error } of results) {
        if (error === null) {
          await this.db.run("UPDATE outbox SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?", [this.now().toISOString(), r.id]);
          sent++;
        } else {
          failed++;
          const attempts = r.attempts + 1;
          const give = attempts >= MAX_ATTEMPTS;
          const next = new Date(this.now().getTime() + attempts * attempts * 60_000).toISOString();
          await this.db.run("UPDATE outbox SET status = ?, error = ?, send_after = ? WHERE id = ?", [give ? "failed" : "queued", error, next, r.id]);
        }
      }
    });
    return { sent, failed };
  }

  list(clinicId: string, limit = 100) {
    return this.db.scope(clinicId, () =>
      this.db.all<{
        id: string; channel: string; to_addr: string; subject: string; body: string; kind: string; status: string;
        attempts: number; error: string | null; send_after: string; sent_at: string | null;
      }>(
        "SELECT id, channel, to_addr, subject, body, kind, status, attempts, error, send_after, sent_at FROM outbox WHERE clinic_id = ? ORDER BY created_at DESC, seq DESC LIMIT ?",
        [clinicId, limit],
      ),
    );
  }
}
