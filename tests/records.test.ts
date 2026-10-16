import { describe, expect, it } from "vitest";
import { platformSetup, PW, type PlatformSetup } from "./platform.helpers";
import { TRANSCRIPT } from "./helpers";
import { Service } from "@/lib/service";
import { MockProvider } from "@/lib/ai/mock";
import { retainUntil } from "@/lib/records";
import type { SessionUser } from "@/lib/accounts";

const MON_9 = "2026-10-19T08:00:00.000Z";

async function consultFor(s: PlatformSetup, approve = true) {
  const svc = new Service({ db: s.db, clinicId: s.clinicId, provider: new MockProvider(), targets: {}, now: () => s.clock.now });
  const id = await svc.createConsult({ patientLabel: "P.J.", practitioner: "Olive Owner", patientId: s.patient }, "olive");
  await svc.recordConsent(id, { method: "verbal", by: "Olive Owner" }, "olive");
  await svc.saveTranscript(id, TRANSCRIPT, "olive");
  await svc.generateDrafts(id, "olive");
  const v = await svc.getConsult(id);
  await svc.saveDrafts(id, { note: { ...v.note, redFlags: { ...v.note.redFlags, screened: true } }, programme: v.programme }, "olive");
  if (approve) await svc.approve(id, "Olive Owner");
  return { svc, id };
}

async function withHistory(s: PlatformSetup) {
  const appt = await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
  await s.p.scheduling.markCompleted(s.clinicId, "u", appt);
  const c = await consultFor(s);
  const inv = await s.p.billing.createInvoice(s.owner, { patientId: s.patient, lines: [{ description: "Assessment", quantity: 1, unitPence: 6000 }] });
  await s.p.billing.recordPayment(s.owner, inv, { amountPence: 2000, method: "cash" });
  return { appt, ...c, inv };
}

async function asRole(s: PlatformSetup, role: "reception" | "clinician"): Promise<SessionUser> {
  const email = `${role}@example.com`;
  const id = await s.p.accounts.createUser(s.owner, { name: role, email, password: PW, role });
  return { id, clinicId: s.clinicId, name: role, email, role };
}

const YEARS = (n: number, from: string) => new Date(new Date(from).getTime() + n * 366 * 86400000);

describe("retention dates", () => {
  const d = (x: string) => new Date(`${x}T12:00:00Z`);
  it("is the retention period after the last activity for an adult", () => {
    expect(retainUntil(d("2026-03-10"), "1980-05-04", 8).toISOString().slice(0, 10)).toBe("2034-03-10");
    expect(retainUntil(d("2024-02-29"), null, 1).toISOString().slice(0, 10)).toBe("2025-02-28");
  });
  it("keeps a child's record until their 25th birthday if that is later", () => {
    expect(retainUntil(d("2026-03-10"), "2016-06-01", 8).toISOString().slice(0, 10)).toBe("2041-06-01");
    // A child at the last visit, but the ordinary period already runs past the 25th birthday.
    expect(retainUntil(d("2026-03-10"), "2008-12-01", 8).toISOString().slice(0, 10)).toBe("2034-03-10");
    // Adult at the last visit: the ordinary period.
    expect(retainUntil(d("2026-03-10"), "2000-01-01", 8).toISOString().slice(0, 10)).toBe("2034-03-10");
  });
});

describe("retention setting", () => {
  it("defaults to eight years, is owner only and is limited to 1 to 30", async () => {
    const s = await platformSetup();
    expect(await s.p.records.getRetentionYears(s.clinicId)).toBe(8);
    await expect(s.p.records.setRetentionYears(await asRole(s, "reception"), 10)).rejects.toThrow(/owner/);
    await expect(s.p.records.setRetentionYears(s.owner, 0)).rejects.toThrow();
    await expect(s.p.records.setRetentionYears(s.owner, 31)).rejects.toThrow();
    await expect(s.p.records.setRetentionYears(s.owner, 7.5)).rejects.toThrow();
    await s.p.records.setRetentionYears(s.owner, 10);
    expect(await s.p.records.getRetentionYears(s.clinicId)).toBe(10);
  });
});

