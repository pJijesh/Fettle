import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import type { SessionUser } from "@/lib/accounts";
import { getPlatform, withClinic } from "@/lib/app";
import { DomainError } from "@/lib/errors";
import { makeLink } from "@/lib/links";
import { formatLocal, minutesToClock, utcToZoned } from "@/lib/tz";
import { arrivedAction, cancelAppointmentAction, completedAction, noShowAction, rescheduleAction, startConsultationAction } from "../../actions/staff";
import { formatPence } from "@/lib/money";
import { invoiceAppointmentAction } from "../../actions/billing";
import { ActionForm } from "../../Forms";
import { Header } from "../../Header";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export default async function AppointmentPage(props: Props) {
  const user = await requireUser();
  return withClinic(user.clinicId, () => AppointmentPageBody(props, user));
}

async function AppointmentPageBody({ params }: Props, user: SessionUser) {
  const { id } = await params;
  const p = getPlatform();
  let a;
  try {
    a = await p.scheduling.getAppointment(user.clinicId, id);
  } catch (err) {
    if (err instanceof DomainError && err.code === "not_found") notFound();
    throw err;
  }
  const clinic = await p.scheduling.clinic(user.clinicId);
  const tz = clinic.timezone;
  const patient = await p.scheduling.getPatient(user.clinicId, a.patientId);
  const forms = await p.forms.forAppointment(id);
  const clinicians = await p.scheduling.clinicians(user.clinicId);
  const start = utcToZoned(new Date(a.startAt), tz);
  const started = new Date(a.startAt) <= p.now();
  const open = a.status === "booked" || a.status === "arrived";
  const canBill = user.role !== "clinician" && (a.status === "arrived" || a.status === "completed");
  const invoice = canBill ? await p.billing.liveInvoiceForAppointment(user.clinicId, id) : null;
  const typePrice = canBill ? (await p.scheduling.getType(user.clinicId, a.typeId)).pricePence : 0;
  const canConsult = user.role !== "reception" && a.status !== "cancelled";

  return (
    <>
      <Header user={user} />
      <main style={{ maxWidth: 760 }}>
        <p className="muted"><Link href={`/calendar?date=${start.date}&view=day`}>← Calendar</Link></p>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h1 style={{ margin: 0 }}>{a.typeName}</h1>
          <span className={`pill ${a.status}`}>{a.status === "no_show" ? "did not attend" : a.status}</span>
        </div>
        <p>
          <strong>{formatLocal(a.startAt, tz)}</strong> to {formatLocal(a.endAt, tz, "time")} with {a.clinicianName}<br />
          <Link href={`/patients/${a.patientId}`}>{a.patientName}</Link>
          <span className="muted"> · {patient.phone ?? "no phone"} · {patient.email ?? "no email"}</span>
          {a.cancelReason ? <><br /><span className="muted">Cancelled: {a.cancelReason}</span></> : null}
        </p>

        <section className="card" aria-labelledby="forms">
          <h2 id="forms">Forms</h2>
          {forms.length === 0 ? <p className="muted">No forms for this appointment.</p> : (
            <ul className="plain">
              {forms.map((f) => (
                <li key={f.id} className="row" style={{ justifyContent: "space-between" }}>
                  <span>{f.formName}{f.mandatory ? "" : " (optional)"}</span>
                  {f.status === "completed" ? <span className="pill arrived">completed</span> : (
                    <span className="row"><span className="pill offered">waiting for patient</span> <Link href={`/form/${makeLink("form", f.id)}`}>Fill in on this device</Link></span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {a.status === "booked" || a.status === "arrived" || a.status === "completed" ? (
          <section className="card" aria-labelledby="actions">
            <h2 id="actions">Actions</h2>
            {a.status === "booked" ? (
              <ActionForm action={arrivedAction} hidden={{ id }} submitLabel="Mark as arrived">
                {a.formsPending > 0 ? (
                  <>
                    <div className="banner warn">Required forms are not finished. Ask the patient to complete them, or give a reason to continue anyway.</div>
                    <label htmlFor="override">Reason for continuing without the forms (optional)</label>
                    <input id="override" name="override" maxLength={200} />
                  </>
                ) : null}
              </ActionForm>
            ) : null}
            {a.status === "arrived" || (a.status === "booked" && started) ? (
              <div style={{ marginTop: 12 }}><ActionForm action={completedAction} hidden={{ id }} submitLabel="Mark as completed" submitClass="" /></div>
            ) : null}
            {canConsult ? (
              <div style={{ marginTop: 12 }}>
                <ActionForm action={startConsultationAction} hidden={{ id }} submitLabel={a.consultId ? "Open consultation" : "Start consultation"} submitClass="" />
              </div>
            ) : null}
            {a.status === "booked" && started ? (
              <div style={{ marginTop: 12 }}><ActionForm action={noShowAction} hidden={{ id }} submitLabel="Mark as did not attend" submitClass="danger" confirmText="Mark this patient as did not attend?" /></div>
            ) : null}
          </section>
        ) : null}

        {canBill ? (
          <section className="card" aria-labelledby="bill">
            <h2 id="bill">Invoice</h2>
            {invoice ? (
              <p>
                <Link href={`/billing/${invoice.id}`}>{invoice.number}</Link> · {formatPence(invoice.totalPence)} · {invoice.status.replace("_", " ")}
              </p>
            ) : (
              <ActionForm action={invoiceAppointmentAction} hidden={{ id }} submitLabel={typePrice > 0 ? `Create invoice for ${formatPence(typePrice)}` : "Create invoice"} submitClass="">
                {typePrice <= 0 ? <div className="banner warn">{a.typeName} has no price yet. Set one in Settings, or <Link href={`/billing/new?patient=${a.patientId}`}>write the invoice by hand</Link>.</div> : null}
                <fieldset>
                  <legend>Who pays</legend>
                  <label className="inline"><input type="radio" name="payerType" value="self" defaultChecked /> The patient</label>
                  <label className="inline"><input type="radio" name="payerType" value="insurer" /> An insurer</label>
                  <div className="grid2">
                    <div><label htmlFor="payerName">Insurer</label><input id="payerName" name="payerName" maxLength={120} /></div>
                    <div><label htmlFor="claimRef">Claim or policy reference</label><input id="claimRef" name="claimRef" maxLength={80} /></div>
                  </div>
                </fieldset>
              </ActionForm>
            )}
          </section>
        ) : null}

        {a.status === "booked" ? (
          <section className="card" aria-labelledby="move">
            <h2 id="move">Move</h2>
            <ActionForm action={rescheduleAction} hidden={{ id }} submitLabel="Move appointment" submitClass="">
              <div className="grid2">
                <div>
                  <label htmlFor="mdate">Date</label>
                  <input id="mdate" name="date" type="date" defaultValue={start.date} required />
                </div>
                <div>
                  <label htmlFor="mtime">Start time (24-hour)</label>
                  <input id="mtime" name="time" defaultValue={minutesToClock(start.minutes)} pattern="[0-9]{1,2}:[0-9]{2}" required />
                </div>
                <div>
                  <label htmlFor="muser">Clinician</label>
                  <select id="muser" name="userId" defaultValue={a.userId}>{clinicians.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                </div>
              </div>
              <p className="muted">The patient is emailed the new time.</p>
            </ActionForm>
          </section>
        ) : null}

        {open ? (
          <section className="card" aria-labelledby="cancel">
            <h2 id="cancel">Cancel</h2>
            <ActionForm action={cancelAppointmentAction} hidden={{ id }} submitLabel="Cancel appointment" submitClass="danger" confirmText="Cancel this appointment? The patient will be told.">
              <label htmlFor="reason">Reason</label>
              <input id="reason" name="reason" maxLength={200} required />
              <p className="muted">The patient is emailed, and the time is offered to people on the waiting list.</p>
            </ActionForm>
          </section>
        ) : null}
      </main>
    </>
  );
}
