import type { Metadata } from "next";
import { getPlatform } from "@/lib/app";
import { DomainError } from "@/lib/errors";
import { submitFormAction } from "../../actions/public";
import { ActionForm } from "../../Forms";
import { PublicShell } from "../../PublicShell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your form", robots: { index: false, follow: false } };

export default async function FormPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let v;
  try {
    v = getPlatform().booking.formByToken(token);
  } catch (err) {
    if (err instanceof DomainError) {
      return <PublicShell clinicName="Form"><h1>This link is not valid</h1><p>Please check the link in your email, or phone the clinic.</p></PublicShell>;
    }
    throw err;
  }
  const { request: r } = v;
  if (r.status === "completed") {
    return (
      <PublicShell clinicName={v.clinicName}>
        <h1>{r.formName}</h1>
        <div className="banner good" role="status">Thank you, {v.patientFirstName}. Your answers have been sent to the clinic.</div>
      </PublicShell>
    );
  }
  return (
    <PublicShell clinicName={v.clinicName}>
      <h1>{r.formName}</h1>
      <p className="muted">Hello {v.patientFirstName}. Your answers go to your clinician and are kept in your record. Questions marked * need an answer.</p>
      <div className="card">
        <ActionForm action={submitFormAction} hidden={{ token }} submitLabel="Send my answers">
          {r.fields.map((f) => {
            const name = `q_${f.id}`;
            const label = `${f.label}${f.required && f.type !== "agree" ? " *" : ""}`;
            if (f.type === "agree") {
              return <label key={f.id} className="inline" style={{ marginTop: 12 }}><input type="checkbox" name={name} value="yes" /> {f.label}{f.required ? " *" : ""}</label>;
            }
            if (f.type === "yesno" || f.type === "choice") {
              const opts: [string, string][] = f.type === "yesno" ? [["yes", "Yes"], ["no", "No"]] : (f.options ?? []).map((o) => [o, o]);
              return (
                <fieldset key={f.id}>
                  <legend>{label}</legend>
                  <div className="inline">{opts.map(([val, text]) => <label key={val}><input type="radio" name={name} value={val} /> {text}</label>)}</div>
                </fieldset>
              );
            }
            return (
              <div key={f.id}>
                <label htmlFor={name}>{label}</label>
                {f.type === "longtext" ? <textarea id={name} name={name} maxLength={4000} /> : f.type === "scale" ? <input id={name} name={name} type="number" min={0} max={10} step={1} inputMode="numeric" style={{ maxWidth: 120 }} /> : f.type === "number" ? <input id={name} name={name} type="number" inputMode="decimal" style={{ maxWidth: 160 }} /> : f.type === "date" ? <input id={name} name={name} type="date" style={{ maxWidth: 200 }} /> : <input id={name} name={name} maxLength={300} />}
              </div>
            );
          })}
        </ActionForm>
      </div>
    </PublicShell>
  );
}
