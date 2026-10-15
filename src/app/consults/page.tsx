import Link from "next/link";
import { requireUser } from "@/lib/auth";
import type { SessionUser } from "@/lib/accounts";
import { getService, withClinic } from "@/lib/app";
import { Header } from "../Header";

export const dynamic = "force-dynamic";

export default async function Consultations() {
  const user = await requireUser(["owner", "clinician"]);
  return withClinic(user.clinicId, () => ConsultationsBody(user));
}

async function ConsultationsBody(user: SessionUser) {
  const consults = await getService(user.clinicId).listConsults();
  return (
    <>
      <Header user={user} />
      <main>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h1>Consultations</h1>
          <Link href="/consults/new" className="btn primary">New consultation</Link>
        </div>
        <p className="muted">Most consultations start from an appointment (open it and choose “Start consultation”). Use this list to find one or to start one without an appointment.</p>
        <div className="card">
          {consults.length === 0 ? (
            <p className="muted">No consultations yet.</p>
          ) : (
            <ul className="plain">
              {consults.map((c) => (
                <li key={c.id} className="row" style={{ justifyContent: "space-between" }}>
                  <span>
                    <Link href={`/consults/${c.id}`}>{c.patientLabel}</Link>
                    {c.discipline === "ayurveda" ? <span className="pill">Ayurveda</span> : null}
                    <span className="muted"> · {c.practitioner} · {new Date(c.updatedAt).toLocaleString("en-GB", { timeZone: "Europe/London" })}</span>
                  </span>
                  <span className={`pill ${c.status}`}>{c.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </>
  );
}
