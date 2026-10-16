"use client";

import { useState, useTransition } from "react";
import { suggestCodesAction } from "../../actions/assist";
import { CopyButton } from "../../Forms";

interface Suggestion { code: string; description: string; reason: string }

/** Diagnosis-code suggestions for a claim. Advice only; nothing is saved. */
export function CodeSuggestions({ id, isMock }: { id: string; isMock: boolean }) {
  const [res, setRes] = useState<{ items?: Suggestion[]; error?: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div>
      {isMock ? <div className="banner warn">Demo assistant: these are not taken from the note. Never use with real patients.</div> : null}
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await suggestCodesAction(id);
            setRes(r.ok ? { items: (r.data as Suggestion[]) ?? [] } : { error: r.message });
          })
        }
      >
        {pending ? "Working…" : "Suggest diagnosis codes"}
      </button>
      <div role="status">
        {res?.error ? <div className="banner bad">{res.error}</div> : null}
        {res?.items && res.items.length === 0 ? <p className="muted">No suggestion fits the note. Choose the code yourself.</p> : null}
        {res?.items && res.items.length > 0 ? (
          <>
            <ul className="plain">
              {res.items.map((s) => (
                <li key={s.code}>
                  <span className="mono"><strong>{s.code}</strong></span> {s.description} <CopyButton text={s.code} label="Copy" />
                  <div className="muted">{s.reason}</div>
                </li>
              ))}
            </ul>
            <p className="muted">ICD-10 suggestions only. Insurers can use a different code set or need more detail, so check each one against the insurer&apos;s own list before you use it.</p>
          </>
        ) : null}
      </div>
    </div>
  );
}
