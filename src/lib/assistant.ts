import type { Db } from "./db";
import type { SessionUser } from "./accounts";
import { DomainError } from "./errors";
import { noteToText } from "./format";
import { logError } from "./log";
import { NoteDraft, ProgrammeDraft } from "./schemas";
import { noteLookTask, codesTask } from "./assist/tasks";
import type { AssistProvider } from "./assist/provider";
import { ruleFindings, type NoteFinding } from "./note-check";
import { transcriptLines } from "./validation";

/** Advice that is never stored: a second look at a draft note, and diagnosis-code suggestions for a claim. */

const ICD10 = /^[A-TV-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/;

export interface CodeSuggestion {
  code: string;
  description: string;
  reason: string;
}

export class Assistant {
  constructor(
    private db: Db,
    private assist: AssistProvider,
    private now: () => Date = () => new Date(),
  ) {}

  private clinicianOnly(actor: SessionUser) {
    if (actor.role === "reception") throw new DomainError("forbidden", "Only clinicians and the owner can use this");
  }

  private async audit(clinicId: string, consultId: string, by: string, action: string, detail: unknown) {
    await this.db.run("INSERT INTO audit_log (clinic_id, consult_id, actor, action, detail, at, entity) VALUES (?, ?, ?, ?, ?, ?, 'consult')", [clinicId, consultId, by, action, JSON.stringify(detail), this.now().toISOString()]);
  }

  /**
   * Checks the note as it is on screen (not only as saved). Plain rules first; then, if the assistant is available, a
   * second reader compares the note with the transcript. The result is advice only: it never changes the note and
   * never blocks approval. If the assistant is unavailable the rule findings are still returned.
   */
  async checkNote(actor: SessionUser, consultId: string, input: { note: unknown; programme: unknown }): Promise<{ findings: NoteFinding[]; assistant: "ok" | "unavailable" }> {
    this.clinicianOnly(actor);
    const note = NoteDraft.safeParse(input.note);
    const programme = ProgrammeDraft.safeParse(input.programme);
    if (!note.success || !programme.success) throw new DomainError("validation", "The note could not be read. Fix the highlighted fields and try again");
    const row = await this.db.scope(actor.clinicId, async () => {
      const r = await this.db.get<{ discipline: string; status: string; transcript: string | null; consent_at: string | null }>("SELECT discipline, status, transcript, consent_at FROM consults WHERE id = ? AND clinic_id = ?", [consultId, actor.clinicId]);
      if (!r) throw new DomainError("not_found", "Consultation not found");
      if (r.discipline !== "physio") throw new DomainError("invalid_state", "Checks are for physiotherapy notes");
      if (!r.consent_at) throw new DomainError("consent_required", "Record the patient's consent first");
      return r;
    });
    const lines = transcriptLines(row.transcript ?? "");
    const findings = ruleFindings(note.data, programme.data, lines);
    let state: "ok" | "unavailable" = "ok";
    if (lines.length) {
      try {
        const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join("\n");
        const out = await this.assist.run(noteLookTask(JSON.stringify(note.data), numbered));
        for (const f of out.findings) {
          // A finding that does not point at a real transcript line is dropped.
          const valid = f.lines.filter((n) => n >= 1 && n <= lines.length);
          if (valid.length) findings.push({ severity: "check", message: f.message, source: "assistant", lines: valid });
        }
      } catch (err) {
        logError("assist", err);
        state = "unavailable";
      }
    }
    await this.db.scope(actor.clinicId, () => this.audit(actor.clinicId, consultId, actor.email, "note.checked", { rules: findings.filter((f) => f.source === "rules").length, assistant: findings.filter((f) => f.source === "assistant").length, assistantState: state }));
    return { findings, assistant: state };
  }

  /** Diagnosis-code suggestions from the approved note, for the clinician to confirm against the insurer's own list. */
  async suggestCodes(actor: SessionUser, consultId: string): Promise<CodeSuggestion[]> {
    this.clinicianOnly(actor);
    const text = await this.db.scope(actor.clinicId, async () => {
      const c = await this.db.get<{ discipline: string; status: string }>("SELECT discipline, status FROM consults WHERE id = ? AND clinic_id = ?", [consultId, actor.clinicId]);
      if (!c) throw new DomainError("not_found", "Consultation not found");
      if (c.discipline !== "physio") throw new DomainError("invalid_state", "Code suggestions are for physiotherapy consultations");
      const a = await this.db.get<{ note_json: string; programme_json: string }>("SELECT note_json, programme_json FROM approvals WHERE consult_id = ? AND clinic_id = ?", [consultId, actor.clinicId]);
      if (!a || c.status !== "approved") throw new DomainError("invalid_state", "Approve the note first");
      return noteToText(JSON.parse(a.note_json), JSON.parse(a.programme_json));
    });
    let suggestions: CodeSuggestion[];
    try {
      suggestions = (await this.assist.run(codesTask(text))).suggestions;
    } catch (err) {
      logError("assist", err);
      throw new DomainError("draft_failed", "The assistant could not suggest codes just now. Try again, or choose the code yourself.");
    }
    // Only codes that look like real ICD-10 codes are shown, and no more than three.
    const kept = suggestions.filter((s) => ICD10.test(s.code.trim().toUpperCase())).slice(0, 3).map((s) => ({ ...s, code: s.code.trim().toUpperCase() }));
    await this.db.scope(actor.clinicId, () => this.audit(actor.clinicId, consultId, actor.email, "codes.suggested", { shown: kept.length }));
    return kept;
  }
}
