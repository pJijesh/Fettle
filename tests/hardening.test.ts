import { describe, expect, it } from "vitest";
import { Db, createPool } from "@/lib/db";
import { allowOn } from "@/lib/session";
import { describeError, logLine } from "@/lib/log";
import { DomainError } from "@/lib/errors";
import { totpAt, totpStep } from "@/lib/crypto";
import { newTestDb } from "./helpers";
import { platformSetup, PW, type PlatformSetup } from "./platform.helpers";

const MON_9 = "2026-10-19T08:00:00.000Z";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const code = (secret: string, s: PlatformSetup) => totpAt(secret, totpStep(s.clock.now));

/** Signs the owner in and turns two-step sign-in on. Returns the session token and the authenticator secret. */
async function enrolOwner(s: PlatformSetup) {
  const { token } = await s.p.accounts.login("olive@example.com", PW);
  const { secret } = await s.p.accounts.beginMfa(token);
  const r = await s.p.accounts.verifyMfa(token, code(secret, s));
  return { token, secret, enrolled: r.enrolled };
}

function resetTokenFrom(body: string): string {
  return /\/reset\/([A-Za-z0-9_-]+)/.exec(body)![1];
}

describe("shared rate limiter", () => {
  it("allows up to the limit, then refuses, and starts again when the window ends", async () => {
    const t = await newTestDb();
    expect(await allowOn(t.db, "k", 3, 200)).toBe(true);
    expect(await allowOn(t.db, "k", 3, 200)).toBe(true);
    expect(await allowOn(t.db, "k", 3, 200)).toBe(true);
    expect(await allowOn(t.db, "k", 3, 200)).toBe(false);
    expect(await allowOn(t.db, "other", 3, 200)).toBe(true);
    await sleep(300);
    expect(await allowOn(t.db, "k", 3, 200)).toBe(true);
  });

  it("is shared between app processes (separate connection pools) and under concurrent requests", async () => {
    const t = await newTestDb();
    const url = new URL(`postgres://fettle_app:fettle_app@127.0.0.1:54329/${t.name}`);
    const other = new Db(createPool(process.env.TEST_DATABASE_URL ? url.toString().replace("127.0.0.1:54329", new URL(process.env.TEST_DATABASE_URL).host) : url.toString(), 3));
    try {
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => allowOn(i % 2 ? t.db : other, "shared", 4, 60_000)));
      expect(results.filter(Boolean)).toHaveLength(4);
    } finally {
      await other.close();
    }
  });

  it("stores only a hash of the key and is not readable by the application role", async () => {
    const t = await newTestDb();
    await allowOn(t.db, "login:acct:someone@example.com", 5, 60_000);
    const rows = JSON.stringify(await t.q.all("SELECT * FROM rate_limits"));
    expect(rows).not.toContain("someone");
    await expect(t.db.system(() => t.db.all("SELECT * FROM rate_limits"))).rejects.toThrow(/permission denied/);
  });
});

