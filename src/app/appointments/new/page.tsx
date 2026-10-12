import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getPlatform } from "@/lib/app";
import { DomainError } from "@/lib/errors";
import { minutesToClock, utcToZoned } from "@/lib/tz";
import { createAppointmentAction } from "../../actions/staff";
import { ActionForm } from "../../Forms";
import { Header } from "../../Header";

export const dynamic = "force-dynamic";

type SP = Promise<{ patient?: string; q?: string; date?: string; time?: string; user?: string; type?: string }>;

export default async function NewAppointment({ searchParams }: { searchParams: SP }) {
  const user = await requireUser();
  const sp = await searchParams;
  const p = getPlatform();
  const keep = new URLSearchParams(Object.entries({ date: sp.date, time: sp.time, user: sp.user, type: sp.type }).filter(([, v]) => v) as [string, string][]).toString();

  let patient = null;
  if (sp.patient) {
    try {
      patient = p.scheduling.getPatient(user.clinicId, sp.patient);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
    }
  }
  if (!patient) {
    const results = sp.q ? p.scheduling.searchPatients(user.clinicId, sp.q, 15) : [];
    return (
      <>
        <Header user={user} />
        <main style={{ maxWidth: 720 }}>
          <h1>New appointment</h1>
          <div className="card">
            <h2>Who is it for?</h2>
            <form method="get" className="toolbar" role="search">
              {Object.entries({ date: sp.date, time: sp.time, user: sp.user, type: sp.type }).map(([k, v]) => v ? <input key={k} type="hidden" name={k} value={v} /> : null)}
              <div>
                <label htmlFor="q">Search by name, email or phone</label>
                <input id="q" name="q" defaultValue={sp.q ?? ""} autoComplete="off" autoFocus style={{ minWidth: 260 }} />
              </div>
              <button type="submit">Search</button>
            </form>
            {sp.q && results.length === 0 ? <p className="muted">Nobody matches. <Link href="/patients/new">Create a new patient</Link>.</p> : null}
            <ul className="plain">
              {results.map((r) => (
                <li key={r.id}><Link href={`/appointments/new?patient=${r.id}${keep ? `&${keep}` : ""}`}>{r.lastName}, {r.firstName}</Link> <span className="muted">{r.dob ?? ""} {r.email ?? ""}</span></li>
              ))}
            </ul>
            {!sp.q ? <p className="muted">New to the clinic? <Link href="/patients/new">Create the patient first</Link>.</p> : null}
          </div>
        </main>
      </>
    );
  }

  const clinic = p.scheduling.clinic(user.clinicId);
  const types = p.scheduling.listTypes(user.clinicId, { onlyActive: true });
  const clinicians = p.scheduling.clinicians(user.clinicId);
  const nowZ = utcToZoned(p.now(), clinic.timezone);
  const defaultTime = sp.time ?? minutesToClock(Math.ceil((nowZ.minutes + 30) / 15) * 15 % 1440);
  const defaultUser = sp.user && clinicians.some((c) => c.id === sp.user) ? sp.user : clinicians.some((c) => c.id === user.id) ? user.id : clinicians[0]?.id;
  return (
    <>
      <Header user={user} />
      <main style={{ maxWidth: 640 }}>
        <p className="muted"><Link href="/calendar">← Calendar</Link></p>
        <h1>New appointment for {patient.firstName} {patient.lastName}</h1>
        <div className="card">
          <ActionForm action={createAppointmentAction} hidden={{ patientId: patient.id }} submitLabel="Book">
            <label htmlFor="typeId">Appointment type</label>
            <select id="typeId" name="typeId" defaultValue={sp.type}>{types.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.durationMin} min)</option>)}</select>
            <label htmlFor="userId">Clinician</label>
            <select id="userId" name="userId" defaultValue={defaultUser}>{clinicians.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            <div className="grid2">
              <div>
                <label htmlFor="date">Date</label>
                <input id="date" name="date" type="date" defaultValue={sp.date ?? nowZ.date} required />
              </div>
              <div>
                <label htmlFor="time">Start time (24-hour, clinic time)</label>
                <input id="time" name="time" defaultValue={defaultTime} pattern="[0-9]{1,2}:[0-9]{2}" required />
              </div>
            </div>
            <p className="muted">Times are in {clinic.timezone}. Staff can book outside working hours; the diary still refuses overlaps.</p>
          </ActionForm>
        </div>
      </main>
    </>
  );
}
