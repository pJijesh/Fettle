import { describe, expect, it } from "vitest";
import { setup, type Setup } from "./helpers";
import { platformSetup } from "./platform.helpers";
import { emptyPlan, emptyRecord, type AyurvedaPlan, type AyurvedaRecord } from "@/lib/ayurveda/schemas";
import { LIBRARY, getLibraryItem } from "@/lib/ayurveda/catalogue";
import { ayurvedaApprovalIssues } from "@/lib/ayurveda/validation";
import { ayurvedaNoteToText } from "@/lib/ayurveda/format";

async function ayurvedaClinic() {
  const s = await setup();
  await s.q.run("UPDATE clinics SET disciplines = 'both' WHERE id = 'clinic-1'");
  return s;
}

const goodRecord = (over: Partial<AyurvedaRecord> = {}): AyurvedaRecord => ({
  ...emptyRecord(),
  qualifications: "BAMS",
  chiefComplaint: "Irregular digestion and poor sleep for six months",
  history: "Worse under stress",
  medications: "None",
  allergies: "None known",
  prakriti: { doshas: ["vata", "pitta"], notes: "" },
  vikriti: { doshas: ["vata"], notes: "Dry skin, light sleep" },
  agni: "vishama",
  ama: "present",
  safety: { screened: true, pregnancy: "not_applicable", findings: [], notes: "" },
  assessment: "Vata aggravation with irregular agni",
  ...over,
});

const goodPlan = (over: Partial<AyurvedaPlan> = {}): AyurvedaPlan => ({
  ...emptyPlan(),
  items: [
    { kind: "therapy", libraryId: "abhyanga", name: "Abhyanga (warm oil massage)", instructions: "Weekly session", duration: "4 weeks", where: "clinic", cautions: "Check oil allergies" },
    { kind: "diet", libraryId: "regular_meals", name: "Regular meal times", instructions: "Eat at similar times each day.", duration: "", where: "home", cautions: "" },
  ],
  reviewInWeeks: 4,
  ...over,
});

async function consent(s: Setup, id: string) {
  await s.service.recordConsent(id, { method: "verbal", by: "Dr Anand" }, "anand");
}
const newConsult = (s: Setup) => s.service.createConsult({ patientLabel: "P.K.", practitioner: "Dr Anand", discipline: "ayurveda" }, "anand");

describe("disciplines", () => {
  it("starts as physiotherapy and can be changed to Ayurveda or both, adding starter types", async () => {
    const s = await platformSetup();
    expect((await s.p.scheduling.clinic(s.clinicId)).disciplines).toBe("physio");
    await s.p.scheduling.setDisciplines(s.clinicId, "olive", "both");
    expect((await s.p.scheduling.clinic(s.clinicId)).disciplines).toBe("both");
    const types = await s.p.scheduling.listTypes(s.clinicId);
    expect(types.filter((t) => t.discipline === "ayurveda").map((t) => t.name)).toEqual(["Ayurvedic follow-up", "Ayurvedic therapy session", "Initial Ayurvedic consultation"]);
    expect(types.filter((t) => t.discipline === "physio")).toHaveLength(3);
    // Choosing it again does not add a second set.
    await s.p.scheduling.setDisciplines(s.clinicId, "olive", "both");
    expect((await s.p.scheduling.listTypes(s.clinicId)).length).toBe(6);
  });

  it("will not switch a discipline off while its appointment types are still offered", async () => {
    const s = await platformSetup();
    await s.p.scheduling.setDisciplines(s.clinicId, "olive", "both");
    await expect(s.p.scheduling.setDisciplines(s.clinicId, "olive", "ayurveda")).rejects.toThrow(/Stop offering the physiotherapy/);
    for (const t of await s.p.scheduling.listTypes(s.clinicId)) {
      if (t.discipline === "physio") await s.p.scheduling.saveType(s.clinicId, "olive", { id: t.id, name: t.name, durationMin: t.durationMin, bufferMin: t.bufferMin, onlineBookable: t.onlineBookable, colour: t.colour, active: false });
    }
    await s.p.scheduling.setDisciplines(s.clinicId, "olive", "ayurveda");
    expect((await s.p.scheduling.clinic(s.clinicId)).disciplines).toBe("ayurveda");
    await expect(s.p.scheduling.setDisciplines(s.clinicId, "olive", "nonsense" as never)).rejects.toThrow();
  });

  it("only lets a type be created for a discipline the clinic practises", async () => {
    const s = await platformSetup();
    await expect(
      s.p.scheduling.saveType(s.clinicId, "olive", { name: "Ayurvedic massage", durationMin: 60, bufferMin: 10, onlineBookable: false, colour: "purple", discipline: "ayurveda" }),
    ).rejects.toThrow(/Turn that discipline on/);
    await s.p.scheduling.setDisciplines(s.clinicId, "olive", "both");
    const id = await s.p.scheduling.saveType(s.clinicId, "olive", { name: "Ayurvedic massage", durationMin: 60, bufferMin: 10, onlineBookable: false, colour: "purple", discipline: "ayurveda" });
    expect((await s.p.scheduling.getType(s.clinicId, id)).discipline).toBe("ayurveda");
  });
});

