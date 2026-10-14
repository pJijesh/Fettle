import crypto from "node:crypto";
import { clinicOf, type Db } from "./db";
import { DomainError } from "./errors";
import { randomToken, sha256 } from "./crypto";

/**
 * Read-only calendar feed per clinician (E1.10). The URL contains a secret token; only its hash is stored, so
 * the URL is shown once. Events carry initials and appointment type only, because a calendar provider
 * (Google, Apple, Outlook) becomes another place the data lives.
 */

function esc(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Lines over 75 octets are folded with a CRLF and a space (RFC 5545 §3.1). */
function fold(line: string): string {
  const bytes = Buffer.from(line);
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let i = 0;
  let limit = 75;
  while (i < bytes.length) {
    let end = Math.min(i + limit, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--; // never split a UTF-8 character
    parts.push(bytes.subarray(i, end).toString());
    i = end;
    limit = 74;
  }
  return parts.join("\r\n ");
}

function stamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function initials(first: string, last: string) {
  return `${first.trim()[0] ?? ""}.${last.trim()[0] ?? ""}.`.toUpperCase();
}

export class Ical {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  /** Replaces any earlier link for this person. Returns the token, which cannot be recovered later. */
  createToken(clinicId: string, userId: string): Promise<string> {
    return this.db.scope(clinicId, async () => {
      const ok = await this.db.get("SELECT 1 FROM users WHERE id = ? AND clinic_id = ? AND active = 1", [userId, clinicId]);
      if (!ok) throw new DomainError("not_found", "Staff member not found");
      const token = randomToken(32);
      const at = this.now().toISOString();
      await this.db.run("UPDATE ical_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [at, userId]);
      await this.db.run("INSERT INTO ical_tokens (id, clinic_id, user_id, token_hash, created_at) VALUES (?, ?, ?, ?, ?)", [crypto.randomUUID(), clinicId, userId, sha256(token), at]);
      await this.db.run("INSERT INTO audit_log (clinic_id, actor, action, detail, at, entity) VALUES (?, ?, 'ical.link_created', ?, ?, 'user')", [clinicId, userId, JSON.stringify({ userId }), at]);
      return token;
    });
  }

  revoke(clinicId: string, userId: string): Promise<void> {
    return this.db.scope(clinicId, async () => {
      await this.db.run("UPDATE ical_tokens SET revoked_at = ? WHERE user_id = ? AND clinic_id = ? AND revoked_at IS NULL", [this.now().toISOString(), userId, clinicId]);
    });
  }

  hasActive(clinicId: string, userId: string): Promise<boolean> {
    return this.db.scope(clinicId, async () => Boolean(await this.db.get("SELECT 1 FROM ical_tokens WHERE user_id = ? AND revoked_at IS NULL", [userId])));
  }

  /** The feed URL carries only a secret token, so the clinic is found from the token's hash first. */
  async feed(token: string): Promise<string | null> {
    if (!token || token.length > 100) return null;
    const hash = sha256(token);
    const clinicId = await clinicOf(this.db, "ical_token", hash);
    if (!clinicId) return null;
    return this.db.scope(clinicId, () => this.feedFor(hash));
  }

  private async feedFor(hash: string): Promise<string | null> {
    const t = await this.db.get<{ clinic_id: string; user_id: string }>("SELECT clinic_id, user_id FROM ical_tokens WHERE token_hash = ? AND revoked_at IS NULL", [hash]);
    if (!t) return null;
    const user = (await this.db.get<{ name: string; active: number }>("SELECT name, active FROM users WHERE id = ?", [t.user_id]))!;
    if (!user.active) return null;
    const clinic = (await this.db.get<{ name: string }>("SELECT name FROM clinics WHERE id = ?", [t.clinic_id]))!;
    const from = new Date(this.now().getTime() - 30 * 86_400_000).toISOString();
    const to = new Date(this.now().getTime() + 180 * 86_400_000).toISOString();
    const rows = await this.db.all<{ id: string; start_at: string; end_at: string; status: string; updated_at: string; first_name: string; last_name: string; type_name: string }>(
      `SELECT a.id, a.start_at, a.end_at, a.status, a.updated_at, p.first_name, p.last_name, ty.name AS type_name
       FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN appointment_types ty ON ty.id = a.type_id
       WHERE a.user_id = ? AND a.clinic_id = ? AND a.status <> 'cancelled' AND a.start_at < ? AND a.end_at > ? ORDER BY a.start_at`,
      [t.user_id, t.clinic_id, to, from],
    );
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Fettle//Diary//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:${esc(`${clinic.name}: ${user.name}`)}`,
      "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    ];
    for (const r of rows) {
      lines.push(
        "BEGIN:VEVENT",
        `UID:${r.id}@fettle`,
        `DTSTAMP:${stamp(r.updated_at)}`,
        `DTSTART:${stamp(r.start_at)}`,
        `DTEND:${stamp(r.end_at)}`,
        `SUMMARY:${esc(`${initials(r.first_name, r.last_name)} ${r.type_name}`)}`,
        r.status === "no_show" ? "STATUS:TENTATIVE" : "STATUS:CONFIRMED",
        "END:VEVENT",
      );
    }
    lines.push("END:VCALENDAR");
    return lines.map(fold).join("\r\n") + "\r\n";
  }
}
