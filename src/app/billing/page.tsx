import Link from "next/link";
import { requireUser } from "@/lib/auth";
import type { SessionUser } from "@/lib/accounts";
import { getPlatform, withClinic } from "@/lib/app";
import { formatPence } from "@/lib/money";
import { formatLocal } from "@/lib/tz";
import { Header } from "../Header";
import { STATUS_LABEL, STATUS_PILL } from "./status";

export const dynamic = "force-dynamic";

const VIEWS = [
  { key: "outstanding", label: "Outstanding" },
  { key: "all", label: "All" },
  { key: "paid", label: "Paid" },
] as const;

type Props = { searchParams: Promise<{ view?: string }> };

export default async function BillingPage(props: Props) {
  const user = await requireUser(["owner", "reception"]);
  const sp = await props.searchParams;
  return withClinic(user.clinicId, () => BillingBody(user, sp));
}

async function BillingBody(user: SessionUser, sp: { view?: string }) {
  const p = getPlatform();
  const view = VIEWS.find((v) => v.key === sp.view)?.key ?? "outstanding";
  const tz = (await p.scheduling.clinic(user.clinicId)).timezone;
  const list = await p.billing.listInvoices(user.clinicId, { status: view });
  const owed = list.filter((i) => i.kind === "invoice").reduce((s, i) => s + i.balancePence, 0);
  return (
    <>
      <Header user={user} />
      <main>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h1 style={{ margin: 0 }}>Billing</h1>
          <Link className="btn primary" href="/billing/new">New invoice</Link>
        </div>
        <nav className="row" aria-label="Invoice views" style={{ margin: "12px 0" }}>
          {VIEWS.map((v) => (
            <Link key={v.key} className="btn" href={`/billing?view=${v.key}`} aria-current={v.key === view ? "page" : undefined} style={v.key === view ? { fontWeight: 700 } : undefined}>
              {v.label}
            </Link>
          ))}
        </nav>
        {view === "outstanding" ? <p><strong>{formatPence(owed)}</strong> <span className="muted">owed across {list.length} invoice{list.length === 1 ? "" : "s"}.</span></p> : null}
        <section className="card tablewrap" tabIndex={0} role="region" aria-label="Invoices, scrollable table">
          {list.length === 0 ? <p className="muted">{view === "outstanding" ? "Nothing is owed." : "No invoices yet."}</p> : (
            <table>
              <thead><tr><th scope="col">Number</th><th scope="col">Patient</th><th scope="col">Date</th><th scope="col">Total</th><th scope="col">Owed</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {list.map((i) => (
                  <tr key={i.id}>
                    <th scope="row"><Link href={`/billing/${i.id}`}>{i.number}</Link></th>
                    <td><Link href={`/patients/${i.patientId}`}>{i.patientName}</Link>{i.payerType === "insurer" ? <span className="muted"> · {i.payerName}</span> : null}</td>
                    <td>{formatLocal(i.issuedAt, tz, "date")}</td>
                    <td>{formatPence(i.totalPence)}</td>
                    <td>{i.balancePence ? formatPence(i.balancePence) : "–"}</td>
                    <td><span className={`pill ${STATUS_PILL[i.status]}`}>{STATUS_LABEL[i.status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </>
  );
}
