"use client";

import { useActionState } from "react";
import { icalCreateAction } from "../actions/staff";
import { Feedback } from "../Forms";
import type { ActionState } from "@/lib/action-util";

export function IcalMaker({ hasActive }: { hasActive: boolean }) {
  const [state, run, pending] = useActionState(icalCreateAction as (p: ActionState, f: FormData) => Promise<ActionState>, {});
  return (
    <form action={run}>
      <Feedback state={state} />
      {state.url ? (
        <div className="banner good">
          <div>Add this address to your calendar app as a subscription. It is shown once.</div>
          <input readOnly value={state.url} className="mono" onFocus={(e) => e.currentTarget.select()} aria-label="Calendar feed address" />
          <button type="button" style={{ marginTop: 8 }} onClick={() => navigator.clipboard?.writeText(state.url!)}>Copy address</button>
        </div>
      ) : null}
      <button type="submit" className="primary" disabled={pending}>{pending ? "Working…" : hasActive ? "Make a new link (stops the old one)" : "Make my calendar link"}</button>
    </form>
  );
}
