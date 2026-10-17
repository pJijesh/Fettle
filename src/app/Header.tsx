import Link from "next/link";
import { logoutAction } from "./actions/auth";
import { getPlatform, getService } from "@/lib/app";
import type { SessionUser } from "@/lib/accounts";
import { Nav, type NavItem } from "./Nav";

const ROLE: Record<SessionUser["role"], string> = { owner: "Owner", clinician: "Clinician", reception: "Reception" };

export async function Header({ user }: { user: SessionUser }) {
  const disciplines = (await getPlatform().scheduling.clinic(user.clinicId)).disciplines;
  const provider = getService(user.clinicId).providerInfo;
  const mailer = getPlatform().mailer;
  const plan = await getPlatform().plans.get(user.clinicId);
  const open = user.role !== "reception" ? await getPlatform().triage.countOpen(user.clinicId) : 0;
  const items: NavItem[] = [
    { href: "/calendar", label: "Calendar" },
    { href: "/patients", label: "Patients" },
    { href: "/waitlist", label: "Waiting list" },
    ...(user.role !== "reception" ? [{ href: "/consults", label: "Consultations" }] : []),
    ...(user.role !== "reception" ? [{ href: "/check-ins", label: open > 0 ? `Check-ins (${open})` : "Check-ins" }] : []),
    ...(user.role !== "reception" ? [{ href: "/reports", label: "Reports" }] : []),
    ...(user.role !== "clinician" ? [{ href: "/billing", label: "Billing" }] : []),
    { href: "/settings", label: "Settings" },
  ];
  return (
    <header className="top">
      {provider.isMock && user.role !== "reception" && disciplines !== "ayurveda" ? (
        <div className="banner warn flat">
          <strong>Demo drafting.</strong> No AI model is connected, so drafts come from a simple keyword matcher. They are not clinical output. Do not use with real patients.
        </div>
      ) : null}
      {!mailer.isReal ? (
        <div className="banner warn flat">
          <strong>Messages are not being sent.</strong> No email or text provider is connected. Confirmations, reminders and waiting-list offers are only listed in the{" "}
          {user.role === "owner" ? <Link href="/dev/outbox">outbox</Link> : "outbox"}.
        </div>
      ) : null}
      {plan.reason === "trial" ? (
        <div className="banner good flat" role="status">
          <strong>Free trial:</strong> {plan.trialDaysLeft} {plan.trialDaysLeft === 1 ? "day" : "days"} left.{" "}
          {user.role === "owner" ? <Link href="/settings/plan">See plans</Link> : "The clinic owner chooses a plan in Settings."}
        </div>
      ) : plan.access === "read_only" ? (
        <div className="banner bad flat" role="alert">
          <strong>Your plan has ended.</strong> You can look things up and export records, but nothing can be added or changed.{" "}
          {user.role === "owner" ? <Link href="/settings/plan">Choose a plan</Link> : "Ask the clinic owner to choose a plan."}
        </div>
      ) : plan.reason === "renewal_due" ? (
        <div className="banner warn flat" role="status">
          <strong>Renewal payment is late.</strong> {user.role === "owner" ? <Link href="/settings/plan">Update the payment</Link> : "Ask the clinic owner to update the payment."} Editing stops in a few days if it is not paid.
        </div>
      ) : null}
      <div className="in">
        <Link href="/calendar" className="brand">Fettle</Link>
        <Nav items={items} />
        <form action={logoutAction} className="row who">
          <span className="muted">{user.name} · {ROLE[user.role]}</span>
          <button type="submit">Sign out</button>
        </form>
      </div>
    </header>
  );
}
