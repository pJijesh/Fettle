import crypto from "node:crypto";
import { z } from "zod";
import type { Db } from "./db";
import { DomainError } from "./errors";
import type { AppointmentView } from "./scheduling";

/** Intake and consent forms (E1.5). A form is versioned; each request freezes the version the patient answered. */

export const FieldType = z.enum(["text", "longtext", "yesno", "choice", "date", "number", "scale", "agree"]);
export const FormField = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/, "field ids are lower case letters, digits and underscores"),
  label: z.string().trim().min(1).max(200),
  type: FieldType,
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  help: z.string().trim().max(300).optional(),
});
export type FormField = z.infer<typeof FormField>;
export const FormFields = z.array(FormField).min(1).max(60);

export interface FormDef {
  id: string;
  name: string;
  kind: "intake" | "consent";
  fields: FormField[];
  mandatory: boolean;
  active: boolean;
  version: number;
  /** "any" is sent with every appointment; otherwise only with appointments of that discipline. */
  discipline: FormDiscipline;
}

export type FormDiscipline = "any" | "physio" | "ayurveda";

export interface FormRequestView {
  id: string;
  appointmentId: string;
  patientId: string;
  formName: string;
  mandatory: boolean;
  status: "pending" | "completed";
  fields: FormField[];
  response: Record<string, string> | null;
  completedAt: string | null;
}

/** A sensible starting form. The clinic should review and edit it; it is a template, not clinical advice. */
export const DEFAULT_INTAKE_FIELDS: FormField[] = [
  { id: "reason", label: "What brings you in?", type: "longtext", required: true },
  { id: "onset", label: "When did it start?", type: "text", required: false },
  { id: "pain_now", label: "Pain right now (0 = none, 10 = worst imaginable)", type: "scale", required: false },
  { id: "history", label: "Anything in your medical history we should know about?", type: "longtext", required: false },
  { id: "medication", label: "Medication you take", type: "longtext", required: false },
  { id: "allergies", label: "Allergies", type: "text", required: false },
  { id: "night_pain", label: "Is the pain worse at night or does it wake you?", type: "yesno", required: true },
  { id: "numbness", label: "Any numbness, pins and needles or weakness?", type: "yesno", required: true },
  { id: "unwell", label: "Have you been generally unwell, with fever or unexplained weight loss?", type: "yesno", required: true },
  { id: "consent", label: "I agree to my information being used for my care, as set out in the clinic's privacy notice.", type: "agree", required: true },
];

/**
 * A starting intake form for Ayurveda, written in plain language for the patient. Like the physiotherapy one it is a
 * template that has not been reviewed by a qualified practitioner. It asks nothing a practitioner could not ask in
 * the room, and the practitioner's own record (not this form) is what gets approved.
 */
export const DEFAULT_AYURVEDA_INTAKE_FIELDS: FormField[] = [
  { id: "reason", label: "What would you like help with?", type: "longtext", required: true },
  { id: "duration", label: "How long have you had this?", type: "text", required: false },
  { id: "doctor", label: "Are you under a doctor's or hospital's care for this?", type: "yesno", required: true },
  { id: "history", label: "Other health conditions, operations or past illnesses", type: "longtext", required: false },
  { id: "medication", label: "Medicines you take, including any prescribed by your doctor", type: "longtext", required: true, help: "Write 'none' if you take none." },
  { id: "supplements", label: "Herbal products, supplements or other remedies you take", type: "longtext", required: true, help: "Include anything bought without a prescription. Write 'none' if you take none." },
  { id: "allergies", label: "Allergies, including to oils, foods or herbs", type: "text", required: true, help: "Write 'none known' if you have none." },
  { id: "pregnancy", label: "Are you pregnant, breastfeeding or trying to conceive?", type: "choice", required: true, options: ["No", "Pregnant", "Breastfeeding", "Trying to conceive", "Not applicable", "Prefer to tell the practitioner"] },
  { id: "digestion", label: "How is your digestion and appetite?", type: "choice", required: false, options: ["Regular", "Irregular appetite", "Gas or bloating", "Acidity or burning", "Slow or heavy", "Constipation", "Loose stools"] },
  { id: "sleep", label: "How do you sleep?", type: "choice", required: false, options: ["Sound", "Light or broken", "Trouble falling asleep", "Wake early", "Sleep a lot and still tired"] },
  { id: "energy", label: "Your energy during the day (0 = very low, 10 = very good)", type: "scale", required: false },
  { id: "stress", label: "How stressed have you felt recently? (0 = not at all, 10 = extremely)", type: "scale", required: false },
  { id: "diet", label: "Your usual diet", type: "choice", required: false, options: ["Vegetarian", "Vegan", "Eggs and fish", "Mixed", "Other"] },
  { id: "previous", label: "Have you had Ayurvedic treatment before?", type: "yesno", required: false },
  { id: "unwell", label: "Have you been generally unwell, with fever, unexplained weight loss or severe pain?", type: "yesno", required: true },
  { id: "consent", label: "I agree to my information being used for my care, as set out in the clinic's privacy notice.", type: "agree", required: true },
];

