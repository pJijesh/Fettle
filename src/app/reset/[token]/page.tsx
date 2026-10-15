import Link from "next/link";
import { getAccounts } from "@/lib/app";
import { resetPasswordWithLinkAction } from "../../actions/auth";
import { ActionForm } from "../../Forms";

export const dynamic = "force-dynamic";

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const valid = await getAccounts().resetLinkValid(token);
  if (!valid) {
    return (
      <main className="narrow">
        <h1>This link no longer works</h1>
        <p>Reset links last an hour and can be used once. <Link href="/forgot-password">Ask for a new one</Link>.</p>
      </main>
    );
  }
  return (
    <main className="narrow">
      <h1>Choose a new password</h1>
      <div className="card">
        <ActionForm action={resetPasswordWithLinkAction} hidden={{ token }} submitLabel="Change password">
          <label htmlFor="password">New password</label>
          <input id="password" name="password" type="password" required minLength={12} autoComplete="new-password" aria-describedby="pwhelp" />
          <p id="pwhelp" className="muted">At least 12 characters. A few random words is fine.</p>
          <label htmlFor="password2">New password again</label>
          <input id="password2" name="password2" type="password" required minLength={12} autoComplete="new-password" />
        </ActionForm>
      </div>
    </main>
  );
}
