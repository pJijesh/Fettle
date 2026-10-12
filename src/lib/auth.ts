import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAccounts } from "./app";
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

export async function requireUser(roles?: Role[]): Promise<SessionUser> {
  const s = await currentSession();
  if (!s) redirect("/login");
  if (!s.mfaOk) redirect(s.mfaEnabled ? "/login/mfa" : "/account/mfa");
  if (roles && !roles.includes(s.user.role)) redirect("/calendar?denied=1");
  return s.user;
}
