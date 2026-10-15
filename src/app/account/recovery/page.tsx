import Link from "next/link";
import { sessionToken, requireUser } from "@/lib/auth";
import { getAccounts } from "@/lib/app";
import { recoveryCodesAction } from "../../actions/auth";
import { RecoveryCodes } from "./Codes";

export const dynamic = "force-dynamic";

export default async function RecoveryPage({ searchParams }: { searchParams: Promise<{ first?: string }> }) {
  await requireUser();
  const sp = await searchParams;
  const left = await getAccounts().recoveryCodesLeft((await sessionToken()) ?? "");
  return (
    <main className="narrow">
      <h1>Recovery codes</h1>
      {sp.first ? <div className="banner good" role="status">Two-step sign-in is on. Make your recovery codes now, in case you lose your phone.</div> : null}
      <div className="card">
        <p>If you lose your phone, a recovery code lets you sign in without the authenticator app. Without one, your clinic owner has to reset your two-step sign-in.</p>
        <RecoveryCodes action={recoveryCodesAction} left={left} />
      </div>
      <p><Link href="/calendar">Back to the calendar</Link></p>
    </main>
  );
}
