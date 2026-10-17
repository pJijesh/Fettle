import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getPlatform } from "@/lib/app";
import { formatPence } from "@/lib/money";
import { planPricePence, trialDays } from "@/lib/plans";
import { managePlanAction, subscribeAction } from "../../actions/plan";
import { Header } from "../../Header";

export const dynamic = "force-dynamic";
export const metadata = { title: "Plan" };

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
const day = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : "");

export default async function PlanPage({ searchParams }: { searchParams: Promise<{ locked?: string; error?: string; subscribed?: string }> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const p = getPlatform();
  const plan = await p.plans.get(user.clinicId);
  const price = planPricePence();
  const isOwner = user.role === "owner";
  const canPay = p.plans.canSubscribe;

  const status =
    plan.reason === "trial" ? `Free trial: ${plan.trialDaysLeft} ${plan.trialDaysLeft === 1 ? "day" : "days"} left (ends ${day(plan.trialEndsAt)})`
    : plan.reason === "trial_ended" ? `Your free trial ended on ${day(plan.trialEndsAt)}`
    : plan.reason === "subscribed" ? `Subscribed, paid up to ${day(plan.paidUntil)}`
    : plan.reason === "renewal_due" ? `Renewal payment is late (paid up to ${day(plan.paidUntil)})`
    : plan.reason === "payment_lapsed" ? `Payment lapsed on ${day(plan.paidUntil)}`
    : plan.reason === "cancelled" ? (plan.access === "full" ? `Subscription cancelled, access until ${day(plan.paidUntil)}` : `Subscription ended on ${day(plan.paidUntil)}`)
    : "Complimentary access";

  return (
    <>
      <Header user={user} />
      <main style={{ maxWidth: 720 }}>
        <p><Link href="/settings">← Settings</Link></p>
        <h1>Plan</h1>
        {sp.locked ? <div className="banner bad" role="alert">That change was not made. {plan.access === "read_only" ? "Your plan has ended, so records can be viewed and exported but not changed." : ""}</div> : null}
        {sp.error ? <div className="banner bad" role="alert">{sp.error}</div> : null}
        {sp.subscribed ? <div className="banner good" role="status">Thank you. Your payment is being confirmed; this page updates within a minute.</div> : null}

        <section className="card" aria-labelledby="now">
          <h2 id="now">Where you are</h2>
          <p><strong>{status}</strong></p>
          {plan.access === "read_only" ? (
            <p>You can still sign in, look up patients and appointments, and export a patient&apos;s record. Adding or changing anything, and online booking, is switched off until a plan is active. Nothing has been deleted.</p>
          ) : plan.reason === "trial" ? (
            <p>Everything works during the trial. When it ends you will be able to view and export your records but not add or change anything until you choose a plan.</p>
          ) : null}
        </section>

        <section className="card" aria-labelledby="plan">
          <h2 id="plan">The plan</h2>
          <p>
            One price for the whole clinic: every user, every patient, both physiotherapy and Ayurveda.{" "}
            {price ? <strong>{formatPence(price)} a month.</strong> : <span className="muted">The price has not been set yet.</span>}
          </p>
          <p className="muted">New clinics get a {trialDays()}-day free trial with no card needed. Cancel at any time; you keep access to the end of the period you paid for.</p>
          {!isOwner ? (
            <p className="muted">Only the clinic owner can choose or change the plan.</p>
          ) : !canPay ? (
            <p className="muted">Paying online is not switched on for this installation yet, so there is nothing to click here.</p>
          ) : plan.hasSubscription && plan.status !== "cancelled" ? (
            <form action={managePlanAction}><button type="submit" className="primary">Manage plan, card and invoices</button></form>
          ) : (
            <form action={subscribeAction}><button type="submit" className="primary">Choose the plan</button></form>
          )}
        </section>
      </main>
    </>
  );
}
