import type { Db } from "./db";
import type { SessionUser } from "./accounts";
import { DomainError } from "./errors";
import { logError } from "./log";
import type { NoteDraft } from "./schemas";
import type { AssistProvider } from "./assist/provider";
import { progressTask } from "./assist/tasks";

/**
 * How a patient has progressed over their approved physiotherapy consultations: each outcome measure across visits, and
 * what they reported in check-ins. Facts only. The system is not told which direction is "better" for a measure, so it
 * shows the change as a number and never calls it an improvement.
 */

export interface MeasurePoint {
  consultId: string;
  date: string;
  scale: string;
  raw: string;
  /** The score as a number when it is one ("6", "6/10", "42%"), else null. */
  value: number | null;
}

export interface MeasureSeries {
  name: string;
  points: MeasurePoint[];
  /** Latest minus first, when both are numbers and there are at least two points. */
  change: number | null;
}

export interface CheckInPoint {
  consultId: string;
  date: string;
  adherence: string;
  painChange: string;
  comment: string;
}

export interface PatientProgress {
  patientName: string;
  visits: { consultId: string; date: string; practitioner: string }[];
  series: MeasureSeries[];
  checkIns: CheckInPoint[];
}

export function numericScore(raw: string): number | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(?:%|\/\s*\d+(?:\.\d+)?)?\s*$/.exec(raw);
  return m ? Number(m[1]) : null;
}

/** Groups outcome measures across visits by name (ignoring case). Pure. */
export function buildSeries(visits: { consultId: string; date: string; measures: NoteDraft["outcomeMeasures"] }[]): MeasureSeries[] {
  const map = new Map<string, MeasureSeries>();
  for (const v of [...visits].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const m of v.measures) {
      if (!m.name.trim() || !m.score.trim()) continue;
      const key = m.name.trim().toLowerCase();
      const s = map.get(key) ?? { name: m.name.trim(), points: [], change: null };
      s.points.push({ consultId: v.consultId, date: v.date, scale: m.scale, raw: m.score.trim(), value: numericScore(m.score) });
      map.set(key, s);
    }
  }
  for (const s of map.values()) {
    const first = s.points[0]?.value;
    const last = s.points[s.points.length - 1]?.value;
    s.change = s.points.length >= 2 && first !== null && first !== undefined && last !== null && last !== undefined ? Math.round((last - first) * 100) / 100 : null;
  }
  return [...map.values()];
}

/** The text the assistant is given: numbers and the patient's check-in words, nothing that names anyone. */
export function progressTable(p: PatientProgress): string {
  const out: string[] = [`Visits recorded: ${p.visits.length}`];
  for (const s of p.series) out.push(`${s.name}${s.points[0]?.scale ? ` (${s.points[0].scale})` : ""}: ${s.points.map((x) => `${x.date} = ${x.raw}`).join("; ")}`);
  if (!p.series.length) out.push("No outcome measures with a score recorded.");
  for (const c of p.checkIns.slice(-8)) out.push(`Check-in ${c.date}: exercises ${c.adherence}; pain ${c.painChange}${c.comment ? `; says "${c.comment}"` : ""}`);
  if (!p.checkIns.length) out.push("No check-ins.");
  return out.join("\n");
}

export class Progress {
  constructor(
    private db: Db,
    private assist: AssistProvider,
    private now: () => Date = () => new Date(),
  ) {}

  private clinicians(actor: SessionUser) {
    if (actor.role === "reception") throw new DomainError("forbidden", "Only clinicians and the owner can see clinical progress");
  }

  async forPatient(actor: SessionUser, patientId: string): Promise<PatientProgress> {
    this.clinicians(actor);
    return this.db.scope(actor.clinicId, async () => {
      const c = actor.clinicId;
      const p = await this.db.get<{ first_name: string; last_name: string; anonymised_at: string | null }>("SELECT first_name, last_name, anonymised_at FROM patients WHERE id = ? AND clinic_id = ?", [patientId, c]);
      if (!p) throw new DomainError("not_found", "Patient not found");
      const rows = await this.db.all<{ consult_id: string; practitioner: string; approved_at: string; note_json: string }>(
        `SELECT k.id AS consult_id, k.practitioner, a.approved_at, a.note_json FROM consults k JOIN approvals a ON a.consult_id = k.id AND a.clinic_id = k.clinic_id
         WHERE k.clinic_id = ? AND k.patient_id = ? AND k.discipline = 'physio' ORDER BY a.approved_at`,
        [c, patientId],
      );
      const visits = rows.map((r) => ({ consultId: r.consult_id, date: r.approved_at.slice(0, 10), practitioner: r.practitioner, measures: (JSON.parse(r.note_json) as NoteDraft).outcomeMeasures ?? [] }));
      const checks = await this.db.all<{ consult_id: string; created_at: string; adherence: string; pain_change: string; comment: string }>(
        `SELECT ci.consult_id, ci.created_at, ci.adherence, ci.pain_change, ci.comment FROM check_ins ci JOIN consults k ON k.id = ci.consult_id AND k.clinic_id = ci.clinic_id
         WHERE ci.clinic_id = ? AND k.patient_id = ? ORDER BY ci.created_at`,
        [c, patientId],
      );
      return {
        patientName: `${p.first_name} ${p.last_name}`,
        visits: visits.map(({ consultId, date, practitioner }) => ({ consultId, date, practitioner })),
        series: buildSeries(visits),
        checkIns: checks.map((k) => ({ consultId: k.consult_id, date: k.created_at.slice(0, 10), adherence: k.adherence, painChange: k.pain_change, comment: k.comment })),
      };
    });
  }

  /** A short factual summary written by the assistant for the physio. Not stored. */
  async summarise(actor: SessionUser, patientId: string): Promise<string> {
    const prog = await this.forPatient(actor, patientId);
    if (!prog.visits.length) throw new DomainError("invalid_state", "There is no approved physiotherapy visit to summarise yet");
    let text: string;
    try {
      text = (await this.assist.run(progressTask(progressTable(prog)))).text;
    } catch (err) {
      logError("assist", err);
      throw new DomainError("draft_failed", "The assistant could not write the summary just now. The figures below are still correct.");
    }
    await this.db.scope(actor.clinicId, () =>
      this.db.run("INSERT INTO audit_log (clinic_id, actor, action, detail, at, entity) VALUES (?, ?, 'progress.summarised', ?, ?, 'patient')", [actor.clinicId, actor.email, JSON.stringify({ patientId, visits: prog.visits.length }), this.now().toISOString()]),
    );
    return text;
  }
}
