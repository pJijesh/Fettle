import Link from "next/link";
import { requireUser } from "@/lib/auth";
import type { SessionUser } from "@/lib/accounts";
import { getPlatform, withClinic } from "@/lib/app";
import { markReviewedAction } from "../actions/assist";
import { ActionForm } from "../Forms";
import { Header } from "../Header";

export const dynamic = "force-dynamic";

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" });

export default async function CheckIns() {
  const user = await requireUser(["owner", "clinician"]);
  return withClinic(user.clinicId, () => Body(user));
}

async function Body(user: SessionUser) {
  const p = getPlatform();
  const open = await p.triage.listOpen(user.clinicId);
  const ai = await p.triage.aiOn(user.clinicId);
  return (
    <>
      <Header user={user} />
      <main style={{ maxWidth: 860 }}>
        <h1>Check-ins that need a look</h1>
        <p className="muted">
          Patients answer two questions on their link after a visit. These are the ones that say pain is worse, or whose comment mentions something that may need a clinician (such as numbness, a fall, or feeling unwell).
          {ai ? " The AI assistant also reads comments and can add to this list; it cannot take anything off it." : ""} A check-in that is not here may still matter: this list is a help, not a guarantee, so look at the check-ins on each consultation too.
        </p>
        {open.length === 0 ? (
          <div className="banner good">Nothing waiting.</div>
        ) : (
          open.map((c) => (
            <section key={c.id} className="card">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong><Link href={`/consults/${c.consultId}`}>{c.patientLabel}</Link></strong>
                <span className="muted">{when(c.createdAt)} · {c.practitioner}</span>
              </div>
              <p style={{ margin: "6px 0" }}>Exercises done: <strong>{c.adherence}</strong>; pain: <strong>{c.painChange}</strong></p>
              {c.comment ? <blockquote style={{ margin: "6px 0" }}>“{c.comment}”</blockquote> : null}
              <p className="muted" style={{ margin: "6px 0" }}>Why it is here: {c.reason} <span>({c.source === "assistant" ? "AI assistant" : "plain rule"})</span></p>
              <ActionForm action={markReviewedAction} hidden={{ checkInId: c.id }} submitLabel="I have seen this" submitClass="" />
            </section>
          ))
        )}
      </main>
    </>
  );
}
