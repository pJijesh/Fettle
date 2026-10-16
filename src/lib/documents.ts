import crypto from "node:crypto";
import type { Db } from "./db";
import type { SessionUser } from "./accounts";
import { DomainError } from "./errors";
import { noteToText } from "./format";
import type { NoteDraft, ProgrammeDraft } from "./schemas";
import { AssistError, type AssistProvider } from "./assist/provider";
import { LETTER_KINDS, LETTER_LABEL, letterTask, summaryTask, SUMMARY_LEVELS, type LetterKind, type SummaryLevel } from "./assist/tasks";
import { logError } from "./log";

/**
 * Letters and patient summaries. Written by the assistant from the approved consultation note, then edited and finalised
 * by a practitioner. Names, dates of birth and addresses are never sent to the assistant: the heading and sign-off are
 * added here, from the patient record, when the document is shown.
 */

export type DocKind = LetterKind | "patient_summary";
export type DocStatus = "draft" | "final" | "withdrawn";

export const DOC_LABEL: Record<DocKind, string> = { ...LETTER_LABEL, patient_summary: "Patient summary" };

export interface DocumentRow {
  id: string;
  consultId: string;
  kind: DocKind;
  status: DocStatus;
  subject: string;
  body: string;
  language: string | null;
  draftModel: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finalisedBy: string | null;
  finalisedAt: string | null;
}

export interface DocumentContext {
  clinicName: string;
  patientName: string;
  dob: string | null;
  address: string | null;
  postcode: string | null;
  gpName: string | null;
  gpPractice: string | null;
  practitioner: string;
}

type Row = Record<string, unknown>;

export class Documents {
  constructor(
    private db: Db,
    private assist: AssistProvider,
    private now: () => Date = () => new Date(),
  ) {}

  get assistInfo() {
    return { name: this.assist.name, model: this.assist.model, isMock: this.assist.isMock };
  }

  private ts() {
    return this.now().toISOString();
  }

  private who(actor: SessionUser) {
    if (actor.role === "reception") throw new DomainError("forbidden", "Only clinicians and the owner can write letters and summaries");
  }

  private async audit(clinicId: string, consultId: string | null, by: string, action: string, detail: unknown) {
    await this.db.run("INSERT INTO audit_log (clinic_id, consult_id, actor, action, detail, at, entity) VALUES (?, ?, ?, ?, ?, ?, 'document')", [clinicId, consultId, by, action, JSON.stringify(detail), this.ts()]);
  }

  private toRow(r: Row): DocumentRow {
    return {
      id: r.id as string, consultId: r.consult_id as string, kind: r.kind as DocKind, status: r.status as DocStatus, subject: r.subject as string, body: r.body as string,
      language: (r.language as string) ?? null, draftModel: r.draft_model as string, createdBy: r.created_by as string, createdAt: r.created_at as string, updatedAt: r.updated_at as string,
      finalisedBy: (r.finalised_by as string) ?? null, finalisedAt: (r.finalised_at as string) ?? null,
    };
  }

  /** The approved physiotherapy note as text, or throws. Nothing identifying is in it. */
  private async approvedText(clinicId: string, consultId: string): Promise<string> {
    const c = await this.db.get<{ discipline: string; status: string }>("SELECT discipline, status FROM consults WHERE id = ? AND clinic_id = ?", [consultId, clinicId]);
    if (!c) throw new DomainError("not_found", "Consultation not found");
    if (c.discipline !== "physio") throw new DomainError("invalid_state", "Letters and summaries are for physiotherapy consultations. Ayurvedic records are written by the practitioner, with no AI");
    const a = await this.db.get<{ note_json: string; programme_json: string }>("SELECT note_json, programme_json FROM approvals WHERE consult_id = ? AND clinic_id = ?", [consultId, clinicId]);
    if (!a || c.status !== "approved") throw new DomainError("invalid_state", "Approve the note first. Letters and summaries are written from the approved note");
    return noteToText(JSON.parse(a.note_json) as NoteDraft, JSON.parse(a.programme_json) as ProgrammeDraft);
  }

