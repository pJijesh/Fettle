import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getPlatform } from "@/lib/app";
import { formatLocal } from "@/lib/tz";
import { PORTAL_COOKIE } from "@/lib/action-util";
import { portalSignOutAction } from "../../../actions/public";
import { PublicShell } from "../../../PublicShell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your appointments", robots: { index: false, follow: false } };

export default async function PortalHome({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const p = getPlatform();
  const clinic = await p.scheduling.clinicBySlug(slug);
  if (!clinic) notFound();
  const session = await p.booking.portalSession((await cookies()).get(PORTAL_COOKIE)?.value);
  if (!session || session.clinicId !== clinic.id) redirect(`/portal/${slug}`);
  const home = await p.booking.portalHome(session);
  const tz = clinic.timezone;
  return (
    <PublicShell clinicName={clinic.name}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 style={{ margin: 0 }}>Hello {home.patient.firstName}</h1>
        <form action={portalSignOutAction}><input type="hidden" name="slug" value={slug} /><button type="submit">Sign out</button></form>
      </div>
      {home.pendingForms.length ? (
        <div className="card">
          <h2>Forms to fill in</h2>
          <ul className="plain">{home.pendingForms.map((f) => <li key={f.id}><Link href={`/form/${f.token}`}>{f.name}</Link></li>)}</ul>
        </div>
      ) : null}
      <div className="card">
        <h2>Upcoming appointments</h2>
        {home.upcoming.length === 0 ? <p className="muted">Nothing booked. <Link href={`/book/${slug}`}>Book an appointment</Link>.</p> : (
          <ul className="plain">{home.upcoming.map((a) => <li key={a.id}><Link href={`/manage/${a.manageToken}`}>{formatLocal(a.startAt, tz)}</Link> · {a.typeName} with {a.clinicianName}</li>)}</ul>
        )}
        {home.upcoming.length ? <p><Link href={`/book/${slug}`}>Book another</Link></p> : null}
      </div>
      {home.past.length ? (
        <div className="card">
          <h2>Past appointments</h2>
          <ul className="plain">{home.past.map((a) => <li key={a.id}>{formatLocal(a.startAt, tz)} · {a.typeName} <span className={`pill ${a.status}`}>{a.status === "no_show" ? "did not attend" : a.status}</span></li>)}</ul>
        </div>
      ) : null}
    </PublicShell>
  );
}
