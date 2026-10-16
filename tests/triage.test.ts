import { describe, expect, it } from "vitest";
import { ruleTriage } from "@/lib/triage";
import { buildSeries, numericScore, progressTable } from "@/lib/progress";
import { AssistError, type AssistProvider, type AssistTask } from "@/lib/assist/provider";
import { createPlatform } from "@/lib/platform";
import { Service } from "@/lib/service";
import { MockProvider } from "@/lib/ai/mock";
import { platformSetup } from "./platform.helpers";
import { TRANSCRIPT } from "./helpers";

class Scripted implements AssistProvider {
  name = "scripted";
  model = "s1";
  isMock = false;
  calls: { name: string; user: string }[] = [];
  fail = false;
  answers: Record<string, unknown> = {};
  async run<T>(task: AssistTask<T>): Promise<T> {
    this.calls.push({ name: task.name, user: task.user });
    if (this.fail) throw new AssistError("down");
    return task.schema.parse(task.name in this.answers ? this.answers[task.name] : task.demo());
  }
}

describe("check-in rules", () => {
  const level = (a: string, p: string, c: string) => ruleTriage(a, p, c).level;
  it("raise worse pain and concerning words, and nothing else", () => {
    expect(level("all", "better", "")).toBe("routine");
    expect(level("some", "same", "Doing fine, found the squats easy")).toBe("routine");
    expect(level("all", "worse", "")).toBe("review");
    expect(ruleTriage("all", "worse", "").reason).toBe("Pain is worse.");
    for (const c of ["I have pins and needles in my foot", "my leg gave way on the stairs", "I fell yesterday", "a bit of fever", "waking me at night", "it's unbearable", "can you ring me please", "went to A&E", "feeling hopeless"]) expect(level("all", "same", c), c).toBe("review");
    expect(level("none", "same", "")).toBe("review");
    expect(level("none", "better", "")).toBe("routine");
  });
  it("does not trip on ordinary words", () => {
    for (const c of ["did them tonight", "my knee is stronger", "felt great, 111 steps today", "my doctor friend said hello"]) expect(level("all", "better", c), c).toBe("routine");
  });
});

describe("progress figures", () => {
  it("reads scores as numbers and groups measures by name across visits", () => {
    expect(["6", "6/10", "42%", " 3.5 ", "-2"].map(numericScore)).toEqual([6, 6, 42, 3.5, -2]);
    expect(["six", "", "10-12", "3 of 10"].map(numericScore)).toEqual([null, null, null, null]);
    const series = buildSeries([
      { consultId: "b", date: "2026-10-20", measures: [{ name: "nprs", score: "3", scale: "0-10", evidence: [] }] },
      { consultId: "a", date: "2026-10-06", measures: [{ name: "NPRS", score: "6", scale: "0-10", evidence: [] }, { name: "ODI", score: "40%", scale: "", evidence: [] }, { name: "Blank", score: "", scale: "", evidence: [] }] },
    ]);
    expect(series.map((s) => s.name)).toEqual(["NPRS", "ODI"]);
    expect(series[0].points.map((p) => p.value)).toEqual([6, 3]);
    expect(series[0].change).toBe(-3);
    expect(series[1].change).toBeNull();
  });
});

async function world() {
  const s = await platformSetup();
  const assist = new Scripted();
  const p = createPlatform(s.db, { now: () => s.clock.now, baseUrl: () => "https://clinic.test", assist });
  const svc = new Service({ db: s.db, clinicId: s.clinicId, provider: new MockProvider(), targets: {}, now: () => s.clock.now });
  return { s, assist, p, svc };
}
type World = Awaited<ReturnType<typeof world>>;

async function approved(w: World, score: string | null, date?: string) {
  if (date) w.s.clock.now = new Date(date);
  const id = await w.svc.createConsult({ patientLabel: "Pat Jones", practitioner: "Olive Owner", patientId: w.s.patient }, "olive");
  await w.svc.recordConsent(id, { method: "verbal", by: "Olive" }, "olive");
  await w.svc.saveTranscript(id, TRANSCRIPT, "olive");
  await w.svc.generateDrafts(id, "olive");
  const v = await w.svc.getConsult(id);
  const note = { ...v.note, redFlags: { ...v.note.redFlags, screened: true }, outcomeMeasures: score ? [{ name: "NPRS", score, scale: "0-10", evidence: [] }] : [] };
  await w.svc.saveDrafts(id, { note, programme: v.programme }, "olive");
  await w.svc.approve(id, "Olive Owner");
  return id;
}

