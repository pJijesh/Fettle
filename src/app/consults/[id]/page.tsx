import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getService } from "@/lib/app";
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

export const dynamic = "force-dynamic";

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" });

export default async function ConsultPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(["owner", "clinician"]);
  const { id } = await params;
  const svc = getService(user.clinicId);

  let c;
  try {
    c = svc.getConsult(id);
  } catch (err) {
    if (err instanceof DomainError && err.code === "not_found") notFound();
    throw err;
  }
  const lines = transcriptLines(c.transcript);
  const approved = c.status === "approved";
  const hasActiveLink = c.links.some((l) => !l.revokedAt && new Date(l.expiresAt) > new Date());

  return (
    <>
      <Header user={user} />
      <main>
        <p className="muted"><Link href="/consults">← All consultations</Link></p>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h1 style={{ margin: 0 }}>{c.patientLabel}</h1>
          <span className={`pill ${c.status}`}>{c.status}</span>
        </div>
        <p className="muted">Treating physio: {c.practitioner}{c.consent ? ` · consent ${c.consent.method}, recorded ${when(c.consent.at)} by ${c.consent.by}` : ""}</p>

        {c.consentWithdrawnAt && !c.consent ? (
          <div className="banner warn">Consent was withdrawn on {when(c.consentWithdrawnAt)}. The transcript and drafts were deleted. Record consent again to start over.</div>
        ) : null}

        {/* 1. Consent gate */}
        {!c.consent && !approved ? (
          <section className="card">
            <h2>1. Patient consent</h2>
            <p>Before any recording or drafting, tell the patient that an AI tool will help draft the note and exercise programme, and that you will review both. Nothing is captured until you record their agreement.</p>
            <ActionForm action={recordConsentAction} hidden={{ id }} submitLabel="Record consent">
              <label htmlFor="method">How was consent given?</label>
              <select id="method" name="method" defaultValue="verbal">
                <option value="verbal">Verbal</option>
                <option value="written">Written</option>
              </select>
              <label style={{ fontWeight: 400 }}>
                <input type="checkbox" name="confirm" value="yes" /> The patient has agreed to AI-assisted note drafting for this consultation.
              </label>
            </ActionForm>
          </section>
        ) : null}

        {/* 2. Transcript */}
        {c.consent && !approved && c.status !== "drafted" ? (
          <section className="card">
            <h2>2. Consultation transcript</h2>
            <p className="muted">Type or paste the transcript, one speaker turn per line. Audio capture is not part of this version.</p>
            <ActionForm action={generateDraftsAction} hidden={{ id }} submitLabel="Save and generate drafts">
              <label htmlFor="transcript" className="noprint">Transcript</label>
              <textarea id="transcript" name="transcript" defaultValue={c.transcript} style={{ minHeight: 220 }} className="mono" />
            </ActionForm>
          </section>
        ) : null}

        {/* 3. Review */}
        {c.status === "drafted" ? (
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
            />
          </>
        ) : null}

        {/* Approved */}
        {approved && c.approval ? (
          <>
            <section className="card">
              <h2>Approved</h2>
              <div className="banner good">Approved by {c.approval.by} on {when(c.approval.at)}. Reference <span className="mono">{c.approval.hash.slice(0, 12)}</span>.</div>
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
            </section>

            <section className="card">
              <h2>Send to the patient</h2>
              <p className="muted">The patient opens the link on their phone with no sign-in. Links expire after 8 weeks and can be revoked.</p>
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
              <pre className="transcript mono card" style={{ background: "var(--bg)" }}>{svc.approvedNoteText(id)}</pre>
              <CopyButton text={svc.approvedNoteText(id)} />
            </section>

            <section className="card">
              <h2>Patient check-ins</h2>
              {c.checkIns.length === 0 ? (
                <p className="muted">None yet.</p>
              ) : (
                <ul className="plain">
                  {c.checkIns.map((k) => (
                    <li key={k.id}>
                      <strong>{when(k.createdAt)}</strong>: exercises done: {k.adherence}; pain: {k.painChange}
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
            <p className="muted">Deletes the transcript and both drafts and stops capture. Use this if the patient changes their mind before approval.</p>
            <ActionForm action={withdrawConsentAction} hidden={{ id }} submitLabel="Withdraw consent and delete data" submitClass="danger" confirmText="This permanently deletes the transcript and drafts for this consultation. Continue?" />
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
