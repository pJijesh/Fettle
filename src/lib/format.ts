import { getExercise } from "./ai/catalogue";
import type { NoteDraft, ProgrammeDraft, Side } from "./schemas";

const SIDE: Record<Side, string> = { left: "left", right: "right", both: "both sides", na: "" };

export function describeDose(item: ProgrammeDraft["items"][number]): string {
  const parts: string[] = [];
  if (item.reps !== null) parts.push(`${item.sets} x ${item.reps}`);
  else parts.push(`${item.sets} sets`);
  if (item.holdSeconds !== null) parts.push(`hold ${item.holdSeconds}s`);
  parts.push(`${item.frequencyPerWeek}x per week`);
  return parts.join(", ");
}

export interface NoteFooter {
  practitioner: string;
  approvedAt: string;
  model: string | null;
}

/** Plain-text rendering used for write-back and for the copy-ready fallback. */
export function noteToText(note: NoteDraft, programme: ProgrammeDraft, footer?: NoteFooter): string {
  const out: string[] = [];
  const section = (title: string, body: string) => {
    if (body.trim()) out.push(`${title}\n${body.trim()}`);
  };

  section("Subjective", note.subjective);
  section("Objective", note.objective);

  if (note.rom.length) {
    section(
      "Range of movement",
      note.rom
        .map((r) => `- ${[r.joint, SIDE[r.side], r.movement].filter(Boolean).join(" ")}: ${r.value}${r.unit === "deg" ? " deg" : r.unit === "cm" ? " cm" : ""}`)
        .join("\n"),
    );
  }
  if (note.outcomeMeasures.length) {
    section(
      "Outcome measures",
      note.outcomeMeasures.map((m) => `- ${m.name}: ${m.score}${m.scale ? ` (${m.scale})` : ""}`).join("\n"),
    );
  }
  if (note.specialTests.length) {
    section(
      "Special tests",
      note.specialTests.map((t) => `- ${[t.name, SIDE[t.side]].filter(Boolean).join(" ")}: ${t.result}`).join("\n"),
    );
  }

  const flags = note.redFlags.screened
    ? note.redFlags.findings.length
      ? `Screened. Findings: ${note.redFlags.findings.join("; ")}`
      : "Screened. No red flags identified."
    : "Not recorded.";
  section("Red flag screening", `${flags}${note.redFlags.notes ? `\n${note.redFlags.notes}` : ""}`);

  if (note.problems.length) {
    section("Problems", note.problems.map((p) => `- ${p.id}: ${p.title}${p.side !== "na" ? ` (${SIDE[p.side]})` : ""}`).join("\n"));
  }
  section("Assessment", note.assessment);
  section("Plan", note.plan);

  if (programme.items.length) {
    const lines = programme.items.map((item) => {
      const ex = getExercise(item.exerciseId);
      return `- ${ex?.name ?? item.exerciseId}: ${describeDose(item)} (${item.problemId})`;
    });
    if (programme.reviewInWeeks) lines.push(`Review in ${programme.reviewInWeeks} week${programme.reviewInWeeks === 1 ? "" : "s"}.`);
    section("Home exercise programme issued", lines.join("\n"));
  }

  if (footer) {
    const when = footer.approvedAt.slice(0, 16).replace("T", " ");
    out.push(
      `Drafted with AI assistance${footer.model ? ` (${footer.model})` : ""}, reviewed and approved by ${footer.practitioner} on ${when} UTC.`,
    );
  }

  return out.join("\n\n");
}
