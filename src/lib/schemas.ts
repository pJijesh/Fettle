import { z } from "zod";

/**
 * Shapes for the two drafts a consultation produces. Everything the PRD wants held as a
 * discrete field (laterality, range of movement, outcome measures, red-flag screening) is
 * a field here, not prose. `evidence` holds 1-based transcript line numbers a statement came from.
 */

export const Side = z.enum(["left", "right", "both", "na"]);
export type Side = z.infer<typeof Side>;

const evidence = z.array(z.number().int().min(1)).max(20).default([]);

export const RomRow = z.object({
  joint: z.string().trim().max(60),
  side: Side,
  movement: z.string().trim().max(60),
  value: z.string().trim().max(30),
  unit: z.enum(["deg", "cm", "other"]).default("deg"),
  evidence,
});
export type RomRow = z.infer<typeof RomRow>;

export const OutcomeMeasure = z.object({
  name: z.string().trim().max(80),
  score: z.string().trim().max(30),
  scale: z.string().trim().max(40),
  evidence,
});
export type OutcomeMeasure = z.infer<typeof OutcomeMeasure>;

export const SpecialTest = z.object({
  name: z.string().trim().max(80),
  side: Side,
  result: z.string().trim().max(120),
  evidence,
});
export type SpecialTest = z.infer<typeof SpecialTest>;

export const Problem = z.object({
  id: z.string().regex(/^p\d{1,2}$/, "problem ids look like p1, p2"),
  title: z.string().trim().min(1).max(120),
  side: Side,
  evidence,
});
export type Problem = z.infer<typeof Problem>;

export const RedFlags = z.object({
  /** True only when the physio confirms red-flag screening was done. Approval needs it. */
  screened: z.boolean(),
  findings: z.array(z.string().trim().max(200)).max(20),
  notes: z.string().trim().max(1000),
});

export const NoteDraft = z.object({
  subjective: z.string().max(6000),
  objective: z.string().max(6000),
  rom: z.array(RomRow).max(40),
  outcomeMeasures: z.array(OutcomeMeasure).max(20),
  specialTests: z.array(SpecialTest).max(30),
  redFlags: RedFlags,
  problems: z.array(Problem).max(10),
  assessment: z.string().max(6000),
  plan: z.string().max(6000),
});
export type NoteDraft = z.infer<typeof NoteDraft>;

export const ProgrammeItem = z.object({
  exerciseId: z.string().min(1).max(60),
  problemId: z.string().regex(/^p\d{1,2}$/),
  sets: z.number().int().min(1).max(10),
  reps: z.number().int().min(1).max(100).nullable(),
  holdSeconds: z.number().int().min(1).max(180).nullable(),
  frequencyPerWeek: z.number().int().min(1).max(14),
  cue: z.string().trim().max(400),
  progression: z.string().trim().max(300),
  evidence,
});
export type ProgrammeItem = z.infer<typeof ProgrammeItem>;

export const ProgrammeDraft = z.object({
  title: z.string().trim().min(1).max(120),
  patientIntro: z.string().trim().max(800),
  items: z.array(ProgrammeItem).max(12),
  safetyAdvice: z.array(z.string().trim().max(300)).max(8),
  reviewInWeeks: z.number().int().min(1).max(26).nullable(),
});
export type ProgrammeDraft = z.infer<typeof ProgrammeDraft>;

export const DraftOutput = z.object({ note: NoteDraft, programme: ProgrammeDraft });
export type DraftOutput = z.infer<typeof DraftOutput>;

export const CheckInInput = z.object({
  adherence: z.enum(["all", "some", "none"]),
  painChange: z.enum(["better", "same", "worse"]),
  comment: z.string().trim().max(500).default(""),
});
export type CheckInInput = z.infer<typeof CheckInInput>;

export const ConsentMethod = z.enum(["verbal", "written"]);
export type ConsentMethod = z.infer<typeof ConsentMethod>;

export function emptyNote(): NoteDraft {
  return {
    subjective: "",
    objective: "",
    rom: [],
    outcomeMeasures: [],
    specialTests: [],
    redFlags: { screened: false, findings: [], notes: "" },
    problems: [],
    assessment: "",
    plan: "",
  };
}

export function emptyProgramme(): ProgrammeDraft {
  return { title: "Home exercise programme", patientIntro: "", items: [], safetyAdvice: [], reviewInWeeks: null };
}
