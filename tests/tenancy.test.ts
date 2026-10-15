import { describe, expect, it } from "vitest";
import { makeLink } from "@/lib/links";
import { platformSetup } from "./platform.helpers";

const MON_9 = "2026-10-19T08:00:00.000Z";

/** Clinic A is the usual test clinic; clinic B is a second, fully separate one in the same database. */
async function twoClinics() {
  const s = await platformSetup();
  const B = "clinic-b";
  await s.q.run("INSERT INTO clinics (id, name, slug, created_at) VALUES (?, 'Other Physio', 'other', ?)", [B, "2026-10-12T00:00:00.000Z"]);
  await s.q.run("INSERT INTO users (id, clinic_id, email, name, role, password_hash, created_at) VALUES ('u-b', ?, 'b@example.com', 'Bea', 'owner', 'x', ?)", [B, "2026-10-12T00:00:00.000Z"]);
  await s.q.run("INSERT INTO appointment_types (id, clinic_id, name, duration_min, online_bookable) VALUES ('t-b', ?, 'Follow-up', 30, 1)", [B]);
  await s.q.run("INSERT INTO clinician_hours (id, clinic_id, user_id, weekday, start_min, end_min) VALUES ('h-b', ?, 'u-b', 1, 540, 1020)", [B]);
  const bPatient = await s.p.scheduling.createPatient(B, "t", { firstName: "Bob", lastName: "Other", email: "bob@example.com" });
  const bAppt = await s.p.scheduling.createAppointment(B, "t", { patientId: bPatient, userId: "u-b", typeId: "t-b", startAt: MON_9, source: "staff" });
  return { ...s, B, bPatient, bAppt };
}

describe("one clinic cannot reach another's records through the service", () => {
  it("cannot read, find, list or change another clinic's patient or appointment by id", async () => {
    const s = await twoClinics();
    await expect(s.p.scheduling.getPatient(s.clinicId, s.bPatient)).rejects.toThrow(/not found/i);
    expect(await s.p.scheduling.searchPatients(s.clinicId, "Other")).toHaveLength(0);
    expect(await s.p.scheduling.searchPatients(s.B, "Other")).toHaveLength(1);
    const a = await s.p.scheduling.listAppointments(s.clinicId, { fromUtc: "2026-10-01T00:00:00.000Z", toUtc: "2026-11-01T00:00:00.000Z" });
    expect(a).toHaveLength(0);
    await expect(s.p.scheduling.cancelAppointment(s.clinicId, "eve", s.bAppt, "nope")).rejects.toThrow(/not found/i);
    await expect(s.p.scheduling.moveAppointment(s.clinicId, "eve", s.bAppt, { startAt: "2026-10-19T12:00:00.000Z" })).rejects.toThrow(/not found/i);
    expect((await s.p.scheduling.getAppointment(s.B, s.bAppt)).status).toBe("booked");
  });

  it("cannot book with another clinic's patient, type or clinician, or merge patients across clinics", async () => {
    const s = await twoClinics();
    const own = { userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" as const };
    await expect(s.p.scheduling.createAppointment(s.clinicId, "eve", { ...own, patientId: s.bPatient })).rejects.toThrow();
    await expect(s.p.scheduling.createAppointment(s.clinicId, "eve", { ...own, patientId: s.patient, typeId: "t-b" })).rejects.toThrow();
    await expect(s.p.scheduling.createAppointment(s.clinicId, "eve", { ...own, patientId: s.patient, userId: "u-b" })).rejects.toThrow();
    await expect(s.p.scheduling.mergePatients(s.clinicId, "eve", s.patient, s.bPatient)).rejects.toThrow();
    expect(await s.q.get("SELECT count(*)::int AS n FROM appointments WHERE clinic_id = ?", [s.clinicId])).toEqual({ n: 0 });
    expect((await s.p.scheduling.getPatient(s.B, s.bPatient)).firstName).toBe("Bob");
  });

  it("cannot deactivate or reset a user of another clinic, and staff lists show only their own clinic", async () => {
    const s = await twoClinics();
    await expect(s.p.accounts.deactivateUser(s.owner, "u-b")).rejects.toThrow(/not found/i);
    await expect(s.p.accounts.resetPassword(s.owner, "u-b", "correct horse battery")).rejects.toThrow(/not found/i);
    expect((await s.p.accounts.listUsers(s.clinicId)).map((u) => u.email).sort()).toEqual(["olive@example.com", "sam@example.com"]);
  });

  it("a patient's manage link opens only their own clinic's appointment", async () => {
    const s = await twoClinics();
    const aAppt = await s.p.scheduling.createAppointment(s.clinicId, "t", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    const token = makeLink("manage", s.bAppt);
    const view = await s.p.booking.manage(token);
    expect(view.appointment.id).toBe(s.bAppt);
    expect(view.appointment.id).not.toBe(aAppt);
    expect(view.clinic.name).toBe("Other Physio");
  });

  it("delivery works one clinic at a time and never lists or sends another clinic's messages", async () => {
    const s = await twoClinics();
    await s.p.outbox.queue({ clinicId: s.B, channel: "email", to: "bob@example.com", body: "hi", kind: "k", key: "b1" });
    const mine = (await s.p.outbox.list(s.clinicId)).map((m) => m.to_addr);
    const theirs = (await s.p.outbox.list(s.B)).map((m) => m.to_addr);
    expect(mine).not.toContain("bob@example.com");
    expect(theirs.every((t) => t === "bob@example.com")).toBe(true);
    expect(theirs.length).toBeGreaterThan(0);
    const sent: string[] = [];
    const spy = { name: "spy", isReal: true, send: async (m: { to: string }) => void sent.push(m.to) };
    await s.p.outbox.deliverDue(s.B, spy);
    expect(sent.length).toBe(theirs.length);
    expect(new Set(sent)).toEqual(new Set(["bob@example.com"]));
  });
});