  private async ask<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof AssistError) logError("assist", err);
      else if (!(err instanceof DomainError)) logError("assist", err);
      throw new DomainError("draft_failed", "The assistant could not write this just now. Nothing was saved. Try again, or write it yourself.");
    }
  }

  async list(clinicId: string, consultId: string): Promise<DocumentRow[]> {
    return this.db.scope(clinicId, async () => (await this.db.all("SELECT * FROM documents WHERE clinic_id = ? AND consult_id = ? ORDER BY created_at DESC", [clinicId, consultId])).map((r) => this.toRow(r)));
  }

  async get(clinicId: string, id: string): Promise<{ doc: DocumentRow; context: DocumentContext }> {
    return this.db.scope(clinicId, async () => {
      const r = await this.db.get("SELECT * FROM documents WHERE id = ? AND clinic_id = ?", [id, clinicId]);
      if (!r) throw new DomainError("not_found", "Document not found");
      const doc = this.toRow(r);
      const c = await this.db.get<{ patient_id: string | null; patient_label: string; practitioner: string }>("SELECT patient_id, patient_label, practitioner FROM consults WHERE id = ? AND clinic_id = ?", [doc.consultId, clinicId]);
      const p = c?.patient_id ? await this.db.get<Row>("SELECT * FROM patients WHERE id = ? AND clinic_id = ?", [c.patient_id, clinicId]) : undefined;
      const clinic = await this.db.get<{ name: string }>("SELECT name FROM clinics WHERE id = ?", [clinicId]);
      return {
        doc,
        context: {
          clinicName: clinic?.name ?? "",
          patientName: p ? `${p.first_name} ${p.last_name}` : (c?.patient_label ?? ""),
          dob: (p?.dob as string) ?? null,
          address: (p?.address as string) ?? null,
          postcode: (p?.postcode as string) ?? null,
          gpName: (p?.gp_name as string) ?? null,
          gpPractice: (p?.gp_practice as string) ?? null,
          practitioner: c?.practitioner ?? "",
        },
      };
    });
  }

  /** Drafts a letter. The assistant is called outside any transaction. */
  async draftLetter(actor: SessionUser, consultId: string, kind: string, instruction = ""): Promise<string> {
    this.who(actor);
    if (!(LETTER_KINDS as readonly string[]).includes(kind)) throw new DomainError("validation", "Choose a kind of letter");
    if (instruction.length > 500) throw new DomainError("validation", "Keep the instruction under 500 characters");
    const text = await this.db.scope(actor.clinicId, () => this.approvedText(actor.clinicId, consultId));
    const out = await this.ask(() => this.assist.run(letterTask(kind as LetterKind, text, instruction)));
    return this.save(actor, consultId, kind as DocKind, out.subject, out.body, null);
  }

  async draftSummary(actor: SessionUser, consultId: string, level: string, language: string): Promise<string> {
    this.who(actor);
    if (!(SUMMARY_LEVELS as readonly string[]).includes(level)) throw new DomainError("validation", "Choose a reading level");
    const lang = language.trim() || "English";
    if (!/^[A-Za-z ()-]{2,40}$/.test(lang)) throw new DomainError("validation", "Choose a language");
    const text = await this.db.scope(actor.clinicId, () => this.approvedText(actor.clinicId, consultId));
    const out = await this.ask(() => this.assist.run(summaryTask(text, level as SummaryLevel, lang)));
    return this.save(actor, consultId, "patient_summary", "", out.text, lang);
  }

  private save(actor: SessionUser, consultId: string, kind: DocKind, subject: string, body: string, language: string | null): Promise<string> {
    return this.db.scope(actor.clinicId, async () => {
      // The consultation may have changed while the assistant was working.
      await this.approvedText(actor.clinicId, consultId);
      const id = crypto.randomUUID();
      await this.db.run("INSERT INTO documents (id, clinic_id, consult_id, kind, status, subject, body, language, draft_model, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)", [
        id, actor.clinicId, consultId, kind, subject, body, language, `${this.assist.name}:${this.assist.model}`, actor.email, this.ts(), this.ts(),
      ]);
      await this.audit(actor.clinicId, consultId, actor.email, "document.drafted", { id, kind, model: this.assist.model, language });
      return id;
    });
  }

  /** Saves the practitioner's edits to a draft. */
  async edit(actor: SessionUser, id: string, input: { subject: string; body: string }): Promise<void> {
    this.who(actor);
    const body = input.body.trim();
    if (!body) throw new DomainError("validation", "The document is empty", [{ path: "body", message: "Write something or delete the draft" }]);
    if (body.length > 8000 || input.subject.length > 150) throw new DomainError("validation", "That is too long");
    await this.db.scope(actor.clinicId, async () => {
      const r = await this.db.get<{ status: string; consult_id: string }>("SELECT status, consult_id FROM documents WHERE id = ? AND clinic_id = ? FOR UPDATE", [id, actor.clinicId]);
      if (!r) throw new DomainError("not_found", "Document not found");
      if (r.status !== "draft") throw new DomainError("invalid_state", "A finalised document cannot be edited");
      await this.db.run("UPDATE documents SET subject = ?, body = ?, updated_at = ? WHERE id = ?", [input.subject.trim(), body, this.ts(), id]);
      await this.audit(actor.clinicId, r.consult_id, actor.email, "document.edited", { id });
    });
  }

  /** The practitioner has read it and takes responsibility. A patient summary then appears on the patient's link. */
  async finalise(actor: SessionUser, id: string): Promise<void> {
    this.who(actor);
    await this.db.scope(actor.clinicId, async () => {
      const r = await this.db.get<{ status: string; consult_id: string; subject: string; body: string; kind: string }>("SELECT status, consult_id, subject, body, kind FROM documents WHERE id = ? AND clinic_id = ? FOR UPDATE", [id, actor.clinicId]);
      if (!r) throw new DomainError("not_found", "Document not found");
      if (r.status !== "draft") throw new DomainError("invalid_state", "Already finalised");
      const hash = crypto.createHash("sha256").update(JSON.stringify({ s: r.subject, b: r.body })).digest("hex");
      await this.db.run("UPDATE documents SET status = 'final', finalised_by = ?, finalised_at = ?, content_hash = ?, updated_at = ? WHERE id = ?", [actor.name, this.ts(), hash, this.ts(), id]);
      await this.audit(actor.clinicId, r.consult_id, actor.email, "document.finalised", { id, kind: r.kind, hash });
    });
  }

  /** Takes a finalised patient summary off the patient's link. */
  async withdraw(actor: SessionUser, id: string): Promise<void> {
    this.who(actor);
    await this.db.scope(actor.clinicId, async () => {
      const r = await this.db.get<{ status: string; consult_id: string; kind: string }>("SELECT status, consult_id, kind FROM documents WHERE id = ? AND clinic_id = ? FOR UPDATE", [id, actor.clinicId]);
      if (!r) throw new DomainError("not_found", "Document not found");
      if (r.status !== "final") throw new DomainError("invalid_state", "Only a finalised document can be withdrawn");
      await this.db.run("UPDATE documents SET status = 'withdrawn', updated_at = ? WHERE id = ?", [this.ts(), id]);
      await this.audit(actor.clinicId, r.consult_id, actor.email, "document.withdrawn", { id, kind: r.kind });
    });
  }

  async deleteDraft(actor: SessionUser, id: string): Promise<void> {
    this.who(actor);
    await this.db.scope(actor.clinicId, async () => {
      const r = await this.db.get<{ status: string; consult_id: string }>("SELECT status, consult_id FROM documents WHERE id = ? AND clinic_id = ?", [id, actor.clinicId]);
      if (!r) throw new DomainError("not_found", "Document not found");
      if (r.status !== "draft") throw new DomainError("invalid_state", "Only a draft can be deleted");
      await this.db.run("DELETE FROM documents WHERE id = ?", [id]);
      await this.audit(actor.clinicId, r.consult_id, actor.email, "document.deleted", { id });
    });
  }
}
