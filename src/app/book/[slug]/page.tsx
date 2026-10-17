import Link from "next/link";
import { notFound } from "next/navigation";
import { getPlatform } from "@/lib/app";
import { addDays, formatLocal, isDate, utcToZoned } from "@/lib/tz";
import { bookAction } from "../../actions/public";
import { ActionForm } from "../../Forms";
import { PublicShell } from "../../PublicShell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Book an appointment" };

type SP = Promise<{ type?: string; user?: string; from?: string; slot?: string }>;

export default async function BookPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: SP }) {
  const { slug } = await params;
  const sp = await searchParams;
  const p = getPlatform();
  const info = await p.booking.publicInfo(slug);
  if (!info) notFound();
  const { clinic, types, clinicians } = info;
  const type = types.find((t) => t.id === sp.type);
  if (!(await p.plans.isOpen(clinic.id))) {
    return (
      <PublicShell clinicName={clinic.name}>
        <h1>Book an appointment</h1>
        <p>Online booking is not available at the moment. Please phone the clinic.</p>
      </PublicShell>
    );
  }

  if (!type) {
    return (
      <PublicShell clinicName={clinic.name}>
        <h1>Book an appointment</h1>
        {types.length === 0 ? <p>Online booking is not available at the moment. Please phone the clinic.</p> : (
          <>
            <p>What would you like to book?</p>
            <ul className="plain card">
              {types.map((t) => (
                <li key={t.id}><Link href={`/book/${slug}?type=${t.id}`}>{t.name}</Link> <span className="muted">· {t.durationMin} minutes</span></li>
              ))}
            </ul>
          </>
        )}
        <p className="muted">Already a patient? <Link href={`/portal/${slug}`}>Sign in to see or change your appointments</Link>.</p>
      </PublicShell>
    );
  }

  const today = utcToZoned(p.now(), clinic.timezone).date;
  const from = sp.from && isDate(sp.from) && sp.from >= today ? sp.from : today;
  const to = addDays(from, 6);
  const userId = sp.user && clinicians.some((c) => c.id === sp.user) ? sp.user : "";

  if (sp.slot) {
    const start = new Date(sp.slot);
    const valid = !Number.isNaN(start.getTime());
    return (
      <PublicShell clinicName={clinic.name}>
        <p className="muted"><Link href={`/book/${slug}?type=${type.id}${userId ? `&user=${userId}` : ""}&from=${from}`}>← Choose another time</Link></p>
        <h1>Your details</h1>
        <p><strong>{type.name}</strong> on <strong>{valid ? formatLocal(start.toISOString(), clinic.timezone) : "?"}</strong></p>
        <div className="card">
          <ActionForm action={bookAction} hidden={{ slug, typeId: type.id, userId, startAt: sp.slot }} submitLabel="Confirm booking">
            <div className="grid2">
              <div><label htmlFor="firstName">First name</label><input id="firstName" name="firstName" required maxLength={80} autoComplete="given-name" /></div>
              <div><label htmlFor="lastName">Last name</label><input id="lastName" name="lastName" required maxLength={80} autoComplete="family-name" /></div>
              <div><label htmlFor="dob">Date of birth</label><input id="dob" name="dob" type="date" required autoComplete="bday" /></div>
              <div><label htmlFor="email">Email (we send your confirmation here)</label><input id="email" name="email" type="email" required autoComplete="email" /></div>
              <div><label htmlFor="phone">Mobile (optional)</label><input id="phone" name="phone" type="tel" autoComplete="tel" /></div>
            </div>
            <label className="inline" style={{ marginTop: 12 }}><input type="checkbox" name="smsConsent" value="yes" /> Text me a reminder (needs a mobile number)</label>
            <p className="muted">We use these details to arrange and run your appointment and to keep your record. After you book you can fill in your health questions online.</p>
          </ActionForm>
        </div>
      </PublicShell>
    );
  }

  let slots: { startAt: string; userName: string }[] = [];
  try {
    slots = (await p.booking.availability(slug, { typeId: type.id, userId, fromDate: from, toDate: to })).slots;
  } catch {
    slots = [];
  }
  const byDay = new Map<string, typeof slots>();
  for (const s of slots) {
    const d = utcToZoned(new Date(s.startAt), clinic.timezone).date;
    byDay.set(d, [...(byDay.get(d) ?? []), s]);
  }
  const link = (over: Record<string, string>) => `/book/${slug}?${new URLSearchParams({ type: type.id, ...(userId ? { user: userId } : {}), from, ...over }).toString()}`;
  return (
    <PublicShell clinicName={clinic.name}>
      <p className="muted"><Link href={`/book/${slug}`}>← Change appointment type</Link></p>
      <h1>{type.name}</h1>
      <form method="get" className="toolbar">
        <input type="hidden" name="type" value={type.id} />
        <input type="hidden" name="from" value={from} />
        <div>
          <label htmlFor="user">With</label>
          <select id="user" name="user" defaultValue={userId}><option value="">Anyone available</option>{clinicians.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        </div>
        <button type="submit">Show times</button>
      </form>
      <div className="row" style={{ marginBottom: 12 }}>
        {from > today ? <Link className="btn" href={link({ from: addDays(from, -7) < today ? today : addDays(from, -7) })}>← Earlier</Link> : null}
        <Link className="btn" href={link({ from: addDays(from, 7) })}>Later →</Link>
      </div>
      {byDay.size === 0 ? <div className="card"><p>No times free in this week. Try later weeks, or another clinician.</p></div> : null}
      {[...byDay.entries()].map(([day, list]) => (
        <section className="card" key={day} aria-label={formatLocal(list[0].startAt, clinic.timezone, "date")}>
          <h2>{formatLocal(list[0].startAt, clinic.timezone, "date")}</h2>
          <div className="slotgrid">
            {list.map((s) => (
              <Link key={s.startAt} className="btn" href={link({ slot: s.startAt })} aria-label={`${formatLocal(s.startAt, clinic.timezone, "time")}${userId ? "" : ""}`}>{formatLocal(s.startAt, clinic.timezone, "time")}</Link>
            ))}
          </div>
        </section>
      ))}
    </PublicShell>
  );
}
