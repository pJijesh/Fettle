import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import type { SessionUser } from "@/lib/accounts";
import { getPlatform, getService, withClinic } from "@/lib/app";
import { DomainError } from "@/lib/service";
import { CATALOGUE } from "@/lib/ai/catalogue";
import { describeDose } from "@/lib/format";
import { transcriptLines } from "@/lib/validation";
import {
  createLinkAction,
  generateDraftsAction,
  recordConsentAction,
  resolveWritebackAction,
  revokeLinksAction,
  setPatientIdAction,
  withdrawConsentAction,
  writeBackAction,
} from "../../actions";
import { ActionForm, CopyButton, LinkMaker } from "../../Forms";
import { Header } from "../../Header";
import { ReviewForm } from "./ReviewForm";
import { AyurvedaForm } from "./AyurvedaForm";
import { AudioCapture } from "./AudioCapture";
import { CodeSuggestions } from "./AssistPanel";
import { draftLetterAction, draftSummaryAction } from "../../actions/assist";
import { DOC_LABEL } from "@/lib/documents";
import { LANGUAGES, LEVEL_LABEL, LETTER_KINDS, LETTER_LABEL, SUMMARY_LEVELS } from "@/lib/assist/tasks";
import { LIBRARY } from "@/lib/ayurveda/catalogue";
import { KIND_LABEL, KIND_ORDER } from "@/lib/ayurveda/schemas";

export const dynamic = "force-dynamic";

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" });

type Props = { params: Promise<{ id: string }> };

export default async function ConsultPage(props: Props) {
  const user = await requireUser(["owner", "clinician"]);
  return withClinic(user.clinicId, () => ConsultPageBody(props, user));
}

