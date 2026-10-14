import Link from "next/link";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { currentSession, sessionToken } from "@/lib/auth";
import { getAccounts } from "@/lib/app";
import { mfaAction } from "../../actions/auth";
import { ActionForm } from "../../Forms";

export const dynamic = "force-dynamic";

export default async function EnrolMfa() {
  const s = await currentSession();
  if (!s) redirect("/login");
  if (s.mfaEnabled) {
    if (!s.mfaOk) redirect("/login/mfa");
    return (
      <main className="narrow">
        <h1>Two-step sign-in</h1>
        <div className="banner good">Two-step sign-in is on for your account.</div>
        <p><Link href="/">Back to the calendar</Link></p>
      </main>
    );
  }
  const token = (await sessionToken()) ?? "";
  const accounts = getAccounts();
  const setup = (await accounts.pendingMfa(token)) ?? (await accounts.beginMfa(token));
  const qr = await QRCode.toDataURL(setup.uri, { margin: 1, width: 220 });
  return (
    <main className="narrow">
      <h1>Set up two-step sign-in</h1>
      <p>Every account needs a second step. Use an authenticator app (such as Microsoft Authenticator, Google Authenticator or 1Password).</p>
      <div className="card">
        <ol>
          <li>Scan this code with the app.</li>
        </ol>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qr} width={220} height={220} alt="QR code to scan with your authenticator app" />
        <p className="muted">Cannot scan it? Enter this key by hand: <span className="mono">{setup.secret}</span></p>
        <ActionForm action={mfaAction} submitLabel="Turn on and sign in">
          <label htmlFor="code">Then enter the 6-digit code the app shows</label>
          <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required />
        </ActionForm>
      </div>
    </main>
  );
}
