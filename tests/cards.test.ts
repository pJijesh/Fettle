import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { StripeCards, signStripePayload, verifyStripeEvent, type StripeEvent } from "@/lib/payments/stripe";
import { handleStripeEvent } from "@/lib/payments/handler";
import { createPlatform } from "@/lib/platform";
import { platformSetup, PW, type PlatformSetup } from "./platform.helpers";
import type { SessionUser } from "@/lib/accounts";

const SECRET = "whsec_test_secret";
const MON_9 = "2026-10-19T08:00:00.000Z";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function fakeStripe(reply: { status: number; body?: unknown } = { status: 200, body: { id: "cs_test_1", url: "https://checkout.stripe.test/c/pay/cs_test_1" } }) {
  const seen: { path: string; auth: string; idem: string; form: URLSearchParams }[] = [];
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", auth: String(req.headers.authorization), idem: String(req.headers["idempotency-key"]), form: new URLSearchParams(b) });
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

async function withCards(s: PlatformSetup, base: string) {
  return createPlatform(s.db, { now: () => s.clock.now, baseUrl: () => "https://clinic.test", card: new StripeCards({ secretKey: "sk_test_x", baseUrl: base }) });
}

async function invoice(s: PlatformSetup, p: { billing: { createInvoice: PlatformSetup["p"]["billing"]["createInvoice"] } }, pence = 6000) {
  return p.billing.createInvoice(s.owner, { patientId: s.patient, lines: [{ description: "Assessment", quantity: 1, unitPence: pence }] });
}

const paidEvent = (s: PlatformSetup, invoiceId: string, over: Record<string, unknown> = {}, id = "evt_1", type = "checkout.session.completed"): StripeEvent => ({
  id,
  type,
  data: { object: { id: "cs_test_1", payment_status: "paid", payment_intent: "pi_1", amount_total: 6000, currency: "gbp", metadata: { invoice_id: invoiceId, clinic_id: s.clinicId }, ...over } },
});

describe("webhook signatures", () => {
  const body = JSON.stringify({ id: "evt_1", type: "x", data: { object: {} } });
  const now = new Date("2026-10-19T10:00:00Z");
  it("accepts a correctly signed, recent event", () => {
    expect(verifyStripeEvent(body, signStripePayload(body, SECRET, now), SECRET, now).id).toBe("evt_1");
  });
  it("refuses a wrong secret, a changed body, an old timestamp and malformed headers", () => {
    expect(() => verifyStripeEvent(body, signStripePayload(body, "other", now), SECRET, now)).toThrow(/mismatch/);
    expect(() => verifyStripeEvent(body + " ", signStripePayload(body, SECRET, now), SECRET, now)).toThrow(/mismatch/);
    expect(() => verifyStripeEvent(body, signStripePayload(body, SECRET, new Date(now.getTime() - 600_000)), SECRET, now)).toThrow(/tolerance/);
    expect(() => verifyStripeEvent(body, null, SECRET, now)).toThrow(/missing/);
    expect(() => verifyStripeEvent(body, "garbage", SECRET, now)).toThrow(/malformed/);
  });
  it("accepts any one of several signatures (key rotation)", () => {
    const good = signStripePayload(body, SECRET, now);
    const header = good.replace("v1=", "v1=deadbeef,v1=");
    expect(verifyStripeEvent(body, header, SECRET, now).id).toBe("evt_1");
  });
});

describe("card payment links", () => {
  it("asks Stripe for the balance only, with identifiers and no patient details", async () => {
    const s = await platformSetup();
    const st = await fakeStripe();
    const p = await withCards(s, st.base);
    const id = await invoice(s, p);
    await p.billing.recordPayment(s.owner, id, { amountPence: 1000, method: "cash" });
    const link = await p.billing.createCardLink(s.owner, id, "https://clinic.test");
    expect(link).toEqual({ url: "https://checkout.stripe.test/c/pay/cs_test_1", amountPence: 5000 });
    const call = st.seen[0];
    expect(call.path).toBe("/v1/checkout/sessions");
    expect(call.auth).toBe("Bearer sk_test_x");
    expect(call.form.get("line_items[0][price_data][unit_amount]")).toBe("5000");
    expect(call.form.get("line_items[0][price_data][currency]")).toBe("gbp");
    expect(call.form.get("metadata[invoice_id]")).toBe(id);
    expect(call.form.get("metadata[clinic_id]")).toBe(s.clinicId);
    expect(call.form.get("success_url")).toBe("https://clinic.test/pay/thanks");
    const all = call.form.toString();
    for (const secret of ["Pat", "Jones", "pat%40example.com", "07700", "1980"]) expect(all).not.toContain(secret);
    expect(call.idem).toContain(id);
    // Nothing is recorded just because a link was made.
    expect((await p.billing.getInvoice(s.clinicId, id)).paidPence).toBe(1000);
  });

  it("is owner and reception only, and refuses cancelled, paid, insurer, tiny and card-less cases", async () => {
    const s = await platformSetup();
    const st = await fakeStripe();
    const p = await withCards(s, st.base);
    const id = await invoice(s, p);
    const clin: SessionUser = { id: s.secondId, clinicId: s.clinicId, name: "Sam", email: "sam@example.com", role: "clinician" };
    await expect(p.billing.createCardLink(clin, id, "https://x")).rejects.toThrow(/owner and reception/);
    const tiny = await invoice(s, p, 20);
    await expect(p.billing.createCardLink(s.owner, tiny, "https://x")).rejects.toThrow(/£0.30/);
    const insurer = await p.billing.createInvoice(s.owner, { patientId: s.patient, payerType: "insurer", payerName: "Bupa", lines: [{ description: "x", quantity: 1, unitPence: 5000 }] });
    await expect(p.billing.createCardLink(s.owner, insurer, "https://x")).rejects.toThrow(/insurer/);
    const paid = await invoice(s, p);
    await p.billing.recordPayment(s.owner, paid, { amountPence: 6000, method: "cash" });
    await expect(p.billing.createCardLink(s.owner, paid, "https://x")).rejects.toThrow(/Nothing is owed/);
    const cancelled = await invoice(s, p);
    await p.billing.creditInvoice(s.owner, cancelled, "Wrong patient");
    await expect(p.billing.createCardLink(s.owner, cancelled, "https://x")).rejects.toThrow(/cancelled/);
    expect(st.seen).toHaveLength(0);
    const without = createPlatform(s.db, { now: () => s.clock.now, card: null });
    await expect(without.billing.createCardLink(s.owner, id, "https://x")).rejects.toThrow(/not switched on/);
    expect(without.billing.cardPaymentsEnabled).toBe(false);
  });

  it("fails cleanly when Stripe refuses or cannot be reached, without leaking the reply", async () => {
    const s = await platformSetup();
    const st = await fakeStripe({ status: 401, body: { error: { message: "Invalid API Key provided: sk_test_x for pat@example.com" } } });
    const p = await withCards(s, st.base);
    const id = await invoice(s, p);
    const err = await p.billing.createCardLink(s.owner, id, "https://x").catch((e) => e as Error);
    expect(String(err)).toBe("Error: Stripe 401");
    const down = await withCards(s, "http://127.0.0.1:1");
    await expect(down.billing.createCardLink(s.owner, id, "https://x")).rejects.toThrow("Stripe: could not be reached");
  });
});

describe("recording a card payment from Stripe", () => {
  it("records it once, as a card payment, and a repeat changes nothing", async () => {
    const s = await platformSetup();
    const p = await withCards(s, "http://127.0.0.1:1");
    const id = await invoice(s, p);
    const out = await handleStripeEvent(p.billing, paidEvent(s, id));
    expect(out.body).toEqual({ received: true, result: "recorded" });
    const inv = await p.billing.getInvoice(s.clinicId, id);
    expect(inv.paidPence).toBe(6000);
    expect(inv.status).toBe("paid");
    expect(inv.payments[0]).toMatchObject({ method: "card", amountPence: 6000, recordedBy: "stripe" });
    expect((await handleStripeEvent(p.billing, paidEvent(s, id, {}, "evt_2"))).body).toEqual({ received: true, result: "duplicate" });
    expect((await p.billing.getInvoice(s.clinicId, id)).payments).toHaveLength(1);
    // Two paths to the same payment (completed, then async success) still count once.
    expect((await handleStripeEvent(p.billing, paidEvent(s, id, {}, "evt_3", "checkout.session.async_payment_succeeded"))).body).toEqual({ received: true, result: "duplicate" });
  });

  it("applies two part-payments from different Stripe payments, and can be reversed like any other payment", async () => {
    const s = await platformSetup();
    const p = await withCards(s, "http://127.0.0.1:1");
    const id = await invoice(s, p);
    await handleStripeEvent(p.billing, paidEvent(s, id, { amount_total: 2000, payment_intent: "pi_a" }));
    await handleStripeEvent(p.billing, paidEvent(s, id, { amount_total: 4000, payment_intent: "pi_b" }, "evt_b"));
    const inv = await p.billing.getInvoice(s.clinicId, id);
    expect(inv.paidPence).toBe(6000);
    await p.billing.reversePayment(s.owner, inv.payments.find((x) => x.amountPence === 2000)!.id, "Refunded in the Stripe dashboard");
    expect((await p.billing.getInvoice(s.clinicId, id)).paidPence).toBe(4000);
  });

  it("does not record money it cannot apply, and writes it to the audit log instead", async () => {
    const s = await platformSetup();
    const p = await withCards(s, "http://127.0.0.1:1");
    const id = await invoice(s, p);
    await p.billing.recordPayment(s.owner, id, { amountPence: 5000, method: "cash" });
    const over = await handleStripeEvent(p.billing, paidEvent(s, id, { amount_total: 6000, payment_intent: "pi_over" }));
    expect(over.body).toEqual({ received: true, result: "unapplied" });
    const cancelled = await invoice(s, p);
    await p.billing.creditInvoice(s.owner, cancelled, "Mistake");
    expect((await handleStripeEvent(p.billing, paidEvent(s, cancelled, { payment_intent: "pi_c" }, "evt_c"))).body).toEqual({ received: true, result: "unapplied" });
    expect((await handleStripeEvent(p.billing, paidEvent(s, "no-such-invoice", { payment_intent: "pi_d" }, "evt_d"))).body).toEqual({ received: true, result: "unapplied" });
    expect((await p.billing.getInvoice(s.clinicId, id)).paidPence).toBe(5000);
    const log = await s.q.all<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'payment.unapplied' ORDER BY at");
    expect(log).toHaveLength(3);
    expect(JSON.parse(log[0].detail)).toMatchObject({ invoiceId: id, amountPence: 6000, reason: "more than the balance owed" });
  });

  it("ignores events that are not paid, not ours, not in pounds, or not payments", async () => {
    const s = await platformSetup();
    const p = await withCards(s, "http://127.0.0.1:1");
    const id = await invoice(s, p);
    expect((await handleStripeEvent(p.billing, paidEvent(s, id, { payment_status: "unpaid" }))).body).toEqual({ received: true, pending: true });
    expect((await handleStripeEvent(p.billing, paidEvent(s, id, { metadata: {} }))).body).toMatchObject({ ignored: "not one of ours" });
    expect((await handleStripeEvent(p.billing, paidEvent(s, id, { currency: "usd" }))).body).toMatchObject({ ignored: "not one of ours" });
    expect((await handleStripeEvent(p.billing, { id: "e", type: "charge.refunded", data: { object: {} } })).body).toMatchObject({ ignored: "charge.refunded" });
    expect((await p.billing.getInvoice(s.clinicId, id)).paidPence).toBe(0);
  });

  it("will not let a notification name another clinic's invoice", async () => {
    const s = await platformSetup();
    const p = await withCards(s, "http://127.0.0.1:1");
    const id = await invoice(s, p);
    await s.q.run("INSERT INTO clinics (id, name, slug, created_at) VALUES ('clinic-z', 'Other', 'other', '2026-10-12T00:00:00.000Z')");
    const out = await handleStripeEvent(p.billing, paidEvent(s, id, { metadata: { invoice_id: id, clinic_id: "clinic-z" } }));
    expect(out.body).toEqual({ received: true, result: "unapplied" });
    expect((await p.billing.getInvoice(s.clinicId, id)).paidPence).toBe(0);
  });
});
