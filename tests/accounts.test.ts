import { describe, expect, it } from "vitest";
import { openDb } from "@/lib/db";
import { Accounts, type SessionUser } from "@/lib/accounts";
import { totpAt, totpStep, verifyPassword, hashPassword, base32Decode, base32Encode, verifyTotp } from "@/lib/crypto";
import { DomainError } from "@/lib/errors";
import { MockProvider } from "@/lib/ai/mock";
import { Service } from "@/lib/service";
import { TRANSCRIPT } from "./helpers";

const PW = "correct horse battery";

function setup() {
  const db = openDb(":memory:");
  const clock = { now: new Date("2026-10-12T10:00:00Z") };
  const accounts = new Accounts(db, () => clock.now);
  const { clinicId, userId } = accounts.bootstrap({ clinicName: "Test Physio", ownerName: "Olive Owner", email: "olive@example.com", password: PW });
  const owner: SessionUser = { id: userId, clinicId, name: "Olive Owner", email: "olive@example.com", role: "owner" };
  return { db, clock, accounts, clinicId, owner };
}

function code(secret: string, now: Date) {
  return totpAt(secret, totpStep(now));
}

describe("crypto", () => {
  it("hashes and verifies passwords, rejecting wrong ones", () => {
    const h = hashPassword("a-long-enough-password");
    expect(verifyPassword("a-long-enough-password", h)).toBe(true);
    expect(verifyPassword("another-password-here", h)).toBe(false);
    expect(verifyPassword("x", "garbage")).toBe(false);
  });

  it("matches the RFC 6238 SHA-1 test vectors", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
    // RFC 6238 appendix B: T = 59 s -> 94287082, last six digits 287082; T = 1111111109 -> 081804
    expect(totpAt(secret, Math.floor(59 / 30))).toBe("287082");
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe("081804");
  });

  it("refuses a reused time step", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    const now = new Date(59_000);
    const step = verifyTotp(secret, "287082", now);
    expect(step).toBe(1);
    expect(verifyTotp(secret, "287082", now, step)).toBeNull();
  });
});