describe("forgotten password", () => {
  it("emails a one-use link, lets the person choose a new password, and signs them out everywhere", async () => {
    const s = await platformSetup();
    const { token: oldSession } = await s.p.accounts.login("olive@example.com", PW);
    await s.p.accounts.requestPasswordReset("Olive@Example.com");
    const mail = (await s.p.outbox.list(s.clinicId)).filter((m) => m.kind === "password_reset");
    expect(mail).toHaveLength(1);
    expect(mail[0].to_addr).toBe("olive@example.com");
    const token = resetTokenFrom(mail[0].body);
    expect(mail[0].body).toContain(`https://clinic.test/reset/${token}`);
    expect(await s.p.accounts.resetLinkValid(token)).toBe(true);

    await s.p.accounts.completePasswordReset(token, "a brand new passphrase");
    await expect(s.p.accounts.login("olive@example.com", PW)).rejects.toThrow(DomainError);
    expect((await s.p.accounts.login("olive@example.com", "a brand new passphrase")).token).toBeTruthy();
    expect(await s.p.accounts.getSession(oldSession)).toBeNull();
    // single use
    expect(await s.p.accounts.resetLinkValid(token)).toBe(false);
    await expect(s.p.accounts.completePasswordReset(token, "yet another passphrase")).rejects.toThrow(/expired or already been used/);
    const audit = await s.q.all<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'password_reset.%' ORDER BY id");
    expect(audit.map((a) => a.action)).toEqual(["password_reset.requested", "password_reset.completed"]);
  });

  it("says nothing about whether an address has an account, and sends nothing for unknown or inactive ones", async () => {
    const s = await platformSetup();
    await expect(s.p.accounts.requestPasswordReset("nobody@example.com")).resolves.toBeUndefined();
    await s.p.accounts.deactivateUser(s.owner, s.secondId);
    await expect(s.p.accounts.requestPasswordReset("sam@example.com")).resolves.toBeUndefined();
    expect((await s.p.outbox.list(s.clinicId)).filter((m) => m.kind === "password_reset")).toHaveLength(0);
  });

  it("refuses a weak new password without using up the link, expires after an hour, and a new request replaces the old link", async () => {
    const s = await platformSetup();
    await s.p.accounts.requestPasswordReset("olive@example.com");
    const first = resetTokenFrom((await s.p.outbox.list(s.clinicId)).find((m) => m.kind === "password_reset")!.body);
    await expect(s.p.accounts.completePasswordReset(first, "short")).rejects.toThrow(DomainError);
    expect(await s.p.accounts.resetLinkValid(first)).toBe(true);

    await s.p.accounts.requestPasswordReset("olive@example.com");
    const mails = (await s.p.outbox.list(s.clinicId)).filter((m) => m.kind === "password_reset");
    expect(mails).toHaveLength(2);
    expect(await s.p.accounts.resetLinkValid(first)).toBe(false);
    const second = mails.map((m) => resetTokenFrom(m.body)).find((t) => t !== first)!;
    expect(await s.p.accounts.resetLinkValid(second)).toBe(true);
    s.clock.now = new Date(s.clock.now.getTime() + 61 * 60_000);
    expect(await s.p.accounts.resetLinkValid(second)).toBe(false);
    await expect(s.p.accounts.completePasswordReset(second, "a perfectly fine passphrase")).rejects.toThrow(/expired/);
  });

  it("clears a lock-out but does not bypass the second factor", async () => {
    const s = await platformSetup();
    await enrolOwner(s);
    for (let i = 0; i < 5; i++) await expect(s.p.accounts.login("olive@example.com", "wrong-password-xx")).rejects.toThrow();
    await s.p.accounts.requestPasswordReset("olive@example.com");
    const token = resetTokenFrom((await s.p.outbox.list(s.clinicId)).find((m) => m.kind === "password_reset")!.body);
    await s.p.accounts.completePasswordReset(token, "a brand new passphrase");
    const { token: session } = await s.p.accounts.login("olive@example.com", "a brand new passphrase");
    expect((await s.p.accounts.getSession(session))!.mfaOk).toBe(false);
  });

  it("an unknown reset token resolves to no clinic and cannot be used", async () => {
    const s = await platformSetup();
    expect(await s.p.accounts.resetLinkValid("nope")).toBe(false);
    await expect(s.p.accounts.completePasswordReset("nope", "a perfectly fine passphrase")).rejects.toThrow(DomainError);
  });
});

