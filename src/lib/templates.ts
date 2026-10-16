import crypto from "node:crypto";
import type { Db } from "./db";
import { DomainError } from "./errors";
import { TemplateBody } from "./template-note";

export { applyTemplate, TemplateBody } from "./template-note";

export interface NoteTemplate {
  id: string;
  name: string;
  body: TemplateBody;
  active: boolean;
}

/** One row per line, parts separated by commas, so a template can be written without a form builder. */
const SIDES = ["left", "right", "both", "na"] as const;
const side = (v: string | undefined) => SIDES.find((x) => x === (v ?? "").trim().toLowerCase()) ?? "na";
const parts = (line: string) => line.split(",").map((x) => x.trim());
const lines = (t: string) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** Rows as typed: ROM "joint, movement, side, unit"; measures "name, scale"; tests "name, side". Unknown sides become n/a. */
export function bodyFromText(t: { subjective: string; objective: string; rom: string; outcomeMeasures: string; specialTests: string; assessment: string; plan: string }): string {
  return JSON.stringify({
    subjective: t.subjective,
    objective: t.objective,
    rom: lines(t.rom).map((l) => {
      const [joint, movement, s, unit] = parts(l);
      return { joint, movement: movement ?? "", side: side(s), unit: unit === "cm" || unit === "other" ? unit : "deg" };
    }),
    outcomeMeasures: lines(t.outcomeMeasures).map((l) => {
      const [name, scale] = parts(l);
      return { name, scale: scale ?? "" };
    }),
    specialTests: lines(t.specialTests).map((l) => {
      const [name, s] = parts(l);
      return { name, side: side(s) };
    }),
    assessment: t.assessment,
    plan: t.plan,
  });
}

/** The reverse, for editing. */
export function bodyToText(b: TemplateBody) {
  return {
    subjective: b.subjective,
    objective: b.objective,
    rom: b.rom.map((r) => [r.joint, r.movement, r.side, r.unit].join(", ")).join("\n"),
    outcomeMeasures: b.outcomeMeasures.map((m) => [m.name, m.scale].join(", ")).join("\n"),
    specialTests: b.specialTests.map((t) => [t.name, t.side].join(", ")).join("\n"),
    assessment: b.assessment,
    plan: b.plan,
  };
}

/**
 * Examples to start from. They list what to look at, not what to conclude, and have not been reviewed by a clinician:
 * the clinic should edit them to match how it works.
 */
export const STARTER_TEMPLATES: { name: string; body: TemplateBody }[] = [
  {
    name: "Lumbar spine review",
    body: TemplateBody.parse({
      objective: "Posture, gait and observation:\nPalpation:\nNeurological screen:",
      rom: [
        { joint: "Lumbar spine", movement: "Flexion" },
        { joint: "Lumbar spine", movement: "Extension" },
        { joint: "Lumbar spine", movement: "Side flexion", side: "left" },
        { joint: "Lumbar spine", movement: "Side flexion", side: "right" },
      ],
      outcomeMeasures: [{ name: "NPRS", scale: "0-10" }, { name: "Oswestry Disability Index", scale: "0-100%" }],
      specialTests: [{ name: "Straight leg raise", side: "left" }, { name: "Straight leg raise", side: "right" }, { name: "Slump test", side: "both" }],
    }),
  },
  {
    name: "Shoulder review",
    body: TemplateBody.parse({
      objective: "Posture and scapular position:\nPalpation:\nNeurological screen:",
      rom: [
        { joint: "Shoulder", movement: "Flexion", side: "left" },
        { joint: "Shoulder", movement: "Flexion", side: "right" },
        { joint: "Shoulder", movement: "Abduction", side: "left" },
        { joint: "Shoulder", movement: "Abduction", side: "right" },
        { joint: "Shoulder", movement: "External rotation", side: "left" },
        { joint: "Shoulder", movement: "External rotation", side: "right" },
      ],
      outcomeMeasures: [{ name: "NPRS", scale: "0-10" }, { name: "QuickDASH", scale: "0-100" }],
      specialTests: [{ name: "Painful arc", side: "left" }, { name: "Painful arc", side: "right" }, { name: "Empty can", side: "left" }, { name: "Empty can", side: "right" }],
    }),
  },
  {
    name: "Follow-up",
    body: TemplateBody.parse({
      subjective: "Progress since the last visit:\nHome exercises (how often, any problems):",
      objective: "Re-assessment:",
      outcomeMeasures: [{ name: "NPRS", scale: "0-10" }],
      plan: "Treatment today:\nNext steps and review:",
    }),
  },
];

