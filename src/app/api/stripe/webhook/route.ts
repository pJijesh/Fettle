import { getPlatform } from "@/lib/app";
import { logError, logInfo } from "@/lib/log";
import { handleStripeEvent } from "@/lib/payments/handler";
import { verifyStripeEvent } from "@/lib/payments/stripe";

export const dynamic = "force-dynamic";

const MAX_BYTES = 1_000_000;

/**
 * Stripe tells us here that a card payment succeeded. Nothing is trusted until the signature checks out against
 * the webhook secret. A reply of 200 means "received" (including payments we could not apply, which are written
 * to the audit log); a 5xx makes Stripe try again, which is safe because each payment is recorded once.
 * Switched off (404) unless STRIPE_WEBHOOK_SECRET is set.
 */
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response("Not found", { status: 404 });
  const raw = await req.text();
  if (raw.length > MAX_BYTES) return new Response("Too large", { status: 413 });

  let event;
  try {
    event = verifyStripeEvent(raw, req.headers.get("stripe-signature"), secret, new Date());
  } catch {
    return new Response("Bad signature", { status: 400 });
  }

  try {
    const out = await handleStripeEvent(getPlatform().billing, event);
    logInfo("stripe.event", { type: event.type, event: event.id, result: String(out.body.result ?? out.body.ignored ?? (out.body.pending ? "pending" : "")) });
    return Response.json(out.body, { status: out.status });
  } catch (err) {
    logError("stripe-webhook", err);
    return new Response("Try again", { status: 500 });
  }
}