describe("check-in triage in the service", () => {
  it("stores the rules' answer on arrival and lists it until a clinician has seen it", async () => {
    const w = await world();
    const id = await approved(w, "6");
    const { token } = await w.svc.createPatientLink(id, "olive");
    const fine = await w.svc.submitCheckIn(token, { adherence: "all", painChange: "better", comment: "great" });
    const bad = await w.svc.submitCheckIn(token, { adherence: "some", painChange: "worse", comment: "numb foot since Tuesday" });
    expect(fine.clinicId).toBe(w.s.clinicId);
    const open = await w.p.triage.listOpen(w.s.clinicId);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ id: bad.checkInId, patientLabel: "Pat Jones", source: "rules" });
    expect(open[0].reason).toContain("numbness");
    expect(await w.p.triage.countOpen(w.s.clinicId)).toBe(1);
    await w.p.triage.markReviewed(w.s.owner, bad.checkInId);
    expect(await w.p.triage.listOpen(w.s.clinicId)).toEqual([]);
    await expect(w.p.triage.markReviewed({ ...w.s.owner, role: "reception" }, bad.checkInId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(w.p.triage.markReviewed(w.s.owner, "nope")).rejects.toMatchObject({ code: "not_found" });
    const acts = (await w.s.q.all("SELECT action FROM audit_log WHERE action LIKE 'check_in.%' ORDER BY id")).map((r) => r.action);
    expect(acts).toEqual(["check_in.submitted", "check_in.submitted", "check_in.reviewed"]);
  });

  it("the assistant does nothing unless the clinic switched it on, and can only raise a check-in", async () => {
    const w = await world();
    const id = await approved(w, "6");
    const { token } = await w.svc.createPatientLink(id, "olive");
    w.assist.answers.checkin_triage = { level: "review", reason: "Mentions low mood" };
    const a = await w.svc.submitCheckIn(token, { adherence: "all", painChange: "same", comment: "I have been feeling a bit flat lately" });
    await w.p.triage.assess(a.clinicId, a.checkInId);
    expect(w.assist.calls).toEqual([]); // off by default
    await expect(w.p.triage.setAi({ ...w.s.owner, role: "clinician" }, true)).rejects.toMatchObject({ code: "forbidden" });
    await w.p.triage.setAi(w.s.owner, true);
    expect(await w.p.triage.aiOn(w.s.clinicId)).toBe(true);
    await w.p.triage.assess(a.clinicId, a.checkInId);
    expect(w.assist.calls).toHaveLength(1);
    expect(w.assist.calls[0].user).toContain("feeling a bit flat");
    expect(w.assist.calls[0].user).not.toMatch(/Pat Jones|Jones/);
    const [row] = await w.p.triage.listOpen(w.s.clinicId);
    expect(row).toMatchObject({ id: a.checkInId, reason: "Mentions low mood", source: "assistant" });

    // A "routine" answer never lowers a check-in the rules raised, and is not even asked for.
    const b = await w.svc.submitCheckIn(token, { adherence: "all", painChange: "worse", comment: "sore" });
    w.assist.answers.checkin_triage = { level: "routine", reason: "" };
    await w.p.triage.assess(b.clinicId, b.checkInId);
    expect(w.assist.calls).toHaveLength(1);
    expect((await w.p.triage.listOpen(w.s.clinicId)).map((x) => x.id)).toContain(b.checkInId);
    // A routine answer for a routine check-in leaves it routine.
    const c = await w.svc.submitCheckIn(token, { adherence: "all", painChange: "better", comment: "all good" });
    await w.p.triage.assess(c.clinicId, c.checkInId);
    expect((await w.p.triage.listOpen(w.s.clinicId)).map((x) => x.id)).not.toContain(c.checkInId);
    // No comment: not asked.
    const d = await w.svc.submitCheckIn(token, { adherence: "all", painChange: "better", comment: "" });
    await w.p.triage.assess(d.clinicId, d.checkInId);
    expect(w.assist.calls).toHaveLength(2);
  });

  it("falls back to the rules when the assistant fails", async () => {
    const w = await world();
    const id = await approved(w, "6");
    const { token } = await w.svc.createPatientLink(id, "olive");
    await w.p.triage.setAi(w.s.owner, true);
    w.assist.fail = true;
    const a = await w.svc.submitCheckIn(token, { adherence: "all", painChange: "same", comment: "all fine" });
    await expect(w.p.triage.assess(a.clinicId, a.checkInId)).resolves.toBeUndefined();
    expect(await w.p.triage.listOpen(w.s.clinicId)).toEqual([]);
  });

  it("keeps check-ins to their own clinic", async () => {
    const w = await world();
    const id = await approved(w, "6");
    const { token } = await w.svc.createPatientLink(id, "olive");
    await w.svc.submitCheckIn(token, { adherence: "all", painChange: "worse", comment: "" });
    await w.s.q.run("INSERT INTO clinics (id, name, slug, created_at) VALUES ('clinic-z', 'Other', 'other', '2026-10-12T00:00:00.000Z')");
    expect(await w.p.triage.listOpen("clinic-z")).toEqual([]);
    expect(await w.p.triage.countOpen("clinic-z")).toBe(0);
  });
});

