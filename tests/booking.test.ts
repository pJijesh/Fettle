import { describe, expect, it } from "vitest";
import { DevMailer } from "@/lib/outbox";
import { makeLink } from "@/lib/links";
import { platformSetup } from "./platform.helpers";

const MON_9 = "2026-10-19T08:00:00.000Z";
const person = { firstName: "Robin", lastName: "Hill", dob: "1990-02-03", email: "robin@example.com", phone: "07700 900456", smsConsent: true };

function book(s: ReturnType<typeof platformSetup>, startAt = MON_9, userId = "") {
  return s.p.booking.book("test-physio", { typeId: s.initial.id, userId, startAt, ...person });
}

describe("online booking", () => {
  it("lists only online-bookable slots at least two hours away, once per start time for 'any clinician'", () => {
    const s = platformSetup("2026-10-19T08:30:00Z"); // 09:30 local Monday
    const { slots } = s.p.booking.availability("test-physio", { typeId: s.initial.id, fromDate: "2026-10-19", toDate: "2026-10-19" });
    expect(slots[0].startAt >= "2026-10-19T10:30:00.000Z").toBe(true);
    const starts = slots.map((x) => x.startAt);
    expect(new Set(starts).size).toBe(starts.length);
  });

  it("books a new patient, sends a confirmation with manage and form links, and queues it once", () => {
    const s = platformSetup();
    const r = book(s);
    const a = s.p.scheduling.getAppointment(s.clinicId, r.appointmentId);
    expect(a.source).toBe("online");
    const mail = s.p.outbox.list(s.clinicId).filter((m) => m.kind === "confirmation");
    expect(mail).toHaveLength(1);
    expect(mail[0].to_addr).toBe("robin@example.com");
    expect(mail[0].body).toContain(`https://clinic.test/manage/${r.manageToken}`);
    expect(mail[0].body).toMatch(/\/form\//);
  });

  it("reuses a patient only when email, surname and date of birth all match", () => {
    const s = platformSetup();
    book(s);
    book(s, "2026-10-20T08:00:00.000Z");
    const same = s.db.prepare("SELECT COUNT(*) AS n FROM patients WHERE email = 'robin@example.com'").get() as { n: number };
    expect(same.n).toBe(1);
    s.p.booking.book("test-physio", { typeId: s.initial.id, startAt: "2026-10-21T08:00:00.000Z", ...person, dob: "1991-01-01" });
    const two = s.db.prepare("SELECT COUNT(*) AS n FROM patients WHERE email = 'robin@example.com'").get() as { n: number };
    expect(two.n).toBe(2);
  });

  it("refuses a taken slot, a slot too soon, and a type that is not bookable online", () => {
    const s = platformSetup();
    book(s); // "any clinician" takes the first free one (Olive)
    book(s, MON_9, s.secondId); // the other clinician is still free
    expect(() => book(s, MON_9, s.owner.id)).toThrowError(/no longer free/);
    expect(() => book(s, "2026-10-12T11:00:00.000Z")).toThrowError(/too soon/i);
    const hidden = s.p.scheduling.saveType(s.clinicId, "u", { name: "Private", durationMin: 30, bufferMin: 0, onlineBookable: false, colour: "grey" });
    expect(() => s.p.booking.book("test-physio", { typeId: hidden, startAt: "2026-10-22T08:00:00.000Z", ...person })).toThrowError(/online/);
  });

  it("refuses times outside working hours", () => {
    const s = platformSetup();
    expect(() => book(s, "2026-10-19T03:00:00.000Z", s.owner.id)).toThrowError(/working hours/);
    expect(() => book(s, "2026-10-24T08:00:00.000Z", s.owner.id)).toThrowError(/working hours/); // Saturday
  });
});

describe("manage link", () => {
  it("shows, reschedules and cancels with 24 hours' notice, frees the slot, and rejects forged links", () => {
    const s = platformSetup();
    const r = book(s, MON_9, s.owner.id);
    const view = s.p.booking.manage(r.manageToken);
    expect(view.canChange).toBe(true);
    expect(() => s.p.booking.manage(r.manageToken + "x")).toThrowError(/not valid/);
    expect(() => s.p.booking.manage(makeLink("form", r.appointmentId))).toThrowError(/not valid/); // wrong purpose
    s.p.booking.rescheduleByPatient(r.manageToken, "2026-10-20T09:00:00.000Z");
    expect(s.p.scheduling.getAppointment(s.clinicId, r.appointmentId).startAt).toBe("2026-10-20T09:00:00.000Z");
    expect(() => s.p.booking.rescheduleByPatient(r.manageToken, "2026-10-20T03:00:00.000Z")).toThrowError(/not available/);
    s.p.booking.cancelByPatient(r.manageToken);
    expect(s.p.scheduling.getAppointment(s.clinicId, r.appointmentId).status).toBe("cancelled");
    expect(s.p.outbox.list(s.clinicId).some((m) => m.kind === "cancellation")).toBe(true);
  });

  it("blocks changes inside 24 hours", () => {
    const s = platformSetup("2026-10-19T07:00:00Z");
    const r = s.p.booking.book("test-physio", { typeId: s.initial.id, userId: s.owner.id, startAt: "2026-10-19T14:00:00.000Z", ...person });
    expect(s.p.booking.manage(r.manageToken).canChange).toBe(false);
    expect(() => s.p.booking.cancelByPatient(r.manageToken)).toThrowError(/notice/);
  });
});

describe("patient forms by link", () => {
  it("opens and submits the right form, and cannot be reused", () => {
    const s = platformSetup();
    const r = book(s);
    const form = s.p.booking.manage(r.manageToken).forms[0];
    expect(s.p.booking.formByToken(form.token).request.formName).toBe("New patient intake");
    expect(() => s.p.booking.submitForm(form.token, { reason: "" })).toThrowError(/check your answers/i);
    s.p.booking.submitForm(form.token, { reason: "Sore knee", night_pain: "no", numbness: "no", unwell: "no", consent: "yes" });
    expect(() => s.p.booking.submitForm(form.token, { reason: "again" })).toThrowError(/already/);
    expect(s.p.scheduling.getAppointment(s.clinicId, r.appointmentId).formsPending).toBe(0);
  });
});

describe("client portal sign-in", () => {
  it("signs in with an emailed one-time code, once only", () => {
    const s = platformSetup();
    book(s);
    s.p.booking.requestCode("test-physio", "robin@example.com");
    const mail = s.p.outbox.list(s.clinicId).find((m) => m.kind === "portal_code")!;
    const code = /code for .* is (\d{6})/.exec(mail.body)![1];
    expect(() => s.p.booking.verifyCode("test-physio", "robin@example.com", "000000" === code ? "111111" : "000000")).toThrowError(/not right/);
    const { token } = s.p.booking.verifyCode("test-physio", "robin@example.com", code);
    const session = s.p.booking.portalSession(token)!;
    expect(s.p.booking.portalHome(session).upcoming).toHaveLength(1);
    expect(() => s.p.booking.verifyCode("test-physio", "robin@example.com", code)).toThrowError(/not right/);
    s.p.booking.portalSignOut(token);
    expect(s.p.booking.portalSession(token)).toBeNull();
  });

  it("gives away nothing about unknown emails, locks a code after five wrong tries, and expires it", () => {
    const s = platformSetup();
    book(s);
    s.p.booking.requestCode("test-physio", "nobody@example.com");
    expect(s.p.outbox.list(s.clinicId).filter((m) => m.kind === "portal_code")).toHaveLength(0);
    s.p.booking.requestCode("test-physio", "robin@example.com");
    const code = /is (\d{6})/.exec(s.p.outbox.list(s.clinicId).find((m) => m.kind === "portal_code")!.body)![1];
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) expect(() => s.p.booking.verifyCode("test-physio", "robin@example.com", wrong)).toThrowError();
    expect(() => s.p.booking.verifyCode("test-physio", "robin@example.com", code)).toThrowError(/not right/);
    s.p.booking.requestCode("test-physio", "robin@example.com");
    const code2 = /is (\d{6})/.exec(s.p.outbox.list(s.clinicId).find((m) => m.kind === "portal_code")!.body)![1];
    s.clock.now = new Date(s.clock.now.getTime() + 16 * 60_000);
    expect(() => s.p.booking.verifyCode("test-physio", "robin@example.com", code2)).toThrowError(/not right/);
  });

  it("a session only shows that patient's own appointments", () => {
    const s = platformSetup();
    book(s);
    s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.followUp.id, startAt: "2026-10-22T08:00:00.000Z", source: "staff" });
    s.p.booking.requestCode("test-physio", "robin@example.com");
    const code = /is (\d{6})/.exec(s.p.outbox.list(s.clinicId).find((m) => m.kind === "portal_code")!.body)![1];
    const { token } = s.p.booking.verifyCode("test-physio", "robin@example.com", code);
    const home = s.p.booking.portalHome(s.p.booking.portalSession(token)!);
    expect(home.upcoming.every((a) => a.patientName === "Robin Hill")).toBe(true);
  });
});

