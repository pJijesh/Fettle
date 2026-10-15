import { describe, expect, it } from "vitest";
import { DomainError } from "@/lib/errors";
import { platformSetup } from "./platform.helpers";

// Monday 19 October 2026, 09:00 London (BST, UTC+1) is 08:00Z.
const MON_9 = "2026-10-19T08:00:00.000Z";

describe("appointments and the diary", () => {
  it("books, and refuses to double-book a clinician (service check)", async () => {
    const s = await platformSetup();
    const id = await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    expect((await s.p.scheduling.getAppointment(s.clinicId, id)).status).toBe("booked");
    await expect(s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.followUp.id, startAt: "2026-10-19T08:30:00.000Z", source: "staff" })).rejects.toThrowError(/no longer free/);
  });

  it("the database itself rejects an overlapping insert, even bypassing the service", async () => {
    const s = await platformSetup();
    await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    const raw = s.q.run(
      `INSERT INTO appointments (id, clinic_id, patient_id, user_id, type_id, start_at, end_at, hold_until, status, source, created_by, created_at, updated_at)
       VALUES ('x', ?, ?, ?, ?, '2026-10-19T08:10:00.000Z', '2026-10-19T08:40:00.000Z', '2026-10-19T08:45:00.000Z', 'booked', 'staff', 'raw', '2026-10-12T10:00:00.000Z', '2026-10-12T10:00:00.000Z')`,
      [s.clinicId, s.patient, s.owner.id, s.followUp.id],
    );
    await expect(raw).rejects.toThrowError(/appointment_overlap/);
  });

  it("the buffer after an appointment is held: back-to-back is refused, the next slot after the buffer is allowed", async () => {
    const s = await platformSetup();
    await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" }); // 09:00-09:45 + 5 buffer
    await expect(s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.followUp.id, startAt: "2026-10-19T08:45:00.000Z", source: "staff" })).rejects.toThrowError(DomainError);
    expect(
      await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.followUp.id, startAt: "2026-10-19T08:50:00.000Z", source: "staff" }),
    ).toBeTruthy();
  });

  it("a cancelled appointment frees its time", async () => {
    const s = await platformSetup();
    const id = await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    await expect(s.p.scheduling.cancelAppointment(s.clinicId, "u", id, "")).rejects.toThrowError(/reason/);
    await s.p.scheduling.cancelAppointment(s.clinicId, "u", id, "Patient unwell");
    expect(await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" })).toBeTruthy();
  });

  it("two simultaneous requests for the same slot: exactly one wins", async () => {
    const s = await platformSetup();
    // Really concurrent now: four transactions race, and the clinician's lock lets exactly one through.
    const results = await Promise.all(
      [0, 1, 2, 3].map(async () => {
        try {
          await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
          return "ok";
        } catch {
          return "conflict";
        }
      }),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
  });

  it("moves an appointment and refuses to move onto another", async () => {
    const s = await platformSetup();
    const a = await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    const b = await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.followUp.id, startAt: "2026-10-19T10:00:00.000Z", source: "staff" });
    await expect(s.p.scheduling.moveAppointment(s.clinicId, "u", b, { startAt: "2026-10-19T08:30:00.000Z" })).rejects.toThrowError(/already taken/);
    await s.p.scheduling.moveAppointment(s.clinicId, "u", a, { startAt: "2026-10-19T12:00:00.000Z" });
    expect((await s.p.scheduling.getAppointment(s.clinicId, a)).startAt).toBe("2026-10-19T12:00:00.000Z");
  });

  it("will not create an appointment in the past, or for a clinician in another clinic", async () => {
    const s = await platformSetup();
    await expect(s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: "2026-10-01T09:00:00.000Z", source: "staff" })).rejects.toThrowError(/future/);
  });

  it("cannot read or change another clinic's data", async () => {
    const s = await platformSetup();
    const other = "00000000-other";
    await expect(s.p.scheduling.getPatient(other, s.patient)).rejects.toThrowError(/not found/i);
    const a = await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    await expect(s.p.scheduling.getAppointment(other, a)).rejects.toThrowError(/not found/i);
    await expect(s.p.scheduling.cancelAppointment(other, "x", a, "nope")).rejects.toThrowError(/not found/i);
  });
});

