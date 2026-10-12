import type { Metadata } from "next";
import Link from "next/link";
import { getPlatform } from "@/lib/app";
import { DomainError } from "@/lib/errors";
import { addDays, formatLocal, utcToZoned } from "@/lib/tz";
import { patientCancelAction, patientRescheduleAction } from "../../actions/public";
import { ActionForm } from "../../Forms";
import { PublicShell } from "../../PublicShell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your appointment", robots: { index: false, follow: false } };

type SP = Promise<{ booked?: string; cancelled?: string; moved?: string; change?: string }>;

export default async function ManagePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: SP }) {
  const { token } = await params;
  const sp = await searchParams;
  const p = getPlatform();
  let view;
  try {
    view = p.booking.manage(token);
  } catch (err) {
    if (err instanceof DomainError) {
      return (
        <PublicShell clinicName="Appointment">
          <h1>This link is not valid</h1>
          <p>Please check the link in your confirmation email, or phone the clinic.</p>
        </PublicShell>
      );
    }
    throw err;
  }
  const { appointment: a, clinic } = view;
  const tz = clinic.timezone;
  let slots: { startAt: string }[] = [];
  if (sp.change && view.canChange) {
    const today = utcToZoned(p.now(), tz).date;
    slots = p.booking.rescheduleSlots(token, today, addDays(today, 20)).slice(0, 60);
  }
  const byDay = new Map<string, typeof slots>();
  for (const s of slots) {
    const d = utcToZoned(new Date(s.startAt), tz).date;
    byDay.set(d, [...(byDay.get(d) ?? []), s]);
  }
  const pendingForms = view.forms.filter((f) => f.status === "pending");
  return (
    <PublicShell clinicName={clinic.name}>
      {sp.booked ? <div className="banner good" role="status">You are booked. We have emailed you the details.</div> : null}
      {sp.moved ? <div className="banner good" role="status">Your appointment has been moved.</div> : null}
      {sp.cancelled || a.status === "cancelled" ? <div className="banner bad" role="status">This appointment is cancelled.</div> : null}
      <h1>Your appointment</h1>
      <div className="card">
        <p style={{ margin: 0 }}>
          <strong>{a.typeName}</strong><br />
          {formatLocal(a.startAt, tz)} to {formatLocal(a.endAt, tz, "time")}<br />
          with {a.clinicianName} at {clinic.name}
        </p>
      </div>
      {pendingForms.length ? (
        <div className="card">
          <h2>Before you come</h2>
          <ul className="plain">{pendingForms.map((f) => <li key={f.id}><Link href={`/form/${f.token}`}>{f.name}</Link>{f.mandatory ? "" : " (optional)"}</li>)}</ul>
        </div>
      ) : null}
      {a.status === "booked" ? (
        view.canChange ? (
          <div className="card">
            <h2>Need to change it?</h2>
            {sp.change ? (
              <>
                {byDay.size === 0 ? <p>No other times are free in the next three weeks. Please phone the clinic.</p> : null}
                {[...byDay.entries()].map(([day, list]) => (
                  <section key={day} aria-label={formatLocal(list[0].startAt, tz, "date")}>
                    <h3>{formatLocal(list[0].startAt, tz, "date")}</h3>
                    <div className="slotgrid">
                      {list.map((s) => (
                        <ActionForm key={s.startAt} action={patientRescheduleAction} hidden={{ token, startAt: s.startAt }} submitLabel={formatLocal(s.startAt, tz, "time")} submitClass="" />
                      ))}
                    </div>
                  </section>
                ))}
                <p><Link href={`/manage/${token}`}>Keep my current time</Link></p>
              </>
            ) : (
              <div className="row"><Link className="btn" href={`/manage/${token}?change=1`}>Choose a different time</Link></div>
            )}
            <h3>Cancel</h3>
            <ActionForm action={patientCancelAction} hidden={{ token }} submitLabel="Cancel my appointment" submitClass="danger" confirmText="Cancel this appointment?" />
          </div>
        ) : (
          <div className="banner warn">{view.cannotChangeReason}</div>
        )
      ) : null}
    </PublicShell>
  );
}
