import crypto from "node:crypto";
import type { Db } from "./db";
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
  createToken(clinicId: string, userId: string): string {
    const ok = this.db.prepare("SELECT 1 FROM users WHERE id = ? AND clinic_id = ? AND active = 1").get(userId, clinicId);
    if (!ok) throw new DomainError("not_found", "Staff member not found");
    const token = randomToken(32);
    this.db.prepare("UPDATE ical_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(this.now().toISOString(), userId);
    this.db
      .prepare("INSERT INTO ical_tokens (id, clinic_id, user_id, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), clinicId, userId, sha256(token), this.now().toISOString());
    this.db.prepare("INSERT INTO audit_log (clinic_id, actor, action, detail, at, entity) VALUES (?, ?, 'ical.link_created', ?, ?, 'user')").run(clinicId, userId, JSON.stringify({ userId }), this.now().toISOString());
    return token;
  }

  revoke(clinicId: string, userId: string) {
    this.db.prepare("UPDATE ical_tokens SET revoked_at = ? WHERE user_id = ? AND clinic_id = ? AND revoked_at IS NULL").run(this.now().toISOString(), userId, clinicId);
  }

  hasActive(userId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM ical_tokens WHERE user_id = ? AND revoked_at IS NULL").get(userId));
  }

  feed(token: string): string | null {
    if (!token || token.length > 100) return null;
    const t = this.db.prepare("SELECT clinic_id, user_id FROM ical_tokens WHERE token_hash = ? AND revoked_at IS NULL").get(sha256(token)) as
      | { clinic_id: string; user_id: string }
      | undefined;
    if (!t) return null;
    const user = this.db.prepare("SELECT name, active FROM users WHERE id = ?").get(t.user_id) as { name: string; active: number };
    if (!user.active) return null;
    const clinic = this.db.prepare("SELECT name FROM clinics WHERE id = ?").get(t.clinic_id) as { name: string };
    const from = new Date(this.now().getTime() - 30 * 86_400_000).toISOString();
    const to = new Date(this.now().getTime() + 180 * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT a.id, a.start_at, a.end_at, a.status, a.updated_at, p.first_name, p.last_name, ty.name AS type_name
         FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN appointment_types ty ON ty.id = a.type_id
         WHERE a.user_id = ? AND a.clinic_id = ? AND a.status <> 'cancelled' AND a.start_at < ? AND a.end_at > ? ORDER BY a.start_at`,
      )
      .all(t.user_id, t.clinic_id, to, from) as unknown as { id: string; start_at: string; end_at: string; status: string; updated_at: string; first_name: string; last_name: string; type_name: string }[];
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
