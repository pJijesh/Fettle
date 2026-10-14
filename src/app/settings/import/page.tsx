import Link from "next/link";
import { requireUser } from "@/lib/auth";
import type { SessionUser } from "@/lib/accounts";
import { getPlatform, withClinic } from "@/lib/app";
import { undoImportAction } from "../../actions/staff";
import { ActionForm } from "../../Forms";
import { Header } from "../../Header";
import { ImportPanel } from "./ImportPanel";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const user = await requireUser(["owner"]);
  return withClinic(user.clinicId, () => ImportPageBody(user));
}

async function ImportPageBody(user: SessionUser) {
  const p = getPlatform();
  const history = await p.importer.list(user.clinicId);
  return (
    <>
      <Header user={user} />
      <main style={{ maxWidth: 820 }}>
        <p className="muted"><Link href="/settings">← Settings</Link></p>
        <h1>Switch from another system</h1>
        <div className="banner warn">
          Move your patients, and then your appointments, from TM3, Cliniko, WriteUpp or any system that can save a list as CSV or Excel. Always run the dry run and check which column goes where: none of these systems publish their column headings, so nothing here has been checked against a real export. Keep your old system until you have checked the result.
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
