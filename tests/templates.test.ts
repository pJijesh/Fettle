import { describe, expect, it } from "vitest";
import { emptyNote, NoteDraft } from "@/lib/schemas";
import { applyTemplate, bodyFromText, bodyToText, STARTER_TEMPLATES, TemplateBody } from "@/lib/templates";
import { approvalIssues } from "@/lib/validation";
import { emptyProgramme } from "@/lib/schemas";
import { platformSetup } from "./platform.helpers";

const body = (o: object = {}) => JSON.stringify({ objective: "Posture:", rom: [{ joint: "Knee", movement: "Flexion", side: "left" }], outcomeMeasures: [{ name: "NPRS", scale: "0-10" }], specialTests: [{ name: "Lachman", side: "left" }], ...o });

describe("applying a template", () => {
  it("adds rows with nothing filled in, and no finding of any kind", () => {
    const { note, added } = applyTemplate(emptyNote(), TemplateBody.parse(JSON.parse(body())));
    expect(note.rom).toEqual([{ joint: "Knee", side: "left", movement: "Flexion", value: "", unit: "deg", evidence: [] }]);
    expect(note.outcomeMeasures).toEqual([{ name: "NPRS", score: "", scale: "0-10", evidence: [] }]);
    expect(note.specialTests).toEqual([{ name: "Lachman", side: "left", result: "", evidence: [] }]);
    expect(note.objective).toBe("Posture:");
    expect(added).toEqual(["objective", "3 rows to fill in"]);
    expect(NoteDraft.safeParse(note).success).toBe(true);
  });

  it("cannot confirm red-flag screening, add a problem or make a note approvable", () => {
    const { note } = applyTemplate(emptyNote(), TemplateBody.parse(JSON.parse(body({ subjective: "x", assessment: "y", plan: "z" }))));
    expect(note.redFlags).toEqual({ screened: false, findings: [], notes: "" });
    expect(note.problems).toEqual([]);
    expect(approvalIssues({ note, programme: emptyProgramme() }).map((i) => i.path)).toContain("note.redFlags.screened");
  });

  it("never overwrites or removes what the clinician already has", () => {
    const before = emptyNote();
    before.objective = "My own findings";
    before.rom = [{ joint: "knee", side: "left", movement: "flexion", value: "120", unit: "deg", evidence: [3] }];
    before.outcomeMeasures = [{ name: "nprs", score: "6", scale: "0-10", evidence: [] }];
    const { note, added } = applyTemplate(before, TemplateBody.parse(JSON.parse(body())));
    expect(note.objective).toBe("My own findings");
    expect(note.rom).toEqual(before.rom);
    expect(note.outcomeMeasures).toEqual(before.outcomeMeasures);
    expect(note.specialTests).toHaveLength(1);
    expect(added).toEqual(["1 row to fill in"]);
    expect(before.specialTests).toEqual([]); // the original is untouched
  });

  it("applying twice adds nothing the second time", () => {
    const t = TemplateBody.parse(JSON.parse(body()));
    const once = applyTemplate(emptyNote(), t).note;
    const twice = applyTemplate(once, t);
    expect(twice.note).toEqual(once);
    expect(twice.added).toEqual([]);
  });

  it("the starter templates are valid and hold no values", () => {
    expect(STARTER_TEMPLATES.length).toBeGreaterThan(0);
    for (const s of STARTER_TEMPLATES) {
      const { note } = applyTemplate(emptyNote(), s.body);
      expect(NoteDraft.safeParse(note).success).toBe(true);
      expect(note.rom.every((r) => r.value === "")).toBe(true);
      expect(note.outcomeMeasures.every((m) => m.score === "")).toBe(true);
      expect(note.specialTests.every((t) => t.result === "")).toBe(true);
    }
  });
});

