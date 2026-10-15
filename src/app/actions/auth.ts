"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, sessionToken } from "@/lib/auth";
import { getAccounts, getPlatform } from "@/lib/app";
import { seedClinic } from "@/lib/seed";
import { allow } from "@/lib/session";
import { logError } from "@/lib/log";
import { fail, field, clientKey, cookieSecure, type ActionState } from "@/lib/action-util";

async function setSession(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: cookieSecure(), path: "/", maxAge: 12 * 3600 });
}

export async function setupAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await allow(`setup:${await clientKey()}`, 10, 15 * 60_000))) return { ok: false, message: "Too many attempts. Wait a few minutes." };
  const p = getPlatform();
  try {
    const password = field(form, "password");
    if (password !== field(form, "password2")) return { ok: false, message: "The two passwords are not the same.", issues: [{ path: "password2", message: "Re-enter the same password" }] };
    const { clinicId, userId } = await p.accounts.bootstrap({ clinicName: field(form, "clinicName"), ownerName: field(form, "ownerName"), email: field(form, "email"), password });
    const pick = field(form, "disciplines");
    await seedClinic(p.db, clinicId, userId, new Date(), pick === "ayurveda" || pick === "both" ? pick : "physio");
    const { token } = await p.accounts.login(field(form, "email"), password);
    await setSession(token);
  } catch (err) {
    return fail(err);
  }
  redirect("/account/mfa");
}

export async function loginAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const key = await clientKey();
  const email = field(form, "email").trim().toLowerCase();
  if (!(await allow(`login:ip:${key}`, 30, 15 * 60_000)) || !(await allow(`login:acct:${email}`, 10, 15 * 60_000))) {
    return { ok: false, message: "Too many attempts. Wait 15 minutes and try again." };
  }
  let next = "/login/mfa";
  try {
    const { token } = await getAccounts().login(email, field(form, "password"));
    await setSession(token);
    const s = await getAccounts().getSession(token);
    if (s && !s.mfaEnabled) next = "/account/mfa";
  } catch (err) {
    return fail(err);
  }
  redirect(next);
}

export async function mfaAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const token = await sessionToken();
  const key = await clientKey();
  if (!(await allow(`mfa:${key}`, 20, 15 * 60_000))) return { ok: false, message: "Too many attempts. Wait 15 minutes and try again." };
  let next = "/";
  try {
    const { enrolled } = await getAccounts().verifyMfa(token ?? "", field(form, "code").replace(/\s/g, ""));
    // First time on: offer recovery codes straight away, while the person still has their phone in hand.
    if (enrolled) next = "/account/recovery?first=1";
  } catch (err) {
    return fail(err);
  }
  redirect(next);
}

const RESET_SENT = "If that address has an account, we have emailed a link to reset the password. It works for an hour.";

export async function forgotPasswordAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const email = field(form, "email").trim().toLowerCase();
  if (!(await allow(`forgot:ip:${await clientKey()}`, 10, 60 * 60_000)) || !(await allow(`forgot:acct:${email}`, 3, 60 * 60_000))) {
    return { ok: false, message: "Too many requests. Wait an hour and try again." };
  }
  try {
    await getAccounts().requestPasswordReset(email);
  } catch (err) {
    logError("password-reset", err);
  }
  // The same answer whether or not the address has an account.
  return { ok: true, message: RESET_SENT };
}

export async function resetPasswordWithLinkAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await allow(`reset:ip:${await clientKey()}`, 20, 15 * 60_000))) return { ok: false, message: "Too many attempts. Wait 15 minutes and try again." };
  const password = field(form, "password");
  if (password !== field(form, "password2")) return { ok: false, message: "The two passwords are not the same.", issues: [{ path: "password2", message: "Re-enter the same password" }] };
  try {
    await getAccounts().completePasswordReset(field(form, "token"), password);
  } catch (err) {
    return fail(err);
  }
  redirect("/login?reset=1");
}

export async function recoveryCodesAction(): Promise<ActionState> {
  const token = await sessionToken();
  try {
    const codes = await getAccounts().newRecoveryCodes(token ?? "");
    return { ok: true, message: "New recovery codes made. Any older ones no longer work.", data: codes };
  } catch (err) {
    return fail(err);
  }
}

export async function logoutAction() {
  const token = await sessionToken();
  await getAccounts().logout(token);
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
