import { describe, expect, it } from "vitest";
import { Accounts, type SessionUser } from "@/lib/accounts";
import { totpAt, totpStep, verifyPassword, hashPassword, base32Decode, base32Encode, verifyTotp } from "@/lib/crypto";
import { DomainError } from "@/lib/errors";
import { MockProvider } from "@/lib/ai/mock";
import { Service } from "@/lib/service";
import { TRANSCRIPT, newTestDb } from "./helpers";

const PW = "correct horse battery";

async function setup() {
  const t = await newTestDb();
  const db = t.db;
  const clock = { now: new Date("2026-10-12T10:00:00Z") };
  const accounts = new Accounts(db, () => clock.now);
  const { clinicId, userId } = await accounts.bootstrap({ clinicName: "Test Physio", ownerName: "Olive Owner", email: "olive@example.com", password: PW });
  const owner: SessionUser = { id: userId, clinicId, name: "Olive Owner", email: "olive@example.com", role: "owner" };
  return { db, q: t.q, clock, accounts, clinicId, owner };
}

function code(secret: string, now: Date) {
  return totpAt(secret, totpStep(now));
}

describe("crypto", () => {
  it("hashes and verifies passwords, rejecting wrong ones", async () => {
    const h = hashPassword("a-long-enough-password");
    expect(verifyPassword("a-long-enough-password", h)).toBe(true);
    expect(verifyPassword("another-password-here", h)).toBe(false);
    expect(verifyPassword("x", "garbage")).toBe(false);
  });

  it("matches the RFC 6238 SHA-1 test vectors", async () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
    // RFC 6238 appendix B: T = 59 s -> 94287082, last six digits 287082; T = 1111111109 -> 081804
    expect(totpAt(secret, Math.floor(59 / 30))).toBe("287082");
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe("081804");
  });

  it("refuses a reused time step", async () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    const now = new Date(59_000);
    const step = verifyTotp(secret, "287082", now);
    expect(step).toBe(1);
    expect(verifyTotp(secret, "287082", now, step)).toBeNull();
  });
});