describe("accounts (E1.9)", () => {
  it("only bootstraps once", () => {
    const { accounts } = setup();
    expect(() => accounts.bootstrap({ clinicName: "Other", ownerName: "X", email: "x@example.com", password: PW })).toThrow(DomainError);
  });

  it("rejects weak passwords and bad emails", () => {
    const db = openDb(":memory:");
    const accounts = new Accounts(db);
    expect(() => accounts.bootstrap({ clinicName: "C", ownerName: "N", email: "bad", password: "short" })).toThrow(/Check the details/);
  });

  it("does not tell a wrong password from an unknown email", () => {
    const { accounts } = setup();
    const a = (() => { try { accounts.login("olive@example.com", "wrong-password-xx"); } catch (e) { return (e as DomainError).message; } })();
    const b = (() => { try { accounts.login("nobody@example.com", "wrong-password-xx"); } catch (e) { return (e as DomainError).message; } })();
    expect(a).toBe(b);
  });

  it("locks the account after five failures, then allows sign-in after the lock", () => {
    const { accounts, clock } = setup();
    for (let i = 0; i < 5; i++) expect(() => accounts.login("olive@example.com", "wrong-password-xx")).toThrow();
    expect(() => accounts.login("olive@example.com", PW)).toThrow(/Too many/);
    clock.now = new Date(clock.now.getTime() + 16 * 60_000);
    expect(accounts.login("olive@example.com", PW).token).toBeTruthy();
  });

  it("needs a second factor before a session counts as complete", () => {
    const { accounts, clock } = setup();
    const { token } = accounts.login("olive@example.com", PW);
    expect(accounts.getSession(token)?.mfaOk).toBe(false);
    const { secret } = accounts.beginMfa(token);
    expect(() => accounts.verifyMfa(token, "000000")).toThrow(/not right/);
    accounts.verifyMfa(token, code(secret, clock.now));
    const s = accounts.getSession(token)!;
    expect(s.mfaOk).toBe(true);
    expect(s.mfaEnabled).toBe(true);
  });

  it("asks for the code on every later sign-in and refuses a replayed code", () => {
    const { accounts, clock } = setup();
    const first = accounts.login("olive@example.com", PW).token;
    const { secret } = accounts.beginMfa(first);
    accounts.verifyMfa(first, code(secret, clock.now));
    clock.now = new Date(clock.now.getTime() + 120_000);
    const second = accounts.login("olive@example.com", PW).token;
    expect(accounts.getSession(second)?.mfaOk).toBe(false);
    const c = code(secret, clock.now);
    accounts.verifyMfa(second, c);
    const third = accounts.login("olive@example.com", PW).token;
    expect(() => accounts.verifyMfa(third, c)).toThrow(); // same code, same step
  });

  it("expires sessions after 12 hours", () => {
    const { accounts, clock } = setup();
    const { token } = accounts.login("olive@example.com", PW);
    clock.now = new Date(clock.now.getTime() + 13 * 3_600_000);
    expect(accounts.getSession(token)).toBeNull();
  });

  it("lets only an owner add staff, and deactivation ends their sessions", () => {
    const { accounts, owner } = setup();
    const staffId = accounts.createUser(owner, { name: "Cleo Clinician", email: "cleo@example.com", password: PW + "1", role: "clinician" });
    const staff: SessionUser = { id: staffId, clinicId: owner.clinicId, name: "Cleo", email: "cleo@example.com", role: "clinician" };
    expect(() => accounts.createUser(staff, { name: "X", email: "x@example.com", password: PW, role: "reception" })).toThrow(/Only the clinic owner/);
    const { token } = accounts.login("cleo@example.com", PW + "1");
    accounts.deactivateUser(owner, staffId);
    expect(accounts.getSession(token)).toBeNull();
    expect(() => accounts.login("cleo@example.com", PW + "1")).toThrow();
  });

  it("cannot deactivate or reset someone in another clinic", () => {
    const { db, accounts, owner } = setup();
    const otherClinic = "clinic-b";
    db.prepare("INSERT INTO clinics (id, name, slug, created_at) VALUES (?, 'B', 'b', ?)").run(otherClinic, new Date().toISOString());
    db.prepare("INSERT INTO users (id, clinic_id, email, name, role, password_hash, created_at) VALUES ('u-b', ?, 'b@example.com', 'B', 'clinician', 'x', ?)").run(otherClinic, new Date().toISOString());
    expect(() => accounts.deactivateUser(owner, "u-b")).toThrow(/not found/);
    expect(() => accounts.resetPassword(owner, "u-b", PW)).toThrow(/not found/);
  });
});

describe("clinic separation of consultations", () => {
  it("one clinic cannot read, list or change another clinic's consultation by id", () => {
    const db = openDb(":memory:");
    const mk = (clinicId: string) => new Service({ db, clinicId, provider: new MockProvider(), targets: {} });
    const a = mk("clinic-a");
    const b = mk("clinic-b");
    const id = a.createConsult({ patientLabel: "A.A.", practitioner: "Sam" }, "sam");
    a.recordConsent(id, { method: "verbal", by: "Sam" }, "sam");
    a.saveTranscript(id, TRANSCRIPT, "sam");
    expect(b.listConsults()).toHaveLength(0);
    expect(() => b.getConsult(id)).toThrow(/not found/i);
    expect(() => b.saveTranscript(id, "x", "eve")).toThrow(/not found/i);
    expect(() => b.withdrawConsent(id, "eve")).toThrow(/not found/i);
    expect(() => b.setPmsPatientId(id, "9", "eve")).toThrow(/not found/i);
    expect(a.getConsult(id).transcript).toBe(TRANSCRIPT);
  });
});
