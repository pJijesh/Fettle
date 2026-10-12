import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { mfaAction } from "../../actions/auth";
import { ActionForm } from "../../Forms";

export const dynamic = "force-dynamic";

export default async function MfaPage() {
  const s = await currentSession();
  if (!s) redirect("/login");
  if (s.mfaOk) redirect("/");
  if (!s.mfaEnabled) redirect("/account/mfa");
  return (
    <main className="narrow">
      <h1>Enter your code</h1>
      <div className="card">
        <ActionForm action={mfaAction} submitLabel="Sign in">
          <label htmlFor="code">6-digit code from your authenticator app</label>
          <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required autoFocus />
        </ActionForm>
      </div>
    </main>
  );
}