describe("a patient's progress", () => {
  it("collects scores across approved visits and check-ins, for clinicians only", async () => {
    const w = await world();
    const first = await approved(w, "6", "2026-10-12T10:00:00Z");
    await approved(w, "3", "2026-10-26T10:00:00Z");
    await approved(w, null, "2026-11-02T10:00:00Z");
    const { token } = await w.svc.createPatientLink(first, "olive");
    await w.svc.submitCheckIn(token, { adherence: "some", painChange: "better", comment: "stairs easier" });
    const p = await w.p.progress.forPatient(w.s.owner, w.s.patient);
    expect(p.visits).toHaveLength(3);
    expect(p.series).toHaveLength(1);
    expect(p.series[0]).toMatchObject({ name: "NPRS", change: -3 });
    expect(p.series[0].points.map((x) => x.raw)).toEqual(["6", "3"]);
    expect(p.checkIns).toHaveLength(1);
    await expect(w.p.progress.forPatient({ ...w.s.owner, role: "reception" }, w.s.patient)).rejects.toMatchObject({ code: "forbidden" });
    await expect(w.p.progress.forPatient(w.s.owner, "nope")).rejects.toMatchObject({ code: "not_found" });
    await w.s.q.run("INSERT INTO clinics (id, name, slug, created_at) VALUES ('clinic-z', 'Other', 'other', '2026-10-12T00:00:00.000Z')");
    await expect(w.p.progress.forPatient({ ...w.s.owner, clinicId: "clinic-z" }, w.s.patient)).rejects.toMatchObject({ code: "not_found" });
  });

  it("sends the assistant figures and check-in words only, and says so when it fails", async () => {
    const w = await world();
    await approved(w, "6", "2026-10-12T10:00:00Z");
    await approved(w, "3", "2026-10-26T10:00:00Z");
    w.assist.answers.progress_summary = { text: "NPRS went from 6 to 3." };
    expect(await w.p.progress.summarise(w.s.owner, w.s.patient)).toBe("NPRS went from 6 to 3.");
    const sent = w.assist.calls.at(-1)!.user;
    expect(sent).toContain("NPRS (0-10): 2026-10-12 = 6; 2026-10-26 = 3");
    expect(sent).not.toMatch(/Pat|Jones|pat@example/);
    w.assist.fail = true;
    await expect(w.p.progress.summarise(w.s.owner, w.s.patient)).rejects.toMatchObject({ code: "draft_failed" });
    const empty = await w.p.progress.summarise(w.s.owner, "x").catch((e) => e);
    expect(empty.code).toBe("not_found");
  });

  it("progressTable says plainly when there is nothing", () => {
    expect(progressTable({ patientName: "x", visits: [], series: [], checkIns: [] })).toContain("No outcome measures with a score recorded.");
  });
});
