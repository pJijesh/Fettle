import { describe, expect, it } from "vitest";
import { z } from "zod";
import { emptyNote, emptyProgramme } from "@/lib/schemas";
import { ruleFindings } from "@/lib/note-check";
import { AssistError, type AssistProvider, type AssistTask } from "@/lib/assist/provider";
import { MockAssist } from "@/lib/assist/mock";
import { createAssist } from "@/lib/assist";
import { createPlatform } from "@/lib/platform";
import { Service } from "@/lib/service";
import { MockProvider } from "@/lib/ai/mock";
import { platformSetup, type PlatformSetup } from "./platform.helpers";
import { TRANSCRIPT } from "./helpers";
import type { SessionUser } from "@/lib/accounts";

/** Answers each task by name and records what it was sent. */
class Scripted implements AssistProvider {
  name = "scripted";
  model = "scripted-1";
  isMock = false;
  calls: { name: string; user: string; system: string }[] = [];
  fail = false;
  answers: Record<string, unknown> = {};
  async run<T>(task: AssistTask<T>): Promise<T> {
    this.calls.push({ name: task.name, user: task.user, system: task.system });
    if (this.fail) throw new AssistError("down");
    const raw = task.name in this.answers ? this.answers[task.name] : task.demo();
    return task.schema.parse(raw);
  }
}

async function world() {
  const s = await platformSetup();
  const assist = new Scripted();
  const p = createPlatform(s.db, { now: () => s.clock.now, baseUrl: () => "https://clinic.test", assist });
  const svc = new Service({ db: s.db, clinicId: s.clinicId, provider: new MockProvider(), targets: {}, now: () => s.clock.now });
  return { s, assist, p, svc };
}
type World = Awaited<ReturnType<typeof world>>;

async function approved(w: World, label = "Pat Jones") {
  const id = await w.svc.createConsult({ patientLabel: label, practitioner: "Olive Owner", patientId: w.s.patient }, "olive");
  await w.svc.recordConsent(id, { method: "verbal", by: "Olive" }, "olive");
  await w.svc.saveTranscript(id, TRANSCRIPT, "olive");
  await w.svc.generateDrafts(id, "olive");
  const v = await w.svc.getConsult(id);
  await w.svc.saveDrafts(id, { note: { ...v.note, redFlags: { ...v.note.redFlags, screened: true } }, programme: v.programme }, "olive");
  await w.svc.approve(id, "Olive Owner");
  return id;
}
const as = (s: PlatformSetup, role: "reception" | "clinician"): SessionUser => ({ ...s.owner, role });

describe("plain note checks", () => {
  it("flags template rows left empty, a missing pain score and an unset review", () => {
    const n = emptyNote();
    n.assessment = "x";
    n.plan = "y";
    n.rom = [{ joint: "Knee", side: "left", movement: "Flexion", value: "", unit: "deg", evidence: [] }];
    n.outcomeMeasures = [{ name: "NPRS", score: "", scale: "0-10", evidence: [] }];
    n.specialTests = [{ name: "Lachman", side: "right", result: "", evidence: [] }];
    n.problems = [{ id: "p1", title: "Knee pain", side: "left", evidence: [] }, { id: "p2", title: "Hip", side: "na", evidence: [] }];
    const pr = { ...emptyProgramme(), items: [{ exerciseId: "e", problemId: "p1", sets: 1, reps: 5, holdSeconds: null, frequencyPerWeek: 3, cue: "", progression: "", evidence: [] }] };
    const text = ruleFindings(n, pr, ["Patient: it is 6/10 on stairs"]).map((f) => f.message).join("\n");
    expect(text).toContain("Range of movement with no value: Knee left Flexion");
    expect(text).toContain("Outcome measure with no score: NPRS");
    expect(text).toContain("Special test with no result: Lachman right");
    expect(text).toContain("pain score out of 10 is mentioned");
    expect(text).toContain("No exercise is linked to: Hip");
    expect(text).toContain("No review time");
    expect(text).toContain("no safety advice");
  });

  it("says nothing about a complete note", () => {
    const n = emptyNote();
    Object.assign(n, { subjective: "a", objective: "b", assessment: "c", plan: "d" });
    n.outcomeMeasures = [{ name: "NPRS", score: "4", scale: "0-10", evidence: [] }];
    n.problems = [{ id: "p1", title: "Knee", side: "na", evidence: [] }];
    expect(ruleFindings(n, emptyProgramme(), ["Patient: hello"])).toEqual([]);
  });
});

