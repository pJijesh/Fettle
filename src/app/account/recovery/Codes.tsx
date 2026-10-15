"use client";

import { useActionState } from "react";
import type { ActionState } from "@/lib/action-util";
import { Feedback } from "../../Forms";

export function RecoveryCodes({ action, left }: { action: () => Promise<ActionState>; left: number }) {
  const [state, run, pending] = useActionState(async () => action(), {} as ActionState);
  const codes = (state.data as string[] | undefined) ?? null;
  return (
    <form action={run}>
      <Feedback state={state} />
      {codes ? (
        <div className="banner good">
          <p>Keep these somewhere safe, such as a password manager or printed. Each works once, in place of the authenticator code. They are shown only now.</p>
          <ul className="mono" style={{ columns: 2, listStyle: "none", padding: 0 }}>
            {codes.map((c) => <li key={c}>{c}</li>)}
          </ul>
          <button type="button" onClick={() => navigator.clipboard?.writeText(codes.join("\n"))}>Copy codes</button>
        </div>
      ) : (
        <p className="muted">{left > 0 ? `You have ${left} unused recovery code${left === 1 ? "" : "s"}.` : "You have no recovery codes yet."}</p>
      )}
      <button type="submit" className="primary" disabled={pending}>
        {pending ? "Working…" : left > 0 || codes ? "Make new codes (replaces the old ones)" : "Make recovery codes"}
      </button>
    </form>
  );
}
