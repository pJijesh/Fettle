import { catalogueIds } from "./ai/catalogue";
import type { DraftOutput } from "./schemas";

export interface Issue {
  path: string;
  message: string;
}

export interface CrossCheckOptions {
  /** Number of transcript lines; evidence references beyond it are rejected. */
  transcriptLineCount?: number;
}

/**
 * Rules that span fields and so cannot live in the Zod shapes:
 * - every programme item points at a problem in the note (PRD R4)
 * - every exercise exists in the catalogue (a model cannot invent one)
 * - dose is complete, and evidence line numbers exist in the transcript
 */
export function crossCheck(out: DraftOutput, opts: CrossCheckOptions = {}): Issue[] {
  const issues: Issue[] = [];
  const known = catalogueIds();
  const problemIds = new Set<string>();

  out.note.problems.forEach((p, i) => {
    if (problemIds.has(p.id)) issues.push({ path: `note.problems.${i}.id`, message: `Duplicate problem id ${p.id}` });
    problemIds.add(p.id);
  });

  const seen = new Set<string>();
  out.programme.items.forEach((item, i) => {
    const at = `programme.items.${i}`;
    if (!known.has(item.exerciseId)) {
      issues.push({ path: `${at}.exerciseId`, message: `Unknown exercise "${item.exerciseId}"` });
    }
    if (!problemIds.has(item.problemId)) {
      issues.push({ path: `${at}.problemId`, message: `Exercise is not linked to a problem in the note (${item.problemId})` });
    }
    if (item.reps === null && item.holdSeconds === null) {
      issues.push({ path: `${at}.reps`, message: "Give reps, a hold time, or both" });
    }
    const key = `${item.exerciseId}:${item.problemId}`;
    if (seen.has(key)) issues.push({ path: at, message: "The same exercise is listed twice for one problem" });
    seen.add(key);
  });

  if (out.programme.items.length > 0 && out.note.problems.length === 0) {
    issues.push({ path: "programme.items", message: "Add at least one problem to the note before prescribing exercises" });
  }

  if (opts.transcriptLineCount !== undefined) {
    const max = opts.transcriptLineCount;
    const check = (path: string, lines: number[]) => {
      for (const n of lines) {
        if (n > max) issues.push({ path, message: `Evidence line ${n} is past the end of the transcript (${max} lines)` });
      }
    };
    out.note.rom.forEach((r, i) => check(`note.rom.${i}.evidence`, r.evidence));
    out.note.outcomeMeasures.forEach((r, i) => check(`note.outcomeMeasures.${i}.evidence`, r.evidence));
    out.note.specialTests.forEach((r, i) => check(`note.specialTests.${i}.evidence`, r.evidence));
    out.note.problems.forEach((r, i) => check(`note.problems.${i}.evidence`, r.evidence));
    out.programme.items.forEach((r, i) => check(`programme.items.${i}.evidence`, r.evidence));
  }

  return issues;
}

/** Extra checks that apply only at the moment of approval. */
export function approvalIssues(out: DraftOutput): Issue[] {
  const issues = crossCheck(out);
  if (!out.note.redFlags.screened) {
    issues.push({ path: "note.redFlags.screened", message: "Confirm that red-flag screening was done before approving" });
  }
  if (!out.note.subjective.trim() && !out.note.objective.trim() && !out.note.assessment.trim()) {
    issues.push({ path: "note", message: "The note is empty" });
  }
  return issues;
}

export function transcriptLines(transcript: string): string[] {
  return transcript.split(/\r?\n/).filter((l) => l.trim().length > 0);
}
