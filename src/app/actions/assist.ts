"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getPlatform } from "@/lib/app";
import { fail, field, type ActionState } from "@/lib/action-util";

const staff = () => requireUser(["owner", "clinician"]);

export async function draftLetterAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await staff();
  const id = field(form, "id");
  let docId: string;
  try {
    docId = await getPlatform().documents.draftLetter(user, id, field(form, "kind"), field(form, "instruction"));
  } catch (err) {
    return fail(err);
  }
  redirect(`/consults/${id}/documents/${docId}`);
}

export async function draftSummaryAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await staff();
  const id = field(form, "id");
  let docId: string;
  try {
    docId = await getPlatform().documents.draftSummary(user, id, field(form, "level"), field(form, "language"));
  } catch (err) {
    return fail(err);
  }
  redirect(`/consults/${id}/documents/${docId}`);
}

/** The button used decides: "save" keeps the draft, anything else saves what is on screen and finalises it. */
export async function finaliseDocumentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await staff();
  const save = field(form, "intent") === "save";
  try {
    const p = getPlatform();
    await p.documents.edit(user, field(form, "docId"), { subject: field(form, "subject"), body: field(form, "body") });
    if (!save) await p.documents.finalise(user, field(form, "docId"));
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/consults/${field(form, "id")}/documents/${field(form, "docId")}`);
  return { ok: true, message: save ? "Saved." : "Finalised." };
}

export async function withdrawDocumentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await staff();
  try {
    await getPlatform().documents.withdraw(user, field(form, "docId"));
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/consults/${field(form, "id")}/documents/${field(form, "docId")}`);
  return { ok: true, message: "Withdrawn. The patient no longer sees it." };
}

export async function deleteDocumentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await staff();
  const id = field(form, "id");
  try {
    await getPlatform().documents.deleteDraft(user, field(form, "docId"));
  } catch (err) {
    return fail(err);
  }
  redirect(`/consults/${id}`);
}

/** Checks the note as it is on screen. Advice only. */
export async function checkNoteAction(id: string, json: string): Promise<ActionState> {
  const user = await staff();
  try {
    const parsed = JSON.parse(json) as { note: unknown; programme: unknown };
    const res = await getPlatform().assistant.checkNote(user, id, parsed);
    return { ok: true, message: res.assistant === "unavailable" ? "The second look at the transcript was not available, so only the plain checks ran." : undefined, data: res.findings };
  } catch (err) {
    return fail(err);
  }
}

export async function suggestCodesAction(id: string): Promise<ActionState> {
  const user = await staff();
  try {
    return { ok: true, data: await getPlatform().assistant.suggestCodes(user, id) };
  } catch (err) {
    return fail(err);
  }
}

export async function markReviewedAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await staff();
  try {
    await getPlatform().triage.markReviewed(user, field(form, "checkInId"));
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/check-ins");
  return { ok: true, message: "Marked as seen." };
}

export async function setAiTriageAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser(["owner"]);
  try {
    await getPlatform().triage.setAi(user, field(form, "on") === "yes");
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/settings");
  return { ok: true, message: "Saved." };
}

export async function summariseProgressAction(patientId: string): Promise<ActionState> {
  const user = await staff();
  try {
    return { ok: true, message: await getPlatform().progress.summarise(user, patientId) };
  } catch (err) {
    return fail(err);
  }
}
