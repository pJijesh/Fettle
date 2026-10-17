import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluatePlan, planPricePence, signupOpen, trialDays, type PlanRow } from "@/lib/plans";
import { handleStripeEvent } from "@/lib/payments/handler";
import { StripeSubscriptions, type StripeEvent, type SubscriptionProvider } from "@/lib/payments/stripe";
import { createPlatform } from "@/lib/platform";
import { DomainError } from "@/lib/errors";
import { platformSetup, PW } from "./platform.helpers";

const DAY = 86_400_000;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (closers.length) await closers.pop()!();
});

const row = (over: Partial<PlanRow> = {}): PlanRow => ({ status: "trial", trial_ends_at: "2026-10-19T10:00:00Z", paid_until: null, stripe_customer_id: null, stripe_subscription_id: null, ...over });

describe("what a plan allows", () => {
  const at = (iso: string) => new Date(iso);
  it("gives a trial full access until it ends, then read-only", () => {
    expect(evaluatePlan(row(), at("2026-10-12T10:00:00Z"))).toMatchObject({ access: "full", reason: "trial", trialDaysLeft: 7 });
    expect(evaluatePlan(row(), at("2026-10-18T22:00:00Z"))).toMatchObject({ access: "full", trialDaysLeft: 1 });
    expect(evaluatePlan(row(), at("2026-10-19T10:00:00Z"))).toMatchObject({ access: "read_only", reason: "trial_ended", trialDaysLeft: null });
  });
  it("keeps a paid clinic open to the end of the period, then through a short grace, then locks", () => {
    const paid = row({ status: "active", paid_until: "2026-11-01T00:00:00Z", stripe_subscription_id: "sub_1" });
    expect(evaluatePlan(paid, at("2026-10-31T00:00:00Z"))).toMatchObject({ access: "full", reason: "subscribed", hasSubscription: true });
    expect(evaluatePlan(paid, at("2026-11-03T00:00:00Z"))).toMatchObject({ access: "full", reason: "renewal_due" });
    expect(evaluatePlan(paid, at("2026-11-04T00:00:01Z"))).toMatchObject({ access: "read_only", reason: "payment_lapsed" });
  });
  it("lets a cancelled clinic use what it paid for and no grace after", () => {
    const c = row({ status: "cancelled", paid_until: "2026-11-01T00:00:00Z" });
    expect(evaluatePlan(c, at("2026-10-31T00:00:00Z"))).toMatchObject({ access: "full", reason: "cancelled" });
    expect(evaluatePlan(c, at("2026-11-01T00:00:01Z"))).toMatchObject({ access: "read_only", reason: "cancelled" });
  });
  it("treats complimentary clinics, and a clinic with no plan record, as open", () => {
    expect(evaluatePlan(row({ status: "complimentary", trial_ends_at: null }), at("2030-01-01T00:00:00Z")).access).toBe("full");
    expect(evaluatePlan(undefined, at("2030-01-01T00:00:00Z")).access).toBe("full");
  });
  it("reads its settings strictly", () => {
    expect(trialDays({} as NodeJS.ProcessEnv)).toBe(7);
    expect(trialDays({ TRIAL_DAYS: "14" } as unknown as NodeJS.ProcessEnv)).toBe(14);
    expect(trialDays({ TRIAL_DAYS: "-3" } as unknown as NodeJS.ProcessEnv)).toBe(7);
    expect(trialDays({ TRIAL_DAYS: "abc" } as unknown as NodeJS.ProcessEnv)).toBe(7);
    expect(planPricePence({ PLAN_PRICE_PENCE: "4900" } as unknown as NodeJS.ProcessEnv)).toBe(4900);
    expect(planPricePence({ PLAN_PRICE_PENCE: "49.00" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(signupOpen({} as NodeJS.ProcessEnv)).toBe(false);
    expect(signupOpen({ SIGNUP_OPEN: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("a new clinic's trial", () => {
  it("starts on a seven-day trial and runs out on time", async () => {
    const s = await platformSetup();
    expect(await s.p.plans.get(s.clinicId)).toMatchObject({ status: "trial", access: "full", trialDaysLeft: 7 });
    s.clock.now = new Date(s.clock.now.getTime() + 7 * DAY + 1000);
    expect(await s.p.plans.get(s.clinicId)).toMatchObject({ access: "read_only", reason: "trial_ended" });
    expect(await s.p.plans.isOpen(s.clinicId)).toBe(false);
  });

  it("registers a second clinic on the trial length asked for, with its own slug, and keeps the two apart", async () => {
    const s = await platformSetup();
    const a = await s.p.accounts.register({ clinicName: "Test Physio", ownerName: "Bea", email: "bea@example.com", password: PW, trialDays: 3 });
    const b = await s.p.accounts.register({ clinicName: "Test Physio", ownerName: "Cal", email: "cal@example.com", password: PW });
    const slugs = await s.t.q.all<{ slug: string }>("SELECT slug FROM clinics ORDER BY slug");
    expect(new Set(slugs.map((r) => r.slug)).size).toBe(3);
    expect(await s.p.plans.get(a.clinicId)).toMatchObject({ trialDaysLeft: 3 });
    expect(await s.p.plans.get(b.clinicId)).toMatchObject({ trialDaysLeft: 7 });
    // One clinic cannot see another's plan.
    const seen = await s.db.scope(a.clinicId, () => s.db.all("SELECT clinic_id FROM clinic_plans"));
    expect(seen).toHaveLength(1);
    const { token } = await s.p.accounts.login("bea@example.com", PW);
    expect((await s.p.accounts.getSession(token))?.user.clinicId).toBe(a.clinicId);
  });

  it("refuses an email that already has an account, and weak details", async () => {
    const s = await platformSetup();
    await expect(s.p.accounts.register({ clinicName: "Dup", ownerName: "Dee", email: "OLIVE@example.com", password: PW })).rejects.toThrow(/already an account/);
    await expect(s.p.accounts.register({ clinicName: "", ownerName: "Dee", email: "bad", password: "short" })).rejects.toThrow(/Check the details/);
    await expect(s.p.accounts.register({ clinicName: "Long", ownerName: "Dee", email: "dee@example.com", password: PW, trialDays: 500 })).rejects.toThrow();
  });

  it("does not let the application move the end of a trial", async () => {
    const s = await platformSetup();
    await expect(s.db.scope(s.clinicId, () => s.db.run("UPDATE clinic_plans SET trial_ends_at = now() + interval '5 years'"))).rejects.toThrow(/permission denied/);
    await expect(s.db.scope(s.clinicId, () => s.db.run("INSERT INTO clinic_plans (clinic_id, status, updated_at) VALUES ('x','active',now())"))).rejects.toThrow(/permission denied/);
  });

  it("leaves clinics that existed before plans open", async () => {
    const s = await platformSetup();
    await s.t.q.run("INSERT INTO clinics (id, name, slug, timezone, created_at) VALUES ('old','Old','old','Europe/London', now())");
    expect(await s.p.plans.get("old")).toMatchObject({ access: "full", reason: "complimentary" });
  });
});

function fakeProvider() {
  const calls: { kind: string; input: Record<string, unknown> }[] = [];
  const provider: SubscriptionProvider = {
    createSubscriptionCheckout: async (input) => (calls.push({ kind: "checkout", input }), { id: "cs_1", url: "https://checkout.stripe.test/plan" }),
    createPortalSession: async (input) => (calls.push({ kind: "portal", input }), { url: "https://billing.stripe.test/portal" }),
  };
  return { provider, calls };
}

describe("choosing a plan", () => {
  it("sends the owner to the payment page, and nobody else", async () => {
    vi.stubEnv("STRIPE_PRICE_ID", "price_123");
    const s = await platformSetup();
    const { provider, calls } = fakeProvider();
    s.p.plans.setProvider(provider);
    const r = await s.p.plans.startSubscription(s.owner, "https://clinic.test");
    expect(r.url).toBe("https://checkout.stripe.test/plan");
    expect(calls[0].input).toMatchObject({ clinicId: s.clinicId, priceId: "price_123", customerId: null, successUrl: "https://clinic.test/settings/plan?subscribed=1" });
    const clinician = { ...s.owner, role: "clinician" as const };
    await expect(s.p.plans.startSubscription(clinician, "https://clinic.test")).rejects.toThrow(/owner/);
    // Starting checkout does not itself make the clinic paid.
    expect(await s.p.plans.get(s.clinicId)).toMatchObject({ status: "trial" });
    const audit = await s.t.q.all<{ action: string }>("SELECT action FROM audit_log WHERE entity = 'plan'");
    expect(audit.map((a) => a.action)).toContain("plan.checkout_started");
  });

  it("says plainly when online payment is not switched on", async () => {
    const s = await platformSetup();
    s.p.plans.setProvider(null);
    expect(s.p.plans.canSubscribe).toBe(false);
    await expect(s.p.plans.startSubscription(s.owner, "https://clinic.test")).rejects.toBeInstanceOf(DomainError);
  });

  it("refuses a second subscription and offers the portal instead", async () => {
    vi.stubEnv("STRIPE_PRICE_ID", "price_123");
    const s = await platformSetup();
    const { provider, calls } = fakeProvider();
    s.p.plans.setProvider(provider);
    await expect(s.p.plans.openPortal(s.owner, "https://clinic.test")).rejects.toThrow(/no subscription/);
    await s.p.plans.subscriptionStarted(s.clinicId, { customerId: "cus_1", subscriptionId: "sub_1" });
    await expect(s.p.plans.startSubscription(s.owner, "https://clinic.test")).rejects.toThrow(/already has a plan/);
    expect((await s.p.plans.openPortal(s.owner, "https://clinic.test")).url).toBe("https://billing.stripe.test/portal");
    expect(calls.at(-1)?.input).toMatchObject({ customerId: "cus_1", returnUrl: "https://clinic.test/settings/plan" });
  });
});

const ev = (type: string, object: Record<string, unknown>, id = `evt_${Math.random()}`): StripeEvent => ({ id, type, data: { object } });

describe("what Stripe tells us", () => {
  it("makes a clinic paid when its subscription checkout completes, and sets the exact date from the first invoice", async () => {
    const s = await platformSetup();
    const plans = s.p.plans;
    const done = ev("checkout.session.completed", { mode: "subscription", payment_status: "paid", customer: "cus_1", subscription: "sub_1", metadata: { clinic_id: s.clinicId, kind: "plan" } });
    expect((await handleStripeEvent(s.p.billing, done, plans, s.clock.now)).body.plan).toBe("subscribed");
    expect(await plans.get(s.clinicId)).toMatchObject({ status: "active", access: "full", hasSubscription: true });
    expect(await plans.clinicOfSubscription("sub_1")).toBe(s.clinicId);

    const end = Math.floor((s.clock.now.getTime() + 30 * DAY) / 1000);
    const paid = ev("invoice.paid", { subscription: "sub_1", customer: "cus_1", lines: { data: [{ period: { start: end - 30 * 86400, end } }] } });
    expect((await handleStripeEvent(s.p.billing, paid, plans, s.clock.now)).body.plan).toBe("renewed");
    // The same event twice changes nothing; an older one cannot move the date back.
    await handleStripeEvent(s.p.billing, paid, plans, s.clock.now);
    const older = ev("invoice.paid", { subscription: "sub_1", lines: { data: [{ period: { end: end - 10 * 86400 } }] } });
    await handleStripeEvent(s.p.billing, older, plans, s.clock.now);
    const info = await plans.get(s.clinicId);
    expect(new Date(info.paidUntil!).getTime()).toBeGreaterThanOrEqual(end * 1000);
  });

  it("copes with the invoice arriving before the checkout, using the metadata it carries", async () => {
    const s = await platformSetup();
    const end = Math.floor((s.clock.now.getTime() + 30 * DAY) / 1000);
    const paid = ev("invoice.paid", { subscription: "sub_9", customer: "cus_9", subscription_details: { metadata: { clinic_id: s.clinicId, kind: "plan" } }, lines: { data: [{ period: { end } }] } });
    await handleStripeEvent(s.p.billing, paid, s.p.plans, s.clock.now);
    expect(await s.p.plans.get(s.clinicId)).toMatchObject({ status: "active", access: "full", hasSubscription: true });
  });

  it("lets a failed renewal run its grace, then locks; and a cancellation ends at the paid date", async () => {
    const s = await platformSetup();
    const plans = s.p.plans;
    const end = Math.floor((s.clock.now.getTime() + 30 * DAY) / 1000);
    await handleStripeEvent(s.p.billing, ev("checkout.session.completed", { mode: "subscription", customer: "cus_1", subscription: "sub_1", metadata: { clinic_id: s.clinicId, kind: "plan" } }), plans, s.clock.now);
    await handleStripeEvent(s.p.billing, ev("invoice.paid", { subscription: "sub_1", lines: { data: [{ period: { end } }] } }), plans, s.clock.now);
    await handleStripeEvent(s.p.billing, ev("invoice.payment_failed", { subscription: "sub_1" }), plans, s.clock.now);
    expect((await plans.get(s.clinicId)).status).toBe("past_due");
    s.clock.now = new Date(end * 1000 + 2 * DAY);
    expect(await plans.get(s.clinicId)).toMatchObject({ access: "full", reason: "renewal_due" });
    s.clock.now = new Date(end * 1000 + 4 * DAY);
    expect(await plans.get(s.clinicId)).toMatchObject({ access: "read_only", reason: "payment_lapsed" });

    // A fresh payment brings it back; cancelling then stops it at the end of that period.
    const end2 = end + 30 * 86400;
    await handleStripeEvent(s.p.billing, ev("invoice.paid", { subscription: "sub_1", lines: { data: [{ period: { end: end2 } }] } }), plans, s.clock.now);
    expect((await plans.get(s.clinicId)).access).toBe("full");
    await handleStripeEvent(s.p.billing, ev("customer.subscription.deleted", { object: "subscription", id: "sub_1", metadata: { clinic_id: s.clinicId, kind: "plan" } }), plans, s.clock.now);
    expect(await plans.get(s.clinicId)).toMatchObject({ status: "cancelled", access: "full", reason: "cancelled" });
    s.clock.now = new Date(end2 * 1000 + 1000);
    expect((await plans.get(s.clinicId)).access).toBe("read_only");
  });

  it("ignores other clinics' subscriptions, unknown events and patient payments", async () => {
    const s = await platformSetup();
    const plans = s.p.plans;
    const stray = await handleStripeEvent(s.p.billing, ev("invoice.paid", { subscription: "sub_unknown", lines: { data: [] } }), plans, s.clock.now);
    expect(stray.body.ignored).toBe("invoice.paid");
    const patientPay = ev("checkout.session.completed", { mode: "payment", payment_status: "paid", metadata: { invoice_id: "nope", clinic_id: s.clinicId }, amount_total: 1000, currency: "gbp" });
    const out = await handleStripeEvent(s.p.billing, patientPay, plans, s.clock.now);
    expect(out.body.result).toBe("unapplied");
    expect(await plans.get(s.clinicId)).toMatchObject({ status: "trial" });
    expect((await handleStripeEvent(s.p.billing, ev("charge.refunded", {}), plans, s.clock.now)).body.ignored).toBe("charge.refunded");
  });
});

describe("the Stripe requests", () => {
  it("asks for a subscription checkout carrying only the clinic id, and for a portal session", async () => {
    const seen: { path: string; auth: string; idem: string; form: URLSearchParams }[] = [];
    const server = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        seen.push({ path: req.url ?? "", auth: String(req.headers.authorization), idem: String(req.headers["idempotency-key"]), form: new URLSearchParams(b) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(req.url?.includes("portal") ? { url: "https://billing.stripe.test/p" } : { id: "cs_1", url: "https://checkout.stripe.test/c" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise((r) => server.close(() => r())));
    const sub = new StripeSubscriptions({ secretKey: "sk_test_x", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    const c = await sub.createSubscriptionCheckout({ clinicId: "clinic-1", priceId: "price_1", customerId: "cus_1", successUrl: "https://x/ok", cancelUrl: "https://x/no", idempotencyKey: "k1" });
    expect(c.url).toBe("https://checkout.stripe.test/c");
    const f = seen[0].form;
    expect(seen[0]).toMatchObject({ path: "/v1/checkout/sessions", auth: "Bearer sk_test_x", idem: "k1" });
    expect(f.get("mode")).toBe("subscription");
    expect(f.get("line_items[0][price]")).toBe("price_1");
    expect(f.get("customer")).toBe("cus_1");
    expect(f.get("subscription_data[metadata][clinic_id]")).toBe("clinic-1");
    expect(f.get("subscription_data[metadata][kind]")).toBe("plan");
    expect([...f.keys()].some((k) => /email|name/i.test(k))).toBe(false);
    const portal = await sub.createPortalSession({ customerId: "cus_1", returnUrl: "https://x/back" });
    expect(portal.url).toBe("https://billing.stripe.test/p");
    expect(seen[1].path).toBe("/v1/billing_portal/sessions");
  });
});

describe("platform wiring", () => {
  it("builds with no payment provider", async () => {
    const s = await platformSetup();
    const p = createPlatform(s.db, { now: () => s.clock.now, subscriptions: null });
    expect(p.plans.canSubscribe).toBe(false);
  });
});
