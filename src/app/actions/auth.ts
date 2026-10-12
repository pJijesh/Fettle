"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, sessionToken } from "@/lib/auth";
import { getAccounts, getPlatform } from "@/lib/app";
import { seedClinic } from "@/lib/seed";
import { allow } from "@/lib/session";
import { fail, field, clientKey, cookieSecure, type ActionState } from "@/lib/action-util";

async function setSession(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: cookieSecure(), path: "/", maxAge: 12 * 3600 });
}

export async function setupAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!allow(`setup:${await clientKey()}`, 10, 15 * 60_000)) return { ok: false, message: "Too many attempts. Wait a few minutes." };
  const p = getPlatform();
  try {
    const password = field(form, "password");
    if (password !== field(form, "password2")) return { ok: false, message: "The two passwords are not the same.", issues: [{ path: "password2", message: "Re-enter the same password" }] };
    const { clinicId, userId } = p.accounts.bootstrap({ clinicName: field(form, "clinicName"), ownerName: field(form, "ownerName"), email: field(form, "email"), password });
    seedClinic(p.db, clinicId, userId);
    const { token } = p.accounts.login(field(form, "email"), password);
    await setSession(token);
  } catch (err) {
    return fail(err);
  }
  redirect("/account/mfa");
}

export async function loginAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const key = await clientKey();
  const email = field(form, "email").trim().toLowerCase();
  if (!allow(`login:ip:${key}`, 30, 15 * 60_000) || !allow(`login:acct:${email}`, 10, 15 * 60_000)) {
    return { ok: false, message: "Too many attempts. Wait 15 minutes and try again." };
  }
  let next = "/login/mfa";
  try {
    const { token } = getAccounts().login(email, field(form, "password"));
    await setSession(token);
    const s = getAccounts().getSession(token);
    if (s && !s.mfaEnabled) next = "/account/mfa";
  } catch (err) {
    return fail(err);
  }
  redirect(next);
}

export async function mfaAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const token = await sessionToken();
  const key = await clientKey();
  if (!allow(`mfa:${key}`, 20, 15 * 60_000)) return { ok: false, message: "Too many attempts. Wait 15 minutes and try again." };
  try {
    getAccounts().verifyMfa(token ?? "", field(form, "code").replace(/\s/g, ""));
  } catch (err) {
    return fail(err);
  }
  redirect("/");
}

export async function logoutAction() {
  const token = await sessionToken();
  getAccounts().logout(token);
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
