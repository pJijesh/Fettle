import crypto from "node:crypto";
import { transaction, type Db } from "./db";
import type { DraftingProvider } from "./ai/provider";
import { DraftShapeError, sanitizeDraft } from "./ai/sanitize";
import { getExercise } from "./ai/catalogue";
import {
  CheckInInput,
  ConsentMethod,
  DraftOutput,
  NoteDraft,
  ProgrammeDraft,
  emptyNote,
  emptyProgramme,
} from "./schemas";
import { approvalIssues, crossCheck, transcriptLines, type Issue } from "./validation";
import { noteToText } from "./format";
import type { WritebackTarget } from "./writeback/types";

export type Status = "created" | "consented" | "captured" | "drafted" | "approved";

export { DomainError } from "./errors";
export type { ErrorCode } from "./errors";
import { DomainError } from "./errors";

const MAX_TRANSCRIPT_CHARS = 200_000;
const CHECKINS_PER_DAY = 5;
const DEFAULT_LINK_DAYS = 56;

export interface Deps {
  db: Db;
  /** Every query is limited to this clinic. */
  clinicId: string;
  provider: DraftingProvider;
  targets: Record<string, WritebackTarget>;
  now?: () => Date;
}

interface ConsultRow {
  id: string;
  patient_label: string;
  pms_patient_id: string | null;
  practitioner: string;
  status: Status;
  consent_at: string | null;
  consent_method: "verbal" | "written" | null;
  consent_recorded_by: string | null;
  consent_withdrawn_at: string | null;
  transcript: string | null;
  note_json: string | null;
  programme_json: string | null;
  draft_model: string | null;
  drafted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ApprovalRow {
  id: string;
  consult_id: string;
  approved_by: string;
  approved_at: string;
  note_json: string;
  programme_json: string;
  content_hash: string;
}

export interface WritebackRow {
  id: string;
  consult_id: string;
  target: string;
  idempotency_key: string;
  status: "pending" | "succeeded" | "failed" | "needs_check";
  external_id: string | null;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

export interface ConsultSummary {
  id: string;
  patientLabel: string;
  practitioner: string;
  status: Status;
  updatedAt: string;
}

export interface ConsultView {
  id: string;
  patientLabel: string;
  pmsPatientId: string | null;
  practitioner: string;
  status: Status;
  consent: { at: string; method: "verbal" | "written"; by: string } | null;
  consentWithdrawnAt: string | null;
  transcript: string;
  note: NoteDraft;
  programme: ProgrammeDraft;
  draftModel: string | null;
  draftedAt: string | null;
  approval: { by: string; at: string; hash: string; note: NoteDraft; programme: ProgrammeDraft } | null;
  links: { id: string; createdAt: string; expiresAt: string; revokedAt: string | null }[];
  checkIns: { id: string; adherence: string; painChange: string; comment: string; createdAt: string }[];
  writebacks: WritebackRow[];
  audit: { at: string; actor: string; action: string; detail: string | null }[];
}

export interface PatientView {
  linkId: string;
  consultId: string;
  practitioner: string;
  approvedAt: string;
  programme: {
    title: string;
    intro: string;
    reviewInWeeks: number | null;
    safetyAdvice: string[];
    items: {
      name: string;
      dose: { sets: number; reps: number | null; holdSeconds: number | null; frequencyPerWeek: number };
      cue: string;
      progression: string;
    }[];
  };
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

export function contentHash(note: NoteDraft, programme: ProgrammeDraft): string {
  return crypto.createHash("sha256").update(stableStringify({ note, programme })).digest("hex");
}

function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 300);
}

export class Service {
  private db: Db;
  private clinicId: string;
  private provider: DraftingProvider;
  private targets: Record<string, WritebackTarget>;
  private now: () => Date;

  constructor(deps: Deps) {
    this.db = deps.db;
    this.clinicId = deps.clinicId;
    this.provider = deps.provider;
    this.targets = deps.targets;
    this.now = deps.now ?? (() => new Date());
  }

  get providerInfo() {
    return { name: this.provider.name, model: this.provider.model, isMock: this.provider.isMock };
  }

  get targetInfo() {
    return Object.values(this.targets).map((t) => ({ name: t.name, label: t.label, configured: t.isConfigured() }));
  }

  private ts(): string {
    return this.now().toISOString();
  }

