"use client";

import { useState, useTransition } from "react";
import { AGNI_LABEL, DOSHAS, KIND_LABEL, KIND_ORDER, KIND_SINGULAR, type Agni, type Ama, type AyurvedaPlan, type AyurvedaRecord, type Dosha, type PlanItem, type PlanKind, type Pregnancy } from "@/lib/ayurveda/schemas";
import { approveAyurvedaAction, saveAyurvedaAction } from "../../actions";
import type { ActionState } from "@/lib/action-util";
import { Feedback } from "../../Forms";

export interface LibraryOption {
  id: string;
  kind: Exclude<PlanKind, "herb">;
  name: string;
  where: "home" | "clinic";
  instructions: string;
  cautions: string;
  doshas: Dosha[];
}

const cap = (d: string) => d[0].toUpperCase() + d.slice(1);
const intOrNull = (v: string): number | null => {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

function DoshaPicker({ legend, value, onChange }: { legend: string; value: Dosha[]; onChange: (v: Dosha[]) => void }) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: "8px 0" }}>
      <legend>{legend}</legend>
      <div className="row">
        {DOSHAS.map((d) => (
          <label key={d} className="inline">
            <input type="checkbox" checked={value.includes(d)} onChange={(e) => onChange(e.target.checked ? [...value, d] : value.filter((x) => x !== d))} /> {cap(d)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function AyurvedaForm({
  id,
  initialRecord,
  initialPlan,
  library,
  practitioner,
}: {
  id: string;
  initialRecord: AyurvedaRecord;
  initialPlan: AyurvedaPlan;
  library: LibraryOption[];
  practitioner: string;
}) {
  const [rec, setRec] = useState(initialRecord);
  const [plan, setPlan] = useState(initialPlan);
  const [state, setState] = useState<ActionState>({});
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [pick, setPick] = useState(library[0]?.id ?? "");

  const payload = () => JSON.stringify({ record: rec, plan });
  const patch = (p: Partial<AyurvedaRecord>) => setRec((r) => ({ ...r, ...p }));
  const patchPlan = (p: Partial<AyurvedaPlan>) => setPlan((x) => ({ ...x, ...p }));
  const setItem = (i: number, p: Partial<PlanItem>) => patchPlan({ items: plan.items.map((x, n) => (n === i ? { ...x, ...p } : x)) });

  function save() {
    start(async () => setState(await saveAyurvedaAction(id, payload())));
  }
  function approve() {
    start(async () => {
      setState(await approveAyurvedaAction(id, payload()));
      setConfirming(false);
    });
  }
  function addFromLibrary() {
    const lib = library.find((l) => l.id === pick);
    if (!lib) return;
    patchPlan({ items: [...plan.items, { kind: lib.kind, libraryId: lib.id, name: lib.name, instructions: lib.instructions, duration: "", where: lib.where, cautions: lib.cautions }] });
  }
  const addCustom = (kind: PlanKind) =>
    patchPlan({ items: [...plan.items, { kind, libraryId: null, name: "", instructions: "", duration: "", where: kind === "therapy" ? "clinic" : "home", cautions: "" }] });

  const text = (label: string, key: keyof AyurvedaRecord & ("history" | "pastHistory" | "diet" | "sleep" | "digestion" | "mind" | "examination" | "assessment" | "plan"), rows = 3) => (
    <>
      <label htmlFor={`a-${key}`}>{label}</label>
      <textarea id={`a-${key}`} rows={rows} value={rec[key]} onChange={(e) => patch({ [key]: e.target.value } as Partial<AyurvedaRecord>)} />
    </>
  );

  return (
    <div>
      <Feedback state={state} />

      <section className="card">
        <h2>Consultation record</h2>
        <label htmlFor="a-qual">Your qualification</label>
        <input id="a-qual" value={rec.qualifications} onChange={(e) => patch({ qualifications: e.target.value })} placeholder="The qualification you practise under" />
        <label htmlFor="a-cc">Main complaint</label>
        <textarea id="a-cc" rows={2} value={rec.chiefComplaint} onChange={(e) => patch({ chiefComplaint: e.target.value })} />
        {text("History of the complaint", "history")}
        {text("Past history", "pastHistory")}

        <label htmlFor="a-med">Medicines, herbs and supplements the patient takes</label>
        <textarea id="a-med" rows={2} value={rec.medications} onChange={(e) => patch({ medications: e.target.value })} />
        <div className="muted">Needed to check for interactions. Write “none” if nothing.</div>
        <label htmlFor="a-all">Allergies</label>
        <textarea id="a-all" rows={2} value={rec.allergies} onChange={(e) => patch({ allergies: e.target.value })} />

        <h3>Lifestyle</h3>
        {text("Diet and appetite", "diet", 2)}
        {text("Sleep", "sleep", 2)}
        {text("Digestion and elimination", "digestion", 2)}
        {text("Mind, stress and energy", "mind", 2)}

        <h3>Assessment</h3>
        <DoshaPicker legend="Constitution (prakriti)" value={rec.prakriti.doshas} onChange={(doshas) => patch({ prakriti: { ...rec.prakriti, doshas } })} />
        <input aria-label="Notes on constitution" placeholder="Notes on constitution" value={rec.prakriti.notes} onChange={(e) => patch({ prakriti: { ...rec.prakriti, notes: e.target.value } })} />
        <DoshaPicker legend="Current imbalance (vikriti)" value={rec.vikriti.doshas} onChange={(doshas) => patch({ vikriti: { ...rec.vikriti, doshas } })} />
        <input aria-label="Notes on current imbalance" placeholder="Notes on current imbalance" value={rec.vikriti.notes} onChange={(e) => patch({ vikriti: { ...rec.vikriti, notes: e.target.value } })} />
        <div className="grid2" style={{ marginTop: 8 }}>
          <label>Agni (digestive fire)
            <select value={rec.agni} onChange={(e) => patch({ agni: e.target.value as Agni })}>
              {(Object.keys(AGNI_LABEL) as Agni[]).map((a) => <option key={a} value={a}>{AGNI_LABEL[a]}</option>)}
            </select>
          </label>
          <label>Ama (toxins)
            <select value={rec.ama} onChange={(e) => patch({ ama: e.target.value as Ama })}>
              <option value="unsure">Not assessed</option><option value="present">Present</option><option value="absent">Absent</option>
            </select>
          </label>
        </div>
        {text("Examination (pulse, tongue and other findings)", "examination")}

        <h3>Safety screen</h3>
        <div className={`banner ${rec.safety.screened ? "good" : "warn"}`}>
          <label style={{ margin: 0 }}>
            <input type="checkbox" checked={rec.safety.screened} onChange={(e) => patch({ safety: { ...rec.safety, screened: e.target.checked } })} /> I confirm I asked about conditions needing medical attention, current medicines (including anticoagulants and other prescribed medicines), allergies and pregnancy, and referred where needed
          </label>
          <div className="muted">Always unticked on a new record. Approval needs it.</div>
        </div>
        <label htmlFor="a-preg">Pregnant or breastfeeding?</label>
        <select id="a-preg" value={rec.safety.pregnancy} onChange={(e) => patch({ safety: { ...rec.safety, pregnancy: e.target.value as Pregnancy } })} style={{ maxWidth: 260 }}>
          <option value="not_asked">Not asked yet</option><option value="no">No</option><option value="yes">Yes</option><option value="not_applicable">Not applicable</option>
        </select>
        <label htmlFor="a-find">Findings that need attention or referral (one per line, empty if none)</label>
        <textarea id="a-find" rows={2} value={rec.safety.findings.join("\n")} onChange={(e) => patch({ safety: { ...rec.safety, findings: e.target.value.split("\n").filter((l) => l.trim()) } })} />
        <label htmlFor="a-sn">Safety notes</label>
        <textarea id="a-sn" rows={2} value={rec.safety.notes} onChange={(e) => patch({ safety: { ...rec.safety, notes: e.target.value } })} />

        {text("Assessment (your reasoning: causes, how it developed, what is out of balance)", "assessment")}
        {text("Plan in brief", "plan", 2)}
      </section>

      <section className="card">
        <h2>Treatment plan</h2>
        <div className="banner warn">
          Starter items are general and have not been reviewed by a qualified Ayurvedic practitioner. Herbs and doses are always your own entries: the software supplies none. Check every item against this patient, their medicines and any pregnancy.
        </div>
        <label htmlFor="a-title">Title</label>
        <input id="a-title" value={plan.title} onChange={(e) => patchPlan({ title: e.target.value })} />
        <label htmlFor="a-intro">Message to the patient</label>
        <textarea id="a-intro" rows={3} value={plan.patientIntro} onChange={(e) => patchPlan({ patientIntro: e.target.value })} />
        <label htmlFor="a-rev">Review in (weeks)</label>
        <input id="a-rev" inputMode="numeric" value={plan.reviewInWeeks ?? ""} onChange={(e) => patchPlan({ reviewInWeeks: intOrNull(e.target.value) })} style={{ maxWidth: 120 }} />

        {KIND_ORDER.map((kind) => {
          const rows = plan.items.map((it, i) => ({ it, i })).filter((x) => x.it.kind === kind);
          return (
            <div key={kind}>
              <h3>{KIND_LABEL[kind]}</h3>
              {rows.length === 0 ? <p className="muted">None.</p> : null}
              {rows.map(({ it, i }) => (
                <div className="sub" key={i}>
                  <label>{KIND_SINGULAR[kind]}
                    <input value={it.name} onChange={(e) => setItem(i, { name: e.target.value })} />
                  </label>
                  <label>{kind === "herb" ? "Form, dose and when to take it (your entry)" : "How to do it"}
                    <textarea rows={2} value={it.instructions} onChange={(e) => setItem(i, { instructions: e.target.value })} />
                  </label>
                  <div className="grid2">
                    <label>For how long<input value={it.duration} onChange={(e) => setItem(i, { duration: e.target.value })} placeholder="e.g. 4 weeks" /></label>
                    <label>Where
                      <select value={it.where} onChange={(e) => setItem(i, { where: e.target.value as "home" | "clinic" })}>
                        <option value="home">At home</option><option value="clinic">In clinic</option>
                      </select>
                    </label>
                  </div>
                  <label>Cautions{kind === "herb" ? " (required: interactions, who should avoid it)" : ""}
                    <textarea rows={2} value={it.cautions} onChange={(e) => setItem(i, { cautions: e.target.value })} />
                  </label>
                  <div className="row" style={{ marginTop: 8 }}>
                    {it.libraryId ? <span className="muted">From the starter library</span> : <span className="muted">Your own entry</span>}
                    <button type="button" onClick={() => patchPlan({ items: plan.items.filter((_, n) => n !== i) })}>Remove</button>
                  </div>
                </div>
              ))}
              <button type="button" onClick={() => addCustom(kind)}>Add {kind === "herb" ? "a herb or preparation" : `my own ${KIND_SINGULAR[kind].toLowerCase()} item`}</button>
            </div>
          );
        })}

        <h3>Add from the starter library</h3>
        <div className="row" style={{ alignItems: "end" }}>
          <label style={{ flex: 1 }}>Item
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              {(["therapy", "diet", "lifestyle"] as const).map((k) => (
                <optgroup key={k} label={KIND_LABEL[k]}>
                  {library.filter((l) => l.kind === k).map((l) => <option key={l.id} value={l.id}>{l.name}{l.where === "clinic" ? " (in clinic)" : ""}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          <button type="button" onClick={addFromLibrary}>Add to plan</button>
        </div>

        <label htmlFor="a-safe">Safety advice for the patient (one per line)</label>
        <textarea id="a-safe" rows={3} value={plan.safetyAdvice.join("\n")} onChange={(e) => patchPlan({ safetyAdvice: e.target.value.split("\n").filter((l) => l.trim()) })} />
      </section>

      <section className="card">
        <h2>Approve</h2>
        <p>
          Approving as <strong>{practitioner}</strong> saves what is on screen as the final record and plan. Nothing is written to the practice record or sent to the patient before this. After approval it cannot be edited.
        </p>
        {!confirming ? (
          <div className="row">
            <button type="button" onClick={save} disabled={pending}>Save</button>
            <button type="button" className="primary" onClick={() => setConfirming(true)} disabled={pending}>Review and approve…</button>
          </div>
        ) : (
          <div className="banner warn">
            <p style={{ marginTop: 0 }}>I have read the record and the plan, I am qualified to give this advice, and I take responsibility for both.</p>
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
