import crypto from "node:crypto";
import { clinicOf, type Db } from "./db";
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
import { AyurvedaDraft, AyurvedaPlan, AyurvedaRecord, KIND_ORDER, emptyPlan, emptyRecord, type PlanKind } from "./ayurveda/schemas";
import { ayurvedaApprovalIssues } from "./ayurveda/validation";
import { ayurvedaNoteToText } from "./ayurveda/format";
import type { WritebackTarget } from "./writeback/types";
import { ruleTriage } from "./triage";
import { baseMime, formatLines, isAudioType, MAX_AUDIO_BYTES, type Transcriber } from "./speech/types";

export type Discipline = "physio" | "ayurveda";
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
  /** Turns a recording into text. Null or absent means audio capture is off. */
  transcriber?: Transcriber | null;
  now?: () => Date;
}

interface ConsultRow {
  id: string;
  discipline: Discipline;
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
  discipline: Discipline;
  patientLabel: string;
  practitioner: string;
  status: Status;
  updatedAt: string;
}

export interface ConsultView {
  id: string;
  discipline: Discipline;
  patientLabel: string;
  pmsPatientId: string | null;
  practitioner: string;
  status: Status;
  consent: { at: string; method: "verbal" | "written"; by: string } | null;
  consentWithdrawnAt: string | null;
  transcript: string;
  note: NoteDraft;
  programme: ProgrammeDraft;
  /** The Ayurvedic record and plan. Set only for an Ayurveda consultation; then `note` and `programme` are empty. */
  ayurveda: AyurvedaDraft | null;
  draftModel: string | null;
  draftedAt: string | null;
  approval: { by: string; at: string; hash: string; note: NoteDraft; programme: ProgrammeDraft; ayurveda: AyurvedaDraft | null } | null;
  links: { id: string; createdAt: string; expiresAt: string; revokedAt: string | null }[];
  checkIns: { id: string; adherence: string; painChange: string; comment: string; createdAt: string }[];
  writebacks: WritebackRow[];
  audit: { at: string; actor: string; action: string; detail: string | null }[];
}

export interface AyurvedaPatientPlan {
  title: string;
  intro: string;
  reviewInWeeks: number | null;
  safetyAdvice: string[];
  groups: { kind: PlanKind; items: { name: string; instructions: string; duration: string; where: "home" | "clinic"; cautions: string }[] }[];
}

export interface PatientView {
  linkId: string;
  consultId: string;
  discipline: Discipline;
  practitioner: string;
  approvedAt: string;
  /** Set for an Ayurveda consultation, with `programme` empty. */
  ayurveda: AyurvedaPatientPlan | null;
  /** A summary the practitioner has read and finalised, or null. */
  summary: { text: string; language: string } | null;
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
  private transcriber: Transcriber | null;
  private now: () => Date;

  constructor(deps: Deps) {
    this.db = deps.db;
    this.clinicId = deps.clinicId;
    this.provider = deps.provider;
    this.targets = deps.targets;
    this.transcriber = deps.transcriber ?? null;
    this.now = deps.now ?? (() => new Date());
  }

  get providerInfo() {
    return { name: this.provider.name, model: this.provider.model, isMock: this.provider.isMock };
  }

  get audioInfo() {
    return this.transcriber ? { enabled: true, name: this.transcriber.name, isMock: this.transcriber.isMock } : { enabled: false, name: "", isMock: false };
  }

  get targetInfo() {
    return Object.values(this.targets).map((t) => ({ name: t.name, label: t.label, configured: t.isConfigured() }));
  }

  private ts(): string {
    return this.now().toISOString();
  }

