import crypto from "node:crypto";
import type { Db } from "./db";
import { addStarterForm } from "./forms";

/**
 * Starting content for a new clinic, so the diary works on day one. Everything here is editable.
 */
export function seedClinic(db: Db, clinicId: string, ownerId: string, now: Date = new Date(), disciplines: "physio" | "ayurveda" | "both" = "physio"): Promise<void> {
  const ts = now.toISOString();
  return db.scope(clinicId, async () => {
    const sets: Record<"physio" | "ayurveda", [string, number, number, string][]> = {
      physio: [
        ["Initial assessment", 45, 5, "blue"],
        ["Follow-up", 30, 5, "green"],
        ["Review", 20, 5, "amber"],
      ],
      ayurveda: [
        ["Initial Ayurvedic consultation", 60, 10, "purple"],
        ["Ayurvedic follow-up", 30, 5, "green"],
        ["Ayurvedic therapy session", 60, 15, "amber"],
      ],
    };
    await db.run("UPDATE clinics SET disciplines = ? WHERE id = ?", [disciplines, clinicId]);
    for (const d of ["physio", "ayurveda"] as const) {
      if (disciplines !== "both" && disciplines !== d) continue;
      for (const [name, dur, buf, colour] of sets[d]) {
        await db.run("INSERT INTO appointment_types (id, clinic_id, name, duration_min, buffer_min, online_bookable, colour, active, discipline) VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?)", [
          crypto.randomUUID(), clinicId, name, dur, buf, colour, d,
        ]);
      }
    }
    for (const d of ["physio", "ayurveda"] as const) {
      if (disciplines === "both" || disciplines === d) await addStarterForm(db, clinicId, d, ts);
    }
    for (let d = 1; d <= 5; d++) {
      await db.run("INSERT INTO clinician_hours (id, clinic_id, user_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?, 540, 1020)", [crypto.randomUUID(), clinicId, ownerId, d]);
    }
  });
}
