"use client";

import { useState } from "react";

interface Q {
  id: string;
  label: string;
  type: string;
  required: boolean;
  options: string;
}

const TYPES: [string, string][] = [
  ["text", "Short answer"], ["longtext", "Long answer"], ["yesno", "Yes / no"], ["choice", "Choose one"],
  ["scale", "0 to 10 scale"], ["number", "Number"], ["date", "Date"], ["agree", "Agreement tick-box"],
];

export function FormBuilder({ initial }: { initial: { id: string; label: string; type: string; required?: boolean; options?: string[] }[] }) {
  const [qs, setQs] = useState<Q[]>(initial.map((q) => ({ id: q.id, label: q.label, type: q.type, required: !!q.required, options: (q.options ?? []).join(", ") })));
  const json = JSON.stringify(
    qs.map((q) => ({
      id: q.id, label: q.label, type: q.type, required: q.required,
      ...(q.type === "choice" ? { options: q.options.split(",").map((o) => o.trim()).filter(Boolean) } : {}),
    })),
  );
  const update = (i: number, patch: Partial<Q>) => setQs(qs.map((q, n) => (n === i ? { ...q, ...patch } : q)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= qs.length) return;
    const next = [...qs];
    [next[i], next[j]] = [next[j], next[i]];
    setQs(next);
  };
  const add = () => {
    let n = qs.length + 1;
    while (qs.some((q) => q.id === `q${n}`)) n++;
    setQs([...qs, { id: `q${n}`, label: "", type: "text", required: false, options: "" }]);
  };
  return (
    <div>
      <input type="hidden" name="fields" value={json} />
      {qs.map((q, i) => (
        <div className="sub" key={q.id}>
          <div className="grid2">
            <div>
              <label htmlFor={`ql${i}`}>Question {i + 1}</label>
              <input id={`ql${i}`} value={q.label} onChange={(e) => update(i, { label: e.target.value })} maxLength={200} />
            </div>
            <div>
              <label htmlFor={`qt${i}`}>Answer type</label>
              <select id={`qt${i}`} value={q.type} onChange={(e) => update(i, { type: e.target.value })}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </div>
          </div>
          {q.type === "choice" ? (
            <>
              <label htmlFor={`qo${i}`}>Choices, separated by commas</label>
              <input id={`qo${i}`} value={q.options} onChange={(e) => update(i, { options: e.target.value })} />
            </>
          ) : null}
          <div className="row" style={{ marginTop: 8 }}>
            <label className="inline" style={{ margin: 0 }}><input type="checkbox" checked={q.required} onChange={(e) => update(i, { required: e.target.checked })} /> Required</label>
            <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move question ${i + 1} up`}>↑</button>
            <button type="button" onClick={() => move(i, 1)} disabled={i === qs.length - 1} aria-label={`Move question ${i + 1} down`}>↓</button>
            <button type="button" className="danger" onClick={() => setQs(qs.filter((_, n) => n !== i))} aria-label={`Remove question ${i + 1}`}>Remove</button>
          </div>
        </div>
      ))}
      <button type="button" onClick={add}>Add a question</button>
    </div>
  );
}
