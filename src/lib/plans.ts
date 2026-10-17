import type { Db } from "./db";
import type { SessionUser } from "./accounts";
import { DomainError } from "./errors";
import type { SubscriptionProvider } from "./payments/stripe";

export type PlanStatus = "trial" | "active" | "past_due" | "cancelled" | "complimentary";

/** After a renewal is missed the clinic keeps working this long, so a card hiccup does not lock the diary mid-week. */
export const GRACE_DAYS = 3;
export const DEFAULT_TRIAL_DAYS = 7;
const DAY = 86_400_000;

export interface PlanRow {
  status: PlanStatus;
  trial_ends_at: string | null;
  paid_until: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}

export interface PlanInfo {
  status: PlanStatus;
  /** full: everything works. read_only: records can be viewed and exported, nothing can be added or changed. */
  access: "full" | "read_only";
  reason: "trial" | "trial_ended" | "subscribed" | "renewal_due" | "payment_lapsed" | "cancelled" | "complimentary";
  trialEndsAt: string | null;
  paidUntil: string | null;
  /** Whole days left in the trial, rounded up (so "1" on the last day). Null outside a trial. */
  trialDaysLeft: number | null;
  hasSubscription: boolean;
}

/** Number of trial days for new clinics: TRIAL_DAYS, else seven. */
export function trialDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRIAL_DAYS?.trim();
  if (!raw) return DEFAULT_TRIAL_DAYS;
  const n = Number(raw);
  return /^\d+$/.test(raw) && n <= 90 ? n : DEFAULT_TRIAL_DAYS;
}

/** Whether anyone may open a clinic of their own. Off unless SIGNUP_OPEN=1, so a deployment opens the door on purpose. */
export function signupOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SIGNUP_OPEN?.trim() === "1";
}

/** The plan's price for display, in whole pence, or null when not set. The real charge is the Stripe price. */
export function planPricePence(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.PLAN_PRICE_PENCE?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return /^\d+$/.test(raw) && n > 0 ? n : null;
}

/** What a clinic may do right now. A clinic with no plan record (nothing creates one) is treated as fully open. */
export function evaluatePlan(row: PlanRow | undefined, now: Date): PlanInfo {
  if (!row || row.status === "complimentary") {
    return { status: "complimentary", access: "full", reason: "complimentary", trialEndsAt: null, paidUntil: null, trialDaysLeft: null, hasSubscription: false };
  }
  const t = now.getTime();
  const base = { status: row.status, trialEndsAt: row.trial_ends_at, paidUntil: row.paid_until, hasSubscription: !!row.stripe_subscription_id };
  if (row.status === "trial") {
    const end = row.trial_ends_at ? new Date(row.trial_ends_at).getTime() : 0;
    if (t < end) return { ...base, access: "full", reason: "trial", trialDaysLeft: Math.max(1, Math.ceil((end - t) / DAY)) };
    return { ...base, access: "read_only", reason: "trial_ended", trialDaysLeft: null };
  }
  const paid = row.paid_until ? new Date(row.paid_until).getTime() : 0;
  if (t <= paid) return { ...base, access: "full", reason: row.status === "cancelled" ? "cancelled" : "subscribed", trialDaysLeft: null };
  if (t <= paid + GRACE_DAYS * DAY && row.status !== "cancelled") return { ...base, access: "full", reason: "renewal_due", trialDaysLeft: null };
  return { ...base, access: "read_only", reason: row.status === "cancelled" ? "cancelled" : "payment_lapsed", trialDaysLeft: null };
}

export const LOCKED_MESSAGE = "This clinic's plan has ended, so records can be viewed and exported but not changed. The owner can choose a plan in Settings → Plan.";

/** Trial, subscription and what a clinic may do. */
export class Plans {
  private sub: SubscriptionProvider | null = null;

  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  setProvider(p: SubscriptionProvider | null) {
    this.sub = p;
  }

  /** True when a subscription can be started or managed online. */
  get canSubscribe(): boolean {
    return !!this.sub && !!this.priceId;
  }

  private get priceId(): string {
    return process.env.STRIPE_PRICE_ID?.trim() ?? "";
  }

  private ts() {
    return this.now().toISOString();
  }

  private async row(clinicId: string): Promise<PlanRow | undefined> {
    return this.db.get<PlanRow>("SELECT status, trial_ends_at, paid_until, stripe_customer_id, stripe_subscription_id FROM clinic_plans WHERE clinic_id = ?", [clinicId]);
  }

  async get(clinicId: string): Promise<PlanInfo> {
    return evaluatePlan(await this.db.scope(clinicId, () => this.row(clinicId)), this.now());
  }

  /** True when the clinic can add and change things. */
  async isOpen(clinicId: string): Promise<boolean> {
    return (await this.get(clinicId)).access === "full";
  }

  private owner(actor: SessionUser) {
    if (actor.role !== "owner") throw new DomainError("forbidden", "Only the clinic owner can manage the plan");
  }

  private audit(clinicId: string, by: string, action: string, detail?: unknown) {
    return this.db.run("INSERT INTO audit_log (clinic_id, actor, action, detail, at, entity) VALUES (?, ?, ?, ?, ?, 'plan')", [
      clinicId, by, action, detail === undefined ? null : JSON.stringify(detail), this.ts(),
    ]);
  }

