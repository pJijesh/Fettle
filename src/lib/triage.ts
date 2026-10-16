import type { Db } from "./db";
import type { SessionUser } from "./accounts";
import { DomainError } from "./errors";
import { logError } from "./log";
import type { AssistProvider } from "./assist/provider";
import { triageTask } from "./assist/tasks";

/**
 * Sorting patient check-ins. Plain rules always run, instantly, when the check-in arrives. If the clinic has switched the
 * assistant on it then reads the comment and may RAISE a check-in to "needs a look"; it can never lower one, and if it
 * is unavailable the rules' answer stands. The patient is not told anything about the result.
 */

export type TriageLevel = "routine" | "review";

const CONCERN: [RegExp, string][] = [
  [/numb|pins and needles|tingling/i, "numbness or tingling"],
  [/weak(ness)?\b|giving way|gave way|can'?t (walk|stand|move|lift)|cannot (walk|stand|move|lift)/i, "weakness or loss of function"],
  [/bladder|bowel|saddle|incontinen/i, "bladder, bowel or saddle symptoms"],
  [/fever|temperature|feel(ing)? (very )?unwell|sweats/i, "feeling unwell or fever"],
  [/chest|breath|dizz|faint/i, "chest, breathing or dizziness"],
  [/\bfell\b|\bfall(en)?\b|accident|re-?injur|hurt myself/i, "a fall or injury"],
  [/swell|swollen|red and hot|hot and red/i, "swelling"],
  [/\bnight\b|wak(es|ing) me|can'?t sleep|cannot sleep/i, "pain at night or poor sleep"],
  [/severe|unbearable|excruciating|agony|worst/i, "severe pain"],
  [/spreading|getting worse|much worse|worse and worse|new pain|different pain/i, "symptoms spreading or worsening"],
  [/hospital|a&e|\ba and e\b|emergency|\b999\b|\bnhs ?111\b/i, "contact with other services"],
  [/depress|hopeless|can'?t cope|cannot cope|suicid|self.?harm|want to die|end my life/i, "distress"],
  [/call me|ring me|phone me|contact me|need help|help me/i, "asking for contact"],
];

/** The rules. Pure, so they can be tested and explained. */
export function ruleTriage(adherence: string, painChange: string, comment: string): { level: TriageLevel; reason: string } {
  const reasons: string[] = [];
  if (painChange === "worse") reasons.push("pain is worse");
  for (const [re, label] of CONCERN) if (re.test(comment)) reasons.push(label);
  if (adherence === "none" && painChange !== "better") reasons.push("has not done the exercises and is not better");
  return reasons.length ? { level: "review", reason: `Mentions ${reasons.join("; ")}.`.replace("Mentions pain is", "Pain is").replace("Mentions has not", "Has not") } : { level: "routine", reason: "" };
}

export interface OpenCheckIn {
  id: string;
  consultId: string;
  patientLabel: string;
  practitioner: string;
  adherence: string;
  painChange: string;
  comment: string;
  createdAt: string;
  reason: string;
  source: "rules" | "assistant";
}

export class Triage {
  constructor(
    private db: Db,
    private assist: AssistProvider,
    private now: () => Date = () => new Date(),
  ) {}

  private clinicians(actor: SessionUser) {
    if (actor.role === "reception") throw new DomainError("forbidden", "Only clinicians and the owner can see check-ins");
  }

  async aiOn(clinicId: string): Promise<boolean> {
    return this.db.scope(clinicId, async () => !!(await this.db.get<{ ai_triage: number }>("SELECT ai_triage FROM clinics WHERE id = ?", [clinicId]))?.ai_triage);
  }

  async setAi(actor: SessionUser, on: boolean): Promise<void> {
    if (actor.role !== "owner") throw new DomainError("forbidden", "Only the clinic owner can change this");
    await this.db.scope(actor.clinicId, async () => {
      await this.db.run("UPDATE clinics SET ai_triage = ? WHERE id = ?", [on ? 1 : 0, actor.clinicId]);
      await this.db.run("INSERT INTO audit_log (clinic_id, actor, action, detail, at, entity) VALUES (?, ?, 'triage.ai_setting', ?, ?, 'clinic')", [actor.clinicId, actor.email, JSON.stringify({ on }), this.now().toISOString()]);
    });
  }

  /**
   * Runs after a check-in is saved (outside the patient's request). Only does anything if the clinic switched the
   * assistant on, the rules said routine and the patient wrote a comment. Failure leaves the rules' result as it was.
   */
  async assess(clinicId: string, checkInId: string): Promise<void> {
    try {
      const row = await this.db.scope(clinicId, async () => {
        if (!(await this.db.get<{ ai_triage: number }>("SELECT ai_triage FROM clinics WHERE id = ?", [clinicId]))?.ai_triage) return null;
        return (await this.db.get<{ adherence: string; pain_change: string; comment: string; triage_level: string }>("SELECT adherence, pain_change, comment, triage_level FROM check_ins WHERE id = ? AND clinic_id = ?", [checkInId, clinicId])) ?? null;
      });
      if (!row || row.triage_level !== "routine" || !row.comment.trim()) return;
      const out = await this.assist.run(triageTask(row.adherence, row.pain_change, row.comment));
      if (out.level !== "review") return;
      await this.db.scope(clinicId, async () => {
        const n = await this.db.run("UPDATE check_ins SET triage_level = 'review', triage_reason = ?, triage_source = 'assistant' WHERE id = ? AND clinic_id = ? AND triage_level = 'routine'", [out.reason || "The assistant suggests a look.", checkInId, clinicId]);
        if (n) await this.db.run("INSERT INTO audit_log (clinic_id, actor, action, detail, at, entity) VALUES (?, 'assistant', 'check_in.raised', ?, ?, 'consult')", [clinicId, JSON.stringify({ checkInId }), this.now().toISOString()]);
      });
    } catch (err) {
      logError("triage", err);
    }
  }

  async listOpen(clinicId: string): Promise<OpenCheckIn[]> {
    return this.db.scope(clinicId, async () =>
      (
        await this.db.all<Record<string, string>>(
          `SELECT k.id, k.consult_id, c.patient_label, c.practitioner, k.adherence, k.pain_change, k.comment, k.created_at, k.triage_reason, k.triage_source
           FROM check_ins k JOIN consults c ON c.id = k.consult_id AND c.clinic_id = k.clinic_id
           WHERE k.clinic_id = ? AND k.triage_level = 'review' AND k.reviewed_at IS NULL ORDER BY k.created_at`,
          [clinicId],
        )
      ).map((r) => ({
        id: r.id, consultId: r.consult_id, patientLabel: r.patient_label, practitioner: r.practitioner, adherence: r.adherence, painChange: r.pain_change, comment: r.comment,
        createdAt: r.created_at, reason: r.triage_reason, source: r.triage_source as "rules" | "assistant",
      })),
    );
  }

  async countOpen(clinicId: string): Promise<number> {
    return this.db.scope(clinicId, async () => Number((await this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM check_ins WHERE clinic_id = ? AND triage_level = 'review' AND reviewed_at IS NULL", [clinicId]))?.n ?? 0));
  }

  /** A clinician has looked at it. */
  async markReviewed(actor: SessionUser, checkInId: string): Promise<void> {
    this.clinicians(actor);
    await this.db.scope(actor.clinicId, async () => {
      const r = await this.db.get<{ consult_id: string }>("SELECT consult_id FROM check_ins WHERE id = ? AND clinic_id = ?", [checkInId, actor.clinicId]);
      if (!r) throw new DomainError("not_found", "Check-in not found");
      const n = await this.db.run("UPDATE check_ins SET reviewed_at = ?, reviewed_by = ? WHERE id = ? AND clinic_id = ? AND reviewed_at IS NULL", [this.now().toISOString(), actor.name, checkInId, actor.clinicId]);
      if (n) await this.db.run("INSERT INTO audit_log (clinic_id, consult_id, actor, action, detail, at, entity) VALUES (?, ?, ?, 'check_in.reviewed', ?, ?, 'consult')", [actor.clinicId, r.consult_id, actor.email, JSON.stringify({ checkInId }), this.now().toISOString()]);
    });
  }
}