export class NoteTemplates {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  private ts() {
    return this.now().toISOString();
  }

  private async audit(clinicId: string, by: string, action: string, detail: unknown) {
    await this.db.run("INSERT INTO audit_log (clinic_id, actor, action, detail, at, entity) VALUES (?, ?, ?, ?, ?, 'note_template')", [clinicId, by, action, JSON.stringify(detail), this.ts()]);
  }

  private toTemplate(r: Record<string, unknown>): NoteTemplate {
    return { id: r.id as string, name: r.name as string, body: TemplateBody.parse(JSON.parse(r.body_json as string)), active: !!r.active };
  }

  async list(clinicId: string, opts: { activeOnly?: boolean } = {}): Promise<NoteTemplate[]> {
    return this.db.scope(clinicId, async () =>
      (await this.db.all(`SELECT * FROM note_templates WHERE clinic_id = ? ${opts.activeOnly ? "AND active = 1" : ""} ORDER BY lower(name)`, [clinicId])).map((r) => this.toTemplate(r)),
    );
  }

  private parse(bodyJson: string): TemplateBody {
    let raw: unknown;
    try {
      raw = JSON.parse(bodyJson);
    } catch {
      throw new DomainError("validation", "The template could not be read");
    }
    const parsed = TemplateBody.safeParse(raw);
    if (!parsed.success) {
      throw new DomainError("validation", "Some fields are not valid", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    }
    return parsed.data;
  }

  /** Creates a template, or saves changes to one. Notes already written are never changed by this. */
  async save(clinicId: string, by: string, input: { id?: string; name: string; bodyJson: string; active: boolean }): Promise<string> {
    const name = input.name.trim();
    if (!name) throw new DomainError("validation", "Give the template a name", [{ path: "name", message: "Give the template a name" }]);
    if (name.length > 80) throw new DomainError("validation", "Use a shorter name", [{ path: "name", message: "80 characters at most" }]);
    const body = this.parse(input.bodyJson);
    return this.db.scope(clinicId, async () => {
      const clash = await this.db.get("SELECT id FROM note_templates WHERE clinic_id = ? AND lower(name) = lower(?) AND id <> ?", [clinicId, name, input.id ?? ""]);
      if (clash) throw new DomainError("conflict", "A template with that name already exists", [{ path: "name", message: "Already used" }]);
      if (input.id) {
        const n = await this.db.run("UPDATE note_templates SET name = ?, body_json = ?, active = ?, updated_at = ? WHERE id = ? AND clinic_id = ?", [
          name, JSON.stringify(body), input.active ? 1 : 0, this.ts(), input.id, clinicId,
        ]);
        if (!n) throw new DomainError("not_found", "Template not found");
        await this.audit(clinicId, by, "note_template.updated", { id: input.id, name });
        return input.id;
      }
      const id = crypto.randomUUID();
      await this.db.run("INSERT INTO note_templates (id, clinic_id, name, body_json, active, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
        id, clinicId, name, JSON.stringify(body), input.active ? 1 : 0, by, this.ts(), this.ts(),
      ]);
      await this.audit(clinicId, by, "note_template.created", { id, name });
      return id;
    });
  }

  async remove(clinicId: string, by: string, id: string): Promise<void> {
    return this.db.scope(clinicId, async () => {
      const r = await this.db.get("SELECT name FROM note_templates WHERE id = ? AND clinic_id = ?", [id, clinicId]);
      if (!r) throw new DomainError("not_found", "Template not found");
      await this.db.run("DELETE FROM note_templates WHERE id = ? AND clinic_id = ?", [id, clinicId]);
      await this.audit(clinicId, by, "note_template.deleted", { id, name: r.name });
    });
  }

  /** Adds the example templates the clinic does not have yet (matched by name). Returns how many were added. */
  async addStarters(clinicId: string, by: string): Promise<number> {
    return this.db.scope(clinicId, async () => {
      let added = 0;
      for (const s of STARTER_TEMPLATES) {
        const have = await this.db.get("SELECT id FROM note_templates WHERE clinic_id = ? AND lower(name) = lower(?)", [clinicId, s.name]);
        if (have) continue;
        const id = crypto.randomUUID();
        await this.db.run("INSERT INTO note_templates (id, clinic_id, name, body_json, active, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)", [
          id, clinicId, s.name, JSON.stringify(s.body), by, this.ts(), this.ts(),
        ]);
        added++;
      }
      if (added) await this.audit(clinicId, by, "note_template.starters_added", { added });
      return added;
    });
  }
}
