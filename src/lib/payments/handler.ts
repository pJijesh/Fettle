import type { Billing } from "../billing";
import type { Plans } from "../plans";
import type { StripeEvent } from "./stripe";

export type StripeOutcome =
  | { status: 200; body: Record<string, unknown> };

const ok = (body: Record<string, unknown>): StripeOutcome => ({ status: 200, body: { received: true, ...body } });

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const rec = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

/** The clinic a plan event is about: our own metadata first, else the subscription we already linked to a clinic. */
async function planClinic(plans: Plans, o: Obj): Promise<string | null> {
  const meta = [rec(o.metadata), rec(rec(o.subscription_details).metadata), rec(rec(rec(o.parent).subscription_details).metadata)];
  for (const m of meta) if (str(m.kind) === "plan" && str(m.clinic_id)) return str(m.clinic_id);
  const sub = str(o.subscription) ?? (str(o.object) === "subscription" ? str(o.id) : null) ?? str(rec(rec(o.parent).subscription_details).subscription);
  return sub ? plans.clinicOfSubscription(sub) : null;
}

/** The end of the period an invoice paid for, as a date, or null if the invoice does not say. */
function periodEnd(invoice: Obj): Date | null {
  const lines = rec(invoice.lines).data;
  const ends = (Array.isArray(lines) ? lines : []).map((l) => rec(rec(l).period).end).filter((n): n is number => typeof n === "number" && n > 0);
  return ends.length ? new Date(Math.max(...ends) * 1000) : null;
}

/** Turns a plan event (subscription started, renewed, failed, ended) into a change to the clinic's plan. */
async function handlePlanEvent(plans: Plans, event: StripeEvent, now: Date): Promise<StripeOutcome | null> {
  const o = event.data.object;
  switch (event.type) {
    case "checkout.session.completed": {
      if (o.mode !== "subscription") return null;
      const clinicId = await planClinic(plans, o);
      if (!clinicId) return ok({ ignored: "not one of ours" });
      await plans.subscriptionStarted(clinicId, { customerId: str(o.customer), subscriptionId: str(o.subscription) });
      return ok({ plan: "subscribed" });
    }
    case "invoice.paid": {
      const clinicId = await planClinic(plans, o);
      if (!clinicId) return null;
      // Only subscription invoices matter here; an invoice with no period end gives a month from now.
      const end = periodEnd(o) ?? new Date(now.getTime() + 32 * 86_400_000);
      await plans.renewed(clinicId, { periodEnd: end, customerId: str(o.customer), subscriptionId: str(o.subscription) });
      return ok({ plan: "renewed" });
    }
    case "invoice.payment_failed": {
      const clinicId = await planClinic(plans, o);
      if (!clinicId) return null;
      await plans.paymentFailed(clinicId);
      return ok({ plan: "payment_failed" });
    }
    case "customer.subscription.deleted": {
      const clinicId = await planClinic(plans, o);
      if (!clinicId) return null;
      await plans.cancelled(clinicId);
      return ok({ plan: "cancelled" });
    }
    default:
      return null;
  }
}

/** Turns a verified Stripe event into at most one recorded payment or plan change. Throws on a failure Stripe should retry. */
export async function handleStripeEvent(billing: Billing, event: StripeEvent, plans?: Plans, now: Date = new Date()): Promise<StripeOutcome> {
  if (plans) {
    const out = await handlePlanEvent(plans, event, now);
    if (out) return out;
  }
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
