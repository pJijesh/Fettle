import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import type { SessionUser } from "@/lib/accounts";
import { getPlatform, withClinic } from "@/lib/app";
import { DomainError } from "@/lib/errors";
import { createInvoiceAction } from "../../actions/billing";
import { ActionForm } from "../../Forms";
import { Header } from "../../Header";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ patient?: string; q?: string }> };

export default async function NewInvoice(props: Props) {
  const user = await requireUser(["owner", "reception"]);
  const sp = await props.searchParams;
  return withClinic(user.clinicId, () => Body(user, sp));
}

async function Body(user: SessionUser, sp: { patient?: string; q?: string }) {
  const p = getPlatform();
  let patient = null;
  if (sp.patient) {
    try {
      patient = await p.scheduling.getPatient(user.clinicId, sp.patient);
    } catch (err) {
      if (err instanceof DomainError && err.code === "not_found") notFound();
      throw err;
    }
  }
  const matches = !patient && sp.q?.trim() ? await p.scheduling.searchPatients(user.clinicId, sp.q, 10) : [];
  const settings = await p.billing.getSettings(user.clinicId);
  return (
    <>
      <Header user={user} />
      <main style={{ maxWidth: 760 }}>
        <p className="muted"><Link href="/billing">← Billing</Link></p>
        <h1>New invoice</h1>
        {!patient ? (
          <section className="card" aria-labelledby="who">
            <h2 id="who">Who is it for?</h2>
            <form method="get" className="row" style={{ alignItems: "end" }}>
              <div><label htmlFor="q">Search patients</label><input id="q" name="q" defaultValue={sp.q ?? ""} autoFocus /></div>
              <button type="submit">Search</button>
            </form>
            {sp.q ? (matches.length === 0 ? <p className="muted">No one found.</p> : (
              <ul className="plain">{matches.map((m) => <li key={m.id}><Link href={`/billing/new?patient=${m.id}`}>{m.firstName} {m.lastName}</Link>{m.dob ? <span className="muted"> · born {m.dob}</span> : null}</li>)}</ul>
            )) : null}
          </section>
        ) : (
          <section className="card" aria-labelledby="lines">
            <h2 id="lines">{patient.firstName} {patient.lastName}</h2>
            <ActionForm action={createInvoiceAction} hidden={{ patientId: patient.id }} submitLabel="Issue invoice">
              <p className="muted">One line per item. Leave unused lines empty. Prices are before VAT{settings.vatRateBp ? ` (VAT is added at ${settings.vatRateBp / 100}%)` : ""}.</p>
              {[1, 2, 3, 4].map((n) => (
                <div key={n} className="grid2" style={{ gridTemplateColumns: "3fr 1fr 1fr" }}>
                  <div><label htmlFor={`desc${n}`}>Description{n === 1 ? "" : " (optional)"}</label><input id={`desc${n}`} name={`desc${n}`} maxLength={200} required={n === 1} /></div>
                  <div><label htmlFor={`qty${n}`}>Quantity</label><input id={`qty${n}`} name={`qty${n}`} type="number" min={1} max={1000} defaultValue={1} /></div>
                  <div><label htmlFor={`price${n}`}>Price each (£)</label><input id={`price${n}`} name={`price${n}`} inputMode="decimal" required={n === 1} /></div>
                </div>
              ))}
              <fieldset style={{ marginTop: 12 }}>
                <legend>Who pays</legend>
                <label className="inline"><input type="radio" name="payerType" value="self" defaultChecked /> The patient</label>
                <label className="inline"><input type="radio" name="payerType" value="insurer" /> An insurer</label>
                <div className="grid2">
                  <div><label htmlFor="payerName">Insurer (if an insurer pays)</label><input id="payerName" name="payerName" maxLength={120} /></div>
                  <div><label htmlFor="claimRef">Claim or policy reference</label><input id="claimRef" name="claimRef" maxLength={80} /></div>
                </div>
              </fieldset>
              <label htmlFor="note">Note on the invoice (optional)</label>
              <input id="note" name="note" maxLength={500} />
            </ActionForm>
          </section>
        )}
      </main>
    </>
  );
}
