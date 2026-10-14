import { getDb } from "./db";
import { createProvider } from "./ai";
import { createTargets } from "./writeback";
import { Service } from "./service";
import { Accounts } from "./accounts";
import { createPlatform, type Platform } from "./platform";
import type { DraftingProvider } from "./ai/provider";
import type { WritebackTarget } from "./writeback/types";

const g = globalThis as unknown as {
  __ctpProvider?: DraftingProvider;
  __ctpTargets?: Record<string, WritebackTarget>;
  __ctpAccounts?: Accounts;
  __ctpPlatform?: Platform;
};

/** A consultation service limited to one clinic. Cheap to create, so make one per request. */
export function getService(clinicId: string): Service {
  g.__ctpProvider ??= createProvider();
  g.__ctpTargets ??= createTargets();
  return new Service({ db: getDb(), clinicId, provider: g.__ctpProvider, targets: g.__ctpTargets });
}

export function getPlatform(): Platform {
  g.__ctpPlatform ??= createPlatform(getDb());
  return g.__ctpPlatform;
}

export function getAccounts(): Accounts {
  return getPlatform().accounts;
}

/**
 * For public patient pages. The patient link is itself the credential, and the two methods used here
 * (getPatientView, submitCheckIn) look the consult up through it, so no clinic is needed.
 */
export function getPublicService(): Service {
  return getService("public");
}

/**
 * Runs a staff page or action's reads in one transaction limited to the signed-in user's clinic, so the page
 * sees one consistent snapshot and takes one database connection instead of one per query.
 */
export function withClinic<T>(clinicId: string, fn: () => Promise<T>): Promise<T> {
  return getDb().scope(clinicId, fn);
}
