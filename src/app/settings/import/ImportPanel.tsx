"use client";

import { startTransition, useActionState, useState } from "react";
import { importAction } from "../../actions/staff";
import { Feedback } from "../../Forms";
import type { ActionState } from "@/lib/action-util";
import type { ImportReport } from "@/lib/importer";
import { IMPORT_NOT_BROUGHT_ACROSS, SOURCES, type ImportKind, type ImportSource } from "@/lib/import-meta";

export function ImportPanel() {
  const [state, run, pending] = useActionState(importAction as (p: ActionState, f: FormData) => Promise<ActionState>, {});
  const [source, setSource] = useState<ImportSource>("tm3");
  const [kind, setKind] = useState<ImportKind>("patients");
  // The report belongs to the file and kind it was made for; changing either hides it so old column choices are never reused.
  const [fileKey, setFileKey] = useState("");
  const [reportKey, setReportKey] = useState<string | null>(null);
  const report = state.data && reportKey === `${fileKey}|${kind}` ? (state.data as ImportReport) : undefined;
  const info = SOURCES[source];

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        const data = new FormData(e.currentTarget, submitter ?? undefined);
        setReportKey(`${fileKey}|${kind}`);
        startTransition(() => run(data));
      }}
    >
      <Feedback state={state} />
      <div className="grid2">
        <div>
          <label htmlFor="source">Coming from</label>
          <select id="source" name="source" value={source} onChange={(e) => setSource(e.target.value as ImportSource)}>
            {(Object.keys(SOURCES) as ImportSource[]).map((k) => <option key={k} value={k}>{SOURCES[k].label}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="kind">What is in the file?</label>
          <select id="kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value as ImportKind)}>
            <option value="patients">Patients</option>
            <option value="appointments">Appointments (import patients first)</option>
          </select>
        </div>
      </div>

      <div className="sub">
        <h3 style={{ marginTop: 0 }}>Getting your data out of {info.label}</h3>
        <ol>{info.howTo.map((h) => <li key={h}>{h}</li>)}</ol>
        <p><strong>What this app can read:</strong> {info.support}</p>
        <p className="muted">
          {info.sourceUrl ? <>Source: <a href={info.sourceUrl} target="_blank" rel="noreferrer">{info.sourceLabel ?? info.sourceUrl} (opens in a new tab)</a>. </> : null}
          Or start from a template: <a href="/settings/import/template?kind=patients">patients template (CSV)</a>, <a href="/settings/import/template?kind=appointments">appointments template (CSV)</a>.
        </p>
      </div>

      <label htmlFor="file">CSV or Excel (.xlsx) file, up to 5 MB</label>
      <input id="file" name="file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required
        onChange={(e) => setFileKey(e.target.files?.[0] ? `${e.target.files[0].name}:${e.target.files[0].size}:${e.target.files[0].lastModified}` : "")} />
      <p className="muted">{IMPORT_NOT_BROUGHT_ACROSS}</p>

      <div className="row" style={{ marginTop: 12 }}>
        <button type="submit" name="mode" value="dry" className="primary" disabled={pending}>{pending ? "Checking…" : report ? "Check again with these columns" : "Check the file (dry run)"}</button>
        {report?.dryRun && report.created > 0 && !report.problems.length ? <button type="submit" name="mode" value="commit" disabled={pending}>Import {report.created} {report.kind} now</button> : null}
      </div>

      {report ? (
        <div className="sub" aria-live="polite">
          {report.problems.length ? (
            <div className="banner warn" role="alert">
              <strong>This file cannot be imported yet.</strong>
              <ul>{report.problems.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          ) : (
            <>
              <h3 style={{ marginTop: 0 }}>{report.dryRun ? "Dry run: nothing saved yet" : "Imported"}</h3>
              <p>{report.rows} rows read. <strong>{report.created}</strong> {report.dryRun ? "would be created" : "created"}, {report.existing} already exist, {report.rejected.length} rejected.</p>
              {report.preview.length ? <p className="muted">For example: {report.preview.join("; ")}</p> : null}
            </>
          )}

          <h3>Columns</h3>
          <p className="muted">Check that each column of your file is matched to the right field. Change any that are wrong, then check again.</p>
          <div className="tablewrap" tabIndex={0} role="region" aria-label="Columns in your file">
            <table>
              <thead><tr><th scope="col">Column in your file</th><th scope="col">Examples</th><th scope="col">Goes into</th></tr></thead>
              <tbody>
                {report.columns.map((c) => (
                  <tr key={`${fileKey}-${c.index}-${report.problems.length}-${report.created}-${report.dryRun}`}>
                    <th scope="row">{c.header || `(column ${c.index + 1}, no heading)`}</th>
                    <td className="muted">{c.sample.join(", ") || "empty"}</td>
                    <td>
                      <select name={`map:${c.index}`} defaultValue={c.field ?? ""} aria-label={`Field for column ${c.header || c.index + 1}`}>
                        <option value="">Do not import</option>
                        {report.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

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