describe("waiting list", () => {
  function fill(s: ReturnType<typeof platformSetup>) {
    const slot = "2026-10-20T08:00:00.000Z"; // Tue 09:00 local
    const appt = s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: slot, source: "staff" });
    const people = Array.from({ length: 7 }, (_, i) =>
      s.p.scheduling.createPatient(s.clinicId, "u", { firstName: `W${i}`, lastName: "Wait", email: `w${i}@example.com` }),
    );
    for (const id of people) {
      s.p.waitlist.add(s.clinicId, "u", { patientId: id, typeId: s.initial.id, earliestDate: "2026-10-13", latestDate: "2026-10-30" });
      s.clock.now = new Date(s.clock.now.getTime() + 1000);
    }
    return { slot, appt, people };
  }

  it("offers a freed slot to the first five only, and holds it against ordinary bookings", () => {
    const s = platformSetup();
    const { slot, appt } = fill(s);
    s.p.scheduling.cancelAppointment(s.clinicId, "u", appt, "Patient unwell");
    const offers = s.db.prepare("SELECT waitlist_id FROM waitlist_offers WHERE status = 'sent'").all();
    expect(offers).toHaveLength(5);
    expect(s.p.outbox.list(s.clinicId).filter((m) => m.kind === "offer")).toHaveLength(5);
    expect(() => s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: slot, source: "staff" })).toThrowError(/no longer free/);
    expect(s.p.scheduling.slots(s.clinicId, { typeId: s.initial.id, userId: s.owner.id, fromDate: "2026-10-20", toDate: "2026-10-20" }).some((x) => x.startAt === slot)).toBe(false);
  });

  it("first to accept gets it; everyone else is told it has gone and goes back on the list", () => {
    const s = platformSetup();
    const { slot, appt } = fill(s);
    s.p.scheduling.cancelAppointment(s.clinicId, "u", appt, "Patient unwell");
    const ids = (s.db.prepare("SELECT id FROM waitlist_offers WHERE status = 'sent' ORDER BY rowid").all() as { id: string }[]).map((o) => o.id);
    const tokens = ids.map((id) => makeLink("offer", id));
    const won = s.p.waitlist.accept(tokens[2]);
    expect(s.p.scheduling.getAppointment(s.clinicId, won.appointmentId).startAt).toBe(slot);
    for (const t of [tokens[0], tokens[1], tokens[3], tokens[4]]) expect(() => s.p.waitlist.accept(t)).toThrowError(/someone else|taken/i);
    expect(() => s.p.waitlist.accept(tokens[2])).toThrowError(/already/);
    const waiting = s.db.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE status = 'waiting'").get() as { n: number };
    expect(waiting.n).toBe(6); // 7 people, one booked
    const dupes = s.db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE start_at = ? AND status <> 'cancelled'").get(slot) as { n: number };
    expect(dupes.n).toBe(1);
  });

  it("an unanswered offer expires after 15 minutes and goes to the next two people, never to the same ones", () => {
    const s = platformSetup();
    const { appt } = fill(s);
    s.p.scheduling.cancelAppointment(s.clinicId, "u", appt, "Patient unwell");
    const firstIds = new Set((s.db.prepare("SELECT waitlist_id FROM waitlist_offers").all() as { waitlist_id: string }[]).map((o) => o.waitlist_id));
    s.clock.now = new Date(s.clock.now.getTime() + 14 * 60_000);
    expect(s.p.waitlist.expireOffers().expired).toBe(0);
    s.clock.now = new Date(s.clock.now.getTime() + 2 * 60_000);
    const r = s.p.waitlist.expireOffers();
    expect(r.expired).toBe(5);
    expect(r.reoffered).toBe(2);
    const second = (s.db.prepare("SELECT waitlist_id FROM waitlist_offers WHERE status = 'sent'").all() as { waitlist_id: string }[]).map((o) => o.waitlist_id);
    expect(second).toHaveLength(2);
    expect(second.some((id) => firstIds.has(id))).toBe(false);
    // an expired offer cannot be accepted
    const expired = s.db.prepare("SELECT id FROM waitlist_offers WHERE status = 'expired' LIMIT 1").get() as { id: string };
    expect(() => s.p.waitlist.accept(makeLink("offer", expired.id))).toThrowError(/ended/);
  });

  it("matches on appointment type, clinician preference, date window and weekday", () => {
    const s = platformSetup();
    const slot = "2026-10-20T08:00:00.000Z"; // Tuesday
    const appt = s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.initial.id, startAt: slot, source: "staff" });
    const mk = (n: string) => s.p.scheduling.createPatient(s.clinicId, "u", { firstName: n, lastName: "M", email: `${n}@example.com` });
    const ok = mk("ok");
    const wrongType = mk("wt");
    const wrongDay = mk("wd");
    const wrongDate = mk("wdt");
    const wrongClin = mk("wc");
    s.p.waitlist.add(s.clinicId, "u", { patientId: ok, typeId: s.initial.id, earliestDate: "2026-10-13", latestDate: "2026-10-30", weekdays: [2] });
    s.p.waitlist.add(s.clinicId, "u", { patientId: wrongType, typeId: s.followUp.id, earliestDate: "2026-10-13", latestDate: "2026-10-30" });
    s.p.waitlist.add(s.clinicId, "u", { patientId: wrongDay, typeId: s.initial.id, earliestDate: "2026-10-13", latestDate: "2026-10-30", weekdays: [1, 3] });
    s.p.waitlist.add(s.clinicId, "u", { patientId: wrongDate, typeId: s.initial.id, earliestDate: "2026-10-21", latestDate: "2026-10-30" });
    s.p.waitlist.add(s.clinicId, "u", { patientId: wrongClin, typeId: s.initial.id, userId: s.secondId, earliestDate: "2026-10-13", latestDate: "2026-10-30" });
    s.p.scheduling.cancelAppointment(s.clinicId, "u", appt, "x");
    const got = (s.db.prepare("SELECT w.patient_id FROM waitlist_offers o JOIN waitlist w ON w.id = o.waitlist_id").all() as { patient_id: string }[]).map((r) => r.patient_id);
    expect(got).toEqual([ok]);
  });

  it("cannot add someone with no way to be contacted, or the same person twice", () => {
    const s = platformSetup();
    const none = s.p.scheduling.createPatient(s.clinicId, "u", { firstName: "No", lastName: "Contact" });
    expect(() => s.p.waitlist.add(s.clinicId, "u", { patientId: none, typeId: s.initial.id, earliestDate: "2026-10-13", latestDate: "2026-10-30" })).toThrowError(/cannot be contacted/);
    s.p.waitlist.add(s.clinicId, "u", { patientId: s.patient, typeId: s.initial.id, earliestDate: "2026-10-13", latestDate: "2026-10-30" });
    expect(() => s.p.waitlist.add(s.clinicId, "u", { patientId: s.patient, typeId: s.initial.id, earliestDate: "2026-10-13", latestDate: "2026-10-30" })).toThrowError(/already/);
  });
});

