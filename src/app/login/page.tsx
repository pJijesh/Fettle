import { redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { getAccounts } from "@/lib/app";
import { loginAction } from "../actions/auth";
import { ActionForm } from "../Forms";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (!await getAccounts().hasUsers()) redirect("/setup");
  const s = await currentSession();
  if (s?.mfaOk) redirect("/");
  return (
    <main className="narrow">
      <h1>Sign in</h1>
      <div className="card">
        <ActionForm action={loginAction} submitLabel="Continue">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="username" required />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
          <p className="muted">You will be asked for a code from your authenticator app next.</p>
        </ActionForm>
      </div>
    </main>
  );
}
