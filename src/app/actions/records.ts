"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getPlatform } from "@/lib/app";
import { fail, field, type ActionState } from "@/lib/action-util";

export async function anonymisePatientAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser(["owner"]);
  const id = field(form, "patientId");
  if (field(form, "confirm") !== "yes") return { ok: false, message: "Tick the box to confirm. This cannot be undone." };
  try {
    await getPlatform().records.anonymise(user, id, { override: field(form, "early") === "yes", reason: field(form, "reason") });
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/patients/${id}`);
  revalidatePath("/settings/retention");
  return { ok: true, message: "Done. This person can no longer be identified from the record." };
}

export async function saveRetentionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser(["owner"]);
  try {
    await getPlatform().records.setRetentionYears(user, Number(field(form, "years")));
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/settings/retention");
  return { ok: true, message: "Saved." };
}