/** Adds the starting intake form for a discipline. Used when a clinic is set up and when it adds a discipline. */
export async function addStarterForm(db: Db, clinicId: string, discipline: "physio" | "ayurveda", ts: string): Promise<void> {
  const [name, fields] = discipline === "ayurveda" ? ["New patient intake (Ayurveda)", DEFAULT_AYURVEDA_INTAKE_FIELDS] : ["New patient intake", DEFAULT_INTAKE_FIELDS];
  await db.run("INSERT INTO forms (id, clinic_id, name, kind, fields_json, mandatory, active, version, created_at, discipline) VALUES (?, ?, ?, 'intake', ?, 1, 1, 1, ?, ?)", [
    crypto.randomUUID(), clinicId, name, JSON.stringify(fields), ts, discipline,
  ]);
}

function parseFields(json: string): FormField[] {
  return FormFields.parse(JSON.parse(json));
}

export class Forms {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  private ts() {
    return this.now().toISOString();
  }

  private async audit(clinicId: string, by: string, action: string, detail: unknown) {
    await this.db.run("INSERT INTO audit_log (clinic_id, actor, action, detail, at, entity) VALUES (?, ?, ?, ?, ?, 'form')", [clinicId, by, action, JSON.stringify(detail), this.ts()]);
  }

  private toDef(r: Record<string, unknown>): FormDef {
    return {
      id: r.id as string,
      name: r.name as string,
      kind: r.kind as "intake" | "consent",
      fields: parseFields(r.fields_json as string),
      mandatory: !!r.mandatory,
      active: !!r.active,
      version: Number(r.version),
      discipline: ((r.discipline as string) ?? "any") as FormDiscipline,
    };
  }

  async list(clinicId: string): Promise<FormDef[]> {
    return this.db.scope(clinicId, async () => (await this.db.all("SELECT * FROM forms WHERE clinic_id = ? ORDER BY name", [clinicId])).map((r) => this.toDef(r)));
  }

  async get(clinicId: string, id: string): Promise<FormDef> {
    return this.db.scope(clinicId, async () => {
      const r = await this.db.get("SELECT * FROM forms WHERE id = ? AND clinic_id = ?", [id, clinicId]);
      if (!r) throw new DomainError("not_found", "Form not found");
      return this.toDef(r);
    });
  }

  /** Creates a form, or saves a new version of an existing one. Past requests keep the version they were sent with. */
  async save(clinicId: string, by: string, input: { id?: string; name: string; kind: "intake" | "consent"; fieldsJson: string; mandatory: boolean; active: boolean; discipline?: FormDiscipline }): Promise<string> {
    let fields: FormField[];
    try {
      const parsed = FormFields.safeParse(JSON.parse(input.fieldsJson));
      if (!parsed.success) {
        throw new DomainError(
          "validation",
          "Check the form's questions",
          parsed.error.issues.slice(0, 8).map((i) => ({ path: `fields.${i.path.join(".")}`, message: i.message })),
        );
      }
      fields = parsed.data;
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw new DomainError("validation", "The questions could not be read", [{ path: "fields", message: "Not valid JSON" }]);
    }
    const seen = new Set<string>();
    for (const f of fields) {
      if (seen.has(f.id)) throw new DomainError("validation", "Check the form's questions", [{ path: "fields", message: `Two questions share the id "${f.id}"` }]);
      seen.add(f.id);
      if (f.type === "choice" && !f.options?.length) {
        throw new DomainError("validation", "Check the form's questions", [{ path: "fields", message: `"${f.label}" needs options to choose from` }]);
      }
    }
    if (input.discipline !== undefined && !["any", "physio", "ayurveda"].includes(input.discipline)) {
      throw new DomainError("validation", "Choose who the form is for", [{ path: "discipline", message: "Choose everyone, physiotherapy or Ayurveda" }]);
    }
    if (!input.name.trim()) throw new DomainError("validation", "Enter a name", [{ path: "name", message: "Enter a name" }]);
    return this.db.scope(clinicId, async () => {
      if (input.id) {
        const cur = await this.get(clinicId, input.id);
        await this.db.run(
          "UPDATE forms SET name = ?, kind = ?, fields_json = ?, mandatory = ?, active = ?, version = ?, discipline = ? WHERE id = ? AND clinic_id = ?",
          [input.name.trim(), input.kind, JSON.stringify(fields), input.mandatory ? 1 : 0, input.active ? 1 : 0, cur.version + 1, input.discipline ?? cur.discipline, input.id, clinicId],
        );
        await this.audit(clinicId, by, "form.updated", { id: input.id, version: cur.version + 1 });
        return input.id;
      }
      const id = crypto.randomUUID();
      await this.db.run(
        "INSERT INTO forms (id, clinic_id, name, kind, fields_json, mandatory, active, version, created_at, discipline) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
        [id, clinicId, input.name.trim(), input.kind, JSON.stringify(fields), input.mandatory ? 1 : 0, input.active ? 1 : 0, this.ts(), input.discipline ?? "any"],
      );
      await this.audit(clinicId, by, "form.created", { id });
      return id;
    });
  }

