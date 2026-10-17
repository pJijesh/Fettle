import crypto from "node:crypto";

export interface CardCheckout {
  id: string;
  url: string;
}

export interface CardProvider {
  readonly name: string;
  createCheckout(input: {
    amountPence: number;
    description: string;
    invoiceId: string;
    clinicId: string;
    successUrl: string;
    cancelUrl: string;
    /** Same key within the window returns the same session, so a double click does not make two links. */
    idempotencyKey: string;
    expiresAt: Date;
  }): Promise<CardCheckout>;
}

export class StripeCards implements CardProvider {
  readonly name = "stripe";
  constructor(private cfg: { secretKey: string; baseUrl?: string }) {}

  async createCheckout(i: Parameters<CardProvider["createCheckout"]>[0]): Promise<CardCheckout> {
    const p = new URLSearchParams();
    p.set("mode", "payment");
    p.set("success_url", i.successUrl);
    p.set("cancel_url", i.cancelUrl);
    p.set("client_reference_id", i.invoiceId);
    p.set("expires_at", String(Math.floor(i.expiresAt.getTime() / 1000)));
    p.set("line_items[0][quantity]", "1");
    p.set("line_items[0][price_data][currency]", "gbp");
    p.set("line_items[0][price_data][unit_amount]", String(i.amountPence));
    p.set("line_items[0][price_data][product_data][name]", i.description);
    // Only identifiers go to Stripe: no patient name, address, email or clinical detail.
    for (const prefix of ["metadata", "payment_intent_data[metadata]"]) {
      p.set(`${prefix}[invoice_id]`, i.invoiceId);
      p.set(`${prefix}[clinic_id]`, i.clinicId);
    }
    const res = await fetch(`${this.cfg.baseUrl ?? "https://api.stripe.com"}/v1/checkout/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.cfg.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": i.idempotencyKey,
      },
      body: p.toString(),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {
      throw new Error("Stripe: could not be reached");
    });
    if (!res.ok) throw new Error(`Stripe ${res.status}`);
    const body = (await res.json()) as { id?: string; url?: string };
    if (!body.id || !body.url) throw new Error("Stripe: unexpected reply");
    return { id: body.id, url: body.url };
  }
}

/** Starting and managing the clinic's own plan (separate from the card links a clinic sends its patients). */
export interface SubscriptionProvider {
  createSubscriptionCheckout(input: {
    clinicId: string;
    priceId: string;
    customerId: string | null;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<CardCheckout>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
}

async function stripePost(cfg: { secretKey: string; baseUrl?: string }, path: string, form: URLSearchParams, idempotencyKey?: string): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { authorization: `Bearer ${cfg.secretKey}`, "content-type": "application/x-www-form-urlencoded" };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const res = await fetch(`${cfg.baseUrl ?? "https://api.stripe.com"}${path}`, { method: "POST", headers, body: form.toString(), signal: AbortSignal.timeout(15_000) }).catch(() => {
    throw new Error("Stripe: could not be reached");
  });
  if (!res.ok) throw new Error(`Stripe ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

export class StripeSubscriptions implements SubscriptionProvider {
  constructor(private cfg: { secretKey: string; baseUrl?: string }) {}

  async createSubscriptionCheckout(i: Parameters<SubscriptionProvider["createSubscriptionCheckout"]>[0]): Promise<CardCheckout> {
    const p = new URLSearchParams();
    p.set("mode", "subscription");
    p.set("success_url", i.successUrl);
    p.set("cancel_url", i.cancelUrl);
    p.set("client_reference_id", i.clinicId);
    p.set("line_items[0][price]", i.priceId);
    p.set("line_items[0][quantity]", "1");
    if (i.customerId) p.set("customer", i.customerId);
    // Only the clinic's identifier goes to Stripe from here; Checkout asks the owner for the email and card itself.
    for (const prefix of ["metadata", "subscription_data[metadata]"]) {
      p.set(`${prefix}[clinic_id]`, i.clinicId);
      p.set(`${prefix}[kind]`, "plan");
    }
    const body = await stripePost(this.cfg, "/v1/checkout/sessions", p, i.idempotencyKey);
    if (typeof body.id !== "string" || typeof body.url !== "string") throw new Error("Stripe: unexpected reply");
    return { id: body.id, url: body.url };
  }

  async createPortalSession(i: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    const p = new URLSearchParams();
    p.set("customer", i.customerId);
    p.set("return_url", i.returnUrl);
    const body = await stripePost(this.cfg, "/v1/billing_portal/sessions", p);
    if (typeof body.url !== "string") throw new Error("Stripe: unexpected reply");
    return { url: body.url };
  }
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/**
 * Checks that a notification really came from Stripe: the `Stripe-Signature` header holds a timestamp and one or
 * more HMAC-SHA256 signatures of "timestamp.body" made with the webhook secret. An old timestamp is refused so a
 * captured notification cannot be replayed later. Throws if anything is wrong.
 */
export function verifyStripeEvent(rawBody: string, header: string | null, secret: string, now: Date, toleranceSec = 300): StripeEvent {
  if (!header) throw new Error("missing signature");
  let t = "";
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (k === "t") t = v ?? "";
    else if (k === "v1" && v) sigs.push(v);
  }
  const ts = Number(t);
  if (!Number.isInteger(ts) || !sigs.length) throw new Error("malformed signature");
  if (Math.abs(now.getTime() / 1000 - ts) > toleranceSec) throw new Error("timestamp outside tolerance");
  const want = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const ok = sigs.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });
  if (!ok) throw new Error("signature mismatch");
  const ev = JSON.parse(rawBody) as StripeEvent;
  if (!ev || typeof ev.id !== "string" || typeof ev.type !== "string" || !ev.data?.object) throw new Error("malformed event");
  return ev;
}

export function signStripePayload(rawBody: string, secret: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}
