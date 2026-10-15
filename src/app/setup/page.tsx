import { redirect } from "next/navigation";
import { getAccounts } from "@/lib/app";
import { setupAction } from "../actions/auth";
import { ActionForm } from "../Forms";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await getAccounts().hasUsers()) redirect("/login");
  return (
    <main className="narrow">
      <h1>Set up your clinic</h1>
      <p className="muted">This creates your clinic and its owner account. You will set up two-step sign-in next. This page stops working once an account exists.</p>
      <div className="card">
        <ActionForm action={setupAction} submitLabel="Create clinic">
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
        </ActionForm>
      </div>
    </main>
  );
}
