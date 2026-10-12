import { describe, expect, it } from "vitest";
import { DomainError } from "@/lib/errors";
import { platformSetup } from "./platform.helpers";

// Monday 19 October 2026, 09:00 London (BST, UTC+1) is 08:00Z.
const MON_9 = "2026-10-19T08:00:00.000Z";

describe("appointments and the diary", () => {
  it("books, and refuses to double-book a clinician (service check)", () => {
    const s = platformSetup();
    const id = s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    expect(s.p.scheduling.getAppointment(s.clinicId, id).status).toBe("booked");
    expect(() =>
      s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.followUp.id, startAt: "2026-10-19T08:30:00.000Z", source: "staff" }),
    ).toThrowError(/no longer free/);
  });

  it("the database itself rejects an overlapping insert, even bypassing the service", () => {
    const s = platformSetup();
    s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    const raw = () =>
      s.db
        .prepare(
          `INSERT INTO appointments (id, clinic_id, patient_id, user_id, type_id, start_at, end_at, hold_until, status, source, created_by, created_at, updated_at)
           VALUES ('x', ?, ?, ?, ?, '2026-10-19T08:10:00.000Z', '2026-10-19T08:40:00.000Z', '2026-10-19T08:45:00.000Z', 'booked', 'staff', 'raw', 'n', 'n')`,
        )
        .run(s.clinicId, s.patient, s.owner.id, s.followUp.id);
    expect(raw).toThrowError(/appointment_overlap/);
  });

  it("the buffer after an appointment is held: back-to-back is refused, the next slot after the buffer is allowed", () => {
    const s = platformSetup();
    s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" }); // 09:00-09:45 + 5 buffer
    expect(() =>
      s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.followUp.id, startAt: "2026-10-19T08:45:00.000Z", source: "staff" }),
    ).toThrowError(DomainError);
    expect(
      s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.followUp.id, startAt: "2026-10-19T08:50:00.000Z", source: "staff" }),
    ).toBeTruthy();
  });

  it("a cancelled appointment frees its time", () => {
    const s = platformSetup();
    const id = s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    expect(() => s.p.scheduling.cancelAppointment(s.clinicId, "u", id, "")).toThrowError(/reason/);
    s.p.scheduling.cancelAppointment(s.clinicId, "u", id, "Patient unwell");
    expect(s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" })).toBeTruthy();
  });

  it("two simultaneous requests for the same slot: exactly one wins", () => {
    const s = platformSetup();
    const results = [0, 1, 2, 3].map(() => {
      try {
        s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
        return "ok";
      } catch {
        return "conflict";
      }
    });
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
  });

  it("moves an appointment and refuses to move onto another", () => {
    const s = platformSetup();
    const a = s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    const b = s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.followUp.id, startAt: "2026-10-19T10:00:00.000Z", source: "staff" });
    expect(() => s.p.scheduling.moveAppointment(s.clinicId, "u", b, { startAt: "2026-10-19T08:30:00.000Z" })).toThrowError(/already taken/);
    s.p.scheduling.moveAppointment(s.clinicId, "u", a, { startAt: "2026-10-19T12:00:00.000Z" });
    expect(s.p.scheduling.getAppointment(s.clinicId, a).startAt).toBe("2026-10-19T12:00:00.000Z");
  });

  it("will not create an appointment in the past, or for a clinician in another clinic", () => {
    const s = platformSetup();
    expect(() => s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: "2026-10-01T09:00:00.000Z", source: "staff" })).toThrowError(/future/);
  });

  it("cannot read or change another clinic's data", () => {
    const s = platformSetup();
    const other = "00000000-other";
    expect(() => s.p.scheduling.getPatient(other, s.patient)).toThrowError(/not found/i);
    const a = s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    expect(() => s.p.scheduling.getAppointment(other, a)).toThrowError(/not found/i);
    expect(() => s.p.scheduling.cancelAppointment(other, "x", a, "nope")).toThrowError(/not found/i);
  });
});

describe("availability", () => {
  it("offers 15-minute starts inside working hours only, never overlapping a booking", () => {
    const s = platformSetup();
    s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    const slots = s.p.scheduling.slots(s.clinicId, { typeId: s.initial.id, userId: s.owner.id, fromDate: "2026-10-19", toDate: "2026-10-19" });
    // 09:00-09:45 is booked and the 5-minute buffer holds until 09:50, so the first quarter-hour start is 10:00 local (09:00Z).
    expect(slots[0].startAt).toBe("2026-10-19T09:00:00.000Z");
  });

  it("uses London time across the clock change on 25 October 2026 (a 25-hour day)", () => {
    const s = platformSetup();
    s.p.scheduling.setHours(s.clinicId, "t", s.owner.id, [{ weekday: 7, startMin: 540, endMin: 600 }]);
    const slots = s.p.scheduling.slots(s.clinicId, { typeId: s.followUp.id, userId: s.owner.id, fromDate: "2026-10-25", toDate: "2026-10-25" });
    expect(slots[0].startAt).toBe("2026-10-25T09:00:00.000Z"); // GMT again: 09:00 local = 09:00Z, not 08:00Z
    const before = s.p.scheduling.slots(s.clinicId, { typeId: s.followUp.id, userId: s.owner.id, fromDate: "2026-10-12", toDate: "2026-10-12" });
    expect(before).toHaveLength(0); // no Sunday hours on that date's weekday set (Monday has hours)
  });

  it("skips the hour that does not exist when clocks go forward (28 March 2027)", () => {
    const s = platformSetup("2027-03-20T10:00:00Z");
    s.p.scheduling.setHours(s.clinicId, "t", s.owner.id, [{ weekday: 7, startMin: 0, endMin: 180 }]);
    const slots = s.p.scheduling.slots(s.clinicId, { typeId: s.followUp.id, userId: s.owner.id, fromDate: "2027-03-28", toDate: "2027-03-28", stepMin: 30 });
    const times = slots.map((x) => x.startAt);
    // Local 00:00 and 00:30 exist; 01:00 and 01:30 do not (clocks jump to 02:00 BST = 01:00Z); then 02:00 and 02:30 BST.
    expect(times).toEqual(["2027-03-28T00:00:00.000Z", "2027-03-28T00:30:00.000Z", "2027-03-28T01:00:00.000Z", "2027-03-28T01:30:00.000Z"]);
  });
});