describe("patient export", () => {
  it("gives the owner everything held about the patient, and records that it happened", async () => {
    const s = await platformSetup();
    const h = await withHistory(s);
    await s.p.scheduling.getPatient(s.clinicId, s.patient); // a plain read
    const out = (await s.p.records.exportPatient(s.owner, s.patient)) as any;
    expect(out.patient).toMatchObject({ firstName: "Pat", lastName: "Jones", email: "pat@example.com", dateOfBirth: "1980-05-04" });
    expect(out.appointments).toHaveLength(1);
    expect(out.appointments[0]).toMatchObject({ id: h.appt, status: "completed", type: "Initial assessment" });
    expect(out.consultations).toHaveLength(1);
    expect(out.consultations[0].approved.hash).toMatch(/^[0-9a-f]{16,}$/);
    expect(out.consultations[0].approved.record).toBeTruthy();
    expect(out.consultations[0].transcript).toContain("knee");
    expect(out.invoices).toHaveLength(1);
    expect(out.invoices[0].lines[0].description).toBe("Assessment");
    expect(out.invoices[0].payments[0]).toMatchObject({ amountPence: 2000, method: "cash" });
    expect(out.messages.length).toBeGreaterThan(0); // the booking confirmation
    const log = await s.q.all<{ action: string }>("SELECT action FROM audit_log WHERE action = 'patient.exported'");
    expect(log).toHaveLength(1);
  });

  it("labels an unapproved consultation as a draft", async () => {
    const s = await platformSetup();
    await consultFor(s, false);
    const out = (await s.p.records.exportPatient(s.owner, s.patient)) as any;
    expect(out.consultations[0].approved).toBeNull();
    expect(out.consultations[0].draft.record).toBeTruthy();
  });

  it("is refused for reception and clinicians, and for another clinic's patient", async () => {
    const s = await platformSetup();
    await expect(s.p.records.exportPatient(await asRole(s, "reception"), s.patient)).rejects.toThrow(/owner/);
    await expect(s.p.records.exportPatient(await asRole(s, "clinician"), s.patient)).rejects.toThrow(/owner/);
    await expect(s.p.records.exportPatient(s.owner, "no-such-patient")).rejects.toThrow(/not found/i);
  });
});

