import Link from "next/link";
import { requireUser } from "@/lib/auth";
import type { SessionUser } from "@/lib/accounts";
import { getPlatform, withClinic } from "@/lib/app";
import { saveFormAction } from "../../actions/staff";
import { ActionForm } from "../../Forms";
import { Header } from "../../Header";
import { FormBuilder } from "./FormBuilder";

export const dynamic = "force-dynamic";

export default async function FormsSettings() {
  const user = await requireUser(["owner"]);
  return withClinic(user.clinicId, () => FormsSettingsBody(user));
}

async function FormsSettingsBody(user: SessionUser) {
  const forms = await getPlatform().forms.list(user.clinicId);
  const both = (await getPlatform().scheduling.clinic(user.clinicId)).disciplines === "both";
  const WHO = { any: "Everyone", physio: "Physiotherapy appointments", ayurveda: "Ayurveda appointments" } as const;
  return (
    <>
      <Header user={user} />
      <main style={{ maxWidth: 820 }}>
        <p className="muted"><Link href="/settings">← Settings</Link></p>
        <h1>Intake and consent forms</h1>
        <p className="muted">Active forms are sent with every new appointment. A required form must be completed before a patient can be marked as arrived (unless staff give a reason). A patient who has already completed the current version is not asked again. The starting forms are templates (the Ayurveda one has not been reviewed by a qualified practitioner): review every question before you rely on them.</p>
        {forms.map((f) => (
          <details key={f.id} className="card" open={forms.length === 1}>
            <summary><strong>{f.name}</strong> · version {f.version} · {f.active ? "active" : "not active"} · {f.mandatory ? "required" : "optional"}{both ? ` · ${WHO[f.discipline]}` : ""}</summary>
            <ActionForm action={saveFormAction} hidden={{ id: f.id, kind: f.kind }} submitLabel="Save as a new version">
              <label htmlFor={`fn${f.id}`}>Form name</label>
              <input id={`fn${f.id}`} name="name" defaultValue={f.name} required />
              {both ? (
                <>
                  <label htmlFor={`fd${f.id}`}>Sent with</label>
                  <select id={`fd${f.id}`} name="discipline" defaultValue={f.discipline}>{Object.entries(WHO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                </>
              ) : null}
              <label className="inline"><input type="checkbox" name="mandatory" value="yes" defaultChecked={f.mandatory} /> Required before arrival</label>
              <label className="inline"><input type="checkbox" name="active" value="yes" defaultChecked={f.active} /> Send with new appointments</label>
              <FormBuilder initial={f.fields} />
            </ActionForm>
          </details>
        ))}
        <details className="card">
          <summary><strong>Add a form</strong></summary>
          <ActionForm action={saveFormAction} hidden={{ kind: "consent" }} submitLabel="Create form">
            <label htmlFor="newname">Form name</label>
            <input id="newname" name="name" required />
            {both ? (
              <>
                <label htmlFor="newwho">Sent with</label>
                <select id="newwho" name="discipline" defaultValue="any">{Object.entries(WHO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </>
            ) : null}
            <label className="inline"><input type="checkbox" name="mandatory" value="yes" defaultChecked /> Required before arrival</label>
            <label className="inline"><input type="checkbox" name="active" value="yes" defaultChecked /> Send with new appointments</label>
            <FormBuilder initial={[{ id: "q1", label: "", type: "text" }]} />
          </ActionForm>
        </details>
      </main>
    </>
  );
}