async function ConsultPageBody({ params }: Props, user: SessionUser) {
  const { id } = await params;
  const svc = getService(user.clinicId);

  let c;
  try {
    c = await svc.getConsult(id);
  } catch (err) {
    if (err instanceof DomainError && err.code === "not_found") notFound();
    throw err;
  }
  const lines = transcriptLines(c.transcript);
  const approved = c.status === "approved";
  const ayu = c.discipline === "ayurveda";
  const docs = !ayu && c.status === "approved" ? await getPlatform().documents.list(user.clinicId, id) : [];
  const assistInfo = getPlatform().documents.assistInfo;
  const templates = !ayu && c.status === "drafted" ? await getPlatform().templates.list(user.clinicId, { activeOnly: true }) : [];
  const hasActiveLink = c.links.some((l) => !l.revokedAt && new Date(l.expiresAt) > new Date());

  return (
    <>
      <Header user={user} />
      <main>
        <p className="muted"><Link href="/consults">← All consultations</Link></p>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h1 style={{ margin: 0 }}>{c.patientLabel}</h1>
          <span className="row">{ayu ? <span className="pill">Ayurveda</span> : null}<span className={`pill ${c.status}`}>{c.status}</span></span>
        </div>
        <p className="muted">{ayu ? "Treating practitioner" : "Treating physio"}: {c.practitioner}{c.consent ? ` · consent ${c.consent.method}, recorded ${when(c.consent.at)} by ${c.consent.by}` : ""}</p>

        {c.consentWithdrawnAt && !c.consent ? (
          <div className="banner warn">Consent was withdrawn on {when(c.consentWithdrawnAt)}. {ayu ? "The record and plan were deleted." : "The transcript and drafts were deleted."} Record consent again to start over.</div>
        ) : null}

        {/* 1. Consent gate */}
        {!c.consent && !approved ? (
          <section className="card">
            <h2>1. Patient consent</h2>
            {ayu ? (
              <p>Tell the patient that you will keep a record of this consultation, and that their treatment plan can be sent to them by a private link. No AI tool is used. Nothing is saved until you record their agreement.</p>
            ) : (
              <p>Before any recording or drafting, tell the patient that an AI tool will help draft the note and exercise programme, and that you will review both. Nothing is captured until you record their agreement.</p>
            )}
            <ActionForm action={recordConsentAction} hidden={{ id }} submitLabel="Record consent">
              <label htmlFor="method">How was consent given?</label>
              <select id="method" name="method" defaultValue="verbal">
                <option value="verbal">Verbal</option>
                <option value="written">Written</option>
              </select>
              <label style={{ fontWeight: 400 }}>
                <input type="checkbox" name="confirm" value="yes" /> {ayu ? "The patient has agreed to this record being kept and the plan being sent to them." : "The patient has agreed to AI-assisted note drafting for this consultation."}
              </label>
            </ActionForm>
          </section>
        ) : null}

        {/* 2. Transcript */}
        {c.consent && !approved && !ayu && c.status !== "drafted" ? (
          <section className="card">
            <h2>2. Consultation transcript</h2>
            <p className="muted">{svc.audioInfo.enabled ? "Record the consultation, or type or paste the transcript, one speaker turn per line." : "Type or paste the transcript, one speaker turn per line. Audio capture is not switched on for this clinic."}</p>
            {svc.audioInfo.enabled ? <AudioCapture id={id} providerName={svc.audioInfo.name} isMock={svc.audioInfo.isMock} /> : null}
            <ActionForm action={generateDraftsAction} hidden={{ id }} submitLabel="Save and generate drafts">
              <label htmlFor="transcript" className="noprint">Transcript</label>
              <textarea id="transcript" name="transcript" defaultValue={c.transcript} style={{ minHeight: 220 }} className="mono" />
            </ActionForm>
          </section>
        ) : null}

        {/* 2 (Ayurveda). Record and plan, written by the practitioner */}
        {ayu && c.consent && !approved && c.ayurveda ? (
          <AyurvedaForm
            key={c.draftedAt ?? "new"}
            id={id}
            initialRecord={c.ayurveda.record}
            initialPlan={c.ayurveda.plan}
            library={LIBRARY.map((l) => ({ id: l.id, kind: l.kind, name: l.name, where: l.where, instructions: l.instructions, cautions: l.cautions, doshas: l.doshas }))}
            practitioner={user.name}
          />
        ) : null}

        {/* 3. Review */}
        {!ayu && c.status === "drafted" ? (
          <>
            <section className="card">
              <h2>3. Review</h2>
              <p>
                Drafted {c.draftedAt ? when(c.draftedAt) : ""} by {c.draftModel}. Check every line against what happened in the room; the drafts are suggestions, not facts.
              </p>
              <details>
                <summary>Edit the transcript and draft again</summary>
                <ActionForm
                  action={generateDraftsAction}
                  hidden={{ id }}
                  submitLabel="Draft again from this transcript"
                  submitClass=""
                  confirmText="Drafting again replaces the note and programme you see below, including your edits. Continue?"
                >
                  <textarea name="transcript" defaultValue={c.transcript} style={{ minHeight: 160 }} className="mono" aria-label="Transcript" />
                </ActionForm>
              </details>
            </section>
            <ReviewForm
              key={c.draftedAt ?? "new"}
              id={id}
              initialNote={c.note}
              initialProgramme={c.programme}
              catalogue={CATALOGUE.map((e) => ({ id: e.id, name: e.name }))}
              transcriptLines={lines}
              practitioner={user.name}
              templates={templates.map((t) => ({ id: t.id, name: t.name, body: t.body }))}
            />
          </>
        ) : null}

        {/* Approved */}
        {approved && c.approval ? (
          <>
            <section className="card">
              <h2>Approved</h2>
              <div className="banner good">Approved by {c.approval.by} on {when(c.approval.at)}. Reference <span className="mono">{c.approval.hash.slice(0, 12)}</span>.</div>
              {c.approval.ayurveda ? (
                <>
                  <h3>Plan: {c.approval.ayurveda.plan.title}</h3>
                  <p className="muted">Approved under {c.approval.ayurveda.record.qualifications}.</p>
                  {KIND_ORDER.filter((k) => c.approval!.ayurveda!.plan.items.some((i) => i.kind === k)).map((k) => (
                    <div key={k}>
                      <h4>{KIND_LABEL[k]}</h4>
                      <ul className="plain">
                        {c.approval!.ayurveda!.plan.items.filter((i) => i.kind === k).map((i, n) => (
                          <li key={n}><strong>{i.name}</strong>{i.where === "clinic" ? <span className="muted"> · in clinic</span> : null}{i.duration ? <span className="muted"> · {i.duration}</span> : null}<div>{i.instructions}</div></li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </>
              ) : (
                <>
                  <h3>Programme: {c.approval.programme.title}</h3>
                  <table>
                    <thead><tr><th>Exercise</th><th>Dose</th></tr></thead>
                    <tbody>
                      {c.approval.programme.items.map((it, i) => (
                        <tr key={i}>
                          <td>{CATALOGUE.find((e) => e.id === it.exerciseId)?.name ?? it.exerciseId}</td>
                          <td>{describeDose(it)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </section>

            <section className="card">
              <h2>Send to the patient</h2>
              <p className="muted">The patient opens the link on their phone with no sign-in and sees their {ayu ? "plan" : "programme"}. Links expire after 8 weeks and can be revoked.</p>
              <LinkMaker action={createLinkAction} id={id} hasActive={hasActiveLink} />
              {!hasActiveLink && c.links.length > 0 ? (
                <p className="muted" role="status">No active patient link. The last one {c.links[0].revokedAt ? `was revoked ${when(c.links[0].revokedAt)}` : "has expired"}.</p>
              ) : null}
              {hasActiveLink ? (
                <div style={{ marginTop: 12 }}>
                  <ActionForm action={revokeLinksAction} hidden={{ id }} submitLabel="Revoke patient links" submitClass="danger" confirmText="The patient will no longer be able to open their programme. Revoke?" />
                </div>
              ) : null}
            </section>

            <section className="card">
              <h2>Add to the practice record</h2>
              {svc.targetInfo.map((t) => {
                const wb = c.writebacks.find((w) => w.target === t.name);
                return (
                  <div key={t.name}>
                    <h3>{t.label}</h3>
                    {!t.configured ? (
                      <p className="muted">Not set up in this installation. Use the copy-ready note below.</p>
                    ) : (
                      <>
                        {wb?.status === "succeeded" ? (
                          <div className="banner good">Written to {t.label}{wb.external_id ? ` (note ${wb.external_id})` : ""} on {when(wb.updated_at)}.</div>
                        ) : (
                          <>
                            <ActionForm action={setPatientIdAction} hidden={{ id }} submitLabel="Save patient ID" submitClass="">
                              <label htmlFor="pmsPatientId">{t.label} patient ID</label>
                              <input id="pmsPatientId" name="pmsPatientId" defaultValue={c.pmsPatientId ?? ""} inputMode="numeric" style={{ maxWidth: 240 }} />
                            </ActionForm>
                            {wb?.status === "needs_check" ? (
                              <div className="banner warn" style={{ marginTop: 12 }}>
                                <p style={{ marginTop: 0 }}>An earlier attempt did not report back, so the note may or may not be in {t.label}. Check the patient&apos;s record, then say what you found. Nothing is retried until you do.</p>
                                <ActionForm action={resolveWritebackAction} hidden={{ id, target: t.name }} submitLabel="Record what I found">
                                  <label><input type="radio" name="outcome" value="written" /> The note is in {t.label}</label>
                                  <label><input type="radio" name="outcome" value="not_written" /> The note is not there</label>
                                  <label htmlFor="externalId">Note ID (optional)</label>
                                  <input id="externalId" name="externalId" style={{ maxWidth: 240 }} />
                                </ActionForm>
                              </div>
                            ) : (
                              <div style={{ marginTop: 12 }}>
                                {wb?.status === "failed" ? <div className="banner bad">Last attempt failed: {wb.error}</div> : null}
                                <ActionForm action={writeBackAction} hidden={{ id, target: t.name }} submitLabel={wb ? `Try again` : `Write note to ${t.label}`} />
                              </div>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
              <h3>Copy-ready note</h3>
              <pre className="transcript mono card" style={{ background: "var(--bg)" }}>{await svc.approvedNoteText(id)}</pre>
              <CopyButton text={await svc.approvedNoteText(id)} />
            </section>

            {!ayu ? (
              <section className="card">
                <h2>Letters and summaries</h2>
                <p className="muted">Written by an AI assistant from the approved note, as a draft. You read, edit and finalise each one; nothing reaches a patient or another clinician until you do, and nothing is sent automatically. Names are not sent to the assistant.</p>
                {assistInfo.isMock ? <div className="banner warn">Demo assistant: it writes placeholder text, not from the note. Never use with real patients.</div> : null}
                {docs.length ? (
                  <ul className="plain">
                    {docs.map((d) => (
                      <li key={d.id}>
                        <Link href={`/consults/${id}/documents/${d.id}`}><strong>{DOC_LABEL[d.kind]}</strong>{d.language && d.language !== "English" ? ` (${d.language})` : ""}</Link> · {d.status === "draft" ? "draft" : d.status === "final" ? `finalised ${when(d.finalisedAt!)}` : "withdrawn"}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <details>
                  <summary><strong>Write a letter</strong></summary>
                  <ActionForm action={draftLetterAction} hidden={{ id }} submitLabel="Write a draft">
                    <label htmlFor="lk">Kind of letter</label>
                    <select id="lk" name="kind" defaultValue="gp_update">{LETTER_KINDS.map((k) => <option key={k} value={k}>{LETTER_LABEL[k]}</option>)}</select>
                    <label htmlFor="li">Anything to include or stress (optional)</label>
                    <textarea id="li" name="instruction" maxLength={500} placeholder="For example: ask the GP to review the patient's pain medication" />
                  </ActionForm>
                </details>
                <details>
                  <summary><strong>Write a summary for the patient</strong></summary>
                  <p className="muted">Shown on the patient&apos;s link once you finalise it. For a language other than English, ask someone who speaks it to check it before you finalise; the assistant can make mistakes.</p>
                  <ActionForm action={draftSummaryAction} hidden={{ id }} submitLabel="Write a draft">
                    <label htmlFor="sl">Reading level</label>
                    <select id="sl" name="level" defaultValue="plain">{SUMMARY_LEVELS.map((k) => <option key={k} value={k}>{LEVEL_LABEL[k]}</option>)}</select>
                    <label htmlFor="sg">Language</label>
                    <select id="sg" name="language" defaultValue="English">{LANGUAGES.map((k) => <option key={k} value={k}>{k}</option>)}</select>
                  </ActionForm>
                </details>
                <details>
                  <summary><strong>Diagnosis codes for an insurance claim</strong></summary>
                  <CodeSuggestions id={id} isMock={assistInfo.isMock} />
                </details>
              </section>
            ) : null}

            <section className="card">
              <h2>Patient check-ins</h2>
              {c.checkIns.length === 0 ? (
                <p className="muted">None yet.</p>
              ) : (
                <ul className="plain">
                  {c.checkIns.map((k) => (
                    <li key={k.id}>
                      <strong>{when(k.createdAt)}</strong>: {ayu ? "followed the plan" : "exercises done"}: {k.adherence}; {ayu ? "symptoms" : "pain"}: {k.painChange}
                      {k.comment ? <div className="muted">“{k.comment}”</div> : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        ) : null}

        {c.consent && !approved ? (
          <section className="card">
            <h2>Patient withdraws consent</h2>
            <p className="muted">{ayu ? "Deletes the record and plan and stops further entries. Use this if the patient changes their mind before approval." : "Deletes the transcript and both drafts and stops capture. Use this if the patient changes their mind before approval."}</p>
            <ActionForm action={withdrawConsentAction} hidden={{ id }} submitLabel="Withdraw consent and delete data" submitClass="danger" confirmText={ayu ? "This permanently deletes the record and plan for this consultation. Continue?" : "This permanently deletes the transcript and drafts for this consultation. Continue?"} />
          </section>
        ) : null}

        <details className="card">
          <summary>History</summary>
          <table>
            <tbody>
              {c.audit.map((a, i) => (
                <tr key={i}>
                  <td>{when(a.at)}</td>
                  <td>{a.actor}</td>
                  <td className="mono">{a.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </main>
    </>
  );
}
