import Link from "next/link";
import { requireUser } from "@/lib/auth";
import type { SessionUser } from "@/lib/accounts";
import { getPlatform, withClinic } from "@/lib/app";
import { saveRetentionAction } from "../../actions/records";
import { ActionForm } from "../../Forms";
import { Header } from "../../Header";

export const dynamic = "force-dynamic";

export default async function Retention() {
  const user = await requireUser(["owner"]);
  return withClinic(user.clinicId, () => Body(user));
}

async function Body(user: SessionUser) {
  const p = getPlatform();
  const years = await p.records.getRetentionYears(user.clinicId);
  const due = await p.records.dueForReview(user.clinicId);
  return (
    <>
      <Header user={user} />
      <main style={{ maxWidth: 900 }}>
        <p className="muted"><Link href="/settings">← Settings</Link></p>
        <h1>Keeping and removing records</h1>
        <section className="card" aria-labelledby="period">
          <h2 id="period">How long records are kept</h2>
          <p className="muted">
            Records are kept for this many years after the person was last seen or billed. For someone under 18 at that point they are kept until the person is 25 if that is later.
            Clinical and financial records have legal minimum periods, so check yours with your professional body or insurer before shortening this. The default is 8 years.
          </p>
          <ActionForm action={saveRetentionAction} submitLabel="Save">
            <label htmlFor="years">Years</label>
            <input id="years" name="years" type="number" min={1} max={30} step={1} defaultValue={years} required style={{ maxWidth: 120 }} />
          </ActionForm>
          <p className="muted">Transcripts of approved consultations are cleared automatically 30 days after approval (set <code>TRANSCRIPT_RETENTION_DAYS</code>, or 0 to keep them).</p>
        </section>

        <section className="card" aria-labelledby="due">
          <h2 id="due">Ready for review</h2>
          {due.length === 0 ? (
            <p className="muted">Nobody has passed their retention date.</p>
          ) : (
            <>
              <p className="muted">These people have passed their retention date. Open a record to export it or remove the person&apos;s identity. Nothing happens automatically.</p>
              <table>
                <thead><tr><th scope="col">Patient</th><th scope="col">Last activity</th><th scope="col">Keep until</th></tr></thead>
                <tbody>
                  {due.map((d) => (
                    <tr key={d.patientId}>
                      <td><Link href={`/patients/${d.patientId}`}>{d.name}</Link></td>
                      <td>{d.lastActivity.slice(0, 10)}</td>
                      <td>{d.retainUntil.slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      </main>
    </>
  );
}
