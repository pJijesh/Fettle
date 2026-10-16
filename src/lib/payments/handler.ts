import type { Billing } from "../billing";
import type { StripeEvent } from "./stripe";

export type StripeOutcome =
  | { status: 200; body: Record<string, unknown> };

/** Turns a verified Stripe event into at most one recorded payment. Throws on a failure Stripe should retry. */
export async function handleStripeEvent(billing: Billing, event: StripeEvent): Promise<StripeOutcome> {
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") {
    return { status: 200, body: { received: true, ignored: event.type } };
  }
  const s = event.data.object as {
    id?: string;
    payment_status?: string;
    payment_intent?: string | null;
    amount_total?: number;
    currency?: string;
    metadata?: { invoice_id?: string; clinic_id?: string };
  };
  // An unpaid session (a delayed method still pending) waits for the later success event.
  if (s.payment_status !== "paid") return { status: 200, body: { received: true, pending: true } };
  const invoiceId = s.metadata?.invoice_id;
  const clinicId = s.metadata?.clinic_id;
  if (!invoiceId || !clinicId || !Number.isInteger(s.amount_total) || (s.currency ?? "").toLowerCase() !== "gbp") {
    return { status: 200, body: { received: true, ignored: "not one of ours" } };
  }
  const result = await billing.applyCardPayment(clinicId, { invoiceId, amountPence: s.amount_total as number, externalId: s.payment_intent || s.id || event.id });
  return { status: 200, body: { received: true, result } };
}