  private audit(consultId: string | null, actor: string, action: string, detail?: unknown) {
    // Public patient actions run without a clinic context, so the consult says which clinic it belongs to.
    const owner = consultId
      ? (this.db.prepare("SELECT clinic_id FROM consults WHERE id = ?").get(consultId) as { clinic_id: string | null } | undefined)
      : undefined;
    this.db
      .prepare("INSERT INTO audit_log (consult_id, actor, action, detail, at, clinic_id, entity) VALUES (?, ?, ?, ?, ?, ?, 'consult')")
      .run(consultId, actor, action, detail === undefined ? null : JSON.stringify(detail), this.ts(), owner?.clinic_id ?? this.clinicId);
  }

  private row(id: string): ConsultRow {
    const row = this.db.prepare("SELECT * FROM consults WHERE id = ? AND clinic_id = ?").get(id, this.clinicId) as ConsultRow | undefined;
    if (!row) throw new DomainError("not_found", "Consultation not found");
    return row;
  }

  private approvalRow(id: string): ApprovalRow | undefined {
    return this.db.prepare("SELECT * FROM approvals WHERE consult_id = ?").get(id) as ApprovalRow | undefined;
  }

  private touch(id: string) {
    this.db.prepare("UPDATE consults SET updated_at = ? WHERE id = ?").run(this.ts(), id);
  }

  private requireEditable(row: ConsultRow) {
    if (row.status === "approved") {
      throw new DomainError("invalid_state", "This consultation is approved and can no longer be edited");
    }
  }

  // ---------------------------------------------------------------- consults

  createConsult(
    input: { patientLabel: string; pmsPatientId?: string; practitioner: string; patientId?: string; appointmentId?: string },
    actor: string,
  ): string {
    const patientLabel = input.patientLabel.trim();
    const practitioner = input.practitioner.trim();
    const issues: Issue[] = [];
    if (!patientLabel) issues.push({ path: "patientLabel", message: "Enter a patient name or initials" });
    if (patientLabel.length > 80) issues.push({ path: "patientLabel", message: "Keep the patient label under 80 characters" });
    if (!practitioner) issues.push({ path: "practitioner", message: "Enter the treating physio's name" });
    if (issues.length) throw new DomainError("validation", "Check the consultation details", issues);

    const id = crypto.randomUUID();
    const now = this.ts();
    this.db
      .prepare(
        `INSERT INTO consults (id, patient_label, pms_patient_id, practitioner, status, created_at, updated_at, clinic_id, patient_id, appointment_id)
         VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?, ?)`,
      )
      .run(id, patientLabel, input.pmsPatientId?.trim() || null, practitioner, now, now, this.clinicId, input.patientId ?? null, input.appointmentId ?? null);
    this.audit(id, actor, "consult.created");
    return id;
  }

  listConsults(limit = 50): ConsultSummary[] {
    const rows = this.db
      .prepare("SELECT id, patient_label, practitioner, status, updated_at FROM consults WHERE clinic_id = ? ORDER BY updated_at DESC LIMIT ?")
      .all(this.clinicId, limit) as unknown as Pick<ConsultRow, "id" | "patient_label" | "practitioner" | "status" | "updated_at">[];
    return rows.map((r) => ({
      id: r.id,
      patientLabel: r.patient_label,
      practitioner: r.practitioner,
      status: r.status,
      updatedAt: r.updated_at,
    }));
  }

