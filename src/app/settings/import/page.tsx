import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getPlatform } from "@/lib/app";
import { undoImportAction } from "../../actions/staff";
import { ActionForm } from "../../Forms";
import { Header } from "../../Header";
import { ImportPanel } from "./ImportPanel";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const user = await requireUser(["owner"]);
  const p = getPlatform();
  const history = p.importer.list(user.clinicId);
  return (
    <>
      <Header user={user} />
      <main style={{ maxWidth: 820 }}>
        <p className="muted"><Link href="/settings">← Settings</Link></p>
        <h1>Switch from another system</h1>
        <div className="banner warn">
          Export patients (and then appointments) from Cliniko, TM3 or WriteUpp as CSV and upload them here. Column names are matched loosely, but they have not been checked against every real export, so always run the dry run and read what it recognised and ignored. Treatment notes and invoices are not imported. Keep your old system until you have checked the result.
        </div>
        <div className="card">
          <h2>Import a file</h2>
          <ImportPanel />
        </div>
        <div className="card">
          <h2>Past imports</h2>
          {history.length === 0 ? <p className="muted">None yet.</p> : (
            <div className="tablewrap" tabIndex={0} role="region" aria-label="Scrollable table">
              <table>
                <thead><tr><th scope="col">When</th><th scope="col">File</th><th scope="col">Kind</th><th scope="col">Created</th><th scope="col">Rejected</th><th scope="col">Undo</th></tr></thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td>{new Date(h.created_at).toLocaleString("en-GB", { timeZone: "Europe/London" })}</td>
                      <td>{h.filename}</td><td>{h.kind}</td><td>{h.counts.created}</td><td>{h.counts.rejected}</td>
                      <td>{h.undone_at ? "Undone" : h.canUndo ? <ActionForm action={undoImportAction} hidden={{ id: h.id }} submitLabel="Undo" submitClass="danger" confirmText="Remove everything this import added?" /> : "Past 7 days"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted">An import can be undone for 7 days. Patients who have been given other records since (an appointment or consultation of their own) are kept.</p>
        </div>
      </main>
    </>
  );
}
