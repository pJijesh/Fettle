"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { moveAppointmentDragAction } from "../actions/staff";

export interface Block {
  id: string;
  patient: string;
  type: string;
  status: "booked" | "arrived" | "completed" | "no_show" | "cancelled";
  startMin: number;
  durMin: number;
  label: string;
  formsPending: number;
  noteToApprove: boolean;
}
export interface Column {
  key: string;
  title: string;
  sub?: string;
  isToday: boolean;
  date: string;
  userId: string;
  work: { start: number; end: number }[];
  appts: Block[];
  nowMin: number | null;
}
export interface StripItem {
  kind: "review" | "worse" | "approve";
  label: string;
  href: string;
}

const PX = 1.3; // pixels per minute
const SNAP = 15;
const STATUS_LABEL: Record<Block["status"], string> = { booked: "Booked", arrived: "Arrived", completed: "Completed", no_show: "Did not attend", cancelled: "Cancelled" };

function clock(min: number) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export function CalendarGrid({ columns, gridStart, gridEnd, strips }: { columns: Column[]; gridStart: number; gridEnd: number; strips: Record<string, StripItem[]> }) {
  const router = useRouter();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [layers, setLayers] = useState({ review: true, worse: true, approve: true });
  const drag = useRef<{ id: string; grab: number } | null>(null);
  const height = (gridEnd - gridStart) * PX;
  const cols = `56px repeat(${columns.length}, minmax(150px, 1fr))`;

  function minutesAt(e: React.DragEvent | React.MouseEvent, el: HTMLElement, grab = 0) {
    const y = e.clientY - el.getBoundingClientRect().top;
    const raw = gridStart + y / PX - grab;
    return Math.max(gridStart, Math.min(gridEnd - SNAP, Math.round(raw / SNAP) * SNAP));
  }

  async function drop(e: React.DragEvent<HTMLDivElement>, col: Column) {
    e.preventDefault();
    setOver(null);
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const minutes = minutesAt(e, e.currentTarget, d.grab);
    setMessage({ ok: true, text: "Moving…" });
    const res = await moveAppointmentDragAction(d.id, col.date, minutes, col.userId);
    setMessage({ ok: !!res.ok, text: res.ok ? `Moved to ${clock(minutes)}.` : res.message ?? "Could not move it." });
    router.refresh();
  }

  const hours: number[] = [];
  for (let m = Math.ceil(gridStart / 60) * 60; m < gridEnd; m += 60) hours.push(m);
  const show = (k: StripItem["kind"]) => layers[k];

  return (
    <div>
      <fieldset className="inline" style={{ margin: "0 0 8px" }}>
        <legend>Show on the calendar</legend>
        <label><input type="checkbox" checked={layers.review} onChange={(e) => setLayers({ ...layers, review: e.target.checked })} /> Programme review due</label>
        <label><input type="checkbox" checked={layers.worse} onChange={(e) => setLayers({ ...layers, worse: e.target.checked })} /> Reported worse pain</label>
        <label><input type="checkbox" checked={layers.approve} onChange={(e) => setLayers({ ...layers, approve: e.target.checked })} /> Note waiting for approval</label>
      </fieldset>
      <div role="status" aria-live="polite" className={message ? `banner ${message.ok ? "good" : "bad"}` : "muted"} style={{ minHeight: message ? undefined : 0 }}>
        {message?.text}
      </div>
      <div className="cal-scroll">
        <div className="cal-inner" style={{ minWidth: 56 + columns.length * 150 }}>
          <div className="cal-head" style={{ gridTemplateColumns: cols }}>
            <div style={{ borderLeft: 0 }} />
            {columns.map((c) => (
              <div key={c.key} className={c.isToday ? "today" : undefined}>
                {c.title}
                {c.sub ? <span className="muted" style={{ display: "block", fontWeight: 400 }}>{c.sub}</span> : null}
              </div>
            ))}
          </div>
          <div className="cal-head" style={{ gridTemplateColumns: cols, position: "static" }}>
            <div className="strip" style={{ borderLeft: 0 }}><span className="muted">Flags</span></div>
            {columns.map((c) => (
              <div key={c.key} className="strip" style={{ fontWeight: 400 }}>
                {(strips[c.date] ?? []).filter((s) => show(s.kind)).map((s, i) => (
                  <a key={i} href={s.href}>{s.label}</a>
                ))}
              </div>
            ))}
          </div>
          <div className="cal-body" style={{ gridTemplateColumns: cols, height }}>
            <div className="cal-times" aria-hidden="true">
              {hours.map((m) => (
                <span key={m} style={{ top: (m - gridStart) * PX }}>{clock(m)}</span>
              ))}
            </div>
            {columns.map((c) => (
              <div
                key={c.key}
                className={`cal-col${over === c.key ? " over" : ""}`}
                onDragEnter={(e) => {
                  if (drag.current) e.preventDefault();
                }}
                onDragOver={(e) => {
                  if (drag.current) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setOver(c.key);
                  }
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === c.key ? null : o));
                }}
                onDrop={(e) => drop(e, c)}
                onClick={(e) => {
                  if (e.target !== e.currentTarget) return;
                  const m = minutesAt(e, e.currentTarget);
                  router.push(`/appointments/new?date=${c.date}&time=${clock(m)}&user=${c.userId}`);
                }}
              >
                {c.work.map((w, i) => (
                  <div key={i} className="work" style={{ top: (Math.max(w.start, gridStart) - gridStart) * PX, height: (Math.min(w.end, gridEnd) - Math.max(w.start, gridStart)) * PX }} />
                ))}
                {hours.map((m) => (
                  <div key={m} className="hr" style={{ top: (m - gridStart) * PX }} />
                ))}
                {c.nowMin !== null && c.nowMin >= gridStart && c.nowMin <= gridEnd ? <div className="now" style={{ top: (c.nowMin - gridStart) * PX }} aria-hidden="true" /> : null}
                {c.appts.map((a) => (
                  <a
                    key={a.id}
                    href={`/appointments/${a.id}`}
                    className={`appt s-${a.status}`}
                    style={{ top: (a.startMin - gridStart) * PX, height: Math.max(a.durMin * PX - 2, 20) }}
                    draggable={a.status === "booked"}
                    onDragStart={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      drag.current = { id: a.id, grab: Math.max(0, Math.round((e.clientY - r.top) / PX / SNAP) * SNAP) };
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", a.id);
                      e.currentTarget.classList.add("dragging");
                    }}
                    onDragEnd={(e) => {
                      e.currentTarget.classList.remove("dragging");
                      drag.current = null;
                      setOver(null);
                    }}
                    title={`${a.label} · ${a.patient} · ${a.type} · ${STATUS_LABEL[a.status]}`}
                  >
                    <strong>{a.label}</strong> {a.patient}
                    <span style={{ display: "block" }}>
                      {a.type} · {STATUS_LABEL[a.status]}
                      {a.formsPending > 0 && a.status === "booked" ? <span className="badge">forms due</span> : null}
                      {a.noteToApprove && layers.approve ? <span className="badge">note to approve</span> : null}
                    </span>
                  </a>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="muted noprint">Drag a booked appointment to move it. Click empty space to book. On a phone or with a keyboard, open an appointment and use “Move”.</p>
    </div>
  );
}