  getConsult(id: string): ConsultView {
    const row = this.row(id);
    const approval = this.approvalRow(id);

    const links = this.db
      .prepare("SELECT id, created_at, expires_at, revoked_at FROM patient_links WHERE consult_id = ? ORDER BY created_at DESC")
      .all(id) as unknown as { id: string; created_at: string; expires_at: string; revoked_at: string | null }[];
    const checkIns = this.db
      .prepare("SELECT id, adherence, pain_change, comment, created_at FROM check_ins WHERE consult_id = ? ORDER BY created_at DESC")
      .all(id) as unknown as { id: string; adherence: string; pain_change: string; comment: string; created_at: string }[];
    const writebacks = this.db
      .prepare("SELECT * FROM writebacks WHERE consult_id = ? ORDER BY created_at DESC")
      .all(id) as unknown as WritebackRow[];
    const audit = this.db
      .prepare("SELECT at, actor, action, detail FROM audit_log WHERE consult_id = ? ORDER BY id DESC LIMIT 100")
      .all(id) as unknown as { at: string; actor: string; action: string; detail: string | null }[];

    return {
      id: row.id,
      patientLabel: row.patient_label,
      pmsPatientId: row.pms_patient_id,
      practitioner: row.practitioner,
      status: row.status,
      consent: row.consent_at
        ? { at: row.consent_at, method: row.consent_method ?? "verbal", by: row.consent_recorded_by ?? "" }
        : null,
      consentWithdrawnAt: row.consent_withdrawn_at,
      transcript: row.transcript ?? "",
      note: row.note_json ? (JSON.parse(row.note_json) as NoteDraft) : emptyNote(),
      programme: row.programme_json ? (JSON.parse(row.programme_json) as ProgrammeDraft) : emptyProgramme(),
      draftModel: row.draft_model,
      draftedAt: row.drafted_at,
      approval: approval
        ? {
            by: approval.approved_by,
            at: approval.approved_at,
            hash: approval.content_hash,
            note: JSON.parse(approval.note_json) as NoteDraft,
            programme: JSON.parse(approval.programme_json) as ProgrammeDraft,
          }
        : null,
      links: links.map((l) => ({ id: l.id, createdAt: l.created_at, expiresAt: l.expires_at, revokedAt: l.revoked_at })),
      checkIns: checkIns.map((c) => ({
        id: c.id,
        adherence: c.adherence,
        painChange: c.pain_change,
        comment: c.comment,
        createdAt: c.created_at,
      })),
      writebacks,
      audit,
    };
  }

  setPmsPatientId(id: string, pmsPatientId: string, actor: string) {
    const row = this.row(id);
    const value = pmsPatientId.trim();
    const done = this.db
      .prepare("SELECT 1 FROM writebacks WHERE consult_id = ? AND status IN ('succeeded','needs_check')")
      .get(id);
    if (done) throw new DomainError("invalid_state", "The note has already been written; the patient id can no longer change");
    this.db.prepare("UPDATE consults SET pms_patient_id = ?, updated_at = ? WHERE id = ?").run(value || null, this.ts(), row.id);
    this.audit(id, actor, "consult.pms_patient_id_set");
  }

  // ---------------------------------------------------------------- consent (R1)

  recordConsent(id: string, input: { method: string; by: string }, actor: string) {
    const row = this.row(id);
    this.requireEditable(row);
    const method = ConsentMethod.safeParse(input.method);
    if (!method.success) throw new DomainError("validation", "Choose how consent was given", [{ path: "method", message: "Choose verbal or written" }]);
    if (row.consent_at) return; // already recorded; keep the first record
    const by = input.by.trim() || actor;
    this.db
      .prepare(
        `UPDATE consults SET status = 'consented', consent_at = ?, consent_method = ?, consent_recorded_by = ?,
         consent_withdrawn_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(this.ts(), method.data, by, this.ts(), id);
    this.audit(id, actor, "consent.recorded", { method: method.data });
  }

  /** Patient withdraws consent before approval: transcript and drafts are deleted and capture stops. */
  withdrawConsent(id: string, actor: string) {
    const row = this.row(id);
    if (row.status === "approved") {
      throw new DomainError("invalid_state", "This record is approved. Handle the withdrawal under the clinic's records policy.");
    }
    transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE consults SET status = 'created', consent_at = NULL, consent_method = NULL, consent_recorded_by = NULL,
           consent_withdrawn_at = ?, transcript = NULL, note_json = NULL, programme_json = NULL, draft_model = NULL,
           drafted_at = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(this.ts(), this.ts(), id);
      this.audit(id, actor, "consent.withdrawn", { dataDeleted: ["transcript", "note draft", "programme draft"] });
    });
  }

  private requireConsent(row: ConsultRow) {
    if (!row.consent_at) {
      throw new DomainError("consent_required", "Record the patient's consent before capturing or drafting");
    }
  }

  // ---------------------------------------------------------------- capture and drafting (R2, R4)

  saveTranscript(id: string, text: string, actor: string) {
    const row = this.row(id);
    this.requireEditable(row);
    this.requireConsent(row);
    if (text.length > MAX_TRANSCRIPT_CHARS) {
      throw new DomainError("validation", "The transcript is too long", [{ path: "transcript", message: "Keep it under 200,000 characters" }]);
    }
    const status: Status = row.status === "drafted" ? "drafted" : text.trim() ? "captured" : "consented";
    this.db.prepare("UPDATE consults SET transcript = ?, status = ?, updated_at = ? WHERE id = ?").run(text, status, this.ts(), id);
    this.audit(id, actor, "transcript.saved", { chars: text.length });
  }

  async generateDrafts(id: string, actor: string, signal?: AbortSignal) {
    const row = this.row(id);
    this.requireEditable(row);
    this.requireConsent(row);
    const lines = transcriptLines(row.transcript ?? "");
    if (lines.length === 0) throw new DomainError("validation", "Add the consultation transcript first", [{ path: "transcript", message: "The transcript is empty" }]);

    let raw: unknown;
    try {
      raw = await this.provider.draft({ transcriptLines: lines, practitioner: row.practitioner, patientLabel: row.patient_label }, signal);
    } catch (err) {
      this.audit(id, actor, "drafts.failed", { provider: this.provider.name, error: safeError(err) });
      throw new DomainError("draft_failed", "The drafting step failed. You can try again or write the note by hand.");
    }

    // The consult may have changed while the provider ran (approval, withdrawal).
    const fresh = this.row(id);
    this.requireEditable(fresh);
    this.requireConsent(fresh);

    let result: ReturnType<typeof sanitizeDraft>;
    try {
      result = sanitizeDraft(raw, lines.length);
    } catch (err) {
      if (err instanceof DraftShapeError) {
        this.audit(id, actor, "drafts.rejected", { provider: this.provider.name, detail: err.detail });
        throw new DomainError("draft_failed", err.message + " Try again or write the note by hand.");
      }
      throw err;
    }

    const now = this.ts();
    this.db
      .prepare(
        `UPDATE consults SET note_json = ?, programme_json = ?, draft_model = ?, drafted_at = ?, status = 'drafted', updated_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(result.output.note), JSON.stringify(result.output.programme), this.provider.model, now, now, id);
    this.audit(id, actor, "drafts.generated", {
      provider: this.provider.name,
      model: this.provider.model,
      problems: result.output.note.problems.length,
      exercises: result.output.programme.items.length,
      dropped: result.dropped,
    });
    return { dropped: result.dropped };
  }

