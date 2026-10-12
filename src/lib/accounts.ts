import crypto from "node:crypto";
import { transaction, type Db } from "./db";
import {
  DUMMY_HASH,
  generateTotpSecret,
  hashPassword,
  otpauthUri,
  passwordProblem,
  randomToken,
  sha256,
  verifyPassword,
  verifyTotp,
} from "./crypto";
import { DomainError } from "./errors";

export type Role = "owner" | "clinician" | "reception";

export interface SessionUser {
  id: string;
  clinicId: string;
  name: string;
  email: string;
  role: Role;
}

export interface SessionInfo {
  user: SessionUser;
  mfaOk: boolean;
  mfaEnabled: boolean;
}

const SESSION_HOURS = 12;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const BAD_LOGIN = "Email or password is not right.";

interface UserRow {
  id: string;
  clinic_id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  totp_secret: string | null;
  totp_enabled: number;
  totp_last_step: number | null;
  active: number;
  failed_logins: number;
  locked_until: string | null;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export class Accounts {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  private ts() {
    return this.now().toISOString();
  }

  private audit(clinicId: string | null, actor: string, action: string, detail?: unknown) {
    this.db
      .prepare("INSERT INTO audit_log (clinic_id, actor, action, detail, at, entity) VALUES (?, ?, ?, ?, ?, 'account')")
      .run(clinicId, actor, action, detail === undefined ? null : JSON.stringify(detail), this.ts());
  }

  hasUsers(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM users LIMIT 1").get());
  }

  /** First-run only: creates the first clinic and its owner. Refused once any user exists. */
  bootstrap(input: { clinicName: string; ownerName: string; email: string; password: string }): { clinicId: string; userId: string } {
    return transaction(this.db, () => {
      if (this.hasUsers()) throw new DomainError("invalid_state", "Setup has already been done");
      const issues = this.userIssues({ name: input.ownerName, email: input.email, password: input.password });
      if (!input.clinicName.trim()) issues.push({ path: "clinicName", message: "Enter the clinic's name" });
      if (issues.length) throw new DomainError("validation", "Check the details", issues);
      const clinicId = crypto.randomUUID();
      const slug = slugify(input.clinicName) || "clinic";
      this.db
        .prepare("INSERT INTO clinics (id, name, slug, timezone, created_at) VALUES (?, ?, ?, 'Europe/London', ?)")
        .run(clinicId, input.clinicName.trim(), slug, this.ts());
      const userId = this.insertUser(clinicId, { name: input.ownerName, email: input.email, password: input.password, role: "owner" });
      this.audit(clinicId, input.email, "clinic.bootstrapped");
      return { clinicId, userId };
    });
  }

  private userIssues(u: { name: string; email: string; password: string }) {
    const issues: { path: string; message: string }[] = [];
    if (!u.name.trim()) issues.push({ path: "name", message: "Enter a name" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.email.trim())) issues.push({ path: "email", message: "Enter a valid email address" });
    const pw = passwordProblem(u.password, u.email.trim());
    if (pw) issues.push({ path: "password", message: pw });
    return issues;
  }

  private insertUser(clinicId: string, u: { name: string; email: string; password: string; role: Role }): string {
    const id = crypto.randomUUID();
    try {
      this.db
        .prepare("INSERT INTO users (id, clinic_id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, clinicId, u.email.trim().toLowerCase(), u.name.trim(), u.role, hashPassword(u.password), this.ts());
    } catch (err) {
      if (String(err).includes("UNIQUE")) throw new DomainError("validation", "That email already has an account", [{ path: "email", message: "Already in use" }]);
      throw err;
    }
    return id;
  }

  createUser(actor: SessionUser, input: { name: string; email: string; password: string; role: Role }): string {
    if (actor.role !== "owner") throw new DomainError("forbidden", "Only the clinic owner can add staff");
    if (!["owner", "clinician", "reception"].includes(input.role)) throw new DomainError("validation", "Choose a role");
    const issues = this.userIssues(input);
    if (issues.length) throw new DomainError("validation", "Check the details", issues);
    const id = this.insertUser(actor.clinicId, input);
    this.audit(actor.clinicId, actor.email, "user.created", { userId: id, role: input.role });
    return id;
  }

  listUsers(clinicId: string) {
    return (
      this.db
        .prepare("SELECT id, name, email, role, active, totp_enabled FROM users WHERE clinic_id = ? ORDER BY name")
        .all(clinicId) as unknown as { id: string; name: string; email: string; role: Role; active: number; totp_enabled: number }[]
    ).map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: !!u.active, mfa: !!u.totp_enabled }));
  }

  deactivateUser(actor: SessionUser, userId: string) {
    if (actor.role !== "owner") throw new DomainError("forbidden", "Only the clinic owner can change staff");
    if (userId === actor.id) throw new DomainError("invalid_state", "You cannot deactivate your own account");
    const res = this.db.prepare("UPDATE users SET active = 0 WHERE id = ? AND clinic_id = ?").run(userId, actor.clinicId);
    if (!Number(res.changes)) throw new DomainError("not_found", "Staff member not found");
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    this.audit(actor.clinicId, actor.email, "user.deactivated", { userId });
  }

  resetPassword(actor: SessionUser, userId: string, password: string) {
    if (actor.role !== "owner") throw new DomainError("forbidden", "Only the clinic owner can reset passwords");
    const target = this.db.prepare("SELECT email FROM users WHERE id = ? AND clinic_id = ?").get(userId, actor.clinicId) as { email: string } | undefined;
    if (!target) throw new DomainError("not_found", "Staff member not found");
    const problem = passwordProblem(password, target.email);
    if (problem) throw new DomainError("validation", problem, [{ path: "password", message: problem }]);
    this.db.prepare("UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?").run(hashPassword(password), userId);
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    this.audit(actor.clinicId, actor.email, "user.password_reset", { userId });
  }

  // ---------------------------------------------------------------- sign-in

  /** Checks email and password. Returns a session token that still needs its second factor. */
  login(email: string, password: string): { token: string } {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase()) as unknown as UserRow | undefined;
    const now = this.now();

    if (row?.locked_until && new Date(row.locked_until) > now) {
      verifyPassword(password, DUMMY_HASH);
      this.audit(row.clinic_id, row.email, "login.locked");
      throw new DomainError("rate_limited", "Too many failed attempts. Try again in a few minutes.");
    }
    const ok = verifyPassword(password, row?.password_hash ?? DUMMY_HASH) && !!row && !!row.active;
    if (!ok) {
      if (row) {
        const failed = row.failed_logins + 1;
        const lock = failed >= MAX_FAILED ? new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString() : null;
        this.db.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?").run(lock ? 0 : failed, lock, row.id);
        this.audit(row.clinic_id, row.email, "login.failed");
      }
      throw new DomainError("unauthenticated", BAD_LOGIN);
    }
    this.db.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?").run(row.id);
    const token = this.newSession(row.id, row.clinic_id);
    this.audit(row.clinic_id, row.email, "login.password_ok");
    return { token };
  }

  private newSession(userId: string, clinicId: string): string {
    const token = randomToken(32);
    const exp = new Date(this.now().getTime() + SESSION_HOURS * 3_600_000).toISOString();
    this.db
      .prepare("INSERT INTO sessions (token_hash, user_id, clinic_id, created_at, expires_at, mfa_ok) VALUES (?, ?, ?, ?, ?, 0)")
      .run(sha256(token), userId, clinicId, this.ts(), exp);
    return token;
  }

  getSession(token: string | undefined): SessionInfo | null {
    if (!token || token.length > 128) return null;
    const row = this.db
      .prepare(
        `SELECT s.mfa_ok, s.expires_at, u.id, u.clinic_id, u.name, u.email, u.role, u.active, u.totp_enabled
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(sha256(token)) as
      | { mfa_ok: number; expires_at: string; id: string; clinic_id: string; name: string; email: string; role: Role; active: number; totp_enabled: number }
      | undefined;
    if (!row || !row.active) return null;
    if (new Date(row.expires_at) <= this.now()) {
      this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
      return null;
    }
    return {
      user: { id: row.id, clinicId: row.clinic_id, name: row.name, email: row.email, role: row.role },
      mfaOk: !!row.mfa_ok,
      mfaEnabled: !!row.totp_enabled,
    };
  }

  logout(token: string | undefined) {
    if (token) this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }

  // ---------------------------------------------------------------- second factor

  /** Starts enrolment: stores a fresh secret (not yet enabled) and returns it for the authenticator app. */
  beginMfa(token: string): { secret: string; uri: string } {
    const info = this.getSession(token);
    if (!info) throw new DomainError("unauthenticated", "Sign in again");
    if (info.mfaEnabled) throw new DomainError("invalid_state", "Two-step sign-in is already on");
    const secret = generateTotpSecret();
    this.db.prepare("UPDATE users SET totp_secret = ? WHERE id = ?").run(secret, info.user.id);
    return { secret, uri: otpauthUri(secret, info.user.email) };
  }

  /** Re-reads the pending secret so the setup page can be reloaded without changing it. */
  pendingMfa(token: string): { secret: string; uri: string } | null {
    const info = this.getSession(token);
    if (!info || info.mfaEnabled) return null;
    const row = this.db.prepare("SELECT totp_secret FROM users WHERE id = ?").get(info.user.id) as { totp_secret: string | null };
    return row.totp_secret ? { secret: row.totp_secret, uri: otpauthUri(row.totp_secret, info.user.email) } : null;
  }

  /** Checks a code. When enrolling, a correct code turns two-step sign-in on. Marks the session complete. */
  verifyMfa(token: string, code: string): void {
    const info = this.getSession(token);
    if (!info) throw new DomainError("unauthenticated", "Sign in again");
    const user = this.db.prepare("SELECT * FROM users WHERE id = ?").get(info.user.id) as unknown as UserRow;
    if (!user.totp_secret) throw new DomainError("invalid_state", "Set up two-step sign-in first");
    if (user.locked_until && new Date(user.locked_until) > this.now()) {
      throw new DomainError("rate_limited", "Too many failed attempts. Try again in a few minutes.");
    }
    const step = verifyTotp(user.totp_secret, code, this.now(), user.totp_last_step);
    if (step === null) {
      const failed = user.failed_logins + 1;
      const lock = failed >= MAX_FAILED ? new Date(this.now().getTime() + LOCK_MINUTES * 60_000).toISOString() : null;
      this.db.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?").run(lock ? 0 : failed, lock, user.id);
      this.audit(user.clinic_id, user.email, "mfa.failed");
      if (lock) this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
      throw new DomainError("unauthenticated", "That code is not right. Use the current code from your authenticator app.");
    }
    this.db.prepare("UPDATE users SET totp_enabled = 1, totp_last_step = ?, failed_logins = 0 WHERE id = ?").run(step, user.id);
    this.db.prepare("UPDATE sessions SET mfa_ok = 1 WHERE token_hash = ?").run(sha256(token));
    this.audit(user.clinic_id, user.email, user.totp_enabled ? "mfa.ok" : "mfa.enabled");
  }
}