describe("availability", () => {
  it("offers 15-minute starts inside working hours only, never overlapping a booking", async () => {
    const s = await platformSetup();
    await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    const slots = await s.p.scheduling.slots(s.clinicId, { typeId: s.initial.id, userId: s.owner.id, fromDate: "2026-10-19", toDate: "2026-10-19" });
    // 09:00-09:45 is booked and the 5-minute buffer holds until 09:50, so the first quarter-hour start is 10:00 local (09:00Z).
    expect(slots[0].startAt).toBe("2026-10-19T09:00:00.000Z");
  });

  it("uses London time across the clock change on 25 October 2026 (a 25-hour day)", async () => {
    const s = await platformSetup();
    await s.p.scheduling.setHours(s.clinicId, "t", s.owner.id, [{ weekday: 7, startMin: 540, endMin: 600 }]);
    const slots = await s.p.scheduling.slots(s.clinicId, { typeId: s.followUp.id, userId: s.owner.id, fromDate: "2026-10-25", toDate: "2026-10-25" });
    expect(slots[0].startAt).toBe("2026-10-25T09:00:00.000Z"); // GMT again: 09:00 local = 09:00Z, not 08:00Z
    const before = await s.p.scheduling.slots(s.clinicId, { typeId: s.followUp.id, userId: s.owner.id, fromDate: "2026-10-12", toDate: "2026-10-12" });
    expect(before).toHaveLength(0); // no Sunday hours on that date's weekday set (Monday has hours)
  });

  it("skips the hour that does not exist when clocks go forward (28 March 2027)", async () => {
    const s = await platformSetup("2027-03-20T10:00:00Z");
    await s.p.scheduling.setHours(s.clinicId, "t", s.owner.id, [{ weekday: 7, startMin: 0, endMin: 180 }]);
    const slots = await s.p.scheduling.slots(s.clinicId, { typeId: s.followUp.id, userId: s.owner.id, fromDate: "2027-03-28", toDate: "2027-03-28", stepMin: 30 });
    const times = slots.map((x) => x.startAt);
    // Local 00:00 and 00:30 exist; 01:00 and 01:30 do not (clocks jump to 02:00 BST = 01:00Z); then 02:00 and 02:30 BST.
    expect(times).toEqual(["2027-03-28T00:00:00.000Z", "2027-03-28T00:30:00.000Z", "2027-03-28T01:00:00.000Z", "2027-03-28T01:30:00.000Z"]);
  });
});

describe("patients", () => {
  it("validates, finds duplicates, and merges records without losing appointments", async () => {
    const s = await platformSetup();
    await expect(s.p.scheduling.createPatient(s.clinicId, "u", { firstName: "", lastName: "X" })).rejects.toThrowError(DomainError);
    await expect(s.p.scheduling.createPatient(s.clinicId, "u", { firstName: "A", lastName: "B", email: "bad" })).rejects.toThrowError(/check/i);
    const dup = await s.p.scheduling.createPatient(s.clinicId, "u", { firstName: "Patricia", lastName: "Jones", dob: "1980-05-04", email: "pat@example.com" });
    expect((await s.p.scheduling.findDuplicates(s.clinicId, { firstName: "Pat", lastName: "Jones", dob: "1980-05-04", email: "pat@example.com" }, s.patient)).map((d) => d.id)).toContain(dup);
    const a = await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: dup, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    await s.p.scheduling.mergePatients(s.clinicId, "u", s.patient, dup);
    expect((await s.p.scheduling.getAppointment(s.clinicId, a)).patientId).toBe(s.patient);
    expect((await s.p.scheduling.getPatient(s.clinicId, dup)).mergedInto).toBe(s.patient);
    await expect(s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: dup, userId: s.owner.id, typeId: s.followUp.id, startAt: "2026-10-19T12:00:00.000Z", source: "staff" })).rejects.toThrowError(/merged/);
  });

  it("records who viewed a record", async () => {
    const s = await platformSetup();
    await s.p.scheduling.viewPatient(s.clinicId, "olive@example.com", s.patient);
    const row = (await s.q.get("SELECT actor FROM audit_log WHERE action = 'patient.viewed'")) as { actor: string };
    expect(row.actor).toBe("olive@example.com");
  });
});

