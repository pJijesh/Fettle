import crypto from "node:crypto";
import { Fail, clinicOf, isUniqueViolation, type Db } from "./db";
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
const RESET_MINUTES = 60;
const RECOVERY_CODE_COUNT = 10;
const BAD_RESET = "This reset link has expired or already been used. Ask for a new one.";
const RECOVERY_SHAPE = /^[a-z0-9]{5}-?[a-z0-9]{5}$/;
// No 0/o/1/l/i, so a code read from paper is hard to get wrong.
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export interface ResetMail {
  clinicId: string;
  to: string;
  name: string;
  token: string;
}

function newRecoveryCode(): string {
  const bytes = crypto.randomBytes(10);
  const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join("");
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

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

  private resetHook?: (m: ResetMail) => Promise<void>;

  /** Called inside the transaction that records a reset request, so the request and its email are saved together. */
  setResetHook(fn: (m: ResetMail) => Promise<void>) {
    this.resetHook = fn;
  }

  private async audit(clinicId: string, actor: string, action: string, detail?: unknown) {
    await this.db.run("INSERT INTO audit_log (clinic_id, actor, action, detail, at, entity) VALUES (?, ?, ?, ?, ?, 'account')", [
      clinicId, actor, action, detail === undefined ? null : JSON.stringify(detail), this.ts(),
    ]);
  }

  /** True until the first clinic and owner have been created. */
  async hasUsers(): Promise<boolean> {
    return this.db.system(async () => !(await this.db.get<{ n: boolean }>("SELECT setup_needed() AS n"))?.n);
  }

  /** First-run only: creates the first clinic and its owner. Refused once any user exists. */
  async bootstrap(input: { clinicName: string; ownerName: string; email: string; password: string }): Promise<{ clinicId: string; userId: string }> {
    if (await this.hasUsers()) throw new DomainError("invalid_state", "Setup has already been done");
    const issues = this.userIssues({ name: input.ownerName, email: input.email, password: input.password });
    if (!input.clinicName.trim()) issues.push({ path: "clinicName", message: "Enter the clinic's name" });
    if (issues.length) throw new DomainError("validation", "Check the details", issues);
    const clinicId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const slug = slugify(input.clinicName) || "clinic";
    try {
      await this.db.system(() =>
        this.db.run("SELECT bootstrap_clinic(?, ?, ?, 'Europe/London', ?, ?, ?, ?, ?)", [
          clinicId, input.clinicName.trim(), slug, userId, input.email.trim(), input.ownerName.trim(), hashPassword(input.password), this.ts(),
        ]),
      );
    } catch (err) {
      if (String(err).includes("setup_done")) throw new DomainError("invalid_state", "Setup has already been done");
      throw err;
    }
    await this.db.scope(clinicId, () => this.audit(clinicId, input.email, "clinic.bootstrapped"));
    return { clinicId, userId };
  }

  private userIssues(u: { name: string; email: string; password: string }) {
    const issues: { path: string; message: string }[] = [];
    if (!u.name.trim()) issues.push({ path: "name", message: "Enter a name" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.email.trim())) issues.push({ path: "email", message: "Enter a valid email address" });
    const pw = passwordProblem(u.password, u.email.trim());
    if (pw) issues.push({ path: "password", message: pw });
    return issues;
  }

  private async insertUser(clinicId: string, u: { name: string; email: string; password: string; role: Role }): Promise<string> {
    const id = crypto.randomUUID();
    try {
      await this.db.attempt(() =>
        this.db.run("INSERT INTO users (id, clinic_id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
          id, clinicId, u.email.trim().toLowerCase(), u.name.trim(), u.role, hashPassword(u.password), this.ts(),
        ]),
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new DomainError("validation", "That email already has an account", [{ path: "email", message: "Already in use" }]);
      throw err;
    }
    return id;
  }

  async createUser(actor: SessionUser, input: { name: string; email: string; password: string; role: Role }): Promise<string> {
    if (actor.role !== "owner") throw new DomainError("forbidden", "Only the clinic owner can add staff");
    if (!["owner", "clinician", "reception"].includes(input.role)) throw new DomainError("validation", "Choose a role");
    const issues = this.userIssues(input);
    if (issues.length) throw new DomainError("validation", "Check the details", issues);
    return this.db.scope(actor.clinicId, async () => {
      const id = await this.insertUser(actor.clinicId, input);
      await this.audit(actor.clinicId, actor.email, "user.created", { userId: id, role: input.role });
      return id;
    });
  }

  listUsers(clinicId: string) {
    return this.db.scope(clinicId, async () =>
      (
        await this.db.all<{ id: string; name: string; email: string; role: Role; active: number; totp_enabled: number }>(
          "SELECT id, name, email, role, active, totp_enabled FROM users WHERE clinic_id = ? ORDER BY name",
          [clinicId],
        )
      ).map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: !!u.active, mfa: !!u.totp_enabled })),
    );
  }

  async deactivateUser(actor: SessionUser, userId: string): Promise<void> {
    if (actor.role !== "owner") throw new DomainError("forbidden", "Only the clinic owner can change staff");
    if (userId === actor.id) throw new DomainError("invalid_state", "You cannot deactivate your own account");
    return this.db.scope(actor.clinicId, async () => {
      const n = await this.db.run("UPDATE users SET active = 0 WHERE id = ? AND clinic_id = ?", [userId, actor.clinicId]);
      if (!n) throw new DomainError("not_found", "Staff member not found");
      await this.db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
      await this.audit(actor.clinicId, actor.email, "user.deactivated", { userId });
    });
  }

  async resetPassword(actor: SessionUser, userId: string, password: string): Promise<void> {
    if (actor.role !== "owner") throw new DomainError("forbidden", "Only the clinic owner can reset passwords");
    return this.db.scope(actor.clinicId, async () => {
      const target = await this.db.get<{ email: string }>("SELECT email FROM users WHERE id = ? AND clinic_id = ?", [userId, actor.clinicId]);
      if (!target) throw new DomainError("not_found", "Staff member not found");
      const problem = passwordProblem(password, target.email);
      if (problem) throw new DomainError("validation", problem, [{ path: "password", message: problem }]);
      await this.db.run("UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?", [hashPassword(password), userId]);
      await this.db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
      await this.audit(actor.clinicId, actor.email, "user.password_reset", { userId });
    });
  }

  // ---------------------------------------------------------------- sign-in

  /** Checks email and password. Returns a session token that still needs its second factor. */
  async login(email: string, password: string): Promise<{ token: string }> {
    const found = await this.db.system(() => this.db.get<UserRow>("SELECT * FROM auth_user_by_email(?)", [email.trim().toLowerCase()]));
    if (!found) {
      verifyPassword(password, DUMMY_HASH);
      throw new DomainError("unauthenticated", BAD_LOGIN);
    }
    // Failed attempts must stay counted, so refusals are returned (and committed) rather than thrown from inside.
    return this.db.scopeOrFail(found.clinic_id, async () => {
      const row = (await this.db.get<UserRow>("SELECT * FROM users WHERE id = ? FOR UPDATE", [found.id]))!;
      const now = this.now();

      if (row.locked_until && new Date(row.locked_until) > now) {
        verifyPassword(password, DUMMY_HASH);
        await this.audit(row.clinic_id, row.email, "login.locked");
        return new Fail(new DomainError("rate_limited", "Too many failed attempts. Try again in a few minutes."));
      }
      const ok = verifyPassword(password, row.password_hash) && !!row.active;
      if (!ok) {
        const failed = row.failed_logins + 1;
        const lock = failed >= MAX_FAILED ? new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString() : null;
        await this.db.run("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?", [lock ? 0 : failed, lock, row.id]);
        await this.audit(row.clinic_id, row.email, "login.failed");
        return new Fail(new DomainError("unauthenticated", BAD_LOGIN));
      }
      await this.db.run("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?", [row.id]);
      const token = await this.newSession(row.id, row.clinic_id);
      await this.audit(row.clinic_id, row.email, "login.password_ok");
      return { token };
    });
  }

  private async newSession(userId: string, clinicId: string): Promise<string> {
    const token = randomToken(32);
    const exp = new Date(this.now().getTime() + SESSION_HOURS * 3_600_000).toISOString();
    await this.db.run("INSERT INTO sessions (token_hash, user_id, clinic_id, created_at, expires_at, mfa_ok) VALUES (?, ?, ?, ?, ?, 0)", [sha256(token), userId, clinicId, this.ts(), exp]);
    return token;
  }

  async getSession(token: string | undefined): Promise<SessionInfo | null> {
    if (!token || token.length > 128) return null;
    const hash = sha256(token);
    const row = await this.db.system(() =>
      this.db.get<{ mfa_ok: number; expires_at: string; id: string; clinic_id: string; name: string; email: string; role: Role; active: number; totp_enabled: number }>(
        "SELECT * FROM auth_session(?)",
        [hash],
      ),
    );
    if (!row || !row.active) return null;
    if (new Date(row.expires_at) <= this.now()) {
      await this.db.scope(row.clinic_id, async () => void (await this.db.run("DELETE FROM sessions WHERE token_hash = ?", [hash])));
      return null;
    }
    return {
      user: { id: row.id, clinicId: row.clinic_id, name: row.name, email: row.email, role: row.role },
      mfaOk: !!row.mfa_ok,
      mfaEnabled: !!row.totp_enabled,
    };
  }

  async logout(token: string | undefined): Promise<void> {
    const info = await this.getSession(token);
    if (!token || !info) return;
    await this.db.scope(info.user.clinicId, async () => void (await this.db.run("DELETE FROM sessions WHERE token_hash = ?", [sha256(token)])));
  }

  // ---------------------------------------------------------------- second factor

  /** Starts enrolment: stores a fresh secret (not yet enabled) and returns it for the authenticator app. */
  async beginMfa(token: string): Promise<{ secret: string; uri: string }> {
    const info = await this.getSession(token);
    if (!info) throw new DomainError("unauthenticated", "Sign in again");
    if (info.mfaEnabled) throw new DomainError("invalid_state", "Two-step sign-in is already on");
    const secret = generateTotpSecret();
    await this.db.scope(info.user.clinicId, async () => void (await this.db.run("UPDATE users SET totp_secret = ? WHERE id = ?", [secret, info.user.id])));
    return { secret, uri: otpauthUri(secret, info.user.email) };
  }

  /** Re-reads the pending secret so the setup page can be reloaded without changing it. */
  async pendingMfa(token: string): Promise<{ secret: string; uri: string } | null> {
    const info = await this.getSession(token);
    if (!info || info.mfaEnabled) return null;
    const row = await this.db.scope(info.user.clinicId, () => this.db.get<{ totp_secret: string | null }>("SELECT totp_secret FROM users WHERE id = ?", [info.user.id]));
    return row?.totp_secret ? { secret: row.totp_secret, uri: otpauthUri(row.totp_secret, info.user.email) } : null;
  }

  /** Checks a code. When enrolling, a correct code turns two-step sign-in on. Marks the session complete. */
  async verifyMfa(token: string, code: string): Promise<{ enrolled: boolean }> {
    const info = await this.getSession(token);
    if (!info) throw new DomainError("unauthenticated", "Sign in again");
    // A wrong code must stay counted towards the lock-out, so refusals are returned (and committed), not thrown from inside.
    await this.db.scopeOrFail<true>(info.user.clinicId, async () => {
      const user = (await this.db.get<UserRow>("SELECT * FROM users WHERE id = ? FOR UPDATE", [info.user.id]))!;
      if (!user.totp_secret) return new Fail(new DomainError("invalid_state", "Set up two-step sign-in first"));
      if (user.locked_until && new Date(user.locked_until) > this.now()) {
        return new Fail(new DomainError("rate_limited", "Too many failed attempts. Try again in a few minutes."));
      }
      const wanted = code.trim().toLowerCase();
      let recovered = false;
      if (user.totp_enabled && RECOVERY_SHAPE.test(wanted)) {
        const n = await this.db.run("UPDATE mfa_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL", [this.ts(), user.id, sha256(wanted.replace("-", ""))]);
        recovered = n === 1;
      }
      const step = recovered ? null : verifyTotp(user.totp_secret, code, this.now(), user.totp_last_step === null ? null : Number(user.totp_last_step));
      if (!recovered && step === null) {
        const failed = user.failed_logins + 1;
        const lock = failed >= MAX_FAILED ? new Date(this.now().getTime() + LOCK_MINUTES * 60_000).toISOString() : null;
        await this.db.run("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?", [lock ? 0 : failed, lock, user.id]);
        await this.audit(user.clinic_id, user.email, "mfa.failed");
        if (lock) await this.db.run("DELETE FROM sessions WHERE user_id = ?", [user.id]);
        return new Fail(new DomainError("unauthenticated", "That code is not right. Use the current code from your authenticator app, or a recovery code."));
      }
      if (recovered) {
        await this.db.run("UPDATE users SET failed_logins = 0 WHERE id = ?", [user.id]);
        await this.db.run("UPDATE sessions SET mfa_ok = 1 WHERE token_hash = ?", [sha256(token)]);
        await this.audit(user.clinic_id, user.email, "mfa.recovery_used");
        return true;
      }
      await this.db.run("UPDATE users SET totp_enabled = 1, totp_last_step = ?, failed_logins = 0 WHERE id = ?", [step, user.id]);
      await this.db.run("UPDATE sessions SET mfa_ok = 1 WHERE token_hash = ?", [sha256(token)]);
      await this.audit(user.clinic_id, user.email, user.totp_enabled ? "mfa.ok" : "mfa.enabled");
      return true;
    });
    return { enrolled: !info.mfaEnabled };
  }

  /** Owner only: a member of staff has lost their authenticator and has no recovery codes. They enrol again at next sign-in. */
  async resetMfa(actor: SessionUser, userId: string): Promise<void> {
    if (actor.role !== "owner") throw new DomainError("forbidden", "Only the clinic owner can reset two-step sign-in");
    if (userId === actor.id) throw new DomainError("invalid_state", "Ask another owner to reset your own two-step sign-in");
    return this.db.scope(actor.clinicId, async () => {
      const n = await this.db.run("UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = NULL, failed_logins = 0, locked_until = NULL WHERE id = ? AND clinic_id = ?", [userId, actor.clinicId]);
      if (!n) throw new DomainError("not_found", "Staff member not found");
      await this.db.run("DELETE FROM mfa_recovery_codes WHERE user_id = ?", [userId]);
      await this.db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
      await this.audit(actor.clinicId, actor.email, "user.mfa_reset", { userId });
    });
  }

  // ---------------------------------------------------------------- recovery codes

  /** Replaces any codes the signed-in person has with ten new single-use ones. They are shown once and stored only as hashes. */
  async newRecoveryCodes(token: string): Promise<string[]> {
    const info = await this.getSession(token);
    if (!info || !info.mfaOk) throw new DomainError("unauthenticated", "Sign in again");
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    await this.db.scope(info.user.clinicId, async () => {
      await this.db.run("DELETE FROM mfa_recovery_codes WHERE user_id = ?", [info.user.id]);
      for (const c of codes) {
        await this.db.run("INSERT INTO mfa_recovery_codes (id, clinic_id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?, ?)", [
          crypto.randomUUID(), info.user.clinicId, info.user.id, sha256(c.replace("-", "")), this.ts(),
        ]);
      }
      await this.audit(info.user.clinicId, info.user.email, "mfa.recovery_codes_created");
    });
    return codes;
  }

  async recoveryCodesLeft(token: string): Promise<number> {
    const info = await this.getSession(token);
    if (!info) return 0;
    return this.db.scope(info.user.clinicId, async () => Number((await this.db.get<{ n: number }>("SELECT count(*) AS n FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL", [info.user.id]))?.n ?? 0));
  }

  // ---------------------------------------------------------------- forgotten password

  /**
   * Starts a reset for an email address. Says nothing about whether the address has an account: it returns the same
   * way either way, and only a real, active account gets a link (by email, valid for an hour, usable once).
   */
  async requestPasswordReset(email: string): Promise<void> {
    const found = await this.db.system(() => this.db.get<UserRow>("SELECT * FROM auth_user_by_email(?)", [email.trim().toLowerCase()]));
    if (!found || !found.active) return;
    await this.db.scope(found.clinic_id, async () => {
      await this.db.run("DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL", [found.id]);
      const token = randomToken(32);
      const expires = new Date(this.now().getTime() + RESET_MINUTES * 60_000).toISOString();
      await this.db.run("INSERT INTO password_resets (id, clinic_id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", [
        crypto.randomUUID(), found.clinic_id, found.id, sha256(token), this.ts(), expires,
      ]);
      await this.audit(found.clinic_id, found.email, "password_reset.requested");
      await this.resetHook?.({ clinicId: found.clinic_id, to: found.email, name: found.name, token });
    });
  }

  /** True while a reset link can still be used (so the page can say so before asking for a new password). */
  async resetLinkValid(token: string): Promise<boolean> {
    if (!token || token.length > 128) return false;
    const hash = sha256(token);
    const clinicId = await clinicOf(this.db, "password_reset", hash);
    if (!clinicId) return false;
    return this.db.scope(clinicId, async () => {
      const r = await this.db.get<{ used_at: string | null; expires_at: string }>("SELECT used_at, expires_at FROM password_resets WHERE token_hash = ?", [hash]);
      return !!r && !r.used_at && new Date(r.expires_at) > this.now();
    });
  }

  /** Sets a new password from a reset link. Signs the person out everywhere and clears any lock. Their second factor still applies. */
  async completePasswordReset(token: string, password: string): Promise<void> {
    if (!token || token.length > 128) throw new DomainError("invalid_state", BAD_RESET);
    const hash = sha256(token);
    const clinicId = await clinicOf(this.db, "password_reset", hash);
    if (!clinicId) throw new DomainError("invalid_state", BAD_RESET);
    await this.db.scope(clinicId, async () => {
      const r = await this.db.get<{ id: string; user_id: string; used_at: string | null; expires_at: string }>("SELECT id, user_id, used_at, expires_at FROM password_resets WHERE token_hash = ? FOR UPDATE", [hash]);
      if (!r || r.used_at || new Date(r.expires_at) <= this.now()) throw new DomainError("invalid_state", BAD_RESET);
      const user = (await this.db.get<{ email: string; active: number }>("SELECT email, active FROM users WHERE id = ?", [r.user_id]))!;
      if (!user.active) throw new DomainError("invalid_state", BAD_RESET);
      // A weak password is refused before the link is used up, so the person can try again.
      const problem = passwordProblem(password, user.email);
      if (problem) throw new DomainError("validation", problem, [{ path: "password", message: problem }]);
      await this.db.run("UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?", [hashPassword(password), r.user_id]);
      await this.db.run("UPDATE password_resets SET used_at = ? WHERE id = ?", [this.ts(), r.id]);
      await this.db.run("DELETE FROM sessions WHERE user_id = ?", [r.user_id]);
      await this.audit(clinicId, user.email, "password_reset.completed");
    });
  }
}