describe("writing a template as text", () => {
  it("reads one row per line and survives a round trip", () => {
    const json = bodyFromText({ subjective: "", objective: "Gait:", rom: "Hip, Flexion, LEFT\n\nHip, Flexion, right, deg\nGrip, strength, , other", outcomeMeasures: "NPRS, 0-10\nLEFS", specialTests: "FADIR, both\nThomas test, sideways", assessment: "", plan: "" });
    const b = TemplateBody.parse(JSON.parse(json));
    expect(b.rom.map((r) => [r.joint, r.side, r.unit])).toEqual([["Hip", "left", "deg"], ["Hip", "right", "deg"], ["Grip", "na", "other"]]);
    expect(b.outcomeMeasures).toEqual([{ name: "NPRS", scale: "0-10" }, { name: "LEFS", scale: "" }]);
    expect(b.specialTests).toEqual([{ name: "FADIR", side: "both" }, { name: "Thomas test", side: "na" }]);
    expect(TemplateBody.parse(JSON.parse(bodyFromText(bodyToText(b))))).toEqual(b);
  });
});

describe("keeping templates", () => {
  it("creates, lists, edits and deletes, with an audit trail", async () => {
    const s = await platformSetup();
    const id = await s.p.templates.save(s.clinicId, "olive@example.com", { name: "Knee review", bodyJson: body(), active: true });
    expect((await s.p.templates.list(s.clinicId)).map((t) => t.name)).toEqual(["Knee review"]);
    await s.p.templates.save(s.clinicId, "olive@example.com", { id, name: "Knee review v2", bodyJson: body({ plan: "Review in 2 weeks" }), active: false });
    const [t] = await s.p.templates.list(s.clinicId);
    expect(t).toMatchObject({ name: "Knee review v2", active: false });
    expect(t.body.plan).toBe("Review in 2 weeks");
    expect(await s.p.templates.list(s.clinicId, { activeOnly: true })).toEqual([]);
    await s.p.templates.remove(s.clinicId, "olive@example.com", id);
    expect(await s.p.templates.list(s.clinicId)).toEqual([]);
    const log = await s.q.all("SELECT action FROM audit_log WHERE entity = 'note_template' ORDER BY id");
    expect(log.map((r) => r.action)).toEqual(["note_template.created", "note_template.updated", "note_template.deleted"]);
  });

  it("refuses an empty name, a repeated name and a bad body", async () => {
    const s = await platformSetup();
    const save = (name: string, bodyJson = body()) => s.p.templates.save(s.clinicId, "o", { name, bodyJson, active: true });
    await expect(save("  ")).rejects.toMatchObject({ code: "validation" });
    await save("Knee review");
    await expect(save("KNEE REVIEW")).rejects.toMatchObject({ code: "conflict" });
    await expect(save("Other", "not json")).rejects.toMatchObject({ code: "validation" });
    await expect(save("Other", JSON.stringify({ rom: [{ joint: "" }] }))).rejects.toMatchObject({ code: "validation" });
  });

  it("starters are added once and a clinic's own edits to them are kept", async () => {
    const s = await platformSetup();
    expect(await s.p.templates.addStarters(s.clinicId, "o")).toBe(STARTER_TEMPLATES.length);
    const first = (await s.p.templates.list(s.clinicId)).find((t) => t.name === "Follow-up")!;
    await s.p.templates.save(s.clinicId, "o", { id: first.id, name: "Follow-up", bodyJson: body({ plan: "mine" }), active: true });
    expect(await s.p.templates.addStarters(s.clinicId, "o")).toBe(0);
    expect((await s.p.templates.list(s.clinicId)).find((t) => t.name === "Follow-up")!.body.plan).toBe("mine");
  });

  it("keeps each clinic's templates to itself", async () => {
    const s = await platformSetup();
    const id = await s.p.templates.save(s.clinicId, "o", { name: "Mine", bodyJson: body(), active: true });
    await s.q.run("INSERT INTO clinics (id, name, slug, created_at) VALUES ('clinic-z', 'Other', 'other', '2026-10-12T00:00:00.000Z')");
    expect(await s.p.templates.list("clinic-z")).toEqual([]);
    await expect(s.p.templates.remove("clinic-z", "x", id)).rejects.toMatchObject({ code: "not_found" });
    await expect(s.p.templates.save("clinic-z", "x", { id, name: "Taken", bodyJson: body(), active: true })).rejects.toMatchObject({ code: "not_found" });
    expect(await s.p.templates.list(s.clinicId)).toHaveLength(1);
    // The same name is free in another clinic.
    await s.p.templates.save("clinic-z", "x", { name: "Mine", bodyJson: body(), active: true });
  });
});
