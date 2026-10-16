import { describe, expect, it } from "vitest";
import { platformSetup, type PlatformSetup } from "./platform.helpers";
import { DEFAULT_AYURVEDA_INTAKE_FIELDS, FormFields } from "@/lib/forms";

const MON_9 = "2026-10-19T08:00:00.000Z";
const MON_11 = "2026-10-19T10:00:00.000Z";

async function formsFor(s: PlatformSetup, typeId: string, startAt: string) {
  const id = await s.p.scheduling.createAppointment(s.clinicId, "u", { patientId: s.patient, userId: s.owner.id, typeId, startAt, source: "staff" });
  return (await s.q.all<{ form_name: string }>("SELECT form_name FROM form_requests WHERE appointment_id = ? ORDER BY form_name", [id])).map((r) => r.form_name);
}

describe("intake forms by discipline", () => {
  it("the Ayurveda starter form is valid, asks for medicines, herbal products and allergies, and has no physio red-flag questions", () => {
    expect(FormFields.safeParse(DEFAULT_AYURVEDA_INTAKE_FIELDS).success).toBe(true);
    const req = (id: string) => DEFAULT_AYURVEDA_INTAKE_FIELDS.find((f) => f.id === id)?.required;
    expect(req("medication")).toBe(true);
    expect(req("supplements")).toBe(true);
    expect(req("allergies")).toBe(true);
    expect(req("pregnancy")).toBe(true);
    expect(DEFAULT_AYURVEDA_INTAKE_FIELDS.some((f) => f.id === "numbness" || f.id === "night_pain")).toBe(false);
    expect(new Set(DEFAULT_AYURVEDA_INTAKE_FIELDS.map((f) => f.id)).size).toBe(DEFAULT_AYURVEDA_INTAKE_FIELDS.length);
  });

  it("adding Ayurveda adds its form once and stops the physio form going to Ayurveda appointments", async () => {
    const s = await platformSetup();
    await s.p.scheduling.setDisciplines(s.clinicId, "olive", "both");
    await s.p.scheduling.setDisciplines(s.clinicId, "olive", "both");
    const forms = await s.p.forms.list(s.clinicId);
    expect(forms.map((f) => `${f.discipline}:${f.name}`).sort()).toEqual(["ayurveda:New patient intake (Ayurveda)", "physio:New patient intake"]);

    const ayu = (await s.p.scheduling.listTypes(s.clinicId)).find((t) => t.discipline === "ayurveda")!;
    expect(await formsFor(s, s.initial.id, MON_9)).toEqual(["New patient intake"]);
    expect(await formsFor(s, ayu.id, MON_11)).toEqual(["New patient intake (Ayurveda)"]);
  });

  it("a form for everyone goes with both, and the setting can be changed on a new version", async () => {
    const s = await platformSetup();
    await s.p.scheduling.setDisciplines(s.clinicId, "olive", "both");
    const ayu = (await s.p.scheduling.listTypes(s.clinicId)).find((t) => t.discipline === "ayurveda")!;
    await s.p.forms.save(s.clinicId, "olive", { name: "Photo consent", kind: "consent", fieldsJson: JSON.stringify([{ id: "ok", label: "I agree", type: "agree", required: true }]), mandatory: false, active: true });
    expect(await formsFor(s, s.initial.id, MON_9)).toEqual(["New patient intake", "Photo consent"]);
    expect(await formsFor(s, ayu.id, MON_11)).toEqual(["New patient intake (Ayurveda)", "Photo consent"]);

    const physio = (await s.p.forms.list(s.clinicId)).find((f) => f.name === "New patient intake")!;
    await s.p.forms.save(s.clinicId, "olive", { id: physio.id, name: physio.name, kind: "intake", fieldsJson: JSON.stringify(physio.fields), mandatory: true, active: true });
    const after = await s.p.forms.get(s.clinicId, physio.id);
    expect(after.version).toBe(physio.version + 1);
    expect(after.discipline).toBe("physio"); // saving without a choice keeps it
    await expect(s.p.forms.save(s.clinicId, "olive", { id: physio.id, name: "x", kind: "intake", fieldsJson: JSON.stringify(physio.fields), mandatory: true, active: true, discipline: "nope" as never })).rejects.toThrow();
  });

  it("a new clinic set up for Ayurveda only gets only the Ayurveda form; a physio clinic only the physio one", async () => {
    const s = await platformSetup();
    expect((await s.p.forms.list(s.clinicId)).map((f) => f.discipline)).toEqual(["physio"]);
    const c = await s.p.scheduling.clinic(s.clinicId);
    expect(c.disciplines).toBe("physio");
  });
});