describe("accounts (E1.9)", () => {
  it("only bootstraps once", async () => {
    const { accounts } = await setup();
    await expect(accounts.bootstrap({ clinicName: "Other", ownerName: "X", email: "x@example.com", password: PW })).rejects.toThrow(DomainError);
  });

  it("rejects weak passwords and bad emails", async () => {
    const db = (await newTestDb()).db;
    const accounts = new Accounts(db);
    await expect(accounts.bootstrap({ clinicName: "C", ownerName: "N", email: "bad", password: "short" })).rejects.toThrow(/Check the details/);
  });

  it("does not tell a wrong password from an unknown email", async () => {
    const { accounts } = await setup();
    const msg = async (email: string) => { try { await accounts.login(email, "wrong-password-xx"); } catch (e) { return (e as DomainError).message; } };
    const a = await msg("olive@example.com");
    const b = await msg("nobody@example.com");
    expect(a).toBe(b);
  });

  it("locks the account after five failures, then allows sign-in after the lock", async () => {
    const { accounts, clock } = await setup();
    for (let i = 0; i < 5; i++) await expect(accounts.login("olive@example.com", "wrong-password-xx")).rejects.toThrow();
    await expect(accounts.login("olive@example.com", PW)).rejects.toThrow(/Too many/);
    clock.now = new Date(clock.now.getTime() + 16 * 60_000);
    expect((await accounts.login("olive@example.com", PW)).token).toBeTruthy();
  });

  it("needs a second factor before a session counts as complete", async () => {
    const { accounts, clock } = await setup();
    const { token } = await accounts.login("olive@example.com", PW);
    expect((await accounts.getSession(token))?.mfaOk).toBe(false);
    const { secret } = await accounts.beginMfa(token);
    await expect(accounts.verifyMfa(token, "000000")).rejects.toThrow(/not right/);
    await accounts.verifyMfa(token, code(secret, clock.now));
    const s = (await accounts.getSession(token))!;
    expect(s.mfaOk).toBe(true);
    expect(s.mfaEnabled).toBe(true);
  });

  it("asks for the code on every later sign-in and refuses a replayed code", async () => {
    const { accounts, clock } = await setup();
    const first = (await accounts.login("olive@example.com", PW)).token;
    const { secret } = await accounts.beginMfa(first);
    await accounts.verifyMfa(first, code(secret, clock.now));
    clock.now = new Date(clock.now.getTime() + 120_000);
    const second = (await accounts.login("olive@example.com", PW)).token;
    expect((await accounts.getSession(second))?.mfaOk).toBe(false);
    const c = code(secret, clock.now);
    await accounts.verifyMfa(second, c);
    const third = (await accounts.login("olive@example.com", PW)).token;
    await expect(accounts.verifyMfa(third, c)).rejects.toThrow(); // same code, same step
  });

  it("expires sessions after 12 hours", async () => {
    const { accounts, clock } = await setup();
    const { token } = await accounts.login("olive@example.com", PW);
    clock.now = new Date(clock.now.getTime() + 13 * 3_600_000);
    expect(await accounts.getSession(token)).toBeNull();
  });

  it("lets only an owner add staff, and deactivation ends their sessions", async () => {
    const { accounts, owner } = await setup();
    const staffId = await accounts.createUser(owner, { name: "Cleo Clinician", email: "cleo@example.com", password: PW + "1", role: "clinician" });
    const staff: SessionUser = { id: staffId, clinicId: owner.clinicId, name: "Cleo", email: "cleo@example.com", role: "clinician" };
    await expect(accounts.createUser(staff, { name: "X", email: "x@example.com", password: PW, role: "reception" })).rejects.toThrow(/Only the clinic owner/);
    const { token } = await accounts.login("cleo@example.com", PW + "1");
    await accounts.deactivateUser(owner, staffId);
    expect(await accounts.getSession(token)).toBeNull();
    await expect(accounts.login("cleo@example.com", PW + "1")).rejects.toThrow();
  });

  it("cannot deactivate or reset someone in another clinic", async () => {
    const { q, accounts, owner } = await setup();
    const otherClinic = "clinic-b";
    await q.run("INSERT INTO clinics (id, name, slug, created_at) VALUES (?, 'B', 'b', ?)", [otherClinic, new Date().toISOString()]);
    await q.run("INSERT INTO users (id, clinic_id, email, name, role, password_hash, created_at) VALUES ('u-b', ?, 'b@example.com', 'B', 'clinician', 'x', ?)", [otherClinic, new Date().toISOString()]);
    await expect(accounts.deactivateUser(owner, "u-b")).rejects.toThrow(/not found/);
    await expect(accounts.resetPassword(owner, "u-b", PW)).rejects.toThrow(/not found/);
  });
});

describe("clinic separation of consultations", () => {
  it("one clinic cannot read, list or change another clinic's consultation by id", async () => {
    const t = await newTestDb();
    const db = t.db;
    for (const id of ["clinic-a", "clinic-b"]) await t.q.run("INSERT INTO clinics (id, name, slug, created_at) VALUES (?, ?, ?, ?)", [id, id, id, "2026-10-12T00:00:00.000Z"]);
    const mk = (clinicId: string) => new Service({ db, clinicId, provider: new MockProvider(), targets: {} });
    const a = mk("clinic-a");
    const b = mk("clinic-b");
    const id = await a.createConsult({ patientLabel: "A.A.", practitioner: "Sam" }, "sam");
    await a.recordConsent(id, { method: "verbal", by: "Sam" }, "sam");
    await a.saveTranscript(id, TRANSCRIPT, "sam");
    expect(await b.listConsults()).toHaveLength(0);
    await expect(b.getConsult(id)).rejects.toThrow(/not found/i);
    await expect(b.saveTranscript(id, "x", "eve")).rejects.toThrow(/not found/i);
    await expect(b.withdrawConsent(id, "eve")).rejects.toThrow(/not found/i);
    await expect(b.setPmsPatientId(id, "9", "eve")).rejects.toThrow(/not found/i);
    expect((await a.getConsult(id)).transcript).toBe(TRANSCRIPT);
  });
});
