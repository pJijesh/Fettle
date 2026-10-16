"use client";

import { useState, useTransition } from "react";
import type { NoteDraft, ProgrammeDraft, Side } from "@/lib/schemas";
import { approveAction, saveDraftsAction } from "../../actions";
import { checkNoteAction } from "../../actions/assist";
import type { NoteFinding } from "@/lib/note-check";
import type { ActionState } from "@/lib/action-util";
import { Feedback } from "../../Forms";
import { applyTemplate, type TemplateBody } from "@/lib/template-note";

export interface ExerciseOption {
  id: string;
  name: string;
}

const SIDES: { v: Side; label: string }[] = [
  { v: "left", label: "Left" },
  { v: "right", label: "Right" },
  { v: "both", label: "Both" },
  { v: "na", label: "n/a" },
];

function SideSelect({ value, onChange, label }: { value: Side; onChange: (s: Side) => void; label: string }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as Side)}>
      {SIDES.map((s) => (
        <option key={s.v} value={s.v}>{s.label}</option>
      ))}
    </select>
  );
}

function intOrNull(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function Source({ lines }: { lines: number[] }) {
  if (!lines.length) return <span className="muted">no source</span>;
  return <span className="muted">line {lines.join(", ")}</span>;
}

export function ReviewForm({
  id,
  initialNote,
  initialProgramme,
  catalogue,
  transcriptLines,
  practitioner,
  templates = [],
}: {
  id: string;
  initialNote: NoteDraft;
  initialProgramme: ProgrammeDraft;
  catalogue: ExerciseOption[];
  transcriptLines: string[];
  practitioner: string;
  templates?: { id: string; name: string; body: TemplateBody }[];
}) {
  const [note, setNote] = useState(initialNote);
  const [prog, setProg] = useState(initialProgramme);
  const [state, setState] = useState<ActionState>({});
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [tplId, setTplId] = useState(templates[0]?.id ?? "");
  const [tplMsg, setTplMsg] = useState("");
  const [check, setCheck] = useState<{ findings: NoteFinding[]; message?: string } | null>(null);

  const payload = () => JSON.stringify({ note, programme: prog });
  const patchNote = (p: Partial<NoteDraft>) => setNote((n) => ({ ...n, ...p }));
  const patchProg = (p: Partial<ProgrammeDraft>) => setProg((n) => ({ ...n, ...p }));

  function save() {
    start(async () => setState(await saveDraftsAction(id, payload())));
  }
  function approve() {
    start(async () => {
      const res = await approveAction(id, payload());
      setState(res);
      setConfirming(false);
    });
  }

  function runCheck() {
    start(async () => {
      const r = await checkNoteAction(id, payload());
      if (r.ok) setCheck({ findings: (r.data as NoteFinding[]) ?? [], message: r.message });
      else {
        setCheck(null);
        setState(r);
      }
    });
  }

  function useTemplate() {
    const t = templates.find((x) => x.id === tplId);
    if (!t) return;
    const res = applyTemplate(note, t.body);
    setNote(res.note);
    setTplMsg(res.added.length ? `Added from "${t.name}": ${res.added.join(", ")}. Nothing is saved until you save the draft.` : `Nothing to add from "${t.name}": the note already has everything in it.`);
  }

  const nextExerciseId = () => {
    const target = note.problems[note.problems.length - 1]?.id ?? "p1";
    const used = new Set(prog.items.filter((x) => x.problemId === target).map((x) => x.exerciseId));
    return catalogue.find((c) => !used.has(c.id))?.id ?? catalogue[0]?.id ?? "";
  };
  const nextProblemId = () => {
    const used = new Set(note.problems.map((p) => p.id));
    for (let i = 1; i < 100; i++) if (!used.has(`p${i}`)) return `p${i}`;
    return "p99";
  };

  const setRow = <K extends "rom" | "outcomeMeasures" | "specialTests" | "problems">(key: K, i: number, patch: Partial<NoteDraft[K][number]>) =>
    patchNote({ [key]: note[key].map((r, n) => (n === i ? { ...r, ...patch } : r)) } as Partial<NoteDraft>);
  const dropRow = (key: "rom" | "outcomeMeasures" | "specialTests" | "problems", i: number) =>
    patchNote({ [key]: note[key].filter((_, n) => n !== i) } as Partial<NoteDraft>);

  return (
    <div>
      <Feedback state={state} />

      <section className="card">
        <h2>Note</h2>
        {templates.length ? (
          <div className="sub">
            <label htmlFor="tpl">Start from a template</label>
            <div className="row">
              <select id="tpl" value={tplId} onChange={(e) => setTplId(e.target.value)}>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <button type="button" onClick={useTemplate}>Add to this note</button>
            </div>
            <div className="muted" role="status">{tplMsg || "Fills empty boxes and adds rows to fill in. It never changes what is already written."}</div>
          </div>
        ) : null}
        <label htmlFor="subj">Subjective</label>
        <textarea id="subj" value={note.subjective} onChange={(e) => patchNote({ subjective: e.target.value })} />
        <label htmlFor="obj">Objective</label>
        <textarea id="obj" value={note.objective} onChange={(e) => patchNote({ objective: e.target.value })} />

        <h3>Range of movement</h3>
        {note.rom.map((r, i) => (
          <div className="sub" key={i}>
            <div className="grid2">
              <input aria-label="Joint" placeholder="Joint" value={r.joint} onChange={(e) => setRow("rom", i, { joint: e.target.value })} />
              <SideSelect label="Side" value={r.side} onChange={(side) => setRow("rom", i, { side })} />
              <input aria-label="Movement" placeholder="Movement" value={r.movement} onChange={(e) => setRow("rom", i, { movement: e.target.value })} />
              <input aria-label="Value" placeholder="Value" value={r.value} onChange={(e) => setRow("rom", i, { value: e.target.value })} />
              <select aria-label="Unit" value={r.unit} onChange={(e) => setRow("rom", i, { unit: e.target.value as "deg" | "cm" | "other" })}>
                <option value="deg">degrees</option>
                <option value="cm">cm</option>
                <option value="other">other</option>
              </select>
            </div>
            <div className="row"><Source lines={r.evidence} /><button type="button" onClick={() => dropRow("rom", i)}>Remove</button></div>
          </div>
        ))}
        <button type="button" onClick={() => patchNote({ rom: [...note.rom, { joint: "", side: "na", movement: "", value: "", unit: "deg", evidence: [] }] })}>Add row</button>

        <h3>Outcome measures</h3>
        {note.outcomeMeasures.map((r, i) => (
          <div className="sub" key={i}>
            <div className="grid2">
              <input aria-label="Measure" placeholder="Measure (e.g. NPRS)" value={r.name} onChange={(e) => setRow("outcomeMeasures", i, { name: e.target.value })} />
              <input aria-label="Score" placeholder="Score" value={r.score} onChange={(e) => setRow("outcomeMeasures", i, { score: e.target.value })} />
              <input aria-label="Scale" placeholder="Scale (e.g. 0-10)" value={r.scale} onChange={(e) => setRow("outcomeMeasures", i, { scale: e.target.value })} />
            </div>
            <div className="row"><Source lines={r.evidence} /><button type="button" onClick={() => dropRow("outcomeMeasures", i)}>Remove</button></div>
          </div>
        ))}
        <button type="button" onClick={() => patchNote({ outcomeMeasures: [...note.outcomeMeasures, { name: "", score: "", scale: "", evidence: [] }] })}>Add row</button>

        <h3>Special tests</h3>
        {note.specialTests.map((r, i) => (
          <div className="sub" key={i}>
            <div className="grid2">
              <input aria-label="Test" placeholder="Test" value={r.name} onChange={(e) => setRow("specialTests", i, { name: e.target.value })} />
              <SideSelect label="Side" value={r.side} onChange={(side) => setRow("specialTests", i, { side })} />
              <input aria-label="Result" placeholder="Result" value={r.result} onChange={(e) => setRow("specialTests", i, { result: e.target.value })} />
            </div>
            <div className="row"><Source lines={r.evidence} /><button type="button" onClick={() => dropRow("specialTests", i)}>Remove</button></div>
          </div>
        ))}
        <button type="button" onClick={() => patchNote({ specialTests: [...note.specialTests, { name: "", side: "na", result: "", evidence: [] }] })}>Add row</button>

        <h3>Red flag screening</h3>
        <div className={`banner ${note.redFlags.screened ? "good" : "warn"}`}>
          <label style={{ margin: 0 }}>
            <input type="checkbox" checked={note.redFlags.screened} onChange={(e) => patchNote({ redFlags: { ...note.redFlags, screened: e.target.checked } })} />{" "}
            I confirm red flag screening was done in this consultation
          </label>
          <div className="muted">Always unticked on a new draft. Approval needs it.</div>
        </div>
        <label htmlFor="rf-find">Findings (one per line, leave empty if none)</label>
        <textarea
          id="rf-find"
          value={note.redFlags.findings.join("\n")}
          onChange={(e) => patchNote({ redFlags: { ...note.redFlags, findings: e.target.value.split("\n").filter((l) => l.trim()) } })}
        />
        <label htmlFor="rf-notes">Screening notes</label>
        <textarea id="rf-notes" value={note.redFlags.notes} onChange={(e) => patchNote({ redFlags: { ...note.redFlags, notes: e.target.value } })} />

        <h3>Problem list</h3>
        {note.problems.map((r, i) => (
          <div className="sub" key={r.id + i}>
            <div className="grid2">
              <input aria-label="Problem" placeholder="Problem" value={r.title} onChange={(e) => setRow("problems", i, { title: e.target.value })} />
              <SideSelect label="Side" value={r.side} onChange={(side) => setRow("problems", i, { side })} />
            </div>
            <div className="row"><span className="muted mono">{r.id}</span><Source lines={r.evidence} /><button type="button" onClick={() => dropRow("problems", i)}>Remove</button></div>
          </div>
        ))}
        <button type="button" onClick={() => patchNote({ problems: [...note.problems, { id: nextProblemId(), title: "", side: "na", evidence: [] }] })}>Add problem</button>

        <label htmlFor="assess">Assessment</label>
        <textarea id="assess" value={note.assessment} onChange={(e) => patchNote({ assessment: e.target.value })} />
        <label htmlFor="plan">Plan</label>
        <textarea id="plan" value={note.plan} onChange={(e) => patchNote({ plan: e.target.value })} />
      </section>

      <section className="card">
        <h2>Home exercise programme</h2>
        <label htmlFor="ptitle">Title</label>
        <input id="ptitle" value={prog.title} onChange={(e) => patchProg({ title: e.target.value })} />
        <label htmlFor="pintro">Message to the patient</label>
        <textarea id="pintro" value={prog.patientIntro} onChange={(e) => patchProg({ patientIntro: e.target.value })} />
        <label htmlFor="prev">Review in (weeks)</label>
        <input id="prev" inputMode="numeric" value={prog.reviewInWeeks ?? ""} onChange={(e) => patchProg({ reviewInWeeks: intOrNull(e.target.value) })} style={{ maxWidth: 120 }} />

        <h3>Exercises</h3>
        {prog.items.map((it, i) => {
          const set = (patch: Partial<ProgrammeDraft["items"][number]>) =>
            patchProg({ items: prog.items.map((x, n) => (n === i ? { ...x, ...patch } : x)) });
          return (
            <div className="sub" key={i}>
              <div className="grid2">
                <label>Exercise
                  <select value={it.exerciseId} onChange={(e) => set({ exerciseId: e.target.value })}>
                    {!catalogue.some((c) => c.id === it.exerciseId) && <option value={it.exerciseId}>{it.exerciseId || "Choose…"}</option>}
                    {catalogue.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </label>
                <label>Treats problem
                  <select value={it.problemId} onChange={(e) => set({ problemId: e.target.value })}>
                    {!note.problems.some((p) => p.id === it.problemId) && <option value={it.problemId}>{it.problemId} (not in note)</option>}
                    {note.problems.map((p) => (
                      <option key={p.id} value={p.id}>{p.title || p.id}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="grid2">
                <label>Sets<input inputMode="numeric" value={it.sets} onChange={(e) => set({ sets: intOrNull(e.target.value) ?? 1 })} /></label>
                <label>Reps<input inputMode="numeric" value={it.reps ?? ""} onChange={(e) => set({ reps: intOrNull(e.target.value) })} /></label>
                <label>Hold (seconds)<input inputMode="numeric" value={it.holdSeconds ?? ""} onChange={(e) => set({ holdSeconds: intOrNull(e.target.value) })} /></label>
                <label>Times per week<input inputMode="numeric" value={it.frequencyPerWeek} onChange={(e) => set({ frequencyPerWeek: intOrNull(e.target.value) ?? 1 })} /></label>
              </div>
              <label>Cue for the patient
                <input value={it.cue} onChange={(e) => set({ cue: e.target.value })} />
              </label>
              <label>How to progress
                <input value={it.progression} onChange={(e) => set({ progression: e.target.value })} />
              </label>
              <div className="row" style={{ marginTop: 8 }}>
                <Source lines={it.evidence} />
                <button type="button" onClick={() => patchProg({ items: prog.items.filter((_, n) => n !== i) })}>Remove</button>
              </div>
            </div>
          );
        })}
        <button
          type="button"
          onClick={() =>
            patchProg({
              items: [
                ...prog.items,
                { exerciseId: nextExerciseId(), problemId: note.problems[note.problems.length - 1]?.id ?? "p1", sets: 2, reps: 10, holdSeconds: null, frequencyPerWeek: 5, cue: "", progression: "", evidence: [] },
              ],
            })
          }
        >
          Add exercise
        </button>

        <label htmlFor="safety">Safety advice for the patient (one per line)</label>
        <textarea id="safety" value={prog.safetyAdvice.join("\n")} onChange={(e) => patchProg({ safetyAdvice: e.target.value.split("\n").filter((l) => l.trim()) })} />
      </section>

      <section className="card">
        <h2>Source transcript</h2>
        <p className="muted">Line numbers match the “line” references on rows above.</p>
        <ol className="transcript mono" style={{ paddingLeft: 24 }}>
          {transcriptLines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ol>
      </section>

      <section className="card">
        <h2>Check before approving</h2>
        <p className="muted">Looks at the note as it is on screen. Plain checks for things a reader would expect, then an AI second reader compares the note with the transcript. It is advice only: it changes nothing and never stops you approving.</p>
        <button type="button" onClick={runCheck} disabled={pending}>{pending ? "Working…" : "Check this note"}</button>
        <div role="status" style={{ marginTop: 8 }}>
          {check?.message ? <div className="banner warn">{check.message}</div> : null}
          {check && check.findings.length === 0 ? <div className="banner good">Nothing to flag.</div> : null}
          {check && check.findings.length > 0 ? (
            <ul className="plain">
              {check.findings.map((f, i) => (
                <li key={i}>
                  <strong>{f.severity === "check" ? "Check: " : "Consider: "}</strong>{f.message}
                  <span className="muted"> ({f.source === "assistant" ? `AI second reader, transcript line${f.lines && f.lines.length > 1 ? "s" : ""} ${f.lines?.join(", ")}` : "plain check"})</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      <section className="card">
        <h2>Approve</h2>
        <p>
          Approving as <strong>{practitioner}</strong> saves what is on screen as the final note and programme. Nothing is written to the record or sent to the patient before this.
          After approval it cannot be edited.
        </p>
        {!confirming ? (
          <div className="row">
            <button type="button" onClick={save} disabled={pending}>Save draft</button>
            <button type="button" className="primary" onClick={() => setConfirming(true)} disabled={pending}>Review and approve…</button>
          </div>
        ) : (
          <div className="banner warn">
            <p style={{ marginTop: 0 }}>I have read the note and the programme, corrected anything wrong, and take responsibility for both.</p>
            <div className="row">
              <button type="button" className="primary" onClick={approve} disabled={pending}>{pending ? "Working…" : "Yes, approve"}</button>
              <button type="button" onClick={() => setConfirming(false)} disabled={pending}>Keep editing</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
