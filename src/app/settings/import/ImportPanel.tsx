"use client";

import { startTransition, useActionState } from "react";
import { importAction } from "../../actions/staff";
import { Feedback } from "../../Forms";
import type { ActionState } from "@/lib/action-util";
import type { ImportReport } from "@/lib/importer";

export function ImportPanel() {
  const [state, run, pending] = useActionState(importAction as (p: ActionState, f: FormData) => Promise<ActionState>, {});
  const report = state.data as ImportReport | undefined;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        const data = new FormData(e.currentTarget, submitter ?? undefined);
        startTransition(() => run(data));
      }}
    >
      <Feedback state={state} />
      <div className="grid2">
        <div>
          <label htmlFor="kind">What is in the file?</label>
          <select id="kind" name="kind" defaultValue="patients"><option value="patients">Patients</option><option value="appointments">Appointments (import patients first)</option></select>
        </div>
        <div>
          <label htmlFor="source">Coming from</label>
          <select id="source" name="source" defaultValue="other"><option value="cliniko">Cliniko</option><option value="tm3">TM3</option><option value="writeupp">WriteUpp</option><option value="other">Another system</option></select>
        </div>
      </div>
      <label htmlFor="file">CSV file (up to 5 MB)</label>
      <input id="file" name="file" type="file" accept=".csv,text/csv" required />
      <div className="row" style={{ marginTop: 12 }}>
        <button type="submit" name="mode" value="dry" className="primary" disabled={pending}>{pending ? "Checking…" : "Check the file (dry run)"}</button>
        {report?.dryRun && report.created > 0 ? <button type="submit" name="mode" value="commit" disabled={pending}>Import {report.created} {report.kind} now</button> : null}
      </div>
      {report ? (
        <div className="sub" aria-live="polite">
          <h3 style={{ marginTop: 0 }}>{report.dryRun ? "Dry run: nothing saved yet" : "Imported"}</h3>
          <p>{report.rows} rows read. <strong>{report.created}</strong> {report.dryRun ? "would be created" : "created"}, {report.existing} already exist, {report.rejected.length} rejected.</p>
          {report.preview.length ? <p className="muted">For example: {report.preview.join("; ")}</p> : null}
          <p className="muted">Columns used: {report.recognised.length ? report.recognised.join("; ") : "none"}.<br />Columns ignored: {report.ignored.length ? report.ignored.join(", ") : "none"}.</p>
          {report.rejected.length ? (
            <details>
              <summary>{report.rejected.length} rejected rows</summary>
              <ul>{report.rejected.slice(0, 100).map((r) => <li key={r.row}>Row {r.row}: {r.reason}</li>)}</ul>
              {report.rejected.length > 100 ? <p className="muted">Showing the first 100.</p> : null}
            </details>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