  /** Attaches every active form that applies to the appointment's discipline. Used by the booking hook. */
  async requestForAppointment(a: AppointmentView, clinicId: string): Promise<FormRequestView[]> {
    return this.db.scope(clinicId, async () => {
      const type = await this.db.get<{ discipline: string }>("SELECT discipline FROM appointment_types WHERE id = ? AND clinic_id = ?", [a.typeId, clinicId]);
      const forms = (await this.list(clinicId)).filter((f) => f.active && (f.discipline === "any" || f.discipline === (type?.discipline ?? "physio")));
      const out: string[] = [];
      for (const f of forms) {
        // Returning patients do not redo a mandatory form they have already completed on this version.
        const done = await this.db.get(
          "SELECT 1 FROM form_requests WHERE patient_id = ? AND form_id = ? AND form_version = ? AND status = 'completed' LIMIT 1",
          [a.patientId, f.id, f.version],
        );
        if (done) continue;
        const id = crypto.randomUUID();
        const n = await this.db.run(
          `INSERT INTO form_requests (id, clinic_id, appointment_id, patient_id, form_id, form_name, form_version, mandatory, fields_json, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
           ON CONFLICT (appointment_id, form_id) DO NOTHING`,
          [id, clinicId, a.id, a.patientId, f.id, f.name, f.version, f.mandatory ? 1 : 0, JSON.stringify(f.fields), this.ts()],
        );
        if (n) out.push(id);
      }
      return Promise.all(out.map((id) => this.request(id)));
    });
  }

  private toRequest(r: Record<string, unknown>): FormRequestView {
    return {
      id: r.id as string,
      appointmentId: r.appointment_id as string,
      patientId: r.patient_id as string,
      formName: r.form_name as string,
      mandatory: !!r.mandatory,
      status: r.status as "pending" | "completed",
      fields: parseFields(r.fields_json as string),
      response: r.response_json ? (JSON.parse(r.response_json as string) as Record<string, string>) : null,
      completedAt: (r.completed_at as string) ?? null,
    };
  }

  /** Needs an open clinic scope: patient links find the clinic first (see Resolver) and then call this. */
  async request(id: string): Promise<FormRequestView> {
    const r = await this.db.get("SELECT * FROM form_requests WHERE id = ?", [id]);
    if (!r) throw new DomainError("not_found", "Form not found");
    return this.toRequest(r);
  }

  async forAppointment(appointmentId: string): Promise<FormRequestView[]> {
    return (await this.db.all("SELECT * FROM form_requests WHERE appointment_id = ? ORDER BY created_at, seq", [appointmentId])).map((r) => this.toRequest(r));
  }

  /** Checks answers against the frozen questions. Only known question ids are kept. */
  private check(fields: FormField[], answers: Record<string, string>) {
    const issues: { path: string; message: string }[] = [];
    const clean: Record<string, string> = {};
    for (const f of fields) {
      const v = (answers[f.id] ?? "").toString().trim();
      if (f.type === "agree") {
        if (f.required && v !== "yes") issues.push({ path: f.id, message: `Tick the box: ${f.label}` });
        clean[f.id] = v === "yes" ? "yes" : "no";
        continue;
      }
      if (!v) {
        if (f.required) issues.push({ path: f.id, message: `Answer: ${f.label}` });
        continue;
      }
      const limit = f.type === "longtext" ? 4000 : 300;
      if (v.length > limit) issues.push({ path: f.id, message: `Keep the answer to “${f.label}” under ${limit} characters` });
      if (f.type === "yesno" && v !== "yes" && v !== "no") issues.push({ path: f.id, message: `Choose yes or no: ${f.label}` });
      if (f.type === "choice" && !f.options?.includes(v)) issues.push({ path: f.id, message: `Choose one of the options: ${f.label}` });
      if (f.type === "number" && !Number.isFinite(Number(v))) issues.push({ path: f.id, message: `Enter a number: ${f.label}` });
      if (f.type === "scale" && !(Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 10)) issues.push({ path: f.id, message: `Choose a number from 0 to 10: ${f.label}` });
      if (f.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) issues.push({ path: f.id, message: `Enter a date: ${f.label}` });
      clean[f.id] = v;
    }
    return { issues, clean };
  }

  async complete(id: string, answers: Record<string, string>): Promise<void> {
    const req = await this.request(id);
    if (req.status === "completed") throw new DomainError("invalid_state", "This form has already been completed");
    const { issues, clean } = this.check(req.fields, answers);
    if (issues.length) throw new DomainError("validation", "Please check your answers", issues);
    // Conditional update: two submissions at once cannot both complete it.
    const n = await this.db.run("UPDATE form_requests SET status = 'completed', response_json = ?, completed_at = ? WHERE id = ? AND status = 'pending'", [JSON.stringify(clean), this.ts(), id]);
    if (!n) throw new DomainError("invalid_state", "This form has already been completed");
  }
}