describe("Ayurvedic consultation", () => {
  it("is refused when the clinic does not practise Ayurveda", async () => {
    const s = await setup();
    await expect(newConsult(s)).rejects.toThrow(/not set up for Ayurveda/);
  });

  it("needs consent before anything is saved, and has no transcript or AI drafting", async () => {
    const s = await ayurvedaClinic();
    const id = await newConsult(s);
    await expect(s.service.saveAyurveda(id, { record: goodRecord(), plan: goodPlan() }, "anand")).rejects.toThrow(/consent/i);
    await consent(s, id);
    await expect(s.service.saveTranscript(id, "hello", "anand")).rejects.toThrow(/no transcript or AI drafting/);
    await expect(s.service.generateDrafts(id, "anand")).rejects.toThrow(/no transcript or AI drafting/);
    await expect(s.service.saveDrafts(id, { note: {}, programme: {} }, "anand")).rejects.toThrow(/no transcript or AI drafting/);
  });

  it("saves the practitioner's own record and plan, and reads it back", async () => {
    const s = await ayurvedaClinic();
    const id = await newConsult(s);
    await consent(s, id);
    await s.service.saveAyurveda(id, { record: goodRecord(), plan: goodPlan() }, "anand");
    const v = await s.service.getConsult(id);
    expect(v).toMatchObject({ discipline: "ayurveda", status: "drafted", draftModel: null });
    expect(v.ayurveda!.record.prakriti.doshas).toEqual(["vata", "pitta"]);
    expect(v.ayurveda!.plan.items).toHaveLength(2);
    expect(v.note.subjective).toBe("");
    await expect(s.service.saveAyurveda(id, { record: { ...goodRecord(), agni: "weird" }, plan: goodPlan() }, "anand")).rejects.toThrow(/not valid/);
  });

  it("is not for a physiotherapy consultation", async () => {
    const s = await ayurvedaClinic();
    const id = await s.service.createConsult({ patientLabel: "J.B.", practitioner: "Sam" }, "sam");
    await consent(s, id);
    await expect(s.service.saveAyurveda(id, { record: goodRecord(), plan: goodPlan() }, "sam")).rejects.toThrow(/not an Ayurvedic/);
  });

  it("will not approve an unfinished record, and says what is missing", async () => {
    const s = await ayurvedaClinic();
    const id = await newConsult(s);
    await consent(s, id);
    await s.service.saveAyurveda(id, { record: emptyRecord(), plan: goodPlan() }, "anand");
    const err = await s.service.approve(id, "Dr Anand").catch((e) => e);
    expect(err.message).toMatch(/Fix these/);
    const paths = err.issues.map((i: { path: string }) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["record.qualifications", "record.safety.screened", "record.safety.pregnancy", "record.medications", "record.allergies", "record.chiefComplaint", "record.assessment"]));
  });

  it("approves a complete one, freezes it, and renders a copy-ready note", async () => {
    const s = await ayurvedaClinic();
    const id = await newConsult(s);
    await consent(s, id);
    await s.service.saveAyurveda(id, { record: goodRecord(), plan: goodPlan() }, "anand");
    const { hash } = await s.service.approve(id, "Dr Anand");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    await expect(s.service.saveAyurveda(id, { record: goodRecord({ assessment: "changed" }), plan: goodPlan() }, "anand")).rejects.toThrow(/approved/);
    const text = await s.service.approvedNoteText(id);
    expect(text).toContain("Constitution (prakriti)\nVata–Pitta");
    expect(text).toContain("Therapies\n- Abhyanga (warm oil massage) (in clinic): Weekly session For 4 weeks.");
    expect(text).toContain("Written and approved by Dr Anand (BAMS)");
    expect(text).not.toMatch(/AI assistance/);
    const v = await s.service.getConsult(id);
    expect(v.approval!.ayurveda!.record.chiefComplaint).toMatch(/digestion/);
    const log = (await s.q.all("SELECT action FROM audit_log WHERE consult_id = ?", [id])).map((r) => r.action);
    expect(log).toEqual(expect.arrayContaining(["ayurveda.saved", "ayurveda.approved"]));
  });

  it("gives the patient a grouped plan through a link, and takes a check-in", async () => {
    const s = await ayurvedaClinic();
    const id = await newConsult(s);
    await consent(s, id);
    await s.service.saveAyurveda(id, { record: goodRecord(), plan: goodPlan({ safetyAdvice: ["Stop and ring us if you feel unwell."] }) }, "anand");
    await s.service.approve(id, "Dr Anand");
    const { token } = await s.service.createPatientLink(id, "anand");
    const view = (await s.service.getPatientView(token))!;
    expect(view.discipline).toBe("ayurveda");
    expect(view.programme.items).toEqual([]);
    expect(view.ayurveda!.groups.map((g) => g.kind)).toEqual(["therapy", "diet"]);
    expect(view.ayurveda!.groups[0].items[0]).toMatchObject({ name: "Abhyanga (warm oil massage)", where: "clinic" });
    expect(view.ayurveda!.safetyAdvice).toHaveLength(1);
    await s.service.submitCheckIn(token, { adherence: "some", painChange: "better", comment: "Sleeping better" });
    expect((await s.service.getConsult(id)).checkIns).toHaveLength(1);
  });

  it("will not send a plan with nothing in it", async () => {
    const s = await ayurvedaClinic();
    const id = await newConsult(s);
    await consent(s, id);
    await s.service.saveAyurveda(id, { record: goodRecord(), plan: goodPlan({ items: [] }) }, "anand");
    await s.service.approve(id, "Dr Anand");
    await expect(s.service.createPatientLink(id, "anand")).rejects.toThrow(/nothing to send/);
  });

  it("deletes the record and plan when consent is withdrawn before approval", async () => {
    const s = await ayurvedaClinic();
    const id = await newConsult(s);
    await consent(s, id);
    await s.service.saveAyurveda(id, { record: goodRecord(), plan: goodPlan() }, "anand");
    await s.service.withdrawConsent(id, "anand");
    const row = await s.q.get("SELECT note_json, programme_json, status FROM consults WHERE id = ?", [id]);
    expect(row).toMatchObject({ note_json: null, programme_json: null, status: "created" });
  });

  it("writes to the practice system with an Ayurvedic title", async () => {
    const s = await ayurvedaClinic();
    const id = await s.service.createConsult({ patientLabel: "P.K.", practitioner: "Dr Anand", discipline: "ayurveda", pmsPatientId: "777" }, "anand");
    await consent(s, id);
    await s.service.saveAyurveda(id, { record: goodRecord(), plan: goodPlan() }, "anand");
    await s.service.approve(id, "Dr Anand");
    await s.service.writeBack(id, "cliniko", "anand");
    expect(JSON.stringify(s.target)).toMatch(/Ayurvedic consultation/);
  });
});