  /** Runs `fn` as one transaction in this service's clinic. */
  private in<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.scope(this.clinicId, fn);
  }

  private async audit(consultId: string | null, actor: string, action: string, detail?: unknown, clinicId = this.clinicId) {
    await this.db.run("INSERT INTO audit_log (consult_id, actor, action, detail, at, clinic_id, entity) VALUES (?, ?, ?, ?, ?, ?, 'consult')", [
      consultId, actor, action, detail === undefined ? null : JSON.stringify(detail), this.ts(), clinicId,
    ]);
  }

  private async row(id: string, lock = false): Promise<ConsultRow> {
    const row = await this.db.get<ConsultRow>(`SELECT * FROM consults WHERE id = ? AND clinic_id = ?${lock ? " FOR UPDATE" : ""}`, [id, this.clinicId]);
    if (!row) throw new DomainError("not_found", "Consultation not found");
    return row;
  }

  private async approvalRow(id: string): Promise<ApprovalRow | undefined> {
    return this.db.get<ApprovalRow>("SELECT * FROM approvals WHERE consult_id = ?", [id]);
  }

  private requireEditable(row: ConsultRow) {
    if (row.status === "approved") {
      throw new DomainError("invalid_state", "This consultation is approved and can no longer be edited");
    }
  }

  // ---------------------------------------------------------------- consults

  createConsult(
    input: { patientLabel: string; pmsPatientId?: string; practitioner: string; patientId?: string; appointmentId?: string; discipline?: Discipline },
    actor: string,
  ): Promise<string> {
    const discipline: Discipline = input.discipline ?? "physio";
    const patientLabel = input.patientLabel.trim();
    const practitioner = input.practitioner.trim();
    const issues: Issue[] = [];
    if (!patientLabel) issues.push({ path: "patientLabel", message: "Enter a patient name or initials" });
    if (patientLabel.length > 80) issues.push({ path: "patientLabel", message: "Keep the patient label under 80 characters" });
    if (!practitioner) issues.push({ path: "practitioner", message: discipline === "ayurveda" ? "Enter the treating practitioner's name" : "Enter the treating physio's name" });
    if (discipline !== "physio" && discipline !== "ayurveda") issues.push({ path: "discipline", message: "Choose physiotherapy or Ayurveda" });
    if (issues.length) throw new DomainError("validation", "Check the consultation details", issues);

    return this.in(async () => {
      const clinic = await this.db.get<{ disciplines: string }>("SELECT disciplines FROM clinics WHERE id = ?", [this.clinicId]);
      if (clinic && clinic.disciplines !== "both" && clinic.disciplines !== discipline) {
        throw new DomainError("validation", `This clinic is not set up for ${discipline === "ayurveda" ? "Ayurveda" : "physiotherapy"}. The owner can change that in Settings.`);
      }
      const id = crypto.randomUUID();
      const now = this.ts();
      await this.db.run(
        `INSERT INTO consults (id, patient_label, pms_patient_id, practitioner, status, created_at, updated_at, clinic_id, patient_id, appointment_id, discipline)
         VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)`,
        [id, patientLabel, input.pmsPatientId?.trim() || null, practitioner, now, now, this.clinicId, input.patientId ?? null, input.appointmentId ?? null, discipline],
      );
      await this.audit(id, actor, "consult.created", discipline === "ayurveda" ? { discipline } : undefined);
      return id;
    });
  }

  async listConsults(limit = 50): Promise<ConsultSummary[]> {
    return this.in(async () => {
      const rows = await this.db.all<Pick<ConsultRow, "id" | "discipline" | "patient_label" | "practitioner" | "status" | "updated_at">>(
        "SELECT id, discipline, patient_label, practitioner, status, updated_at FROM consults WHERE clinic_id = ? ORDER BY updated_at DESC LIMIT ?",
        [this.clinicId, limit],
      );
      return rows.map((r) => ({ id: r.id, discipline: r.discipline, patientLabel: r.patient_label, practitioner: r.practitioner, status: r.status, updatedAt: r.updated_at }));
    });
  }

  async getConsult(id: string): Promise<ConsultView> {
    return this.in(async () => {
      const row = await this.row(id);
      const approval = await this.approvalRow(id);

      const links = await this.db.all<{ id: string; created_at: string; expires_at: string; revoked_at: string | null }>(
        "SELECT id, created_at, expires_at, revoked_at FROM patient_links WHERE consult_id = ? ORDER BY created_at DESC",
        [id],
      );
      const checkIns = await this.db.all<{ id: string; adherence: string; pain_change: string; comment: string; created_at: string }>(
        "SELECT id, adherence, pain_change, comment, created_at FROM check_ins WHERE consult_id = ? ORDER BY created_at DESC",
        [id],
      );
      const writebacks = await this.db.all<WritebackRow>("SELECT * FROM writebacks WHERE consult_id = ? ORDER BY created_at DESC", [id]);
      const audit = await this.db.all<{ at: string; actor: string; action: string; detail: string | null }>(
        "SELECT at, actor, action, detail FROM audit_log WHERE consult_id = ? ORDER BY id DESC LIMIT 100",
        [id],
      );

      const ayurveda = row.discipline === "ayurveda";
      return {
        id: row.id,
        discipline: row.discipline,
        patientLabel: row.patient_label,
        pmsPatientId: row.pms_patient_id,
        practitioner: row.practitioner,
        status: row.status,
        consent: row.consent_at ? { at: row.consent_at, method: row.consent_method ?? "verbal", by: row.consent_recorded_by ?? "" } : null,
        consentWithdrawnAt: row.consent_withdrawn_at,
        transcript: row.transcript ?? "",
        note: !ayurveda && row.note_json ? (JSON.parse(row.note_json) as NoteDraft) : emptyNote(),
        programme: !ayurveda && row.programme_json ? (JSON.parse(row.programme_json) as ProgrammeDraft) : emptyProgramme(),
        ayurveda: ayurveda
          ? { record: row.note_json ? (JSON.parse(row.note_json) as AyurvedaRecord) : emptyRecord(), plan: row.programme_json ? (JSON.parse(row.programme_json) as AyurvedaPlan) : emptyPlan() }
          : null,
        draftModel: row.draft_model,
        draftedAt: row.drafted_at,
        approval: approval
          ? {
              by: approval.approved_by,
              at: approval.approved_at,
              hash: approval.content_hash,
              note: ayurveda ? emptyNote() : (JSON.parse(approval.note_json) as NoteDraft),
              programme: ayurveda ? emptyProgramme() : (JSON.parse(approval.programme_json) as ProgrammeDraft),
              ayurveda: ayurveda ? { record: JSON.parse(approval.note_json) as AyurvedaRecord, plan: JSON.parse(approval.programme_json) as AyurvedaPlan } : null,
            }
          : null,
        links: links.map((l) => ({ id: l.id, createdAt: l.created_at, expiresAt: l.expires_at, revokedAt: l.revoked_at })),
        checkIns: checkIns.map((c) => ({ id: c.id, adherence: c.adherence, painChange: c.pain_change, comment: c.comment, createdAt: c.created_at })),
        writebacks,
        audit,
      };
    });
  }

  async setPmsPatientId(id: string, pmsPatientId: string, actor: string): Promise<void> {
    return this.in(async () => {
      const row = await this.row(id);
      const value = pmsPatientId.trim();
      const done = await this.db.get("SELECT 1 FROM writebacks WHERE consult_id = ? AND status IN ('succeeded','needs_check')", [id]);
      if (done) throw new DomainError("invalid_state", "The note has already been written; the patient id can no longer change");
      await this.db.run("UPDATE consults SET pms_patient_id = ?, updated_at = ? WHERE id = ?", [value || null, this.ts(), row.id]);
      await this.audit(id, actor, "consult.pms_patient_id_set");
    });
  }

  // ---------------------------------------------------------------- consent (R1)

  async recordConsent(id: string, input: { method: string; by: string }, actor: string): Promise<void> {
    return this.in(async () => {
      const row = await this.row(id, true);
      this.requireEditable(row);
      const method = ConsentMethod.safeParse(input.method);
      if (!method.success) throw new DomainError("validation", "Choose how consent was given", [{ path: "method", message: "Choose verbal or written" }]);
      if (row.consent_at) return; // already recorded; keep the first record
      const by = input.by.trim() || actor;
      await this.db.run(
        `UPDATE consults SET status = 'consented', consent_at = ?, consent_method = ?, consent_recorded_by = ?,
         consent_withdrawn_at = NULL, updated_at = ? WHERE id = ?`,
        [this.ts(), method.data, by, this.ts(), id],
      );
      await this.audit(id, actor, "consent.recorded", { method: method.data });
    });
  }

  /** Patient withdraws consent before approval: transcript and drafts are deleted and capture stops. */
  async withdrawConsent(id: string, actor: string): Promise<void> {
    return this.in(async () => {
      const row = await this.row(id, true);
      if (row.status === "approved") {
        throw new DomainError("invalid_state", "This record is approved. Handle the withdrawal under the clinic's records policy.");
      }
      await this.db.run(
        `UPDATE consults SET status = 'created', consent_at = NULL, consent_method = NULL, consent_recorded_by = NULL,
         consent_withdrawn_at = ?, transcript = NULL, note_json = NULL, programme_json = NULL, draft_model = NULL,
         drafted_at = NULL, updated_at = ? WHERE id = ?`,
        [this.ts(), this.ts(), id],
      );
      await this.audit(id, actor, "consent.withdrawn", { dataDeleted: ["transcript", "note draft", "programme draft"] });
    });
  }

  private requireConsent(row: ConsultRow) {
    if (!row.consent_at) {
      throw new DomainError("consent_required", "Record the patient's consent before capturing or drafting");
    }
  }

  // ---------------------------------------------------------------- capture and drafting (R2, R4)

  private requirePhysio(row: ConsultRow) {
    if (row.discipline !== "physio") throw new DomainError("invalid_state", "Ayurvedic consultations are written by the practitioner; there is no transcript or AI drafting");
  }

  async saveTranscript(id: string, text: string, actor: string): Promise<void> {
    return this.in(async () => {
      const row = await this.row(id, true);
      this.requirePhysio(row);
      this.requireEditable(row);
      this.requireConsent(row);
      if (text.length > MAX_TRANSCRIPT_CHARS) {
        throw new DomainError("validation", "The transcript is too long", [{ path: "transcript", message: "Keep it under 200,000 characters" }]);
      }
      const status: Status = row.status === "drafted" ? "drafted" : text.trim() ? "captured" : "consented";
      await this.db.run("UPDATE consults SET transcript = ?, status = ?, updated_at = ? WHERE id = ?", [text, status, this.ts(), id]);
      await this.audit(id, actor, "transcript.saved", { chars: text.length });
    });
  }

  /**
   * Turns a recording into transcript text and adds it to the consultation's transcript. The audio is held in memory
   * for the length of this call and is never written anywhere: only the text is kept, and the audit trail records
   * sizes and the confirmation, never content. Three steps so no connection is held while the speech service works.
   */
  async captureAudio(id: string, input: { audio: Uint8Array; mime: string; audioConsent: boolean }, actor: string, signal?: AbortSignal): Promise<{ transcript: string; added: string }> {
    const transcriber = this.transcriber;
    if (!transcriber) throw new DomainError("invalid_state", "Audio capture is not set up for this clinic");
    if (!input.audioConsent) {
      throw new DomainError("validation", "Confirm the patient agreed to the recording", [{ path: "audioConsent", message: "Confirm the patient agreed to the recording" }]);
    }
    if (!isAudioType(input.mime)) throw new DomainError("validation", "That is not a supported audio file", [{ path: "audio", message: "Use a recording from the browser or an audio file (webm, ogg, mp3, m4a, wav, flac)" }]);
    if (input.audio.length === 0) throw new DomainError("validation", "The recording is empty", [{ path: "audio", message: "Nothing was recorded" }]);
    if (input.audio.length > MAX_AUDIO_BYTES) throw new DomainError("validation", "The recording is too large", [{ path: "audio", message: "Keep it under 100 MB" }]);

    await this.in(async () => {
      const row = await this.row(id, true);
      this.requirePhysio(row);
      this.requireEditable(row);
      this.requireConsent(row);
      await this.audit(id, actor, "audio.received", { bytes: input.audio.length, type: baseMime(input.mime), provider: transcriber.name, audioConsentConfirmed: true });
    });

    let text: string;
    try {
      text = formatLines(await transcriber.transcribe(input.audio, input.mime, signal));
    } catch (err) {
      if (signal?.aborted) throw err;
      const message = err instanceof Error ? err.message : "failed";
      await this.in(() => this.audit(id, actor, "audio.failed", { reason: message.slice(0, 80) }));
      throw new DomainError("draft_failed", "The recording could not be turned into text. Nothing was saved and the audio was not kept. You can try again or type the transcript.");
    }
    if (!text.trim()) throw new DomainError("validation", "No speech was found in the recording", [{ path: "audio", message: "No speech was found" }]);

    return this.in(async () => {
      const row = await this.row(id, true);
      this.requirePhysio(row);
      this.requireEditable(row);
      // Consent may have been withdrawn while the recording was being processed; the text is then discarded.
      this.requireConsent(row);
      const joined = row.transcript?.trim() ? `${row.transcript.trimEnd()}\n${text}` : text;
      if (joined.length > MAX_TRANSCRIPT_CHARS) {
        throw new DomainError("validation", "The transcript is too long", [{ path: "transcript", message: "Keep it under 200,000 characters" }]);
      }
      const status: Status = row.status === "drafted" ? "drafted" : "captured";
      await this.db.run("UPDATE consults SET transcript = ?, status = ?, updated_at = ? WHERE id = ?", [joined, status, this.ts(), id]);
      await this.audit(id, actor, "audio.transcribed", { chars: text.length, provider: transcriber.name });
      return { transcript: joined, added: text };
    });
  }

  /**
   * Three steps so that no database connection is held while the drafting service is being called: read what is
   * needed, call the provider, then write the result (checking the consult has not changed in the meantime).
   */
  async generateDrafts(id: string, actor: string, signal?: AbortSignal) {
    const input = await this.in(async () => {
      const row = await this.row(id);
      this.requirePhysio(row);
      this.requireEditable(row);
      this.requireConsent(row);
      const lines = transcriptLines(row.transcript ?? "");
      if (lines.length === 0) throw new DomainError("validation", "Add the consultation transcript first", [{ path: "transcript", message: "The transcript is empty" }]);
      return { lines, practitioner: row.practitioner, patientLabel: row.patient_label };
    });

    let raw: unknown;
    try {
      raw = await this.provider.draft({ transcriptLines: input.lines, practitioner: input.practitioner, patientLabel: input.patientLabel }, signal);
    } catch (err) {
      await this.in(() => this.audit(id, actor, "drafts.failed", { provider: this.provider.name, error: safeError(err) }));
      throw new DomainError("draft_failed", "The drafting step failed. You can try again or write the note by hand.");
    }
    const lines = input.lines;

    const outcome = await this.in(async () => {
      // The consult may have changed while the provider ran (approval, withdrawal).
      const fresh = await this.row(id, true);
      this.requireEditable(fresh);
      this.requireConsent(fresh);

      let result: ReturnType<typeof sanitizeDraft>;
      try {
        result = sanitizeDraft(raw, lines.length);
      } catch (err) {
        if (err instanceof DraftShapeError) {
          await this.audit(id, actor, "drafts.rejected", { provider: this.provider.name, detail: err.detail });
          return new DomainError("draft_failed", err.message + " Try again or write the note by hand.");
        }
        throw err;
      }

      const now = this.ts();
      await this.db.run(
        `UPDATE consults SET note_json = ?, programme_json = ?, draft_model = ?, drafted_at = ?, status = 'drafted', updated_at = ? WHERE id = ?`,
        [JSON.stringify(result.output.note), JSON.stringify(result.output.programme), this.provider.model, now, now, id],
      );
      await this.audit(id, actor, "drafts.generated", {
        provider: this.provider.name,
        model: this.provider.model,
        problems: result.output.note.problems.length,
        exercises: result.output.programme.items.length,
        dropped: result.dropped,
      });
      return { dropped: result.dropped };
    });
    // A rejected draft is thrown only now, so the audit line recording it is kept.
    if (outcome instanceof DomainError) throw outcome;
    return outcome;
  }

  /** Saves the physio's edits. Shape is checked here; cross-field rules are enforced at approval. */
  async saveDrafts(id: string, input: { note: unknown; programme: unknown }, actor: string): Promise<void> {
    return this.in(async () => {
      const row = await this.row(id, true);
      this.requirePhysio(row);
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
      await this.db.run("UPDATE consults SET note_json = ?, programme_json = ?, status = 'drafted', drafted_at = COALESCE(drafted_at, ?::timestamptz), updated_at = ? WHERE id = ?", [
        JSON.stringify(parsed.data.note), JSON.stringify(parsed.data.programme), this.ts(), this.ts(), id,
      ]);
      await this.audit(id, actor, "drafts.edited");
    });
  }

  /** Saves the practitioner's Ayurvedic record and plan. Shape is checked here; completeness is enforced at approval. */
  async saveAyurveda(id: string, input: { record: unknown; plan: unknown }, actor: string): Promise<void> {
    return this.in(async () => {
      const row = await this.row(id, true);
      if (row.discipline !== "ayurveda") throw new DomainError("invalid_state", "This is not an Ayurvedic consultation");
      this.requireEditable(row);
      this.requireConsent(row);
      const parsed = AyurvedaDraft.safeParse({ record: input.record, plan: input.plan });
      if (!parsed.success) {
        throw new DomainError("validation", "Some fields are not valid", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
      }
      // A saved record is the practitioner's own work, so no model is named and the "unscreened" state is never assumed.
      await this.db.run("UPDATE consults SET note_json = ?, programme_json = ?, status = 'drafted', drafted_at = COALESCE(drafted_at, ?::timestamptz), draft_model = NULL, updated_at = ? WHERE id = ?", [
        JSON.stringify(parsed.data.record), JSON.stringify(parsed.data.plan), this.ts(), this.ts(), id,
      ]);
      await this.audit(id, actor, "ayurveda.saved");
    });
  }

  // ---------------------------------------------------------------- approval gate (R3)

  async approve(id: string, practitioner: string): Promise<{ hash: string }> {
    return this.in(async () => {
      const row = await this.row(id, true);
      if (row.status === "approved") throw new DomainError("invalid_state", "Already approved");
      if (row.status !== "drafted" || !row.note_json || !row.programme_json) {
        throw new DomainError("invalid_state", "Draft the note and programme before approving");
      }
      this.requireConsent(row);

      let note: unknown;
      let programme: unknown;
      if (row.discipline === "ayurveda") {
        const parsed = AyurvedaDraft.parse({ record: JSON.parse(row.note_json), plan: JSON.parse(row.programme_json) });
        const issues = ayurvedaApprovalIssues(parsed);
        if (issues.length) throw new DomainError("validation", "Fix these before approving", issues);
        note = parsed.record;
        programme = parsed.plan;
      } else {
        const n = JSON.parse(row.note_json) as NoteDraft;
        const pr = JSON.parse(row.programme_json) as ProgrammeDraft;
        const lineCount = transcriptLines(row.transcript ?? "").length;
        const issues = approvalIssues({ note: n, programme: pr });
        issues.push(...crossCheck({ note: n, programme: pr }, { transcriptLineCount: lineCount }).filter((i) => i.message.startsWith("Evidence line")));
        if (issues.length) throw new DomainError("validation", "Fix these before approving", issues);
        note = n;
        programme = pr;
      }

      const hash = contentHash(note as NoteDraft, programme as ProgrammeDraft);
      const at = this.ts();
      await this.db.run("INSERT INTO approvals (id, clinic_id, consult_id, approved_by, approved_at, note_json, programme_json, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
        crypto.randomUUID(), this.clinicId, id, practitioner, at, JSON.stringify(note), JSON.stringify(programme), hash,
      ]);
      await this.db.run("UPDATE consults SET status = 'approved', updated_at = ? WHERE id = ?", [at, id]);
      await this.audit(id, practitioner, row.discipline === "ayurveda" ? "ayurveda.approved" : "drafts.approved", { hash, aiModel: row.draft_model });
      return { hash };
    });
  }

  private async requireApproval(id: string): Promise<{ row: ConsultRow; approval: ApprovalRow }> {
    const row = await this.row(id);
    const approval = await this.approvalRow(id);
    if (!approval || row.status !== "approved") {
      throw new DomainError("invalid_state", "Nothing is saved to the record or sent to a patient until the practitioner approves");
    }
    return { row, approval };
  }

  // ---------------------------------------------------------------- patient link (R6) and check-ins (R8)

  /** Returns the raw token once. Only its hash is stored. Creating a link revokes earlier ones. */
  async createPatientLink(id: string, actor: string, ttlDays = DEFAULT_LINK_DAYS): Promise<{ token: string; expiresAt: string }> {
    return this.in(async () => {
      const { row, approval } = await this.requireApproval(id);
      const programme = JSON.parse(approval.programme_json) as { items: unknown[] };
      if (programme.items.length === 0) {
        throw new DomainError("invalid_state", row.discipline === "ayurveda" ? "The approved plan has nothing to send" : "The approved programme has no exercises to send");
      }

      const token = crypto.randomBytes(24).toString("base64url");
      const now = this.now();
      const expiresAt = new Date(now.getTime() + ttlDays * 86_400_000).toISOString();
      await this.db.run("UPDATE patient_links SET revoked_at = ? WHERE consult_id = ? AND revoked_at IS NULL", [now.toISOString(), id]);
      await this.db.run("INSERT INTO patient_links (id, clinic_id, consult_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", [
        crypto.randomUUID(), this.clinicId, id, hashToken(token), now.toISOString(), expiresAt,
      ]);
      await this.audit(id, actor, "patient_link.created", { expiresAt });
      return { token, expiresAt };
    });
  }

  async revokePatientLinks(id: string, actor: string): Promise<void> {
    return this.in(async () => {
      await this.row(id);
      const n = await this.db.run("UPDATE patient_links SET revoked_at = ? WHERE consult_id = ? AND revoked_at IS NULL", [this.ts(), id]);
      await this.audit(id, actor, "patient_link.revoked", { count: n });
    });
  }

  /**
   * Patient pages carry only a secret token. The clinic is found from the token's hash first and the rest runs inside
   * that clinic, so a token can only ever reach its own consultation.
   */
  private async viaToken<T>(token: string, fn: (link: { id: string; consult_id: string; clinic_id: string }, clinicId: string) => Promise<T>): Promise<T | null> {
    if (!token || token.length > 128) return null;
    const hash = hashToken(token);
    const clinicId = await clinicOf(this.db, "patient_link", hash);
    if (!clinicId) return null;
    return this.db.scope(clinicId, async () => {
      const link = await this.db.get<{ id: string; consult_id: string; clinic_id: string; expires_at: string; revoked_at: string | null }>(
        "SELECT id, consult_id, clinic_id, expires_at, revoked_at FROM patient_links WHERE token_hash = ?",
        [hash],
      );
      if (!link || link.revoked_at) return null;
      if (new Date(link.expires_at).getTime() <= this.now().getTime()) return null;
      return fn(link, clinicId);
    });
  }

  async getPatientView(token: string): Promise<PatientView | null> {
    return this.viaToken(token, async (link) => {
      const approval = await this.approvalRow(link.consult_id);
      const row = await this.db.get<{ practitioner: string; discipline: Discipline }>("SELECT practitioner, discipline FROM consults WHERE id = ?", [link.consult_id]);
      if (!approval || !row) return null;
      const sum = await this.db.get<{ body: string; language: string | null }>("SELECT body, language FROM documents WHERE consult_id = ? AND kind = 'patient_summary' AND status = 'final' ORDER BY finalised_at DESC LIMIT 1", [link.consult_id]);
      const summary = sum ? { text: sum.body, language: sum.language ?? "English" } : null;
      if (row.discipline === "ayurveda") {
        const plan = JSON.parse(approval.programme_json) as AyurvedaPlan;
        return {
          linkId: link.id,
          consultId: link.consult_id,
          discipline: "ayurveda" as const,
          summary: null,
          practitioner: row.practitioner,
          approvedAt: approval.approved_at,
          programme: { title: "", intro: "", reviewInWeeks: null, safetyAdvice: [], items: [] },
          ayurveda: {
            title: plan.title,
            intro: plan.patientIntro,
            reviewInWeeks: plan.reviewInWeeks,
            safetyAdvice: plan.safetyAdvice,
            groups: KIND_ORDER.map((kind) => ({
              kind,
              items: plan.items.filter((i) => i.kind === kind).map((i) => ({ name: i.name, instructions: i.instructions, duration: i.duration, where: i.where, cautions: i.cautions })),
            })).filter((g) => g.items.length > 0),
          },
        };
      }
      const programme = JSON.parse(approval.programme_json) as ProgrammeDraft;
      return {
        linkId: link.id,
        consultId: link.consult_id,
        discipline: "physio" as const,
        summary,
        practitioner: row.practitioner,
        approvedAt: approval.approved_at,
        ayurveda: null,
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
    });
  }

  async submitCheckIn(token: string, input: unknown): Promise<{ checkInId: string; clinicId: string }> {
    const done = await this.viaToken<{ checkInId: string; clinicId: string } | DomainError>(token, async (link, clinicId) => {
      const parsed = CheckInInput.safeParse(input);
      if (!parsed.success) return new DomainError("validation", "Choose how the exercises went and how the pain is");
      const since = new Date(this.now().getTime() - 86_400_000).toISOString();
      const recent = await this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM check_ins WHERE link_id = ? AND created_at > ?", [link.id, since]);
      if (Number(recent?.n ?? 0) >= CHECKINS_PER_DAY) return new DomainError("rate_limited", "That is enough check-ins for today. Thank you.");
      const triage = ruleTriage(parsed.data.adherence, parsed.data.painChange, parsed.data.comment);
      const checkInId = crypto.randomUUID();
      await this.db.run("INSERT INTO check_ins (id, clinic_id, consult_id, link_id, adherence, pain_change, comment, created_at, triage_level, triage_reason, triage_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rules')", [
        checkInId, clinicId, link.consult_id, link.id, parsed.data.adherence, parsed.data.painChange, parsed.data.comment, this.ts(), triage.level, triage.reason,
      ]);
      await this.audit(link.consult_id, "patient", "check_in.submitted", { adherence: parsed.data.adherence, painChange: parsed.data.painChange, triage: triage.level }, clinicId);
      return { checkInId, clinicId };
    });
    if (done === null) throw new DomainError("not_found", "This link is no longer active");
    if (done instanceof DomainError) throw done;
    return done;
  }

  // ---------------------------------------------------------------- write-back (R5) and copy-ready fallback

  private noteTextOf(row: ConsultRow, approval: ApprovalRow): string {
    if (row.discipline === "ayurveda") {
      return ayurvedaNoteToText(JSON.parse(approval.note_json) as AyurvedaRecord, JSON.parse(approval.programme_json) as AyurvedaPlan, {
        practitioner: approval.approved_by,
        approvedAt: approval.approved_at,
      });
    }
    return noteToText(JSON.parse(approval.note_json) as NoteDraft, JSON.parse(approval.programme_json) as ProgrammeDraft, {
      practitioner: approval.approved_by,
      approvedAt: approval.approved_at,
      model: row.draft_model,
    });
  }

  async approvedNoteText(id: string): Promise<string> {
    return this.in(async () => {
      const { row, approval } = await this.requireApproval(id);
      return this.noteTextOf(row, approval);
    });
  }

  private writebackKey(id: string, contentHash: string, targetName: string) {
    return crypto.createHash("sha256").update(`${id}:${contentHash}:${targetName}`).digest("hex");
  }

  /**
   * The attempt is recorded as 'pending' and committed before the practice system is called, and the result is recorded
   * afterwards. If the process dies in between, the next try finds 'pending', cannot know whether the note was created,
   * and stops at "needs check" for a person rather than risk a duplicate.
   */
  async writeBack(id: string, targetName: string, actor: string): Promise<WritebackRow> {
    const target = this.targets[targetName];
    if (!target) throw new DomainError("writeback_unavailable", `Unknown destination "${targetName}"`);

    const start = await this.in(async () => {
      const { row, approval } = await this.requireApproval(id);
      if (!target.isConfigured()) throw new DomainError("writeback_unavailable", `${target.label} is not set up. Use the copy-ready note instead.`);
      if (!row.pms_patient_id) {
        throw new DomainError("validation", `Add the ${target.label} patient ID first`, [{ path: "pmsPatientId", message: "Required for write-back" }]);
      }
      const key = this.writebackKey(id, approval.content_hash, targetName);
      const existing = await this.db.get<WritebackRow>("SELECT * FROM writebacks WHERE idempotency_key = ? FOR UPDATE", [key]);

      if (existing?.status === "succeeded" || existing?.status === "needs_check") return { done: existing };
      if (existing?.status === "pending") {
        await this.db.run("UPDATE writebacks SET status = 'needs_check', updated_at = ? WHERE id = ?", [this.ts(), existing.id]);
        await this.audit(id, actor, "writeback.needs_check", { target: targetName });
        return { done: (await this.db.get<WritebackRow>("SELECT * FROM writebacks WHERE id = ?", [existing.id]))! };
      }

      let wbId: string;
      if (existing) {
        wbId = existing.id; // failed earlier; retrying
        await this.db.run("UPDATE writebacks SET status = 'pending', error = NULL, attempts = attempts + 1, updated_at = ? WHERE id = ?", [this.ts(), wbId]);
      } else {
        wbId = crypto.randomUUID();
        const n = await this.db.run(
          `INSERT INTO writebacks (id, clinic_id, consult_id, target, idempotency_key, status, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 1, ?, ?) ON CONFLICT (idempotency_key) DO NOTHING`,
          [wbId, this.clinicId, id, targetName, key, this.ts(), this.ts()],
        );
        // Another request began the same write-back a moment ago; leave it to that one.
        if (!n) return { done: (await this.db.get<WritebackRow>("SELECT * FROM writebacks WHERE idempotency_key = ?", [key]))! };
      }
      return {
        wbId,
        call: {
          patientId: row.pms_patient_id,
          title: `${row.discipline === "ayurveda" ? "Ayurvedic" : "Physiotherapy"} consultation ${approval.approved_at.slice(0, 10)}`,
          text: this.noteTextOf(row, approval),
          practitioner: approval.approved_by,
          reference: id,
        },
      };
    });
    if ("done" in start && start.done) return start.done;
    const { wbId, call } = start as { wbId: string; call: Parameters<WritebackTarget["createNote"]>[0] };

    let failure: string | null = null;
    let externalId = "";
    try {
      externalId = (await target.createNote(call)).externalId;
    } catch (err) {
      failure = safeError(err);
    }
    return this.in(async () => {
      if (failure === null) {
        await this.db.run("UPDATE writebacks SET status = 'succeeded', external_id = ?, updated_at = ? WHERE id = ?", [externalId, this.ts(), wbId]);
        await this.audit(id, actor, "writeback.succeeded", { target: targetName, externalId });
      } else {
        await this.db.run("UPDATE writebacks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", [failure, this.ts(), wbId]);
        await this.audit(id, actor, "writeback.failed", { target: targetName, error: failure });
      }
      return (await this.db.get<WritebackRow>("SELECT * FROM writebacks WHERE id = ?", [wbId]))!;
    });
  }

  /** A person checked the practice system after an uncertain attempt and says what they found. */
  async resolveWriteback(id: string, targetName: string, outcome: "written" | "not_written", actor: string, externalId?: string): Promise<void> {
    return this.in(async () => {
      const { approval } = await this.requireApproval(id);
      const key = this.writebackKey(id, approval.content_hash, targetName);
      const existing = await this.db.get<WritebackRow>("SELECT * FROM writebacks WHERE idempotency_key = ? FOR UPDATE", [key]);
      if (!existing || existing.status !== "needs_check") throw new DomainError("invalid_state", "Nothing to resolve");
      if (outcome === "written") {
        await this.db.run("UPDATE writebacks SET status = 'succeeded', external_id = ?, updated_at = ? WHERE id = ?", [externalId?.trim() || null, this.ts(), existing.id]);
      } else {
        await this.db.run("UPDATE writebacks SET status = 'failed', error = 'Confirmed not written', updated_at = ? WHERE id = ?", [this.ts(), existing.id]);
      }
      await this.audit(id, actor, "writeback.resolved", { target: targetName, outcome });
    });
  }
}