describe("arrival and intake forms", () => {
  it("blocks Arrived until required forms are done, unless overridden with a reason (which is audited)", async () => {
    const s = await platformSetup();
    const a = await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    expect((await s.p.scheduling.getAppointment(s.clinicId, a)).formsPending).toBe(1);
    await expect(s.p.scheduling.markArrived(s.clinicId, "u", a)).rejects.toThrowError(/forms are not finished/i);
    await s.p.scheduling.markArrived(s.clinicId, "u", a, "Patient will fill in on the tablet");
    expect((await s.p.scheduling.getAppointment(s.clinicId, a)).status).toBe("arrived");
    expect((await s.q.get("SELECT 1 FROM audit_log WHERE action = 'appointment.arrival_override'"))).toBeTruthy();
  });

  it("completing the form lets the patient be marked arrived", async () => {
    const s = await platformSetup();
    const a = await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    const [req] = await s.db.scope(s.clinicId, () => s.p.forms.forAppointment(a));
    await expect(s.db.scope(s.clinicId, () => s.p.forms.complete(req.id, { reason: "Knee pain" }))).rejects.toThrowError(/check your answers/i);
    await s.db.scope(s.clinicId, () => s.p.forms.complete(req.id, { reason: "Knee pain", night_pain: "no", numbness: "no", unwell: "no", consent: "yes", bogus: "ignored" }));
    expect((await s.db.scope(s.clinicId, () => s.p.forms.request(req.id))).response).not.toHaveProperty("bogus");
    await s.p.scheduling.markArrived(s.clinicId, "u", a);
    await expect(s.db.scope(s.clinicId, () => s.p.forms.complete(req.id, { reason: "again" }))).rejects.toThrowError(/already/);
  });

  it("a returning patient does not get the same completed form again", async () => {
    const s = await platformSetup();
    const a = await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    const [req] = await s.db.scope(s.clinicId, () => s.p.forms.forAppointment(a));
    await s.db.scope(s.clinicId, () => s.p.forms.complete(req.id, { reason: "x", night_pain: "no", numbness: "no", unwell: "no", consent: "yes" }));
    const b = await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.followUp.id, startAt: "2026-10-20T08:00:00.000Z", source: "staff" });
    expect(await s.db.scope(s.clinicId, () => s.p.forms.forAppointment(b))).toHaveLength(0);
  });

  it("a form edit makes a new version without changing requests already sent", async () => {
    const s = await platformSetup();
    const a = await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    const f = (await s.p.forms.list(s.clinicId))[0];
    await s.p.forms.save(s.clinicId, "u", { id: f.id, name: f.name, kind: "intake", fieldsJson: JSON.stringify([{ id: "q1", label: "New question", type: "text", required: true }]), mandatory: true, active: true });
    expect((await s.p.forms.get(s.clinicId, f.id)).version).toBe(2);
    expect((await s.db.scope(s.clinicId, () => s.p.forms.forAppointment(a)))[0].fields.length).toBeGreaterThan(1);
  });
});

describe("markers", () => {
  it("returns an empty set cleanly", async () => {
    const s = await platformSetup();
    expect(await s.p.scheduling.markers(s.clinicId, "2026-10-12", "2026-10-18")).toEqual({ reviewsDue: [], worsePain: [], awaitingApproval: [] });
  });
});
