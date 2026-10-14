import { newTestDb } from "./helpers";
import { createPlatform } from "@/lib/platform";
import { seedClinic } from "@/lib/seed";
import type { SessionUser } from "@/lib/accounts";

process.env.LINK_SECRET = "test-link-secret-0123456789";

export const PW = "correct horse battery";

/** A clinic with an owner (clinician) and a second clinician, default types and Monday-Friday 09:00-17:00 hours. */
export async function platformSetup(start = "2026-10-12T10:00:00Z") {
  const t = await newTestDb();
  const db = t.db;
  const clock = { now: new Date(start) };
  const p = createPlatform(db, { now: () => clock.now, baseUrl: () => "https://clinic.test" });
  const { clinicId, userId } = await p.accounts.bootstrap({ clinicName: "Test Physio", ownerName: "Olive Owner", email: "olive@example.com", password: PW });
  await seedClinic(db, clinicId, userId, clock.now);
  const owner: SessionUser = { id: userId, clinicId, name: "Olive Owner", email: "olive@example.com", role: "owner" };
  const secondId = await p.accounts.createUser(owner, { name: "Sam Clinician", email: "sam@example.com", password: PW, role: "clinician" });
  await p.scheduling.setHours(clinicId, "t", secondId, [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 540, endMin: 1020 })));
  const types = await p.scheduling.listTypes(clinicId);
  const byName = (n: string) => types.find((t) => t.name === n)!;
  const patient = await p.scheduling.createPatient(clinicId, "t", { firstName: "Pat", lastName: "Jones", dob: "1980-05-04", email: "pat@example.com", phone: "07700 900123", smsConsent: true });
  return { db, q: t.q, t, clock, p, clinicId, owner, secondId, types, initial: byName("Initial assessment"), followUp: byName("Follow-up"), patient };
}
export type PlatformSetup = Awaited<ReturnType<typeof platformSetup>>;
