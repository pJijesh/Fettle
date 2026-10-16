"use client";

import { useState, useTransition } from "react";
import type { MeasureSeries } from "@/lib/progress";
import { summariseProgressAction } from "../../actions/assist";

function Chart({ s }: { s: MeasureSeries }) {
  const pts = s.points.filter((p) => p.value !== null) as (typeof s.points[number] & { value: number })[];
  if (pts.length < 2) return null;
  const W = 320, H = 90, P = 14;
  const lo = Math.min(...pts.map((p) => p.value)), hi = Math.max(...pts.map((p) => p.value));
  const span = hi - lo || 1;
  const x = (i: number) => P + (i * (W - 2 * P)) / (pts.length - 1);
  const y = (v: number) => H - P - ((v - lo) / span) * (H - 2 * P);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`${s.name}: ${pts.map((p) => `${p.date} ${p.raw}`).join(", ")}`} style={{ maxWidth: "100%" }}>
      <polyline fill="none" stroke="currentColor" strokeWidth="2" points={pts.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")} />
      {pts.map((p, i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(p.value)} r="3.5" fill="currentColor" />
          <text x={x(i)} y={y(p.value) - 7} fontSize="10" textAnchor="middle" fill="currentColor">{p.raw}</text>
        </g>
      ))}
    </svg>
  );
}

export function ProgressView({ patientId, series, visits, checkIns, isMock }: {
  patientId: string;
  series: MeasureSeries[];
  visits: number;
  checkIns: { date: string; adherence: string; painChange: string; comment: string }[];
  isMock: boolean;
}) {
  const [text, setText] = useState<{ ok: boolean; t: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div>
      {visits === 0 ? <p className="muted">No approved physiotherapy visit yet.</p> : null}
      {series.length === 0 && visits > 0 ? <p className="muted">No outcome measure with a score has been recorded, so there is nothing to compare. Recording one at each visit (for example a pain score) lets progress show here.</p> : null}
      {series.map((s) => (
        <div key={s.name} style={{ marginBottom: 12 }}>
          <h3 style={{ marginBottom: 4 }}>{s.name}{s.points[0]?.scale ? <span className="muted"> ({s.points[0].scale})</span> : null}</h3>
          <Chart s={s} />
          <table>
            <thead><tr><th>Date</th><th>Score</th></tr></thead>
            <tbody>{s.points.map((p, i) => <tr key={i}><td>{p.date}</td><td>{p.raw}</td></tr>)}</tbody>
          </table>
          {s.change !== null ? <p className="muted" style={{ margin: "4px 0 0" }}>Change from first to latest: {s.change > 0 ? "+" : ""}{s.change}. Whether higher or lower is better depends on the measure.</p> : null}
        </div>
      ))}
      {checkIns.length ? (
        <>
          <h3>What the patient reported</h3>
          <ul className="plain">
            {checkIns.slice(-6).map((c, i) => <li key={i}>{c.date}: exercises {c.adherence}; pain {c.painChange}{c.comment ? <span className="muted"> — “{c.comment}”</span> : null}</li>)}
          </ul>
        </>
      ) : null}
      {visits > 0 ? (
        <div className="noprint">
          {isMock ? <div className="banner warn">Demo assistant: the summary is placeholder text. Never use with real patients.</div> : null}
          <button type="button" disabled={pending} onClick={() => start(async () => { const r = await summariseProgressAction(patientId); setText({ ok: !!r.ok, t: r.message ?? "" }); })}>
            {pending ? "Working…" : "Summarise since the last visit"}
          </button>
          <div role="status" className={text && !text.ok ? "banner bad" : undefined} style={{ marginTop: 8 }}>
            {text ? (text.ok ? <p style={{ margin: 0 }}>{text.t}<span className="muted"> (AI-written from the figures above, for you only, not saved. Check it against them.)</span></p> : text.t) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
