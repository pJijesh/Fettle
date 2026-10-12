import { openDb } from "@/lib/db";
import { createPlatform } from "@/lib/platform";
import { seedClinic } from "@/lib/seed";
import type { SessionUser } from "@/lib/accounts";

process.env.LINK_SECRET = "test-link-secret-0123456789";

export const PW = "correct horse battery";

/** A clinic with an owner (clinician) and a second clinician, default types and Monday-Friday 09:00-17:00 hours. */
export function platformSetup(start = "2026-10-12T10:00:00Z") {
  const db = openDb(":memory:");
  const clock = { now: new Date(start) };
  const p = createPlatform(db, { now: () => clock.now, baseUrl: () => "https://clinic.test" });
  const { clinicId, userId } = p.accounts.bootstrap({ clinicName: "Test Physio", ownerName: "Olive Owner", email: "olive@example.com", password: PW });
  seedClinic(db, clinicId, userId, clock.now);
  const owner: SessionUser = { id: userId, clinicId, name: "Olive Owner", email: "olive@example.com", role: "owner" };
  const secondId = p.accounts.createUser(owner, { name: "Sam Clinician", email: "sam@example.com", password: PW, role: "clinician" });
  p.scheduling.setHours(clinicId, "t", secondId, [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 540, endMin: 1020 })));
  const types = p.scheduling.listTypes(clinicId);
  const byName = (n: string) => types.find((t) => t.name === n)!;
  const patient = p.scheduling.createPatient(clinicId, "t", { firstName: "Pat", lastName: "Jones", dob: "1980-05-04", email: "pat@example.com", phone: "07700 900123", smsConsent: true });
  return { db, clock, p, clinicId, owner, secondId, types, initial: byName("Initial assessment"), followUp: byName("Follow-up"), patient };
}
export type PlatformSetup = ReturnType<typeof platformSetup>;
