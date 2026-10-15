import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import type { SessionUser } from "@/lib/accounts";
import { getPlatform, withClinic } from "@/lib/app";
import { DomainError } from "@/lib/errors";
import { formatPence, poundsField } from "@/lib/money";
import { formatLocal, utcToZoned } from "@/lib/tz";
import { creditInvoiceAction, recordPaymentAction, reversePaymentAction } from "../../actions/billing";
import { ActionForm } from "../../Forms";
import { Header } from "../../Header";
import { PrintButton } from "../PrintButton";
import { STATUS_LABEL, STATUS_PILL } from "../status";

export const dynamic = "force-dynamic";

const METHOD: Record<string, string> = { cash: "Cash", card: "Card", bank_transfer: "Bank transfer", cheque: "Cheque", insurer: "Insurer", other: "Other" };

type Props = { params: Promise<{ id: string }> };

export default async function InvoicePage(props: Props) {
  const user = await requireUser(["owner", "reception"]);
  return withClinic(user.clinicId, () => Body(props, user));
}

async function Body({ params }: Props, user: SessionUser) {
  const { id } = await params;
  const p = getPlatform();
  let inv;
  try {
    inv = await p.billing.getInvoice(user.clinicId, id);
  } catch (err) {
    if (err instanceof DomainError && err.code === "not_found") notFound();
    throw err;
  }
  const clinic = await p.scheduling.clinic(user.clinicId);
  const settings = await p.billing.getSettings(user.clinicId);
  const patient = await p.scheduling.getPatient(user.clinicId, inv.patientId);
  const tz = clinic.timezone;
  const today = utcToZoned(p.now(), tz).date;
  const isCredit = inv.kind === "credit_note";
  const canPay = !isCredit && inv.status !== "credited" && inv.balancePence > 0;
  const canCredit = !isCredit && !inv.creditedById;

  return (
    <>
      <Header user={user} />
      <main style={{ maxWidth: 820 }}>
        <p className="muted noprint"><Link href="/billing">← Billing</Link> · <Link href={`/patients/${inv.patientId}`}>{inv.patientName}</Link></p>

        <article className="card" aria-labelledby="inv-title">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "start" }}>
            <div>
              <h1 id="inv-title" style={{ margin: 0 }}>{isCredit ? "Credit note" : "Invoice"} {inv.number}</h1>
              <p className="muted" style={{ margin: "4px 0" }}>Issued {formatLocal(inv.issuedAt, tz, "date")}{isCredit ? "" : ` · due ${formatLocal(inv.dueAt, tz, "date")}`}</p>
            </div>
            <span className={`pill ${STATUS_PILL[inv.status]}`}>{STATUS_LABEL[inv.status]}</span>
          </div>
          {isCredit ? <p>Cancels invoice <Link href={`/billing/${inv.creditsInvoiceId}`}>{inv.creditsNumber}</Link>. Reason: {inv.note}</p> : null}
          {inv.creditedById ? <div className="banner warn">This invoice was cancelled by credit note <Link href={`/billing/${inv.creditedById}`}>{inv.creditedByNumber}</Link>.</div> : null}

          <div className="grid2">
            <div>
              <strong>From</strong>
              <div style={{ whiteSpace: "pre-line" }}>{settings.billingDetails || clinic.name}</div>
            </div>
            <div>
              <strong>To</strong>
              <div>
                {inv.payerType === "insurer" ? <>{inv.payerName}<br /><span className="muted">Patient: </span></> : null}
                {inv.patientName}
                {patient.address ? <><br />{patient.address}{patient.postcode ? `, ${patient.postcode}` : ""}</> : null}
                {inv.claimRef ? <><br /><span className="muted">Reference:</span> {inv.claimRef}</> : null}
              </div>
            </div>
          </div>

          <div className="tablewrap" tabIndex={0} role="region" aria-label="Invoice lines, scrollable table" style={{ marginTop: 16 }}>
            <table>
              <thead><tr><th scope="col">Description</th><th scope="col">Qty</th><th scope="col">Price</th><th scope="col">Net</th>{inv.vatPence !== 0 ? <th scope="col">VAT</th> : null}</tr></thead>
              <tbody>
                {inv.lines.map((l) => (
                  <tr key={l.position}>
                    <th scope="row">{l.description}</th><td>{l.quantity}</td><td>{formatPence(l.unitPence)}</td><td>{formatPence(l.netPence)}</td>
                    {inv.vatPence !== 0 ? <td>{formatPence(l.vatPence)} <span className="muted">({l.vatBp / 100}%)</span></td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="stats" style={{ marginTop: 12 }}>
            {inv.vatPence !== 0 ? <div><dt>Subtotal</dt><dd>{formatPence(inv.subtotalPence)}</dd></div> : null}
            {inv.vatPence !== 0 ? <div><dt>VAT</dt><dd>{formatPence(inv.vatPence)}</dd></div> : null}
            <div><dt>Total</dt><dd>{formatPence(inv.totalPence)}</dd></div>
            {!isCredit ? <div><dt>Paid</dt><dd>{formatPence(inv.paidPence)}</dd></div> : null}
            {!isCredit ? <div><dt>Owed</dt><dd>{formatPence(inv.balancePence)}</dd></div> : null}
          </dl>
          {!isCredit && inv.note ? <p>{inv.note}</p> : null}
          <p className="muted noprint"><PrintButton /></p>
        </article>

        {!isCredit ? (
          <section className="card noprint" aria-labelledby="payments">
            <h2 id="payments">Payments</h2>
            {inv.payments.length === 0 ? <p className="muted">Nothing paid yet.</p> : (
              <div className="tablewrap" tabIndex={0} role="region" aria-label="Payments, scrollable table">
                <table>
                  <thead><tr><th scope="col">Date</th><th scope="col">Method</th><th scope="col">Amount</th><th scope="col">Reference</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {inv.payments.map((x) => (
                      <tr key={x.id}>
                        <th scope="row">{formatLocal(x.receivedAt, tz, "date")}</th>
                        <td>{METHOD[x.method]}</td>
                        <td>{formatPence(x.amountPence)}</td>
                        <td>{x.reference || "–"}{x.reversed ? <span className="muted"> · reversed</span> : null}</td>
                        <td>
                          {!x.reversesPaymentId && !x.reversed ? (
                            <details className="sub">
                              <summary>Reverse</summary>
                              <ActionForm action={reversePaymentAction} hidden={{ id: inv.id, paymentId: x.id }} submitLabel="Reverse payment" submitClass="danger" confirmText="Reverse this payment? The entry stays on the record.">
                                <label htmlFor={`rr${x.id}`}>Why</label>
                                <input id={`rr${x.id}`} name="reason" maxLength={200} required />
                              </ActionForm>
                            </details>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {canPay ? (
              <>
                <h3>Record a payment</h3>
                <ActionForm action={recordPaymentAction} hidden={{ id: inv.id }} submitLabel="Record payment">
                  <div className="grid2">
                    <div><label htmlFor="amount">Amount (£)</label><input id="amount" name="amount" inputMode="decimal" defaultValue={poundsField(inv.balancePence)} required /></div>
                    <div>
                      <label htmlFor="method">How paid</label>
                      <select id="method" name="method" defaultValue={inv.payerType === "insurer" ? "insurer" : "card"}>
                        {Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </div>
                    <div><label htmlFor="receivedOn">Date received</label><input id="receivedOn" name="receivedOn" type="date" max={today} defaultValue={today} /></div>
                    <div><label htmlFor="reference">Reference (optional)</label><input id="reference" name="reference" maxLength={80} /></div>
                  </div>
                </ActionForm>
              </>
            ) : null}
          </section>
        ) : null}

        {canCredit ? (
          <section className="card noprint" aria-labelledby="credit">
            <h2 id="credit">Cancel this invoice</h2>
            {inv.paidPence !== 0 ? (
              <p className="muted">Money is recorded against this invoice. Reverse the payment{inv.payments.filter((x) => !x.reversesPaymentId && !x.reversed).length === 1 ? "" : "s"} above first; then it can be cancelled.</p>
            ) : (
              <ActionForm action={creditInvoiceAction} hidden={{ id: inv.id }} submitLabel="Cancel with a credit note" submitClass="danger" confirmText="Cancel this invoice with a credit note? This cannot be undone.">
                <p className="muted">An issued invoice is never edited or deleted. A credit note cancels it in full and is kept alongside it; you can then issue a new invoice.</p>
                <label htmlFor="reason">Reason</label>
                <input id="reason" name="reason" maxLength={300} required />
              </ActionForm>
            )}
          </section>
        ) : null}
      </main>
    </>
  );
}
