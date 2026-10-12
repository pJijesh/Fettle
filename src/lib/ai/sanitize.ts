import { DraftOutput } from "../schemas";
import { catalogueIds } from "./catalogue";

export class DraftShapeError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
    this.name = "DraftShapeError";
  }
}

/**
 * Turns an untrusted provider response into a draft the app is willing to store.
 * - must match the schema, otherwise nothing is stored
 * - exercises outside the catalogue, or not linked to a problem, are dropped (and reported)
 * - evidence line numbers past the end of the transcript are removed
 * - red-flag screening is always reset: only the physio can confirm it
 */
export function sanitizeDraft(raw: unknown, lineCount: number): { output: DraftOutput; dropped: string[] } {
  const parsed = DraftOutput.safeParse(raw);
  if (!parsed.success) {
    throw new DraftShapeError(
      "The drafting step returned something that could not be used.",
      parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  }

  const out = structuredClone(parsed.data);
  const dropped: string[] = [];
  const known = catalogueIds();
  const clampEvidence = (lines: number[]) => lines.filter((n) => n <= lineCount);

  out.note.rom.forEach((r) => (r.evidence = clampEvidence(r.evidence)));
  out.note.outcomeMeasures.forEach((r) => (r.evidence = clampEvidence(r.evidence)));
  out.note.specialTests.forEach((r) => (r.evidence = clampEvidence(r.evidence)));
  out.note.problems.forEach((r) => (r.evidence = clampEvidence(r.evidence)));

  const problemIds = new Set(out.note.problems.map((p) => p.id));
  const seen = new Set<string>();
  out.programme.items = out.programme.items.filter((item) => {
    item.evidence = clampEvidence(item.evidence);
    if (!known.has(item.exerciseId)) {
      dropped.push(`Dropped unknown exercise "${item.exerciseId}"`);
      return false;
    }
    if (!problemIds.has(item.problemId)) {
      dropped.push(`Dropped "${item.exerciseId}": not linked to a problem in the note`);
      return false;
    }
    if (item.reps === null && item.holdSeconds === null) {
      dropped.push(`Dropped "${item.exerciseId}": no reps or hold time`);
      return false;
    }
    const key = `${item.exerciseId}:${item.problemId}`;
    if (seen.has(key)) {
      dropped.push(`Dropped duplicate "${item.exerciseId}"`);
      return false;
    }
    seen.add(key);
    return true;
  });

  out.note.redFlags.screened = false;
  return { output: out, dropped };
}