describe("assistant providers", () => {
  it("the demo provider returns the task's demo answer and checks its shape", async () => {
    const ok = { name: "t", system: "", user: "", schema: z.object({ a: z.string() }), demo: () => ({ a: "x" }) };
    expect(await new MockAssist().run(ok)).toEqual({ a: "x" });
    await expect(new MockAssist().run({ ...ok, demo: () => ({ a: 1 }) as never })).rejects.toBeInstanceOf(AssistError);
  });
  it("uses the demo unless AI_PROVIDER=anthropic, and then needs a key", () => {
    expect(createAssist({}).isMock).toBe(true);
    expect(() => createAssist({ AI_PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(createAssist({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }).isMock).toBe(false);
  });
});

describe("letters and summaries", () => {
  it("are written only from an approved note, and never send the patient's name", async () => {
    const w = await world();
    const early = await w.svc.createConsult({ patientLabel: "Pat Jones", practitioner: "Olive", patientId: w.s.patient }, "o");
    await expect(w.p.documents.draftLetter(w.s.owner, early, "gp_update")).rejects.toMatchObject({ code: "invalid_state" });
    const id = await approved(w);
    const docId = await w.p.documents.draftLetter(w.s.owner, id, "gp_update", "Please review pain medication");
    const call = w.assist.calls.at(-1)!;
    expect(call.user).toContain("Please review pain medication");
    expect(call.user + call.system).not.toMatch(/Pat|Jones|pat@example|07700|1980/);
    const { doc, context } = await w.p.documents.get(w.s.clinicId, docId);
    expect(doc).toMatchObject({ kind: "gp_update", status: "draft", createdBy: "olive@example.com" });
    expect(context.patientName).toBe("Pat Jones");
    expect(context.dob).toBe("1980-05-04");
  });

  it("can be edited as a draft, finalised once, and then not changed", async () => {
    const w = await world();
    const id = await approved(w);
    const docId = await w.p.documents.draftLetter(w.s.owner, id, "discharge");
    await w.p.documents.edit(w.s.owner, docId, { subject: "Discharge", body: "My wording." });
    await w.p.documents.finalise(w.s.owner, docId);
    const { doc } = await w.p.documents.get(w.s.clinicId, docId);
    expect(doc).toMatchObject({ status: "final", subject: "Discharge", body: "My wording.", finalisedBy: "Olive Owner" });
    await expect(w.p.documents.edit(w.s.owner, docId, { subject: "", body: "Changed" })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(w.p.documents.finalise(w.s.owner, docId)).rejects.toMatchObject({ code: "invalid_state" });
    await expect(w.p.documents.deleteDraft(w.s.owner, docId)).rejects.toMatchObject({ code: "invalid_state" });
    await expect(w.p.documents.edit(w.s.owner, "nope", { subject: "", body: "x" })).rejects.toMatchObject({ code: "not_found" });
    const actions = (await w.s.q.all("SELECT action FROM audit_log WHERE entity = 'document' ORDER BY id")).map((r) => r.action);
    expect(actions).toEqual(["document.drafted", "document.edited", "document.finalised"]);
  });

  it("show a patient summary on the patient's link only once finalised, and not after withdrawal", async () => {
    const w = await world();
    const id = await approved(w);
    const { token } = await w.svc.createPatientLink(id, "olive");
    w.assist.answers.patient_summary = { text: "You hurt your knee.\n\nDo your exercises." };
    const docId = await w.p.documents.draftSummary(w.s.owner, id, "plain", "Polish");
    expect(w.assist.calls.at(-1)!.system).toContain("Write the summary in Polish");
    expect((await w.svc.getPatientView(token))!.summary).toBeNull();
    await w.p.documents.finalise(w.s.owner, docId);
    expect((await w.svc.getPatientView(token))!.summary).toEqual({ text: "You hurt your knee.\n\nDo your exercises.", language: "Polish" });
    await w.p.documents.withdraw(w.s.owner, docId);
    expect((await w.svc.getPatientView(token))!.summary).toBeNull();
    await expect(w.p.documents.withdraw(w.s.owner, docId)).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("save nothing when the assistant fails, and reject bad choices", async () => {
    const w = await world();
    const id = await approved(w);
    w.assist.fail = true;
    await expect(w.p.documents.draftLetter(w.s.owner, id, "referral")).rejects.toMatchObject({ code: "draft_failed" });
    expect(await w.p.documents.list(w.s.clinicId, id)).toEqual([]);
    w.assist.fail = false;
    await expect(w.p.documents.draftLetter(w.s.owner, id, "love_letter")).rejects.toMatchObject({ code: "validation" });
    await expect(w.p.documents.draftSummary(w.s.owner, id, "plain", "Klingon<script>")).rejects.toMatchObject({ code: "validation" });
    await expect(w.p.documents.draftSummary(w.s.owner, id, "chatty", "English")).rejects.toMatchObject({ code: "validation" });
  });

  it("are not for reception, other clinics or Ayurveda consultations", async () => {
    const w = await world();
    const id = await approved(w);
    await expect(w.p.documents.draftLetter(as(w.s, "reception"), id, "gp_update")).rejects.toMatchObject({ code: "forbidden" });
    const docId = await w.p.documents.draftLetter(w.s.owner, id, "gp_update");
    await w.s.q.run("INSERT INTO clinics (id, name, slug, created_at) VALUES ('clinic-z', 'Other', 'other', '2026-10-12T00:00:00.000Z')");
    await expect(w.p.documents.get("clinic-z", docId)).rejects.toMatchObject({ code: "not_found" });
    expect(await w.p.documents.list("clinic-z", id)).toEqual([]);
    await w.s.q.run("UPDATE consults SET discipline = 'ayurveda' WHERE id = ?", [id]);
    await expect(w.p.documents.draftLetter(w.s.owner, id, "gp_update")).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("are included in a patient export and removed when the patient is anonymised", async () => {
    const w = await world();
    const id = await approved(w);
    const docId = await w.p.documents.draftLetter(w.s.owner, id, "gp_update");
    await w.p.documents.finalise(w.s.owner, docId);
    const out = (await w.p.records.exportPatient(w.s.owner, w.s.patient)) as any;
    expect(out.consultations[0].documents).toHaveLength(1);
    expect(out.consultations[0].documents[0]).toMatchObject({ kind: "gp_update", status: "final" });
    w.s.clock.now = new Date("2036-01-01T00:00:00Z");
    await w.p.records.anonymise(w.s.owner, w.s.patient, { override: true, reason: "Patient asked for erasure of everything" });
    expect(await w.p.documents.list(w.s.clinicId, id)).toEqual([]);
  });
});

describe("second look at a note and code suggestions", () => {
  const onScreen = async (w: World, id: string) => {
    const v = await w.svc.getConsult(id);
    return { note: v.note, programme: v.programme };
  };
  async function drafted(w: World) {
    const id = await w.svc.createConsult({ patientLabel: "J.B.", practitioner: "Olive" }, "o");
    await w.svc.recordConsent(id, { method: "verbal", by: "O" }, "o");
    await w.svc.saveTranscript(id, TRANSCRIPT, "o");
    await w.svc.generateDrafts(id, "o");
    return id;
  }

  it("keeps assistant findings only when they cite a real transcript line, and adds the plain checks", async () => {
    const w = await world();
    const id = await drafted(w);
    w.assist.answers.note_second_look = { findings: [{ message: "Knee flexion is 110 degrees in the transcript.", lines: [3, 99] }, { message: "Made up.", lines: [] }, { message: "Off the end.", lines: [50] }] };
    const r = await w.p.assistant.checkNote(w.s.owner, id, await onScreen(w, id));
    const ai = r.findings.filter((f) => f.source === "assistant");
    expect(ai).toEqual([{ severity: "check", message: "Knee flexion is 110 degrees in the transcript.", source: "assistant", lines: [3] }]);
    expect(r.assistant).toBe("ok");
    expect(w.assist.calls.at(-1)!.user).toContain("3: Physio: On examination");
  });

  it("still returns the plain checks when the assistant is down, and checks the note on screen", async () => {
    const w = await world();
    const id = await drafted(w);
    w.assist.fail = true;
    const screen = await onScreen(w, id);
    screen.note.assessment = "";
    const r = await w.p.assistant.checkNote(w.s.owner, id, screen);
    expect(r.assistant).toBe("unavailable");
    expect(r.findings.some((f) => f.message === "Assessment is empty.")).toBe(true);
    await expect(w.p.assistant.checkNote(w.s.owner, id, { note: { nonsense: true }, programme: {} })).rejects.toMatchObject({ code: "validation" });
    await expect(w.p.assistant.checkNote(as(w.s, "reception"), id, screen)).rejects.toMatchObject({ code: "forbidden" });
    const noConsent = await w.svc.createConsult({ patientLabel: "X", practitioner: "O" }, "o");
    await expect(w.p.assistant.checkNote(w.s.owner, noConsent, screen)).rejects.toMatchObject({ code: "consent_required" });
  });

  it("audits that a check happened without keeping its text", async () => {
    const w = await world();
    const id = await drafted(w);
    await w.p.assistant.checkNote(w.s.owner, id, await onScreen(w, id));
    const [row] = await w.s.q.all("SELECT detail FROM audit_log WHERE action = 'note.checked'");
    expect(Object.keys(JSON.parse(row.detail as string)).sort()).toEqual(["assistant", "assistantState", "rules"]);
  });

  it("suggests codes only for an approved note, keeps valid-looking codes, and shows at most three", async () => {
    const w = await world();
    const early = await drafted(w);
    await expect(w.p.assistant.suggestCodes(w.s.owner, early)).rejects.toMatchObject({ code: "invalid_state" });
    const id = await approved(w);
    w.assist.answers.claim_codes = { suggestions: [
      { code: "m25.56", description: "Pain in knee", reason: "Knee pain recorded" },
      { code: "not a code", description: "x", reason: "y" },
      { code: "M17.9", description: "Osteoarthritis of knee, unspecified", reason: "r" },
      { code: "S83.5", description: "Cruciate sprain", reason: "r" },
      { code: "M23.2", description: "Meniscus", reason: "r" },
    ] };
    const out = await w.p.assistant.suggestCodes(w.s.owner, id);
    expect(out.map((c) => c.code)).toEqual(["M25.56", "M17.9", "S83.5"]);
    w.assist.fail = true;
    await expect(w.p.assistant.suggestCodes(w.s.owner, id)).rejects.toMatchObject({ code: "draft_failed" });
  });
});