describe("authenticator recovery codes", () => {
  it("makes ten single-use codes, shown once and stored only as hashes, and a code stands in for the authenticator", async () => {
    const s = await platformSetup();
    const { token, enrolled } = await enrolOwner(s);
    expect(enrolled).toBe(true);
    const codes = await s.p.accounts.newRecoveryCodes(token);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes.every((c) => /^[a-z0-9]{5}-[a-z0-9]{5}$/.test(c))).toBe(true);
    expect(JSON.stringify(await s.q.all("SELECT * FROM mfa_recovery_codes"))).not.toContain(codes[0].replace("-", ""));
    expect(await s.p.accounts.recoveryCodesLeft(token)).toBe(10);

    const { token: next } = await s.p.accounts.login("olive@example.com", PW);
    expect((await s.p.accounts.getSession(next))!.mfaOk).toBe(false);
    const r = await s.p.accounts.verifyMfa(next, codes[0].toUpperCase());
    expect(r.enrolled).toBe(false);
    expect((await s.p.accounts.getSession(next))!.mfaOk).toBe(true);
    expect(await s.p.accounts.recoveryCodesLeft(next)).toBe(9);

    // used once only
    const { token: again } = await s.p.accounts.login("olive@example.com", PW);
    await expect(s.p.accounts.verifyMfa(again, codes[0])).rejects.toThrow(/not right/);
    await s.p.accounts.verifyMfa(again, codes[1].replace("-", ""));
    expect((await s.p.accounts.getSession(again))!.mfaOk).toBe(true);
  });

  it("making new codes replaces the old ones", async () => {
    const s = await platformSetup();
    const { token } = await enrolOwner(s);
    const old = await s.p.accounts.newRecoveryCodes(token);
    const fresh = await s.p.accounts.newRecoveryCodes(token);
    const { token: next } = await s.p.accounts.login("olive@example.com", PW);
    await expect(s.p.accounts.verifyMfa(next, old[0])).rejects.toThrow(DomainError);
    await s.p.accounts.verifyMfa(next, fresh[0]);
    expect((await s.p.accounts.getSession(next))!.mfaOk).toBe(true);
  });

  it("wrong recovery codes count towards the lock-out like wrong authenticator codes", async () => {
    const s = await platformSetup();
    const { token } = await enrolOwner(s);
    await s.p.accounts.newRecoveryCodes(token);
    const { token: next } = await s.p.accounts.login("olive@example.com", PW);
    for (let i = 0; i < 5; i++) await expect(s.p.accounts.verifyMfa(next, "aaaaa-bbbbb")).rejects.toThrow();
    await expect(s.p.accounts.login("olive@example.com", PW)).rejects.toThrow(/failed attempts/i);
  });

  it("only works for someone already signed in with two steps, and never before enrolment", async () => {
    const s = await platformSetup();
    const { token } = await s.p.accounts.login("olive@example.com", PW);
    await expect(s.p.accounts.newRecoveryCodes(token)).rejects.toThrow(DomainError);
    await expect(s.p.accounts.newRecoveryCodes("nonsense")).rejects.toThrow(DomainError);
  });
});

describe("owner reset of two-step sign-in", () => {
  it("lets an owner reset a colleague, who then enrols again; refuses others, self and other clinics", async () => {
    const s = await platformSetup();
    const sam = await s.p.accounts.login("sam@example.com", PW);
    const { secret } = await s.p.accounts.beginMfa(sam.token);
    await s.p.accounts.verifyMfa(sam.token, code(secret, s));
    await s.p.accounts.newRecoveryCodes(sam.token);

    const samUser = { id: s.secondId, clinicId: s.clinicId, name: "Sam Clinician", email: "sam@example.com", role: "clinician" as const };
    await expect(s.p.accounts.resetMfa(samUser, s.owner.id)).rejects.toThrow(/Only the clinic owner/);
    await expect(s.p.accounts.resetMfa(s.owner, s.owner.id)).rejects.toThrow(/another owner/);
    await expect(s.p.accounts.resetMfa(s.owner, "no-such-user")).rejects.toThrow(/not found/);

    await s.p.accounts.resetMfa(s.owner, s.secondId);
    expect(await s.p.accounts.getSession(sam.token)).toBeNull();
    expect(await s.q.get("SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = ?", [s.secondId])).toEqual({ n: 0 });
    const again = await s.p.accounts.login("sam@example.com", PW);
    expect((await s.p.accounts.getSession(again.token))!.mfaEnabled).toBe(false);
  });
});

