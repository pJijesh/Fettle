import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentSession } from "@/lib/auth";
import { signupOpen, trialDays } from "@/lib/plans";
import { signupAction } from "../actions/auth";
import { ActionForm } from "../Forms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Start your free trial" };

export default async function SignupPage() {
  if (!signupOpen()) notFound();
  const s = await currentSession();
  if (s?.mfaOk) redirect("/");
  const days = trialDays();
  return (
    <main className="narrow">
      <h1>Start your free trial</h1>
      <p className="muted">
        {days} days free with everything switched on, no card needed. After that you choose a plan; until you do, your records stay safe and can be viewed and exported, but nothing can be added or changed.
      </p>
      <div className="card">
        <ActionForm action={signupAction} submitLabel="Create clinic">
          <label htmlFor="clinicName">Clinic name</label>
          <input id="clinicName" name="clinicName" required maxLength={80} autoComplete="organization" />
          <label htmlFor="disciplines">What does the clinic practise?</label>
          <select id="disciplines" name="disciplines" defaultValue="physio">
            <option value="physio">Physiotherapy</option>
            <option value="ayurveda">Ayurveda</option>
            <option value="both">Physiotherapy and Ayurveda</option>
          </select>
          <p className="muted">You can change this later in Settings.</p>
          <label htmlFor="ownerName">Your name</label>
          <input id="ownerName" name="ownerName" required maxLength={80} autoComplete="name" />
          <label htmlFor="email">Your email</label>
          <input id="email" name="email" type="email" required autoComplete="username" />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" required minLength={12} autoComplete="new-password" aria-describedby="pwhelp" />
          <p id="pwhelp" className="muted">At least 12 characters. A few random words is fine.</p>
          <label htmlFor="password2">Password again</label>
          <input id="password2" name="password2" type="password" required minLength={12} autoComplete="new-password" />
          <p className="muted">You will set up two-step sign-in next.</p>
        </ActionForm>
      </div>
      <p className="muted">Already have an account? <Link href="/login">Sign in</Link>.</p>
    </main>
  );
}
