import crypto from "node:crypto";
import { transaction, type Db } from "./db";
import { DEFAULT_INTAKE_FIELDS } from "./forms";

/**
 * Starting content for a new clinic, so the diary works on day one. Everything here is editable.
 * Also adopts consultations created by the Phase 0 single-clinic MVP, which had no clinic.
 */
export function seedClinic(db: Db, clinicId: string, ownerId: string, now: Date = new Date()): { adopted: number } {
  const ts = now.toISOString();
  return transaction(db, () => {
    const types: [string, number, number, string][] = [
      ["Initial assessment", 45, 5, "blue"],
      ["Follow-up", 30, 5, "green"],
      ["Review", 20, 5, "amber"],
    ];
    const ins = db.prepare("INSERT INTO appointment_types (id, clinic_id, name, duration_min, buffer_min, online_bookable, colour, active) VALUES (?, ?, ?, ?, ?, 1, ?, 1)");
    for (const [name, dur, buf, colour] of types) ins.run(crypto.randomUUID(), clinicId, name, dur, buf, colour);

    db.prepare("INSERT INTO forms (id, clinic_id, name, kind, fields_json, mandatory, active, version, created_at) VALUES (?, ?, 'New patient intake', 'intake', ?, 1, 1, 1, ?)").run(
      crypto.randomUUID(), clinicId, JSON.stringify(DEFAULT_INTAKE_FIELDS), ts,
    );

    const hours = db.prepare("INSERT INTO clinician_hours (id, clinic_id, user_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?, 540, 1020)");
    for (let d = 1; d <= 5; d++) hours.run(crypto.randomUUID(), clinicId, ownerId, d);

    const res = db.prepare("UPDATE consults SET clinic_id = ? WHERE clinic_id IS NULL").run(clinicId);
    db.prepare("UPDATE audit_log SET clinic_id = ? WHERE clinic_id IS NULL").run(clinicId);
    return { adopted: Number(res.changes) };
  });
}
