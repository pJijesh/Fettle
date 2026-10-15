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
  const items: NavItem[] = [
    { href: "/calendar", label: "Calendar" },
    { href: "/patients", label: "Patients" },
    { href: "/waitlist", label: "Waiting list" },
    ...(user.role !== "reception" ? [{ href: "/consults", label: "Consultations" }] : []),
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
