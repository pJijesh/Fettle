import Link from "next/link";
import { forgotPasswordAction } from "../actions/auth";
import { ActionForm } from "../Forms";

export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  return (
    <main className="narrow">
      <h1>Reset your password</h1>
      <div className="card">
        <ActionForm action={forgotPasswordAction} submitLabel="Email me a link">
          <label htmlFor="email">Your work email</label>
          <input id="email" name="email" type="email" autoComplete="username" required />
          <p className="muted">If the address has an account, we will email a link that works for an hour. You will still need your authenticator app to sign in afterwards.</p>
        </ActionForm>
        <p className="muted" style={{ marginTop: 12 }}><Link href="/login">Back to sign in</Link></p>
      </div>
    </main>
  );
}