describe("approval rules for herbs and plan items", () => {
  const herb = (over = {}) => ({ kind: "herb" as const, libraryId: null, name: "Ashwagandha", instructions: "Practitioner's dose and form", duration: "6 weeks", where: "home" as const, cautions: "Avoid in pregnancy", ...over });

  it("accepts a herb the practitioner has fully described", () => {
    expect(ayurvedaApprovalIssues({ record: goodRecord(), plan: goodPlan({ items: [herb()] }) })).toEqual([]);
  });

  it("insists a herb has instructions, a duration and cautions", () => {
    const paths = ayurvedaApprovalIssues({ record: goodRecord(), plan: goodPlan({ items: [herb({ instructions: "", duration: "", cautions: "" })] }) }).map((i) => i.path);
    expect(paths).toEqual(["plan.items.0.instructions", "plan.items.0.duration", "plan.items.0.cautions"]);
  });

  it("rejects duplicates, unknown or mismatched library items", () => {
    const a = goodPlan().items[0];
    const issues = ayurvedaApprovalIssues({
      record: goodRecord(),
      plan: goodPlan({ items: [a, a, { ...a, name: "Mystery", libraryId: "nope" }, { ...a, name: "Wrong kind", kind: "diet" }] }),
    });
    expect(issues.map((i) => i.message).join(" | ")).toMatch(/listed twice.*Unknown library item "nope".*not of that kind/);
  });
});

describe("starter library", () => {
  it("has no herbs and no doses, and every item names its cautions", () => {
    expect(LIBRARY.every((i) => (i.kind as string) !== "herb")).toBe(true);
    expect(LIBRARY.every((i) => i.cautions.length > 10 && i.instructions.length > 10)).toBe(true);
    expect(LIBRARY.some((i) => /\b\d+\s?(mg|g|ml|tsp|tbsp|capsules?|tablets?)\b/i.test(i.instructions))).toBe(false);
    expect(new Set(LIBRARY.map((i) => i.id)).size).toBe(LIBRARY.length);
    expect(getLibraryItem("abhyanga")?.where).toBe("clinic");
  });

  it("leaves out the intensive cleansing procedures", () => {
    expect(LIBRARY.map((i) => i.id).filter((id) => /vamana|virechana|^basti$|raktamokshana/.test(id))).toEqual([]);
  });

  it("renders an empty record without failing", () => {
    expect(ayurvedaNoteToText(emptyRecord(), emptyPlan())).toMatch(/Agni: Not assessed/);
  });
});
