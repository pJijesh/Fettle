"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPlatform } from "@/lib/app";
import { makeLink } from "@/lib/links";
import { allow } from "@/lib/session";
import { PORTAL_COOKIE, clientKey, cookieSecure, fail, field, type ActionState } from "@/lib/action-util";

const tooMany: ActionState = { ok: false, message: "Too many attempts. Please wait a few minutes and try again." };

export async function bookAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await allow(`book:${await clientKey()}`, 10, 15 * 60_000))) return tooMany;
  const slug = field(form, "slug");
  let token: string;
  try {
    const clinic = await getPlatform().scheduling.clinicBySlug(slug);
    if (clinic && !(await getPlatform().plans.isOpen(clinic.id))) return { ok: false, message: "Online booking is not available at the moment. Please phone the clinic." };
    const r = await getPlatform().booking.book(slug, {
      typeId: field(form, "typeId"), userId: field(form, "userId"), startAt: field(form, "startAt"),
      firstName: field(form, "firstName"), lastName: field(form, "lastName"), dob: field(form, "dob"), email: field(form, "email"),
      phone: field(form, "phone"), smsConsent: form.get("smsConsent") === "yes",
    });
    token = r.manageToken;
  } catch (err) {
    return fail(err);
  }
  redirect(`/manage/${token}?booked=1`);
}

export async function patientCancelAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await allow(`manage:${await clientKey()}`, 30, 15 * 60_000))) return tooMany;
  const token = field(form, "token");
  try {
    await getPlatform().booking.cancelByPatient(token);
  } catch (err) {
    return fail(err);
  }
  redirect(`/manage/${token}?cancelled=1`);
}

export async function patientRescheduleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await allow(`manage:${await clientKey()}`, 30, 15 * 60_000))) return tooMany;
  const token = field(form, "token");
  try {
    await getPlatform().booking.rescheduleByPatient(token, field(form, "startAt"));
  } catch (err) {
    return fail(err);
  }
  redirect(`/manage/${token}?moved=1`);
}

export async function submitFormAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await allow(`form:${await clientKey()}`, 30, 15 * 60_000))) return tooMany;
  const token = field(form, "token");
  const answers: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string" && k.startsWith("q_")) answers[k.slice(2)] = v;
  try {
    await getPlatform().booking.submitForm(token, answers);
  } catch (err) {
    return fail(err);
  }
  redirect(`/form/${token}?done=1`);
}

export async function acceptOfferAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!(await allow(`offer:${await clientKey()}`, 20, 15 * 60_000))) return tooMany;
  let manage: string;
  try {
    const { appointmentId } = await getPlatform().waitlist.accept(field(form, "token"));
    manage = makeLink("manage", appointmentId);
  } catch (err) {
    return fail(err);
  }
  redirect(`/manage/${manage}?booked=1`);
}

export async function portalRequestCodeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const slug = field(form, "slug");
  const email = field(form, "email").trim().toLowerCase();
  if (!(await allow(`portal:code:ip:${await clientKey()}`, 10, 15 * 60_000)) || !(await allow(`portal:code:${email}`, 5, 60 * 60_000))) return tooMany;
  await getPlatform().booking.requestCode(slug, email);
  redirect(`/portal/${slug}/code?email=${encodeURIComponent(email)}`);
}

export async function portalVerifyAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const slug = field(form, "slug");
  const email = field(form, "email").trim().toLowerCase();
  if (!(await allow(`portal:verify:ip:${await clientKey()}`, 20, 15 * 60_000)) || !(await allow(`portal:verify:${email}`, 10, 15 * 60_000))) return tooMany;
  try {
    const { token } = await getPlatform().booking.verifyCode(slug, email, field(form, "code"));
    (await cookies()).set(PORTAL_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: cookieSecure(), path: "/", maxAge: 2 * 3600 });
  } catch (err) {
    return fail(err);
  }
  redirect(`/portal/${slug}/home`);
}

export async function portalSignOutAction(form: FormData) {
  const jar = await cookies();
  await getPlatform().booking.portalSignOut(jar.get(PORTAL_COOKIE)?.value);
  jar.delete(PORTAL_COOKIE);
  redirect(`/portal/${field(form, "slug")}`);
}
