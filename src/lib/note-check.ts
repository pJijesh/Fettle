import type { NoteDraft, ProgrammeDraft } from "./schemas";

/**
 * Plain checks on a physiotherapy note that need no AI. They point at things a reader would expect to find,
 * and never stop approval: the physio decides. Anything left over from a template (a row with no value) is named.
 */

export interface NoteFinding {
  /** "check" is worth a look before approving; "info" is a nudge. */
  severity: "check" | "info";
  message: string;
  source: "rules" | "assistant";
  /** Transcript lines the finding rests on (assistant findings only). */
  lines?: number[];
}

const SIDE: Record<string, string> = { left: "left", right: "right", both: "both sides", na: "" };

export function ruleFindings(note: NoteDraft, programme: ProgrammeDraft, transcriptLines: string[]): NoteFinding[] {
  const out: NoteFinding[] = [];
  const add = (severity: NoteFinding["severity"], message: string) => out.push({ severity, message, source: "rules" });

  const empty = (k: "subjective" | "objective" | "assessment" | "plan") => !note[k].trim();
  for (const [k, label] of [["subjective", "Subjective"], ["objective", "Objective"], ["assessment", "Assessment"], ["plan", "Plan"]] as const) {
    if (empty(k)) add(k === "plan" || k === "assessment" ? "check" : "info", `${label} is empty.`);
  }

  const blankRom = note.rom.filter((r) => !r.value.trim());
  if (blankRom.length) add("check", `Range of movement with no value: ${blankRom.map((r) => [r.joint, SIDE[r.side], r.movement].filter(Boolean).join(" ")).join("; ")}. Fill in or remove.`);
  const blankMeasure = note.outcomeMeasures.filter((m) => !m.score.trim());
  if (blankMeasure.length) add("check", `Outcome measure with no score: ${blankMeasure.map((m) => m.name).join("; ")}. Fill in or remove.`);
  const blankTest = note.specialTests.filter((t) => !t.result.trim());
  if (blankTest.length) add("check", `Special test with no result: ${blankTest.map((t) => [t.name, SIDE[t.side]].filter(Boolean).join(" ")).join("; ")}. Fill in or remove.`);

  const mentionsPain = transcriptLines.some((l) => /\b\d{1,2}\s*(\/|out of)\s*10\b/i.test(l));
  const hasPainScore = note.outcomeMeasures.some((m) => m.score.trim() && /pain|nprs|vas|nrs/i.test(m.name));
  if (mentionsPain && !hasPainScore) add("check", "A pain score out of 10 is mentioned in the transcript but no pain outcome measure is recorded.");
  if (!note.outcomeMeasures.some((m) => m.score.trim())) add("info", "No outcome measure with a score is recorded, so progress cannot be compared at the next visit.");

  if (!note.problems.length && (note.assessment.trim() || note.plan.trim())) add("info", "No problem is listed.");
  if (programme.items.length) {
    const treated = new Set(programme.items.map((i) => i.problemId));
    const untreated = note.problems.filter((p) => !treated.has(p.id));
    if (untreated.length) add("info", `No exercise is linked to: ${untreated.map((p) => p.title || p.id).join("; ")}.`);
    if (programme.reviewInWeeks === null) add("info", "No review time is set on the exercise programme.");
    if (!programme.safetyAdvice.length) add("info", "The programme has no safety advice for the patient.");
  }
  if (note.redFlags.findings.length && !note.redFlags.screened) add("check", "Red flag findings are listed but screening is not confirmed.");
  return out;
}