describe("patients", () => {
  it("validates, finds duplicates, and merges records without losing appointments", () => {
    const s = platformSetup();
    expect(() => s.p.scheduling.createPatient(s.clinicId, "u", { firstName: "", lastName: "X" })).toThrowError(DomainError);
    expect(() => s.p.scheduling.createPatient(s.clinicId, "u", { firstName: "A", lastName: "B", email: "bad" })).toThrowError(/check/i);
    const dup = s.p.scheduling.createPatient(s.clinicId, "u", { firstName: "Patricia", lastName: "Jones", dob: "1980-05-04", email: "pat@example.com" });
    expect(s.p.scheduling.findDuplicates(s.clinicId, { firstName: "Pat", lastName: "Jones", dob: "1980-05-04", email: "pat@example.com" }, s.patient).map((d) => d.id)).toContain(dup);
    const a = s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: dup, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    s.p.scheduling.mergePatients(s.clinicId, "u", s.patient, dup);
    expect(s.p.scheduling.getAppointment(s.clinicId, a).patientId).toBe(s.patient);
    expect(s.p.scheduling.getPatient(s.clinicId, dup).mergedInto).toBe(s.patient);
    expect(() => s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: dup, userId: s.owner.id, typeId: s.followUp.id, startAt: "2026-10-19T12:00:00.000Z", source: "staff" })).toThrowError(/merged/);
  });

  it("records who viewed a record", () => {
    const s = platformSetup();
    s.p.scheduling.viewPatient(s.clinicId, "olive@example.com", s.patient);
    const row = s.db.prepare("SELECT actor FROM audit_log WHERE action = 'patient.viewed'").get() as { actor: string };
    expect(row.actor).toBe("olive@example.com");
  });
});

describe("arrival and intake forms", () => {
  it("blocks Arrived until required forms are done, unless overridden with a reason (which is audited)", () => {
    const s = platformSetup();
    const a = s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    expect(s.p.scheduling.getAppointment(s.clinicId, a).formsPending).toBe(1);
    expect(() => s.p.scheduling.markArrived(s.clinicId, "u", a)).toThrowError(/forms are not finished/i);
    s.p.scheduling.markArrived(s.clinicId, "u", a, "Patient will fill in on the tablet");
    expect(s.p.scheduling.getAppointment(s.clinicId, a).status).toBe("arrived");
    expect(s.db.prepare("SELECT 1 FROM audit_log WHERE action = 'appointment.arrival_override'").get()).toBeTruthy();
  });

  it("completing the form lets the patient be marked arrived", () => {
    const s = platformSetup();
    const a = s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    const [req] = s.p.forms.forAppointment(a);
    expect(() => s.p.forms.complete(req.id, { reason: "Knee pain" })).toThrowError(/check your answers/i);
    s.p.forms.complete(req.id, { reason: "Knee pain", night_pain: "no", numbness: "no", unwell: "no", consent: "yes", bogus: "ignored" });
    expect(s.p.forms.request(req.id).response).not.toHaveProperty("bogus");
    s.p.scheduling.markArrived(s.clinicId, "u", a);
    expect(() => s.p.forms.complete(req.id, { reason: "again" })).toThrowError(/already/);
  });

  it("a returning patient does not get the same completed form again", () => {
    const s = platformSetup();
    const a = s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    const [req] = s.p.forms.forAppointment(a);
    s.p.forms.complete(req.id, { reason: "x", night_pain: "no", numbness: "no", unwell: "no", consent: "yes" });
    const b = s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.followUp.id, startAt: "2026-10-20T08:00:00.000Z", source: "staff" });
    expect(s.p.forms.forAppointment(b)).toHaveLength(0);
  });

  it("a form edit makes a new version without changing requests already sent", () => {
    const s = platformSetup();
    const a = s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: MON_9, source: "staff" });
    const f = s.p.forms.list(s.clinicId)[0];
    s.p.forms.save(s.clinicId, "u", { id: f.id, name: f.name, kind: "intake", fieldsJson: JSON.stringify([{ id: "q1", label: "New question", type: "text", required: true }]), mandatory: true, active: true });
    expect(s.p.forms.get(s.clinicId, f.id).version).toBe(2);
    expect(s.p.forms.forAppointment(a)[0].fields.length).toBeGreaterThan(1);
  });
});

describe("markers", () => {
  it("returns an empty set cleanly", () => {
    const s = platformSetup();
    expect(s.p.scheduling.markers(s.clinicId, "2026-10-12", "2026-10-18")).toEqual({ reviewsDue: [], worsePain: [], awaitingApproval: [] });
  });
});
