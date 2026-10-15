import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import type { SessionUser } from "@/lib/accounts";
import { getPlatform, withClinic } from "@/lib/app";
import { DomainError } from "@/lib/errors";
import { formatPence } from "@/lib/money";
import { formatLocal } from "@/lib/tz";
import { addWaitlistAction, mergePatientsAction, updatePatientAction } from "../../actions/staff";
import { ActionForm } from "../../Forms";
import { Header } from "../../Header";
import { PatientFields } from "../PatientFields";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ mq?: string }> };

export default async function PatientPage(props: Props) {
  const user = await requireUser();
  return withClinic(user.clinicId, () => PatientPageBody(props, user));
}

async function PatientPageBody({ params, searchParams }: Props, user: SessionUser) {
  const { id } = await params;
  const { mq = "" } = await searchParams;
  const p = getPlatform();
  let patient;
  try {
    patient = await p.scheduling.viewPatient(user.clinicId, user.email, id);
  } catch (err) {
    if (err instanceof DomainError && err.code === "not_found") notFound();
    throw err;
  }
  if (patient.mergedInto) {
    return (
      <>
        <Header user={user} />
        <main><h1>{patient.firstName} {patient.lastName}</h1><div className="banner warn">This record was merged into another. <Link href={`/patients/${patient.mergedInto}`}>Open the current record</Link>.</div></main>
      </>
    );
  }
  const tz = (await p.scheduling.clinic(user.clinicId)).timezone;
  const now = p.now();
  const appts = await p.scheduling.listAppointments(user.clinicId, {
    patientId: id, includeCancelled: true,
    fromUtc: new Date(now.getTime() - 3 * 365 * 86_400_000).toISOString(), toUtc: new Date(now.getTime() + 365 * 86_400_000).toISOString(),
  });
  const upcoming = appts.filter((a) => new Date(a.endAt) > now && (a.status === "booked" || a.status === "arrived"));
  const past = appts.filter((a) => !upcoming.includes(a)).reverse();
  const consults = await p.scheduling.consultsForPatient(user.clinicId, id);
  const types = await p.scheduling.listTypes(user.clinicId, { onlyActive: true });
  const clinicians = await p.scheduling.clinicians(user.clinicId);
  const onList = (await p.waitlist.list(user.clinicId)).filter((w) => w.patientId === id);
  const mergeCandidates = mq ? (await p.scheduling.searchPatients(user.clinicId, mq, 10)).filter((c) => c.id !== id) : [];
  const dupes = await p.scheduling.findDuplicates(user.clinicId, patient, id);
  const canBill = user.role !== "clinician";
  const invoices = canBill ? await p.billing.listInvoices(user.clinicId, { patientId: id, limit: 50 }) : [];
  const owed = canBill ? await p.billing.patientBalance(user.clinicId, id) : 0;
  const defaultFrom = now.toISOString().slice(0, 10);
  const defaultTo = new Date(now.getTime() + 28 * 86_400_000).toISOString().slice(0, 10);

  return (
    <>
      <Header user={user} />
      <main>
        <p className="muted"><Link href="/patients">← All patients</Link></p>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h1 style={{ margin: 0 }}>{patient.firstName} {patient.lastName}</h1>
          <Link className="btn primary" href={`/appointments/new?patient=${id}`}>Book appointment</Link>
        </div>
        {dupes.length ? (
          <div className="banner warn" style={{ marginTop: 12 }}>
            Possible duplicate: {dupes.map((d, i) => <span key={d.id}>{i ? ", " : ""}<Link href={`/patients/${d.id}`}>{d.firstName} {d.lastName}</Link></span>)}. You can merge below.
          </div>
        ) : null}

        {canBill ? (
          <section className="card" aria-labelledby="bills">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 id="bills" style={{ margin: 0 }}>Billing</h2>
              <Link className="btn" href={`/billing/new?patient=${id}`}>New invoice</Link>
            </div>
            <p>{owed > 0 ? <><strong>{formatPence(owed)}</strong> owed</> : <span className="muted">Nothing owed.</span>}</p>
            {invoices.length ? (
              <ul className="plain">
                {invoices.map((i) => (
                  <li key={i.id} className="row" style={{ justifyContent: "space-between" }}>
                    <span><Link href={`/billing/${i.id}`}>{i.number}</Link> · {formatLocal(i.issuedAt, tz, "date")}</span>
                    <span>{formatPence(i.totalPence)} <span className="muted">· {i.status.replace("_", " ")}</span></span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        <section className="card" aria-labelledby="appts">
          <h2 id="appts">Appointments</h2>
          {upcoming.length === 0 && past.length === 0 ? <p className="muted">No appointments yet.</p> : null}
          {[...upcoming, ...past].length ? (
            <div className="tablewrap" tabIndex={0} role="region" aria-label="Scrollable table">
              <table>
                <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col">With</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  {[...upcoming, ...past].map((a) => (
                    <tr key={a.id}>
                      <td><Link href={`/appointments/${a.id}`}>{formatLocal(a.startAt, tz)}</Link></td>
                      <td>{a.typeName}</td>
                      <td>{a.clinicianName}</td>
                      <td><span className={`pill ${a.status}`}>{a.status === "no_show" ? "did not attend" : a.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        {user.role !== "reception" ? (
          <section className="card" aria-labelledby="cons">
            <h2 id="cons">Consultations</h2>
            {consults.length === 0 ? <p className="muted">None yet. Open an appointment and choose “Start consultation”.</p> : (
              <ul className="plain">{consults.map((c) => <li key={c.id}><Link href={`/consults/${c.id}`}>{formatLocal(c.updated_at, tz)}</Link> <span className={`pill ${c.status}`}>{c.status}</span></li>)}</ul>
            )}
          </section>
        ) : null}

        <section className="card" aria-labelledby="det">
          <h2 id="det">Details</h2>
          <ActionForm action={updatePatientAction} hidden={{ id }} submitLabel="Save details">
            <PatientFields p={patient} />
          </ActionForm>
        </section>

        <section className="card" aria-labelledby="wl">
          <h2 id="wl">Waiting list</h2>
          {onList.length ? (
            <ul className="plain">{onList.map((w) => <li key={w.id}>{w.typeName}, {w.earliestDate} to {w.latestDate}{w.clinicianName ? `, with ${w.clinicianName}` : ""} <span className={`pill ${w.status}`}>{w.status}</span></li>)}</ul>
          ) : <p className="muted">Not on the waiting list. Add them to be offered an earlier time if one is freed.</p>}
          <ActionForm action={addWaitlistAction} hidden={{ patientId: id }} submitLabel="Add to waiting list" submitClass="">
            <div className="grid2">
              <div>
                <label htmlFor="wtype">Appointment</label>
                <select id="wtype" name="typeId">{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
              </div>
              <div>
                <label htmlFor="wuser">Clinician</label>
                <select id="wuser" name="userId"><option value="">Anyone</option>{clinicians.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
              </div>
              <div>
                <label htmlFor="we">Earliest date</label>
                <input id="we" name="earliestDate" type="date" defaultValue={defaultFrom} required />
              </div>
              <div>
                <label htmlFor="wl2">Latest date</label>
                <input id="wl2" name="latestDate" type="date" defaultValue={defaultTo} required />
              </div>
            </div>
            <fieldset className="inline">
              <legend>Days that suit</legend>
              {WEEKDAYS.map((d, i) => <label key={d}><input type="checkbox" name="weekdays" value={i + 1} defaultChecked /> {d}</label>)}
            </fieldset>
          </ActionForm>
        </section>

        {user.role !== "reception" ? (
          <section className="card" aria-labelledby="merge">
            <h2 id="merge">Merge a duplicate into this record</h2>
            <p className="muted">Appointments, forms and consultations of the duplicate move here, and the duplicate is closed. This cannot be undone.</p>
            <form method="get" className="toolbar" role="search">
              <div>
                <label htmlFor="mq">Find the duplicate</label>
                <input id="mq" name="mq" defaultValue={mq} autoComplete="off" />
              </div>
              <button type="submit">Search</button>
            </form>
            {mq && mergeCandidates.length === 0 ? <p className="muted">Nobody else matches that search.</p> : null}
            {mergeCandidates.map((c) => (
              <div className="sub" key={c.id}>
                <strong>{c.firstName} {c.lastName}</strong> <span className="muted">{c.dob ?? "no date of birth"} · {c.email ?? "no email"}</span>
                <ActionForm action={mergePatientsAction} hidden={{ keepId: id, removeId: c.id }} submitLabel={`Merge ${c.firstName} ${c.lastName} into ${patient.firstName} ${patient.lastName}`} submitClass="danger">
                  <label className="inline"><input type="checkbox" name="confirm" value="yes" /> I understand this cannot be undone</label>
                </ActionForm>
              </div>
            ))}
          </section>
        ) : null}
      </main>
    </>
  );
}
