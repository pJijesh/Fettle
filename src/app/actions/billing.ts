"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getPlatform } from "@/lib/app";
import { DomainError } from "@/lib/errors";
import { parsePounds } from "@/lib/money";
import { PAYMENT_METHODS, type LineInput, type PaymentMethod } from "@/lib/billing";
import { fail, field, type ActionState } from "@/lib/action-util";

const STAFF = ["owner", "reception"] as const;

function pounds(text: string, name: string, label: string): number {
  const v = parsePounds(text);
  if (v === null) throw new DomainError("validation", `Enter ${label} in pounds, like 45 or 45.50`, [{ path: name, message: `Enter ${label} in pounds, like 45 or 45.50` }]);
  return v;
}

export async function saveBillingSettingsAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser(["owner"]);
  try {
    const vat = Number(field(form, "vatRate").trim() || "0");
    await getPlatform().billing.saveSettings(user, {
      invoicePrefix: field(form, "invoicePrefix"),
      creditPrefix: field(form, "creditPrefix"),
      vatRateBp: Number.isFinite(vat) ? Math.round(vat * 100) : -1,
      billingDetails: field(form, "billingDetails"),
      paymentTermsDays: Number(field(form, "paymentTermsDays")),
    });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/settings");
  return { ok: true, message: "Saved." };
}

export async function invoiceAppointmentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser([...STAFF]);
  let id: string;
  try {
    const payerType = field(form, "payerType") === "insurer" ? "insurer" : "self";
    id = await getPlatform().billing.invoiceForAppointment(user, field(form, "id"), {
      payerType,
      payerName: payerType === "insurer" ? field(form, "payerName") : "",
      claimRef: payerType === "insurer" ? field(form, "claimRef") : "",
    });
  } catch (err) {
    return fail(err);
  }
  redirect(`/billing/${id}`);
}

export async function createInvoiceAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser([...STAFF]);
  let id: string;
  try {
    const lines: LineInput[] = [];
    for (let i = 1; i <= 8; i++) {
      const description = field(form, `desc${i}`).trim();
      const qty = field(form, `qty${i}`).trim();
      const price = field(form, `price${i}`).trim();
      if (!description && !price) continue;
      lines.push({ description, quantity: qty ? Number(qty) : 1, unitPence: pounds(price, `lines.${lines.length}.unitPence`, "the price") });
    }
    const payerType = field(form, "payerType") === "insurer" ? "insurer" : "self";
    id = await getPlatform().billing.createInvoice(user, {
      patientId: field(form, "patientId"),
      lines,
      payerType,
      payerName: payerType === "insurer" ? field(form, "payerName") : "",
      claimRef: payerType === "insurer" ? field(form, "claimRef") : "",
      note: field(form, "note"),
    });
  } catch (err) {
    return fail(err);
  }
  redirect(`/billing/${id}`);
}

export async function recordPaymentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser([...STAFF]);
  const id = field(form, "id");
  try {
    const method = field(form, "method") as PaymentMethod;
    await getPlatform().billing.recordPayment(user, id, {
      amountPence: pounds(field(form, "amount"), "amount", "the amount"),
      method: PAYMENT_METHODS.includes(method) ? method : ("" as PaymentMethod),
      receivedOn: field(form, "receivedOn") || undefined,
      reference: field(form, "reference"),
    });
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/billing/${id}`);
  revalidatePath("/billing");
  return { ok: true, message: "Payment recorded." };
}

export async function reversePaymentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser([...STAFF]);
  try {
    await getPlatform().billing.reversePayment(user, field(form, "paymentId"), field(form, "reason"));
  } catch (err) {
    return fail(err);
  }
  revalidatePath(`/billing/${field(form, "id")}`);
  revalidatePath("/billing");
  return { ok: true, message: "Payment reversed." };
}

export async function creditInvoiceAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireUser([...STAFF]);
  let cn: string;
  try {
    cn = await getPlatform().billing.creditInvoice(user, field(form, "id"), field(form, "reason"));
  } catch (err) {
    return fail(err);
  }
  redirect(`/billing/${cn}`);
}
