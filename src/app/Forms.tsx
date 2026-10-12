"use client";

import { startTransition, useActionState } from "react";
import type { ActionState } from "@/lib/action-util";

type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

const idle: ActionState = {};

const ROW_LABEL: [RegExp, string][] = [
  [/^programme\.items\.(\d+)/, "Exercise"],
  [/^note\.rom\.(\d+)/, "Range of movement row"],
  [/^note\.outcomeMeasures\.(\d+)/, "Outcome measure"],
  [/^note\.specialTests\.(\d+)/, "Special test"],
  [/^note\.problems\.(\d+)/, "Problem"],
];

function issueText(path: string, message: string): string {
  for (const [re, label] of ROW_LABEL) {
    const m = re.exec(path);
    if (m) return `${label} ${Number(m[1]) + 1}: ${message}`;
  }
  return message;
}

export function Feedback({ state }: { state: ActionState }) {
  if (!state.message && !state.issues?.length) return null;
  return (
    <div className={`banner ${state.ok ? "good" : "bad"}`} role={state.ok ? "status" : "alert"}>
      {state.message}
      {state.issues?.length ? (
        <ul>
          {state.issues.map((i, n) => (
            <li key={n}>{issueText(i.path, i.message)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A form wired to a server action, with the result shown above the buttons. */
export function ActionForm({
  action,
  children,
  hidden,
  submitLabel,
  submitClass = "primary",
  confirmText,
  extraButtons,
  encType,
}: {
  action: Action;
  children?: React.ReactNode;
  hidden?: Record<string, string>;
  submitLabel: string;
  submitClass?: string;
  confirmText?: string;
  extraButtons?: { label: string; name: string; value: string; className?: string }[];
  encType?: string;
}) {
  const [state, run, pending] = useActionState(action, idle);
  return (
    <form
      encType={encType}
      onSubmit={(e) => {
        // Submitting through a transition (rather than the form's action attribute) stops React
        // clearing the fields when a request fails, so typed text is never lost.
        e.preventDefault();
        if (confirmText && !window.confirm(confirmText)) return;
        const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
        const data = new FormData(e.currentTarget, submitter instanceof HTMLButtonElement ? submitter : undefined);
        startTransition(() => run(data));
      }}
    >
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <Feedback state={state} />
      {children}
      <div className="row" style={{ marginTop: 12 }}>
        <button type="submit" className={submitClass} disabled={pending}>
          {pending ? "Working…" : submitLabel}
        </button>
        {extraButtons?.map((b) => (
          <button key={b.value} type="submit" name={b.name} value={b.value} className={b.className} disabled={pending}>
            {b.label}
          </button>
        ))}
      </div>
    </form>
  );
}

export function LinkMaker({ action, id, hasActive }: { action: Action; id: string; hasActive: boolean }) {
  const [state, run, pending] = useActionState(action, idle);
  return (
    <form action={run}>
      <input type="hidden" name="id" value={id} />
      <Feedback state={state} />
      {state.url ? (
        <div className="banner good">
          <div>Send this link to the patient. It is shown once and cannot be recovered; making another link replaces it.</div>
          <input readOnly value={state.url} className="mono" onFocus={(e) => e.currentTarget.select()} aria-label="Patient link" />
          <div className="muted">Expires {new Date(state.expiresAt!).toLocaleDateString("en-GB")}.</div>
          <button type="button" style={{ marginTop: 8 }} onClick={() => navigator.clipboard?.writeText(state.url!)}>
            Copy link
          </button>
        </div>
      ) : null}
      <button type="submit" className="primary" disabled={pending}>
        {pending ? "Working…" : hasActive ? "Make a new link (replaces the old one)" : "Create patient link"}
      </button>
    </form>
  );
}

export function CopyButton({ text, label = "Copy note" }: { text: string; label?: string }) {
  return (
    <button type="button" onClick={() => navigator.clipboard?.writeText(text)}>
      {label}
    </button>
  );
}
