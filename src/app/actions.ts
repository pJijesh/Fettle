"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getPublicService, getService } from "@/lib/app";
import { DomainError } from "@/lib/service";
import { baseUrl, fail, field, type ActionState } from "@/lib/action-util";

// ------------------------------------------------------------------ consultations

export async function createConsultAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  let id: string;
  try {
    id = await getService(user.clinicId).createConsult(
      {
        patientLabel: field(form, "patientLabel"),
        practitioner: field(form, "practitioner"),
        pmsPatientId: field(form, "pmsPatientId"),
        discipline: field(form, "discipline") === "ayurveda" ? "ayurveda" : "physio",
      },
      user.name,
    );
  } catch (err) {
    return fail(err);
  }
  redirect(`/consults/${id}`);
}

export async function recordConsentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(form, "id");
  try {
    if (form.get("confirm") !== "yes") {
      return { ok: false, message: "Tick the box to confirm the patient has agreed." };
    }
    await getService(user.clinicId).recordConsent(id, { method: field(form, "method"), by: user.name }, user.name);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/consults/${id}`);
  return { ok: true };
}

export async function withdrawConsentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(form, "id");
  try {
    await getService(user.clinicId).withdrawConsent(id, user.name);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/consults/${id}`);
  return { ok: true, message: "Consent withdrawn. What was recorded was deleted." };
}

export async function saveTranscriptAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(form, "id");
  try {
    await getService(user.clinicId).saveTranscript(id, field(form, "transcript"), user.name);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/consults/${id}`);
  return { ok: true, message: "Transcript saved." };
}

export async function generateDraftsAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(form, "id");
  try {
    const svc = getService(user.clinicId);
    // Save what is on screen first so the draft is made from exactly that text.
    if (form.has("transcript")) await svc.saveTranscript(id, field(form, "transcript"), user.name);
    const { dropped } = await svc.generateDrafts(id, user.name);
    revalidatePath(`/consults/${id}`);
    return {
      ok: true,
      message: dropped.length
        ? `Drafts ready. ${dropped.length} item(s) from the draft were removed because they were not valid (see the history).`
        : "Drafts ready for review.",
    };
  } catch (err) {
    return fail(err);
  }
}

export async function setPatientIdAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(form, "id");
  try {
    await getService(user.clinicId).setPmsPatientId(id, field(form, "pmsPatientId"), user.name);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/consults/${id}`);
  return { ok: true, message: "Saved." };
}

function parseDrafts(json: string): { note: unknown; programme: unknown } {
  try {
    const data = JSON.parse(json) as { note?: unknown; programme?: unknown };
    return { note: data.note, programme: data.programme };
  } catch {
    throw new DomainError("validation", "The review form could not be read. Reload the page and try again.");
  }
}

export async function saveDraftsAction(id: string, json: string): Promise<ActionState> {
  const user = await requireUser();
  try {
    await getService(user.clinicId).saveDrafts(id, parseDrafts(json), user.name);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/consults/${id}`);
  return { ok: true, message: "Saved." };
}

/** Saves the on-screen edits, then approves. The approver is the signed-in physio, never a form field. */
export async function approveAction(id: string, json: string): Promise<ActionState> {
  const user = await requireUser();
  try {
    const svc = getService(user.clinicId);
    await svc.saveDrafts(id, parseDrafts(json), user.name);
    await svc.approve(id, user.name);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/consults/${id}`);
  return { ok: true, message: "Approved." };
}

function parseAyurveda(json: string): { record: unknown; plan: unknown } {
  try {
    const data = JSON.parse(json) as { record?: unknown; plan?: unknown };
    return { record: data.record, plan: data.plan };
  } catch {
    throw new DomainError("validation", "The form could not be read. Reload the page and try again.");
  }
}

export async function saveAyurvedaAction(id: string, json: string): Promise<ActionState> {
  const user = await requireUser(["owner", "clinician"]);
  try {
    await getService(user.clinicId).saveAyurveda(id, parseAyurveda(json), user.name);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/consults/${id}`);
  return { ok: true, message: "Saved." };
}

/** Saves the on-screen record and plan, then approves. The approver is the signed-in practitioner, never a form field. */
export async function approveAyurvedaAction(id: string, json: string): Promise<ActionState> {
  const user = await requireUser(["owner", "clinician"]);
  try {
    const svc = getService(user.clinicId);
    await svc.saveAyurveda(id, parseAyurveda(json), user.name);
    await svc.approve(id, user.name);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/consults/${id}`);
  return { ok: true, message: "Approved." };
}

// ------------------------------------------------------------------ patient link, write-back

export async function createLinkAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(form, "id");
  try {
    const { token, expiresAt } = await getService(user.clinicId).createPatientLink(id, user.name);
    revalidatePath(`/consults/${id}`);
    return { ok: true, url: `${await baseUrl()}/p/${token}`, expiresAt };
  } catch (err) {
    return fail(err);
  }
}

export async function revokeLinksAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(form, "id");
  try {
    await getService(user.clinicId).revokePatientLinks(id, user.name);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/consults/${id}`);
  return { ok: true, message: "Links revoked." };
}

export async function writeBackAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(form, "id");
  try {
    const row = await getService(user.clinicId).writeBack(id, field(form, "target"), user.name);
    revalidatePath(`/consults/${id}`);
    if (row.status === "succeeded") return { ok: true, message: "Note written to the practice system." };
    if (row.status === "needs_check") return { ok: false, message: "An earlier attempt did not report back. Check the practice system, then say what you found below." };
    return { ok: false, message: `Write-back failed: ${row.error ?? "unknown error"}. Nothing was changed on your side; you can retry or copy the note.` };
  } catch (err) {
    return fail(err);
  }
}

export async function resolveWritebackAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(form, "id");
  const outcome = field(form, "outcome");
  try {
    if (outcome !== "written" && outcome !== "not_written") return { ok: false, message: "Choose what you found." };
    await getService(user.clinicId).resolveWriteback(id, field(form, "target"), outcome, user.name, field(form, "externalId"));
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/consults/${id}`);
  return { ok: true, message: "Recorded." };
}

// ------------------------------------------------------------------ patient (public)

export async function checkInAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    await getPublicService().submitCheckIn(field(form, "token"), {
      adherence: field(form, "adherence"),
      painChange: field(form, "painChange"),
      comment: field(form, "comment"),
    });
    return { ok: true, message: "Thank you. Your practitioner will see this." };
  } catch (err) {
    return fail(err);
  }
}
