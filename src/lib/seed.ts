import crypto from "node:crypto";
import type { Db } from "./db";
import { DEFAULT_INTAKE_FIELDS } from "./forms";

/**
 * Starting content for a new clinic, so the diary works on day one. Everything here is editable.
 */
export function seedClinic(db: Db, clinicId: string, ownerId: string, now: Date = new Date()): Promise<void> {
  const ts = now.toISOString();
  return db.scope(clinicId, async () => {
    const types: [string, number, number, string][] = [
      ["Initial assessment", 45, 5, "blue"],
      ["Follow-up", 30, 5, "green"],
      ["Review", 20, 5, "amber"],
    ];
    for (const [name, dur, buf, colour] of types) {
      await db.run("INSERT INTO appointment_types (id, clinic_id, name, duration_min, buffer_min, online_bookable, colour, active) VALUES (?, ?, ?, ?, ?, 1, ?, 1)", [
        crypto.randomUUID(), clinicId, name, dur, buf, colour,
      ]);
    }
    await db.run("INSERT INTO forms (id, clinic_id, name, kind, fields_json, mandatory, active, version, created_at) VALUES (?, ?, 'New patient intake', 'intake', ?, 1, 1, 1, ?)", [
      crypto.randomUUID(), clinicId, JSON.stringify(DEFAULT_INTAKE_FIELDS), ts,
    ]);
    for (let d = 1; d <= 5; d++) {
      await db.run("INSERT INTO clinician_hours (id, clinic_id, user_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?, 540, 1020)", [crypto.randomUUID(), clinicId, ownerId, d]);
    }
  });
}
