"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getPlatform, getService } from "@/lib/app";
import { DomainError } from "@/lib/errors";
import { clockToMinutes, isDate, zonedToUtc } from "@/lib/tz";
import { baseUrl, fail, field, type ActionState } from "@/lib/action-util";
import type { PatientInput } from "@/lib/scheduling";
import type { ImportKind, ImportSource } from "@/lib/import-meta";
import { readTable } from "@/lib/sheet";

const bool = (form: FormData, name: string) => form.get(name) === "yes";

function patientInput(form: FormData): PatientInput {
  return {
    firstName: field(form, "firstName"),
    lastName: field(form, "lastName"),
    dob: field(form, "dob") || null,
    email: field(form, "email") || null,
    phone: field(form, "phone") || null,
    gpName: field(form, "gpName") || null,
    gpPractice: field(form, "gpPractice") || null,
    address: field(form, "address") || null,
    postcode: field(form, "postcode") || null,
    smsConsent: bool(form, "smsConsent"),
    emailConsent: bool(form, "emailConsent"),
    marketingConsent: bool(form, "marketingConsent"),
  };
}

/** Local date and clock time (as typed) to a UTC instant, in the clinic's zone. */
function localToUtc(clinicTz: string, date: string, time: string): string {
  const minutes = clockToMinutes(time);
  if (!isDate(date)) throw new DomainError("validation", "Choose a date", [{ path: "date", message: "Choose a date" }]);
  if (minutes === null) throw new DomainError("validation", "Enter the time as hours and minutes, like 14:30", [{ path: "time", message: "Enter a time like 14:30" }]);
  const d = zonedToUtc(date, minutes, clinicTz);
  if (!d) throw new DomainError("validation", "That time does not exist because the clocks go forward then. Choose another.", [{ path: "time", message: "Time skipped by the clock change" }]);
  return d.toISOString();
}

// ------------------------------------------------------------------ patients

export async function createPatientAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const p = getPlatform();
  let id: string;
  try {
    const input = patientInput(form);
    if (!bool(form, "force") && input.firstName.trim() && input.lastName.trim()) {
      const dup = await p.scheduling.findDuplicates(user.clinicId, { firstName: input.firstName, lastName: input.lastName, dob: input.dob, email: input.email });
      if (dup.length) {
        return {
          ok: false,
          message: `There may already be a record for this person: ${dup.map((d) => `${d.firstName} ${d.lastName}${d.dob ? `, born ${d.dob}` : ""}`).join("; ")}. Search for them first, or tick “Create anyway” if this is a different person.`,
        };
      }
    }
    id = await p.scheduling.createPatient(user.clinicId, user.email, input);
  } catch (err) {
    return fail(err);
  }
  redirect(`/patients/${id}`);
}

export async function updatePatientAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(form, "id");
  try {
    await getPlatform().scheduling.updatePatient(user.clinicId, user.email, id, patientInput(form));
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/patients/${id}`);
  return { ok: true, message: "Saved." };
}

export async function mergePatientsAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser(["owner", "clinician"]);
  const keep = field(form, "keepId");
  try {
    if (form.get("confirm") !== "yes") return { ok: false, message: "Tick the box to confirm. A merge cannot be undone." };
    await getPlatform().scheduling.mergePatients(user.clinicId, user.email, keep, field(form, "removeId"));
  } catch (err) {
    return fail(err);
  }
  redirect(`/patients/${keep}`);
}

// ------------------------------------------------------------------ appointments

export async function createAppointmentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const p = getPlatform();
  const date = field(form, "date");
  try {
    const tz = (await p.scheduling.clinic(user.clinicId)).timezone;
    const startAt = localToUtc(tz, date, field(form, "time"));
    await p.scheduling.createAppointment(user.clinicId, user.email, {
      patientId: field(form, "patientId"), userId: field(form, "userId"), typeId: field(form, "typeId"), startAt, source: "staff",
    });
  } catch (err) {
    return fail(err);
  }
  redirect(`/calendar?date=${date}&view=day`);
}

/** Drag-and-drop on the calendar. `minutes` is minutes after local midnight on `date`. */
export async function moveAppointmentDragAction(id: string, date: string, minutes: number, userId: string): Promise<ActionState> {
  const user = await requireUser();
  const p = getPlatform();
  try {
    const tz = (await p.scheduling.clinic(user.clinicId)).timezone;
    if (!isDate(date) || !Number.isInteger(minutes) || minutes < 0 || minutes >= 1440) throw new DomainError("validation", "Drop the appointment on a valid time");
    const d = zonedToUtc(date, minutes, tz);
    if (!d) throw new DomainError("validation", "That time does not exist because the clocks go forward then.");
    await p.scheduling.moveAppointment(user.clinicId, user.email, id, { startAt: d.toISOString(), userId });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/calendar");
  return { ok: true, message: "Moved." };
}

export async function rescheduleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const p = getPlatform();
  const id = field(form, "id");
  try {
    const tz = (await p.scheduling.clinic(user.clinicId)).timezone;
    await p.scheduling.moveAppointment(user.clinicId, user.email, id, { startAt: localToUtc(tz, field(form, "date"), field(form, "time")), userId: field(form, "userId") || undefined });
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/appointments/${id}`);
  return { ok: true, message: "Appointment moved. The patient has been told." };
}

