import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAccounts, getPlatform } from "./app";
import type { Role, SessionInfo, SessionUser } from "./accounts";

export const SESSION_COOKIE = "ctp_session";

export async function sessionToken(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value;
}

export async function currentSession(): Promise<SessionInfo | null> {
  return getAccounts().getSession(await sessionToken());
}

/** The signed-in user, only once both factors are done. */
export async function currentUser(): Promise<SessionUser | null> {
  const s = await currentSession();
  return s && s.mfaOk ? s.user : null;
}

/** True when the clinic's plan has ended: records can be read and exported but not added to or changed. */
export async function isReadOnly(clinicId: string): Promise<boolean> {
  return (await getPlatform().plans.get(clinicId)).access === "read_only";
}

/**
 * The signed-in user. Every change a signed-in person can make arrives as a server action, so this is also where a
 * clinic whose plan has ended is stopped: any action sends them to the Plan page instead. Pages that only read are
 * unaffected, and an action that must keep working after the plan ends (choosing a plan, signing out) opts out.
 */
export async function requireUser(roles?: Role[], opts: { allowReadOnly?: boolean } = {}): Promise<SessionUser> {
  const s = await currentSession();
  if (!s) redirect("/login");
  if (!s.mfaOk) redirect(s.mfaEnabled ? "/login/mfa" : "/account/mfa");
  if (roles && !roles.includes(s.user.role)) redirect("/calendar?denied=1");
  if (!opts.allowReadOnly && (await headers()).has("next-action") && (await isReadOnly(s.user.clinicId))) redirect("/settings/plan?locked=1");
  return s.user;
}