describe("anonymise", () => {
  it("is refused before the retention period ends unless the owner overrides with a reason", async () => {
    const s = await platformSetup();
    await withHistory(s);
    s.clock.now = new Date("2026-11-30T10:00:00Z"); // appointment is in the past
    await expect(s.p.records.anonymise(s.owner, s.patient)).rejects.toThrow(/kept until 2034/);
    await expect(s.p.records.anonymise(s.owner, s.patient, { override: true, reason: "short" })).rejects.toThrow(/Say why/);
    expect((await s.p.scheduling.getPatient(s.clinicId, s.patient)).anonymisedAt).toBeNull();
  });

  it("removes identity but keeps the clinical and financial record", async () => {
    const s = await platformSetup();
    const h = await withHistory(s);
    const link = await h.svc.createPatientLink(h.id, "olive");
    s.clock.now = new Date("2026-11-30T10:00:00Z");
    await s.p.records.anonymise(s.owner, s.patient, { override: true, reason: "Erasure request received 1 Nov, advice taken" });

    const p = await s.q.get<any>("SELECT * FROM patients WHERE id = ?", [s.patient]);
    expect(p.first_name).toBe("Anonymised");
    for (const col of ["dob", "email", "phone", "gp_name", "gp_practice", "address", "postcode", "sms_consent_at", "email_consent_at", "marketing_consent_at"]) expect(p[col]).toBeNull();
    expect(p.anonymised_at).toBeTruthy();

    const c = await s.q.get<any>("SELECT patient_label, transcript FROM consults WHERE id = ?", [h.id]);
    expect(c.patient_label).toBe("Anonymised patient");
    expect(c.transcript).toBeNull();
    // The approved record is untouched.
    expect((await s.q.get<any>("SELECT content_hash FROM approvals WHERE consult_id = ?", [h.id])).content_hash).toBeTruthy();
    // The link no longer works.
    expect(await h.svc.getPatientView(link.token)).toBeNull();
    // The invoice and payment stay.
    expect((await s.q.get<any>("SELECT count(*)::int AS n FROM invoices WHERE patient_id = ?", [s.patient])).n).toBe(1);
    expect((await s.q.get<any>("SELECT count(*)::int AS n FROM payments"))?.n).toBe(1);
    // Messages sent to the old address no longer carry it or their text.
    expect((await s.q.get<any>("SELECT count(*)::int AS n FROM outbox WHERE to_addr IN ('pat@example.com','07700 900123')")).n).toBe(0);
    // Not found by search, and the act is audited with its reason.
    expect(await s.p.scheduling.searchPatients(s.clinicId, "Jones")).toHaveLength(0);
    const a = await s.q.get<any>("SELECT detail FROM audit_log WHERE action = 'patient.anonymised'");
    expect(JSON.parse(a.detail)).toMatchObject({ patientId: s.patient, beforeRetentionEnd: true });
    // A second attempt is refused.
    await expect(s.p.records.anonymise(s.owner, s.patient, { override: true, reason: "Again for no reason" })).rejects.toThrow(/already/);
  });

  it("is refused while an appointment is coming up", async () => {
    const s = await platformSetup();
    await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    await expect(s.p.records.anonymise(s.owner, s.patient, { override: true, reason: "Erasure request received" })).rejects.toThrow(/coming up/);
  });

  it("needs no override once the retention period has ended, and the patient then shows as due", async () => {
    const s = await platformSetup();
    await withHistory(s);
    expect(await s.p.records.dueForReview(s.clinicId)).toHaveLength(0);
    s.clock.now = YEARS(9, MON_9);
    const due = await s.p.records.dueForReview(s.clinicId);
    expect(due.map((d) => d.patientId)).toEqual([s.patient]);
    await s.p.records.anonymise(s.owner, s.patient);
    expect(await s.p.records.dueForReview(s.clinicId)).toHaveLength(0);
  });

  it("is owner only, and cannot reach another clinic's patient", async () => {
    const s = await platformSetup();
    await expect(s.p.records.anonymise(await asRole(s, "reception"), s.patient, { override: true, reason: "Erasure request received" })).rejects.toThrow(/owner/);
    await expect(s.p.records.anonymise(s.owner, "nope", { override: true, reason: "Erasure request received" })).rejects.toThrow(/not found/i);
  });
});

describe("transcript purge", () => {
  it("clears the transcripts of approved consultations older than the limit and leaves the rest", async () => {
    const s = await platformSetup();
    const a = await consultFor(s); // approved now
    const b = await consultFor(s, false); // never approved
    expect(await s.p.records.purgeTranscripts(s.clinicId, 30)).toBe(0);
    expect(await s.p.records.purgeTranscripts(s.clinicId, 0)).toBe(0); // switched off
    s.clock.now = new Date(s.clock.now.getTime() + 31 * 86_400_000);
    expect(await s.p.records.purgeTranscripts(s.clinicId, 30)).toBe(1);
    expect((await s.q.get<any>("SELECT transcript FROM consults WHERE id = ?", [a.id])).transcript).toBeNull();
    expect((await s.q.get<any>("SELECT transcript FROM consults WHERE id = ?", [b.id])).transcript).not.toBeNull();
    expect((await s.q.get<any>("SELECT note_json FROM approvals WHERE consult_id = ?", [a.id])).note_json).toBeTruthy();
    expect(await s.p.records.purgeTranscripts(s.clinicId, 30)).toBe(0);
  });

  it("runs from the background tick", async () => {
    const s = await platformSetup();
    await consultFor(s);
    s.clock.now = new Date(s.clock.now.getTime() + 31 * 86_400_000);
    const out = await s.p.tick();
    expect(out.purged).toBe(1);
  });
});
