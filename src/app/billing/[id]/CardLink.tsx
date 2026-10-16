"use client";

import { useActionState } from "react";
import type { ActionState } from "@/lib/action-util";

/** Makes a card payment link for an invoice and shows it to copy. Nothing is stored; each press makes a link. */
export function CardLink({ action, invoiceId, amount }: { action: (prev: ActionState, form: FormData) => Promise<ActionState>; invoiceId: string; amount: string }) {
  const [state, run, pending] = useActionState(action, {} as ActionState);
  return (
    <form action={run}>
      <input type="hidden" name="id" value={invoiceId} />
      {state.message ? <div className={`banner ${state.ok ? "good" : "bad"}`} role={state.ok ? "status" : "alert"}>{state.message}</div> : null}
      {state.url ? (
        <div className="banner good">
          <input readOnly value={state.url} className="mono" onFocus={(e) => e.currentTarget.select()} aria-label="Card payment link" />
          <button type="button" style={{ marginTop: 8 }} onClick={() => navigator.clipboard?.writeText(state.url!)}>Copy link</button>
        </div>
      ) : null}
      <button type="submit" disabled={pending}>{pending ? "Working…" : `Make a card payment link for ${amount}`}</button>
    </form>
  );
}