describe("reports", () => {
  it("counts appointments, no-shows, cancellations, sources and utilisation in the clinic's own time", async () => {
    const s = await platformSetup();
    const mk = (startAt: string, typeId: string) => s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId, startAt, source: "staff" });
    const a1 = await mk(MON_9, s.initial.id); // 45 min
    const a2 = await mk("2026-10-19T09:00:00.000Z", s.followUp.id);
    const a3 = await mk("2026-10-19T10:00:00.000Z", s.followUp.id);
    await mk("2026-10-19T14:00:00.000Z", s.followUp.id); // still to come
    await s.p.scheduling.cancelAppointment(s.clinicId, "u", a3, "Patient unwell");
    s.clock.now = new Date("2026-10-19T12:00:00Z");
    await s.p.scheduling.markArrived(s.clinicId, "u", a1, "walk-in");
    await s.p.scheduling.markCompleted(s.clinicId, "u", a1);
    await s.p.scheduling.markNoShow(s.clinicId, "u", a2);

    const r = await s.p.reports.range(s.clinicId, "2026-10-19", "2026-10-19");
    expect(r).toMatchObject({ total: 4, seen: 1, noShows: 1, cancelled: 1, upcoming: 1, noShowRate: 0.5, cancellationRate: 0.25, timezone: "Europe/London" });
    expect(r.bySource).toEqual([{ source: "staff", count: 3 }]); // cancelled one excluded
    expect(r.byType).toEqual([{ type: "Follow-up", count: 2 }, { type: "Initial assessment", count: 1 }]);
    const olive = r.byClinician.find((c) => c.userId === s.owner.id)!;
    expect(olive).toMatchObject({ seen: 1, noShows: 1, cancelled: 1, bookedMinutes: 45 + 30, availableMinutes: 480 });
    expect(olive.utilisation).toBeCloseTo(75 / 480);
    const sam = r.byClinician.find((c) => c.userId === s.secondId)!;
    expect(sam).toMatchObject({ bookedMinutes: 0, availableMinutes: 480, utilisation: 0 });
  });

  it("uses the clinic's day, not UTC: an appointment at 23:30 UTC on 19 October is on the 20th in London", async () => {
    const s = await platformSetup();
    await s.q.run("UPDATE clinician_hours SET start_min = 0, end_min = 1440 WHERE user_id = ?", [s.owner.id]);
    await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.followUp.id, startAt: "2026-10-19T23:30:00.000Z", source: "staff" });
    expect((await s.p.reports.range(s.clinicId, "2026-10-19", "2026-10-19")).total).toBe(0);
    expect((await s.p.reports.range(s.clinicId, "2026-10-20", "2026-10-20")).total).toBe(1);
  });

  it("rejects bad ranges, and another clinic's appointments never appear", async () => {
    const s = await platformSetup();
    await expect(s.p.reports.range(s.clinicId, "2026-10-20", "2026-10-19")).rejects.toThrow(DomainError);
    await expect(s.p.reports.range(s.clinicId, "2025-01-01", "2026-10-19")).rejects.toThrow(/a year or less/);
    await expect(s.p.reports.range(s.clinicId, "nope", "2026-10-19")).rejects.toThrow(DomainError);
    await s.q.run("INSERT INTO clinics (id, name, slug, created_at) VALUES ('clinic-z', 'Z', 'z', ?)", ["2026-10-12T00:00:00.000Z"]);
    expect((await s.p.reports.range("clinic-z", "2026-10-01", "2026-10-31")).total).toBe(0);
    const def = await s.p.reports.defaultRange(s.clinicId);
    expect(def).toEqual({ from: "2026-09-15", to: "2026-10-12" });
  });
});

describe("safe error logging", () => {
  it("never repeats a database error's message, which can quote patient data", () => {
    const pgErr = Object.assign(new Error('invalid input syntax for type date: "1980-02-30 Jane Doe"'), { code: "22007", severity: "ERROR", table: "patients" });
    const text = describeError(pgErr);
    expect(text).toContain("22007");
    expect(text).not.toContain("Jane");
    const plain = describeError(new Error("Failed for Jane Doe"));
    expect(plain).not.toContain("Jane");
    expect(plain.startsWith("Error")).toBe(true);
  });
});

describe("structured logging", () => {
  it("writes one parseable JSON object per line with the fields given", () => {
    const lines: string[] = [];
    logLine("info", "tick", { sent: 2, purged: 0 }, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    const o = JSON.parse(lines[0]);
    expect(o).toMatchObject({ level: "info", event: "tick", sent: 2, purged: 0 });
    expect(new Date(o.time).getTime()).not.toBeNaN();
    expect(lines[0]).not.toContain("\n");
  });
});