  /** Returns the payment page to send the owner to. The clinic only becomes paid when the provider says so. */
  async startSubscription(actor: SessionUser, baseUrl: string): Promise<{ url: string }> {
    this.owner(actor);
    if (!this.sub || !this.priceId) throw new DomainError("invalid_state", "Paying for the plan online is not switched on yet");
    const current = await this.get(actor.clinicId);
    if (current.hasSubscription && current.status !== "cancelled" && current.access === "full" && current.reason !== "trial") {
      throw new DomainError("invalid_state", "This clinic already has a plan. Use Manage plan to change it");
    }
    const row = await this.db.scope(actor.clinicId, () => this.row(actor.clinicId));
    // The network call happens outside any open transaction.
    const session = await this.sub.createSubscriptionCheckout({
      clinicId: actor.clinicId,
      priceId: this.priceId,
      customerId: row?.stripe_customer_id ?? null,
      successUrl: `${baseUrl}/settings/plan?subscribed=1`,
      cancelUrl: `${baseUrl}/settings/plan`,
      idempotencyKey: `plan:${actor.clinicId}:${Math.floor(this.now().getTime() / 600_000)}`,
    });
    await this.db.scope(actor.clinicId, () => this.audit(actor.clinicId, actor.email, "plan.checkout_started"));
    return { url: session.url };
  }

  /** The provider's own page for updating the card or cancelling. */
  async openPortal(actor: SessionUser, baseUrl: string): Promise<{ url: string }> {
    this.owner(actor);
    if (!this.sub) throw new DomainError("invalid_state", "Paying for the plan online is not switched on yet");
    const row = await this.db.scope(actor.clinicId, () => this.row(actor.clinicId));
    if (!row?.stripe_customer_id) throw new DomainError("invalid_state", "There is no subscription to manage yet");
    const s = await this.sub.createPortalSession({ customerId: row.stripe_customer_id, returnUrl: `${baseUrl}/settings/plan` });
    return { url: s.url };
  }

  // ---------------------------------------------------------------- reports from the payment provider
  // Each of these is safe to repeat and safe to receive out of order: a payment only ever moves paid_until forward.

  /** A subscription was set up. Gives two days' access at once, in case the first invoice is slow; that invoice then sets the exact date. */
  async subscriptionStarted(clinicId: string, p: { customerId: string | null; subscriptionId: string | null }): Promise<void> {
    const provisional = new Date(this.now().getTime() + 2 * DAY).toISOString();
    await this.db.scope(clinicId, async () => {
      await this.db.run(
        `UPDATE clinic_plans SET status = 'active', stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = COALESCE(?, stripe_subscription_id),
           paid_until = GREATEST(COALESCE(paid_until, ?::timestamptz), ?::timestamptz), updated_at = ? WHERE clinic_id = ?`,
        [p.customerId, p.subscriptionId, provisional, provisional, this.ts(), clinicId],
      );
      await this.audit(clinicId, "stripe", "plan.subscribed", { subscriptionId: p.subscriptionId });
    });
  }

  /** An invoice for the subscription was paid, covering the time up to periodEnd. */
  async renewed(clinicId: string, p: { periodEnd: Date; customerId?: string | null; subscriptionId?: string | null }): Promise<void> {
    await this.db.scope(clinicId, async () => {
      await this.db.run(
        `UPDATE clinic_plans SET status = 'active', paid_until = GREATEST(COALESCE(paid_until, ?::timestamptz), ?::timestamptz),
           stripe_customer_id = COALESCE(stripe_customer_id, ?), stripe_subscription_id = COALESCE(stripe_subscription_id, ?), updated_at = ? WHERE clinic_id = ?`,
        [p.periodEnd.toISOString(), p.periodEnd.toISOString(), p.customerId ?? null, p.subscriptionId ?? null, this.ts(), clinicId],
      );
      await this.audit(clinicId, "stripe", "plan.renewed", { until: p.periodEnd.toISOString() });
    });
  }

  /** A renewal payment failed. Access carries on through the paid period and a short grace. */
  async paymentFailed(clinicId: string): Promise<void> {
    await this.db.scope(clinicId, async () => {
      await this.db.run("UPDATE clinic_plans SET status = 'past_due', updated_at = ? WHERE clinic_id = ? AND status = 'active'", [this.ts(), clinicId]);
      await this.audit(clinicId, "stripe", "plan.payment_failed");
    });
  }

  /** The subscription ended. The clinic keeps access to the end of the period it paid for. */
  async cancelled(clinicId: string): Promise<void> {
    await this.db.scope(clinicId, async () => {
      await this.db.run("UPDATE clinic_plans SET status = 'cancelled', updated_at = ? WHERE clinic_id = ?", [this.ts(), clinicId]);
      await this.audit(clinicId, "stripe", "plan.cancelled");
    });
  }

  /** Which clinic a subscription belongs to, or null. */
  async clinicOfSubscription(subscriptionId: string): Promise<string | null> {
    return this.db.system(async () => (await this.db.get<{ c: string | null }>("SELECT clinic_of_subscription(?) AS c", [subscriptionId]))?.c ?? null);
  }
}
