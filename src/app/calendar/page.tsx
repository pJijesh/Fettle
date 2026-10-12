import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getPlatform } from "@/lib/app";
import { addDays, dayBounds, isDate, utcToZoned, weekdayOf } from "@/lib/tz";
import { Header } from "../Header";
import { CalendarGrid, type Block, type Column, type StripItem } from "./CalendarGrid";

export const dynamic = "force-dynamic";

type SP = Promise<{ view?: string; date?: string; clinician?: string; denied?: string }>;

const DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const pretty = (d: string) => {
  const [y, m, dd] = d.split("-").map(Number);
  return `${DAY[weekdayOf(d) - 1]} ${dd}/${m}/${y}`;
};

export default async function CalendarPage({ searchParams }: { searchParams: SP }) {
  const user = await requireUser();
  const sp = await searchParams;
  const p = getPlatform();
  const sched = p.scheduling;
  const clinic = sched.clinic(user.clinicId);
  const tz = clinic.timezone;
  const nowZ = utcToZoned(p.now(), tz);
  const today = nowZ.date;
  const date = sp.date && isDate(sp.date) ? sp.date : today;
  const view = sp.view === "week" ? "week" : "day";
  const clinicians = sched.clinicians(user.clinicId);
  const own = clinicians.find((c) => c.id === user.id);
  const chosen = sp.clinician && sp.clinician !== "all" ? clinicians.find((c) => c.id === sp.clinician) : undefined;
  // Week view needs one clinician; day view can show everyone side by side.
  const weekClin = chosen ?? own ?? clinicians[0];
  const dayClins = chosen ? [chosen] : clinicians;

  const monday = addDays(date, 1 - weekdayOf(date));
  const dates = view === "week" ? Array.from({ length: 7 }, (_, i) => addDays(monday, i)) : [date];
  const from = dates[0];
  const to = dates[dates.length - 1];
  const fromUtc = dayBounds(from, tz).start.toISOString();
  const toUtc = dayBounds(to, tz).end.toISOString();

  const targets = view === "week" ? [{ date: null as string | null, clin: weekClin }] : dayClins.map((c) => ({ date: null as string | null, clin: c }));
  const appts = sched.listAppointments(user.clinicId, { fromUtc, toUtc, userId: view === "week" ? weekClin?.id : chosen?.id });
  const consultByAppt = new Set(sched.markers(user.clinicId, from, to).awaitingApproval.map((a) => a.appointmentId));

  const columns: Column[] = [];
  const mk = (date: string, clin: { id: string; name: string } | undefined, title: string, sub?: string): Column | null => {
    if (!clin) return null;
    const hours = sched.getHours(user.clinicId, clin.id).filter((h) => h.weekday === weekdayOf(date));
    const b = dayBounds(date, tz);
    const blocks: Block[] = appts
      .filter((a) => a.userId === clin.id && new Date(a.startAt) >= b.start && new Date(a.startAt) < b.end)
      .map((a) => {
        const s = utcToZoned(new Date(a.startAt), tz);
        const dur = Math.round((new Date(a.endAt).getTime() - new Date(a.startAt).getTime()) / 60_000);
        const hh = (m: number) => `${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
        return {
          id: a.id, patient: a.patientName, type: a.typeName, status: a.status, startMin: s.minutes, durMin: dur,
          label: `${hh(s.minutes)}–${hh(s.minutes + dur)}`, formsPending: a.formsPending, noteToApprove: consultByAppt.has(a.id),
        };
      });
    return {
      key: `${date}:${clin.id}`, title, sub, isToday: date === today, date, userId: clin.id,
      work: hours.map((h) => ({ start: h.startMin, end: h.endMin })), appts: blocks, nowMin: date === today ? nowZ.minutes : null,
    };
  };
  if (view === "week") {
    for (const d of dates) {
      const c = mk(d, weekClin, pretty(d), d === today ? "Today" : undefined);
      if (c) columns.push(c);
    }
  } else {
    for (const t of targets) {
      const c = mk(date, t.clin, t.clin.name, pretty(date));
      if (c) columns.push(c);
    }
  }

  let gridStart = 7 * 60;
  let gridEnd = 19 * 60;
  for (const c of columns) {
    for (const w of c.work) {
      gridStart = Math.min(gridStart, Math.floor(w.start / 60) * 60);
      gridEnd = Math.max(gridEnd, Math.ceil(w.end / 60) * 60);
    }
    for (const a of c.appts) {
      gridStart = Math.min(gridStart, Math.floor(a.startMin / 60) * 60);
      gridEnd = Math.max(gridEnd, Math.min(1440, Math.ceil((a.startMin + a.durMin) / 60) * 60));
    }
  }

  const markers = sched.markers(user.clinicId, from, to);
  const strips: Record<string, StripItem[]> = {};
  for (const r of markers.reviewsDue) {
    (strips[r.date] ??= []).push({ kind: "review", label: `Review due: ${r.patientLabel}`, href: `/consults/${r.consultId}` });
  }
  const attention: StripItem[] = [
    ...markers.worsePain.map((w) => ({ kind: "worse" as const, label: `${w.patientLabel} reported worse pain`, href: `/consults/${w.consultId}` })),
    ...markers.awaitingApproval.map((w) => ({ kind: "approve" as const, label: `${w.patientLabel}: note waiting for approval`, href: `/consults/${w.consultId}` })),
  ];

  const step = view === "week" ? 7 : 1;
  const q = (over: Record<string, string>) => {
    const params = new URLSearchParams({ view, date, ...(sp.clinician ? { clinician: sp.clinician } : {}), ...over });
    return `/calendar?${params.toString()}`;
  };

  return (
    <>
      <Header user={user} />
      <main>
        {sp.denied ? <div className="banner warn" role="status">Your role does not have access to that page.</div> : null}
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h1 style={{ margin: 0 }}>{view === "week" ? `Week of ${pretty(monday)}` : `${pretty(date)}`}{view === "week" && weekClin ? ` · ${weekClin.name}` : ""}</h1>
          <Link className="btn primary" href={`/appointments/new?date=${date}`}>New appointment</Link>
        </div>
        <div className="toolbar" style={{ marginTop: 12 }}>
          <Link className="btn" href={q({ date: addDays(date, -step) })} aria-label={view === "week" ? "Previous week" : "Previous day"}>←</Link>
          <Link className="btn" href={q({ date: today })}>Today</Link>
          <Link className="btn" href={q({ date: addDays(date, step) })} aria-label={view === "week" ? "Next week" : "Next day"}>→</Link>
          <Link className="btn" href={q({ view: "day" })} aria-current={view === "day" ? "true" : undefined} style={view === "day" ? { fontWeight: 700 } : undefined}>Day</Link>
          <Link className="btn" href={q({ view: "week" })} aria-current={view === "week" ? "true" : undefined} style={view === "week" ? { fontWeight: 700 } : undefined}>Week</Link>
          <form method="get" className="toolbar" style={{ margin: 0 }}>
            <input type="hidden" name="view" value={view} />
            <div>
              <label htmlFor="date">Go to date</label>
              <input id="date" name="date" type="date" defaultValue={date} />
            </div>
            <div>
              <label htmlFor="clinician">Clinician</label>
              <select id="clinician" name="clinician" defaultValue={sp.clinician ?? (view === "week" ? weekClin?.id : "all")}>
                {view === "day" ? <option value="all">Everyone</option> : null}
                {clinicians.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <button type="submit">Show</button>
          </form>
        </div>
        {columns.length === 0 ? (
          <div className="card"><p>No clinicians are set up yet. Add one under <Link href="/settings">Settings</Link>.</p></div>
        ) : (
          <CalendarGrid columns={columns} gridStart={gridStart} gridEnd={gridEnd} strips={strips} />
        )}
        <div className="legend" aria-label="Key">
          <span><i style={{ background: "var(--blue-bg)", borderLeft: "4px solid var(--blue)" }} />Booked</span>
          <span><i style={{ background: "var(--good-bg)", borderLeft: "4px solid var(--good)" }} />Arrived</span>
          <span><i style={{ background: "var(--grey-bg)" }} />Completed</span>
          <span><i style={{ background: "var(--bad-bg)", borderLeft: "4px solid var(--bad)" }} />Did not attend</span>
          <span><i style={{ background: "var(--card)" }} />Working hours</span>
          <span><i style={{ background: "var(--off)" }} />Outside working hours</span>
        </div>
        {attention.length ? (
          <section className="card attention" aria-labelledby="att">
            <h2 id="att">Needs attention</h2>
            <ul className="plain">
              {attention.map((a, i) => (
                <li key={i}><Link href={a.href}>{a.label}</Link></li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>
    </>
  );
}