describe("outbox and reminders", () => {
  it("queues each message once and only texts patients who agreed", async () => {
    const s = platformSetup();
    expect(s.p.outbox.queue({ clinicId: s.clinicId, channel: "email", to: "a@b.co", body: "x", kind: "k", key: "same" })).toBe(true);
    expect(s.p.outbox.queue({ clinicId: s.clinicId, channel: "email", to: "a@b.co", body: "x", kind: "k", key: "same" })).toBe(false);
    const noText = s.p.scheduling.createPatient(s.clinicId, "u", { firstName: "No", lastName: "Text", email: "nt@example.com", phone: "07700 900777" });
    const a = s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: noText, userId: s.owner.id, typeId: s.followUp.id, startAt: "2026-10-20T10:00:00.000Z", source: "staff" });
    s.clock.now = new Date("2026-10-19T11:00:00Z");
    await s.p.tick();
    const mine = s.p.outbox.list(s.clinicId).filter((m) => m.kind === "reminder" && m.body.includes("manage"));
    expect(mine.map((m) => m.channel)).toEqual(["email"]);
    void a;
  });

  it("sends a reminder about 24 hours ahead, once, and not for a booking made inside that window", async () => {
    const s = platformSetup();
    s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.followUp.id, startAt: "2026-10-20T10:00:00.000Z", source: "staff" });
    await s.p.tick();
    expect(s.p.outbox.list(s.clinicId).filter((m) => m.kind === "reminder")).toHaveLength(0); // still more than 24h away
    s.clock.now = new Date("2026-10-19T11:00:00Z");
    await s.p.tick();
    await s.p.tick();
    const rem = s.p.outbox.list(s.clinicId).filter((m) => m.kind === "reminder");
    expect(rem.map((m) => m.channel).sort()).toEqual(["email", "sms"]);
    // booked inside the window: confirmation only
    s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.followUp.id, startAt: "2026-10-20T08:00:00.000Z", source: "staff" });
    await s.p.tick();
    expect(s.p.outbox.list(s.clinicId).filter((m) => m.kind === "reminder")).toHaveLength(2);
  });

  it("does not remind about a cancelled appointment and tells the patient when it moves", async () => {
    const s = platformSetup();
    const a = s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId: s.followUp.id, startAt: "2026-10-20T10:00:00.000Z", source: "staff" });
    s.p.scheduling.moveAppointment(s.clinicId, "u", a, { startAt: "2026-10-20T11:00:00.000Z" });
    expect(s.p.outbox.list(s.clinicId).some((m) => m.kind === "moved")).toBe(true);
    s.p.scheduling.cancelAppointment(s.clinicId, "u", a, "Clinic closed");
    s.clock.now = new Date("2026-10-19T12:00:00Z");
    await s.p.tick();
    expect(s.p.outbox.list(s.clinicId).filter((m) => m.kind === "reminder")).toHaveLength(0);
  });

  it("retries failures with a delay and gives up after five tries", async () => {
    const s = platformSetup();
    s.p.outbox.queue({ clinicId: s.clinicId, channel: "email", to: "a@b.co", body: "x", kind: "k", key: "flaky" });
    const bad = { name: "bad", isReal: true, send: async () => { throw new Error("smtp down"); } };
    for (let i = 0; i < 5; i++) {
      const r = await s.p.outbox.deliverDue(bad);
      expect(r.failed).toBe(1);
      s.clock.now = new Date(s.clock.now.getTime() + 30 * 60_000);
    }
    expect(s.p.outbox.list(s.clinicId)[0].status).toBe("failed");
    expect((await s.p.outbox.deliverDue(new DevMailer())).sent).toBe(0);
  });
});
