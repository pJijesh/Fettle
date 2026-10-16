import { z } from "zod";
import { Side, type NoteDraft } from "./schemas";

/**
 * Note templates. A template is a starting structure the clinician chooses after a draft exists: it prompts for the
 * rows they usually record and adds standard wording. It never carries a finding. There is no value, score or result
 * in it, no problem, no evidence line and no red-flag screening, so applying one cannot put a clinical statement in a
 * note that nobody made in the room. Everything it adds is shown on screen and goes through the same approval.
 */

const text = (max: number) => z.string().trim().max(max).default("");

export const TemplateBody = z.object({
  subjective: text(6000),
  objective: text(6000),
  rom: z.array(z.object({ joint: z.string().trim().min(1).max(60), side: Side.default("na"), movement: z.string().trim().max(60).default(""), unit: z.enum(["deg", "cm", "other"]).default("deg") })).max(40).default([]),
  outcomeMeasures: z.array(z.object({ name: z.string().trim().min(1).max(80), scale: z.string().trim().max(40).default("") })).max(20).default([]),
  specialTests: z.array(z.object({ name: z.string().trim().min(1).max(80), side: Side.default("na") })).max(30).default([]),
  assessment: text(6000),
  plan: text(6000),
});
export type TemplateBody = z.infer<typeof TemplateBody>;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Adds a template to a note without removing or changing anything already there. Text boxes are filled only when empty;
 * rows are added only when the note does not already have that joint and movement, measure or test. Returns the new
 * note and what it added, so the screen can say so.
 */
export function applyTemplate(note: NoteDraft, body: TemplateBody): { note: NoteDraft; added: string[] } {
  const added: string[] = [];
  const out: NoteDraft = { ...note, rom: [...note.rom], outcomeMeasures: [...note.outcomeMeasures], specialTests: [...note.specialTests] };
  for (const key of ["subjective", "objective", "assessment", "plan"] as const) {
    if (body[key].trim() && !out[key].trim()) {
      out[key] = body[key];
      added.push(key);
    }
  }
  let rows = 0;
  for (const r of body.rom) {
    if (out.rom.some((x) => same(x.joint, r.joint) && same(x.movement, r.movement) && x.side === r.side)) continue;
    out.rom.push({ joint: r.joint, side: r.side, movement: r.movement, value: "", unit: r.unit, evidence: [] });
    rows++;
  }
  for (const m of body.outcomeMeasures) {
    if (out.outcomeMeasures.some((x) => same(x.name, m.name))) continue;
    out.outcomeMeasures.push({ name: m.name, score: "", scale: m.scale, evidence: [] });
    rows++;
  }
  for (const t of body.specialTests) {
    if (out.specialTests.some((x) => same(x.name, t.name) && x.side === t.side)) continue;
    out.specialTests.push({ name: t.name, side: t.side, result: "", evidence: [] });
    rows++;
  }
  if (rows) added.push(`${rows} row${rows === 1 ? "" : "s"} to fill in`);
  return { note: out, added };
}