  /** Saves the physio's edits. Shape is checked here; cross-field rules are enforced at approval. */
  saveDrafts(id: string, input: { note: unknown; programme: unknown }, actor: string) {
    const row = this.row(id);
    this.requireEditable(row);
    this.requireConsent(row);
    const parsed = DraftOutput.safeParse({ note: input.note, programme: input.programme });
    if (!parsed.success) {
      throw new DomainError(
        "validation",
        "Some fields are not valid",
        parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      );
    }
    this.db
      .prepare("UPDATE consults SET note_json = ?, programme_json = ?, status = 'drafted', drafted_at = COALESCE(drafted_at, ?), updated_at = ? WHERE id = ?")
      .run(JSON.stringify(parsed.data.note), JSON.stringify(parsed.data.programme), this.ts(), this.ts(), id);
    this.audit(id, actor, "drafts.edited");
  }

  // ---------------------------------------------------------------- approval gate (R3)

  approve(id: string, practitioner: string): { hash: string } {
    return transaction(this.db, () => {
      const row = this.row(id);
      if (row.status === "approved") throw new DomainError("invalid_state", "Already approved");
      if (row.status !== "drafted" || !row.note_json || !row.programme_json) {
        throw new DomainError("invalid_state", "Draft the note and programme before approving");
      }
      this.requireConsent(row);

      const note = JSON.parse(row.note_json) as NoteDraft;
      const programme = JSON.parse(row.programme_json) as ProgrammeDraft;
      const lineCount = transcriptLines(row.transcript ?? "").length;
      const issues = approvalIssues({ note, programme });
      issues.push(...crossCheck({ note, programme }, { transcriptLineCount: lineCount }).filter((i) => i.message.startsWith("Evidence line")));
      if (issues.length) throw new DomainError("validation", "Fix these before approving", issues);

      const hash = contentHash(note, programme);
      const at = this.ts();
      this.db
        .prepare("INSERT INTO approvals (id, consult_id, approved_by, approved_at, note_json, programme_json, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(crypto.randomUUID(), id, practitioner, at, JSON.stringify(note), JSON.stringify(programme), hash);
      this.db.prepare("UPDATE consults SET status = 'approved', updated_at = ? WHERE id = ?").run(at, id);
      this.audit(id, practitioner, "drafts.approved", { hash, aiModel: row.draft_model });
      return { hash };
    });
  }

  private requireApproval(id: string): { row: ConsultRow; approval: ApprovalRow } {
    const row = this.row(id);
    const approval = this.approvalRow(id);
    if (!approval || row.status !== "approved") {
      throw new DomainError("invalid_state", "Nothing is saved to the record or sent to a patient until the physio approves");
    }
    return { row, approval };
  }

  // ---------------------------------------------------------------- patient link (R6) and check-ins (R8)

  /** Returns the raw token once. Only its hash is stored. Creating a link revokes earlier ones. */
  createPatientLink(id: string, actor: string, ttlDays = DEFAULT_LINK_DAYS): { token: string; expiresAt: string } {
    this.requireApproval(id);
    const programme = JSON.parse(this.approvalRow(id)!.programme_json) as ProgrammeDraft;
    if (programme.items.length === 0) throw new DomainError("invalid_state", "The approved programme has no exercises to send");

    const token = crypto.randomBytes(24).toString("base64url");
    const now = this.now();
    const expiresAt = new Date(now.getTime() + ttlDays * 86_400_000).toISOString();
    transaction(this.db, () => {
      this.db.prepare("UPDATE patient_links SET revoked_at = ? WHERE consult_id = ? AND revoked_at IS NULL").run(now.toISOString(), id);
      this.db
        .prepare("INSERT INTO patient_links (id, consult_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .run(crypto.randomUUID(), id, hashToken(token), now.toISOString(), expiresAt);
      this.audit(id, actor, "patient_link.created", { expiresAt });
    });
    return { token, expiresAt };
  }

  revokePatientLinks(id: string, actor: string) {
    this.row(id);
    const res = this.db.prepare("UPDATE patient_links SET revoked_at = ? WHERE consult_id = ? AND revoked_at IS NULL").run(this.ts(), id);
    this.audit(id, actor, "patient_link.revoked", { count: Number(res.changes) });
  }

  private linkByToken(token: string) {
    if (!token || token.length > 128) return undefined;
    const link = this.db
      .prepare("SELECT id, consult_id, expires_at, revoked_at FROM patient_links WHERE token_hash = ?")
      .get(hashToken(token)) as { id: string; consult_id: string; expires_at: string; revoked_at: string | null } | undefined;
    if (!link || link.revoked_at) return undefined;
    if (new Date(link.expires_at).getTime() <= this.now().getTime()) return undefined;
    return link;
  }

  getPatientView(token: string): PatientView | null {
    const link = this.linkByToken(token);
    if (!link) return null;
    const approval = this.approvalRow(link.consult_id);
    const row = this.db.prepare("SELECT practitioner FROM consults WHERE id = ?").get(link.consult_id) as { practitioner: string } | undefined;
    if (!approval || !row) return null;
    const programme = JSON.parse(approval.programme_json) as ProgrammeDraft;
    return {
      linkId: link.id,
      consultId: link.consult_id,
      practitioner: row.practitioner,
      approvedAt: approval.approved_at,
      programme: {
        title: programme.title,
        intro: programme.patientIntro,
        reviewInWeeks: programme.reviewInWeeks,
        safetyAdvice: programme.safetyAdvice,
        items: programme.items.map((item) => {
          const ex = getExercise(item.exerciseId);
          return {
            name: ex?.name ?? item.exerciseId,
            dose: { sets: item.sets, reps: item.reps, holdSeconds: item.holdSeconds, frequencyPerWeek: item.frequencyPerWeek },
            cue: item.cue || ex?.cue || "",
            progression: item.progression,
          };
        }),
      },
    };
  }

  submitCheckIn(token: string, input: unknown) {
    const link = this.linkByToken(token);
    if (!link) throw new DomainError("not_found", "This link is no longer active");
    const parsed = CheckInInput.safeParse(input);
    if (!parsed.success) throw new DomainError("validation", "Choose how the exercises went and how the pain is");
    const since = new Date(this.now().getTime() - 86_400_000).toISOString();
    const recent = this.db
      .prepare("SELECT COUNT(*) AS n FROM check_ins WHERE link_id = ? AND created_at > ?")
      .get(link.id, since) as { n: number | bigint };
    if (Number(recent.n) >= CHECKINS_PER_DAY) throw new DomainError("rate_limited", "That is enough check-ins for today. Thank you.");
    this.db
      .prepare("INSERT INTO check_ins (id, consult_id, link_id, adherence, pain_change, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), link.consult_id, link.id, parsed.data.adherence, parsed.data.painChange, parsed.data.comment, this.ts());
    this.audit(link.consult_id, "patient", "check_in.submitted", { adherence: parsed.data.adherence, painChange: parsed.data.painChange });
  }

  // ---------------------------------------------------------------- write-back (R5) and copy-ready fallback

  approvedNoteText(id: string): string {
    const { row, approval } = this.requireApproval(id);
    return noteToText(
      JSON.parse(approval.note_json) as NoteDraft,
      JSON.parse(approval.programme_json) as ProgrammeDraft,
      { practitioner: approval.approved_by, approvedAt: approval.approved_at, model: row.draft_model },
    );
  }

  async writeBack(id: string, targetName: string, actor: string): Promise<WritebackRow> {
    const { row, approval } = this.requireApproval(id);
    const target = this.targets[targetName];
    if (!target) throw new DomainError("writeback_unavailable", `Unknown destination "${targetName}"`);
    if (!target.isConfigured()) throw new DomainError("writeback_unavailable", `${target.label} is not set up. Use the copy-ready note instead.`);
    if (!row.pms_patient_id) {
      throw new DomainError("validation", `Add the ${target.label} patient ID first`, [{ path: "pmsPatientId", message: "Required for write-back" }]);
    }

    const key = crypto.createHash("sha256").update(`${id}:${approval.content_hash}:${targetName}`).digest("hex");
    const existing = this.db.prepare("SELECT * FROM writebacks WHERE idempotency_key = ?").get(key) as WritebackRow | undefined;

    if (existing?.status === "succeeded" || existing?.status === "needs_check") return existing;
    if (existing?.status === "pending") {
      // A previous attempt never reported back. We cannot tell whether the note was created, so stop
      // and ask a person to check rather than risk a duplicate.
      this.db.prepare("UPDATE writebacks SET status = 'needs_check', updated_at = ? WHERE id = ?").run(this.ts(), existing.id);
      this.audit(id, actor, "writeback.needs_check", { target: targetName });
      return this.db.prepare("SELECT * FROM writebacks WHERE id = ?").get(existing.id) as unknown as WritebackRow;
    }

    let wbId: string;
    if (existing) {
      wbId = existing.id; // failed earlier; retrying
      this.db.prepare("UPDATE writebacks SET status = 'pending', error = NULL, attempts = attempts + 1, updated_at = ? WHERE id = ?").run(this.ts(), wbId);
    } else {
      wbId = crypto.randomUUID();
      this.db
        .prepare(
          "INSERT INTO writebacks (id, consult_id, target, idempotency_key, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 1, ?, ?)",
        )
        .run(wbId, id, targetName, key, this.ts(), this.ts());
    }

    try {
      const { externalId } = await target.createNote({
        patientId: row.pms_patient_id,
        title: `Physiotherapy consultation ${approval.approved_at.slice(0, 10)}`,
        text: this.approvedNoteText(id),
        practitioner: approval.approved_by,
        reference: id,
      });
      this.db.prepare("UPDATE writebacks SET status = 'succeeded', external_id = ?, updated_at = ? WHERE id = ?").run(externalId, this.ts(), wbId);
      this.audit(id, actor, "writeback.succeeded", { target: targetName, externalId });
    } catch (err) {
      this.db.prepare("UPDATE writebacks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(safeError(err), this.ts(), wbId);
      this.audit(id, actor, "writeback.failed", { target: targetName, error: safeError(err) });
    }
    return this.db.prepare("SELECT * FROM writebacks WHERE id = ?").get(wbId) as unknown as WritebackRow;
  }

  /** A person checked the practice system after an uncertain attempt and says what they found. */
  resolveWriteback(id: string, targetName: string, outcome: "written" | "not_written", actor: string, externalId?: string) {
    const { approval } = this.requireApproval(id);
    const key = crypto.createHash("sha256").update(`${id}:${approval.content_hash}:${targetName}`).digest("hex");
    const existing = this.db.prepare("SELECT * FROM writebacks WHERE idempotency_key = ?").get(key) as WritebackRow | undefined;
    if (!existing || existing.status !== "needs_check") throw new DomainError("invalid_state", "Nothing to resolve");
    if (outcome === "written") {
      this.db.prepare("UPDATE writebacks SET status = 'succeeded', external_id = ?, updated_at = ? WHERE id = ?").run(externalId?.trim() || null, this.ts(), existing.id);
    } else {
      this.db.prepare("UPDATE writebacks SET status = 'failed', error = 'Confirmed not written', updated_at = ? WHERE id = ?").run(this.ts(), existing.id);
    }
    this.audit(id, actor, "writeback.resolved", { target: targetName, outcome });
  }
}