export async function cancelAppointmentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(form, "id");
  try {
    await getPlatform().scheduling.cancelAppointment(user.clinicId, user.email, id, field(form, "reason"));
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/appointments/${id}`);
  return { ok: true, message: "Cancelled. The patient has been told and the waiting list has been offered the time." };
}

export async function arrivedAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(form, "id");
  try {
    await getPlatform().scheduling.markArrived(user.clinicId, user.email, id, field(form, "override") || undefined);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/appointments/${id}`);
  return { ok: true, message: "Marked as arrived." };
}

export async function completedAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(form, "id");
  try {
    await getPlatform().scheduling.markCompleted(user.clinicId, user.email, id);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/appointments/${id}`);
  return { ok: true, message: "Marked as completed." };
}

export async function noShowAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(form, "id");
  try {
    await getPlatform().scheduling.markNoShow(user.clinicId, user.email, id);
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/appointments/${id}`);
  return { ok: true, message: "Marked as did not attend." };
}

/** Starts (or opens) the consultation for an appointment, so the note and exercise programme belong to the visit. */
export async function startConsultationAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser(["owner", "clinician"]);
  const p = getPlatform();
  let consultId: string;
  try {
    const a = await p.scheduling.getAppointment(user.clinicId, field(form, "id"));
    if (a.consultId) consultId = a.consultId;
    else {
      const patient = await p.scheduling.getPatient(user.clinicId, a.patientId);
      consultId = await getService(user.clinicId).createConsult(
        { patientLabel: `${patient.firstName} ${patient.lastName}`.slice(0, 80), practitioner: a.clinicianName, patientId: a.patientId, appointmentId: a.id },
        user.email,
      );
      await p.scheduling.attachConsult(user.clinicId, a.id, consultId);
    }
  } catch (err) {
    return fail(err);
  }
  redirect(`/consults/${consultId}`);
}

// ------------------------------------------------------------------ waiting list

export async function addWaitlistAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  try {
    await getPlatform().waitlist.add(user.clinicId, user.email, {
      patientId: field(form, "patientId"), typeId: field(form, "typeId"), userId: field(form, "userId") || null,
      earliestDate: field(form, "earliestDate"), latestDate: field(form, "latestDate"),
      weekdays: form.getAll("weekdays").map((v) => Number(v)),
    });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/waitlist");
  revalidatePath(`/patients/${field(form, "patientId")}`);
  return { ok: true, message: "Added to the waiting list." };
}

export async function removeWaitlistAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser();
  try {
    await getPlatform().waitlist.remove(user.clinicId, user.email, field(form, "id"));
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/waitlist");
  return { ok: true, message: "Removed." };
}

// ------------------------------------------------------------------ settings (owner)

export async function saveTypeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser(["owner"]);
  try {
    await getPlatform().scheduling.saveType(user.clinicId, user.email, {
      id: field(form, "id") || undefined, name: field(form, "name"), durationMin: Number(field(form, "durationMin")), bufferMin: Number(field(form, "bufferMin") || 0),
      onlineBookable: bool(form, "onlineBookable"), colour: field(form, "colour"), active: field(form, "id") ? bool(form, "active") : true,
    });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/settings");
  return { ok: true, message: "Saved." };
}

