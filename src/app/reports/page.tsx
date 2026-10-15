import { requireUser } from "@/lib/auth";
import type { SessionUser } from "@/lib/accounts";
import { getPlatform, withClinic } from "@/lib/app";
import { DomainError } from "@/lib/errors";
import { formatPence } from "@/lib/money";
import { Header } from "../Header";

export const dynamic = "force-dynamic";

const pct = (n: number | null) => (n === null ? "–" : `${(n * 100).toFixed(1)}%`);
const hours = (m: number) => `${(m / 60).toFixed(1)} h`;
const SOURCE: Record<string, string> = { staff: "Booked by staff", online: "Online booking", waitlist: "Waiting list", import: "Imported" };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const user = await requireUser(["owner", "clinician"]);
  const sp = await searchParams;
  return withClinic(user.clinicId, () => ReportsBody(user, sp));
}

async function ReportsBody(user: SessionUser, sp: { from?: string; to?: string }) {
  const reports = getPlatform().reports;
  const def = await reports.defaultRange(user.clinicId);
  const from = sp.from || def.from;
  const to = sp.to || def.to;
  let error: string | null = null;
  let r: Awaited<ReturnType<typeof reports.range>> | null = null;
  try {
    r = await reports.range(user.clinicId, from, to);
  } catch (err) {
    if (err instanceof DomainError) error = err.message;
    else throw err;
  }
  const money = r && user.role === "owner" ? await getPlatform().billing.summary(user.clinicId, from, to) : null;
  const METHOD: Record<string, string> = { cash: "Cash", card: "Card", bank_transfer: "Bank transfer", cheque: "Cheque", insurer: "Insurer", other: "Other" };
  return (
    <>
      <Header user={user} />
      <main>
        <h1>Reports</h1>
        <p className="muted">Counts for appointments starting in the range, in the clinic&apos;s time zone. No patients are named here.</p>
        <form method="get" className="card row" style={{ alignItems: "end", gap: 12 }}>
          <div><label htmlFor="from">From</label><input id="from" name="from" type="date" defaultValue={from} required /></div>
          <div><label htmlFor="to">To</label><input id="to" name="to" type="date" defaultValue={to} required /></div>
          <button type="submit" className="primary">Show</button>
        </form>
        {error ? <div className="banner bad" role="alert">{error}</div> : null}
        {r ? (
          <>
            <section className="card" aria-labelledby="summary">
              <h2 id="summary">Summary</h2>
              <dl className="stats">
                <div><dt>Appointments</dt><dd>{r.total}</dd></div>
                <div><dt>Seen</dt><dd>{r.seen}</dd></div>
                <div><dt>Still to come</dt><dd>{r.upcoming}</dd></div>
                <div><dt>Did not attend</dt><dd>{r.noShows} <span className="muted">({pct(r.noShowRate)} of those due)</span></dd></div>
                <div><dt>Cancelled</dt><dd>{r.cancelled} <span className="muted">({pct(r.cancellationRate)})</span></dd></div>
                <div><dt>New patients</dt><dd>{r.newPatients}</dd></div>
              </dl>
            </section>
            {money ? (
              <section className="card" aria-labelledby="money">
                <h2 id="money">Money</h2>
                <dl className="stats">
                  <div><dt>Invoiced</dt><dd>{formatPence(money.invoicedPence)} <span className="muted">({money.invoiceCount})</span></dd></div>
                  <div><dt>Credited</dt><dd>{formatPence(money.creditedPence)}</dd></div>
                  <div><dt>Collected</dt><dd>{formatPence(money.collectedPence)}</dd></div>
                  <div><dt>Owed now</dt><dd>{formatPence(money.outstandingPence)}</dd></div>
                  <div><dt>Overdue now</dt><dd>{formatPence(money.overduePence)}</dd></div>
                </dl>
                {money.byMethod.length ? <p className="muted">Collected by {money.byMethod.map((m) => `${METHOD[m.method].toLowerCase()} ${formatPence(m.pence)}`).join(", ")}. Invoiced and credited count by the date issued; collected counts by the date received. Owed and overdue are as of today, whatever the range.</p> : <p className="muted">Invoiced and credited count by the date issued; collected counts by the date received. Owed and overdue are as of today, whatever the range.</p>}
              </section>
            ) : null}
            <section className="card tablewrap" tabIndex={0} role="region" aria-label="Clinicians, scrollable table">
              <h2>By clinician</h2>
              {r.byClinician.length === 0 ? <p className="muted">No clinicians or appointments in this range.</p> : (
                <table>
                  <thead><tr><th scope="col">Clinician</th><th scope="col">Seen</th><th scope="col">Did not attend</th><th scope="col">Cancelled</th><th scope="col">Booked time</th><th scope="col">Working hours</th><th scope="col">Utilisation</th></tr></thead>
                  <tbody>
                    {r.byClinician.map((c) => (
                      <tr key={c.userId}><th scope="row">{c.name}</th><td>{c.seen}</td><td>{c.noShows}</td><td>{c.cancelled}</td><td>{hours(c.bookedMinutes)}</td><td>{hours(c.availableMinutes)}</td><td>{pct(c.utilisation)}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="muted">Utilisation is booked time (not cancelled, not missed) as a share of working hours in the range.</p>
            </section>
            <div className="grid2">
              <section className="card tablewrap" tabIndex={0} role="region" aria-label="Sources, scrollable table">
                <h2>Where bookings come from</h2>
                {r.bySource.length === 0 ? <p className="muted">None.</p> : (
                  <table><thead><tr><th scope="col">Source</th><th scope="col">Appointments</th></tr></thead>
                    <tbody>{r.bySource.map((s) => <tr key={s.source}><th scope="row">{SOURCE[s.source] ?? s.source}</th><td>{s.count}</td></tr>)}</tbody></table>
                )}
              </section>
              <section className="card tablewrap" tabIndex={0} role="region" aria-label="Appointment types, scrollable table">
                <h2>By appointment type</h2>
                {r.byType.length === 0 ? <p className="muted">None.</p> : (
                  <table><thead><tr><th scope="col">Type</th><th scope="col">Appointments</th></tr></thead>
                    <tbody>{r.byType.map((t) => <tr key={t.type}><th scope="row">{t.type}</th><td>{t.count}</td></tr>)}</tbody></table>
                )}
              </section>
            </div>
          </>
        ) : null}
      </main>
    </>
  );
}
