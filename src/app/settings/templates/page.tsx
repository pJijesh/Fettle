import Link from "next/link";
import { requireUser } from "@/lib/auth";
import type { SessionUser } from "@/lib/accounts";
import { getPlatform, withClinic } from "@/lib/app";
import { bodyToText, type NoteTemplate } from "@/lib/templates";
import { addStarterTemplatesAction, deleteTemplateAction, saveTemplateAction } from "../../actions/staff";
import { ActionForm } from "../../Forms";
import { Header } from "../../Header";

export const dynamic = "force-dynamic";

export default async function TemplatesSettings() {
  const user = await requireUser(["owner", "clinician"]);
  return withClinic(user.clinicId, () => Body(user));
}

function Fields({ t, prefix }: { t?: NoteTemplate; prefix: string }) {
  const x = t ? bodyToText(t.body) : { subjective: "", objective: "", rom: "", outcomeMeasures: "", specialTests: "", assessment: "", plan: "" };
  return (
    <>
      <label htmlFor={`${prefix}n`}>Template name</label>
      <input id={`${prefix}n`} name="name" defaultValue={t?.name ?? ""} required maxLength={80} />
      <label className="inline"><input type="checkbox" name="active" value="yes" defaultChecked={t?.active ?? true} /> Offer this template on the review screen</label>
      <label htmlFor={`${prefix}s`}>Subjective: standard wording (leave empty for none)</label>
      <textarea id={`${prefix}s`} name="subjective" defaultValue={x.subjective} />
      <label htmlFor={`${prefix}o`}>Objective: standard wording</label>
      <textarea id={`${prefix}o`} name="objective" defaultValue={x.objective} />
      <label htmlFor={`${prefix}r`}>Range of movement rows to prompt for</label>
      <textarea id={`${prefix}r`} name="rom" defaultValue={x.rom} className="mono" placeholder="Knee, Flexion, left" />
      <div className="muted">One per line: joint, movement, side (left, right, both or leave out), unit (deg, cm or other; deg if left out).</div>
      <label htmlFor={`${prefix}m`}>Outcome measures to prompt for</label>
      <textarea id={`${prefix}m`} name="outcomeMeasures" defaultValue={x.outcomeMeasures} className="mono" placeholder="NPRS, 0-10" />
      <div className="muted">One per line: name, scale.</div>
      <label htmlFor={`${prefix}t`}>Special tests to prompt for</label>
      <textarea id={`${prefix}t`} name="specialTests" defaultValue={x.specialTests} className="mono" placeholder="Lachman, left" />
      <div className="muted">One per line: test, side.</div>
      <label htmlFor={`${prefix}a`}>Assessment: standard wording</label>
      <textarea id={`${prefix}a`} name="assessment" defaultValue={x.assessment} />
      <label htmlFor={`${prefix}p`}>Plan: standard wording</label>
      <textarea id={`${prefix}p`} name="plan" defaultValue={x.plan} />
    </>
  );
}

async function Body(user: SessionUser) {
  const templates = await getPlatform().templates.list(user.clinicId);
  return (
    <>
      <Header user={user} />
      <main style={{ maxWidth: 820 }}>
        <p className="muted"><Link href="/settings">← Settings</Link></p>
        <h1>Note templates</h1>
        <p className="muted">
          A template is a starting point for a physiotherapy note. On the review screen the physio chooses one, and it adds the rows to fill in and any standard wording you have written. It only fills boxes that are empty and adds rows that are not already there; it never changes what the physio or the AI has written. A template cannot hold a finding, a score or a result, and it never ticks red flag screening, so the physio still examines, records and approves everything. Applying a template is not clinical advice: write only what you would want to be prompted to cover.
        </p>
        {templates.length === 0 ? (
          <section className="card">
            <p>You have no templates yet. Add a few examples to edit, or write your own below. The examples list what to look at, not what to conclude, and have not been reviewed by a clinician.</p>
            <ActionForm action={addStarterTemplatesAction} submitLabel="Add example templates" />
          </section>
        ) : null}
        {templates.map((t) => (
          <details key={t.id} className="card">
            <summary><strong>{t.name}</strong> · {t.active ? "offered" : "not offered"}</summary>
            <ActionForm action={saveTemplateAction} hidden={{ id: t.id }} submitLabel="Save changes">
              <Fields t={t} prefix={`t${t.id}`} />
            </ActionForm>
            <div style={{ marginTop: 12 }}>
              <ActionForm action={deleteTemplateAction} hidden={{ id: t.id }} submitLabel="Delete this template" submitClass="danger" confirmText="Delete this template? Notes already written are not affected." />
            </div>
          </details>
        ))}
        <details className="card" open={templates.length === 0}>
          <summary><strong>Add a template</strong></summary>
          <ActionForm action={saveTemplateAction} submitLabel="Create template">
            <Fields prefix="new" />
          </ActionForm>
        </details>
        {templates.length > 0 ? (
          <details className="card">
            <summary><strong>Example templates</strong></summary>
            <p className="muted">Adds any of the examples you do not already have.</p>
            <ActionForm action={addStarterTemplatesAction} submitLabel="Add example templates" submitClass="" />
          </details>
        ) : null}
      </main>
    </>
  );
}