export async function saveHoursAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser(["owner"]);
  const userId = field(form, "userId");
  try {
    const rows: { weekday: number; startMin: number; endMin: number }[] = [];
    const issues: { path: string; message: string }[] = [];
    for (let day = 1; day <= 7; day++) {
      for (const n of [1, 2]) {
        const s = field(form, `d${day}_${n}_start`).trim();
        const e = field(form, `d${day}_${n}_end`).trim();
        if (!s && !e) continue;
        const sm = clockToMinutes(s);
        const em = clockToMinutes(e);
        if (sm === null || em === null) issues.push({ path: `d${day}_${n}`, message: `${DAYS[day - 1]}: enter both times like 09:00` });
        else rows.push({ weekday: day, startMin: sm, endMin: em });
      }
    }
    if (issues.length) throw new DomainError("validation", "Check the working hours", issues);
    await getPlatform().scheduling.setHours(user.clinicId, user.email, userId, rows);
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/settings");
  return { ok: true, message: "Working hours saved." };
}
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export async function createUserAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser(["owner"]);
  try {
    await getPlatform().accounts.createUser(user, { name: field(form, "name"), email: field(form, "email"), password: field(form, "password"), role: field(form, "role") as "owner" | "clinician" | "reception" });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/settings");
  return { ok: true, message: "Added. They set up two-step sign-in the first time they sign in." };
}

export async function deactivateUserAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser(["owner"]);
  try {
    await getPlatform().accounts.deactivateUser(user, field(form, "id"));
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/settings");
  return { ok: true, message: "Deactivated and signed out." };
}

export async function resetPasswordAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser(["owner"]);
  try {
    await getPlatform().accounts.resetPassword(user, field(form, "id"), field(form, "password"));
  } catch (err) {
    return fail(err);
  }
  return { ok: true, message: "Password changed and the person was signed out." };
}

export async function resetMfaAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser(["owner"]);
  try {
    await getPlatform().accounts.resetMfa(user, field(form, "id"));
  } catch (err) {
    return fail(err);
  }
  return { ok: true, message: "Two-step sign-in reset. They will set it up again at their next sign-in." };
}

export async function icalCreateAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser(["owner", "clinician"]);
  const target = user.role === "owner" && field(form, "userId") ? field(form, "userId") : user.id;
  try {
    const token = await getPlatform().ical.createToken(user.clinicId, target);
    revalidatePath("/settings");
    return { ok: true, url: `${await baseUrl()}/api/ical/${token}`, message: "Calendar link made." };
  } catch (err) {
    return fail(err);
  }
}

export async function icalRevokeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser(["owner", "clinician"]);
  const target = user.role === "owner" && field(form, "userId") ? field(form, "userId") : user.id;
  await getPlatform().ical.revoke(user.clinicId, target);
  revalidatePath("/settings");
  return { ok: true, message: "Calendar link stopped." };
}

export async function saveFormAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser(["owner"]);
  try {
    await getPlatform().forms.save(user.clinicId, user.email, {
      id: field(form, "id") || undefined, name: field(form, "name"), kind: field(form, "kind") === "consent" ? "consent" : "intake",
      fieldsJson: field(form, "fields"), mandatory: bool(form, "mandatory"), active: bool(form, "active"),
    });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/settings/forms");
  return { ok: true, message: "Saved. New appointments use this version; forms already sent keep the questions they were sent with." };
}

// ------------------------------------------------------------------ switching import (owner)

export async function importAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser(["owner"]);
  try {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose a CSV or Excel file to import." };
    if (file.size > 5_000_000) return { ok: false, message: "That file is over 5 MB. Split it and import in parts." };
    const dryRun = field(form, "mode") !== "commit";
    const rows = await readTable(file.name, new Uint8Array(await file.arrayBuffer()));
    // The person's corrections: one "map:<column number>" entry per column, holding a field name or nothing.
    const hasMapping = [...form.keys()].some((k) => k.startsWith("map:"));
    const mapping = hasMapping ? (rows[0] ?? []).map((_, i) => field(form, `map:${i}`) || null) : undefined;
    const report = await getPlatform().importer.run(user.clinicId, user.email, {
      kind: field(form, "kind") as ImportKind, source: field(form, "source") as ImportSource, filename: file.name, rows, mapping, dryRun,
    });
    revalidatePath("/settings/import");
    // When columns are missing the panel explains it next to the column table, so no banner here.
    return { ok: true, data: report, message: report.problems.length ? "" : dryRun ? "Dry run complete. Nothing has been saved yet." : "Import complete." };
  } catch (err) {
    return fail(err);
  }
}

export async function undoImportAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser(["owner"]);
  try {
    const r = await getPlatform().importer.undo(user.clinicId, user.email, field(form, "id"));
    revalidatePath("/settings/import");
    return { ok: true, message: `Undone: ${r.removedAppointments} appointments and ${r.removedPatients} patients removed${r.keptPatients ? `; ${r.keptPatients} patients were kept because they now have other records` : ""}.` };
  } catch (err) {
    return fail(err);
  }
}
