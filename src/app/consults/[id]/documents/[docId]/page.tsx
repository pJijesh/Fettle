import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import type { SessionUser } from "@/lib/accounts";
import { getPlatform, withClinic } from "@/lib/app";
import { DOC_LABEL } from "@/lib/documents";
import { deleteDocumentAction, finaliseDocumentAction, withdrawDocumentAction } from "../../../../actions/assist";
import { ActionForm, PrintButton } from "../../../../Forms";
import { Header } from "../../../../Header";

export const dynamic = "force-dynamic";

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { timeZone: "Europe/London", dateStyle: "long" });

type Props = { params: Promise<{ id: string; docId: string }> };

export default async function DocumentPage(props: Props) {
  const user = await requireUser(["owner", "clinician"]);
  return withClinic(user.clinicId, () => Body(props, user));
}

async function Body({ params }: Props, user: SessionUser) {
  const { id, docId } = await params;
  const p = getPlatform();
  let got;
  try {
    got = await p.documents.get(user.clinicId, docId);
  } catch {
    notFound();
  }
  const { doc, context: c } = got;
  if (doc.consultId !== id) notFound();
  const letter = doc.kind !== "patient_summary";
  const info = p.documents.assistInfo;
  const isDraft = doc.status === "draft";
  const address = [c.address, c.postcode].filter(Boolean).join(", ");

  return (
    <>
      <Header user={user} />
      <main style={{ maxWidth: 760 }}>
        <p className="muted noprint"><Link href={`/consults/${id}`}>← Back to the consultation</Link></p>
        <div className="row noprint" style={{ justifyContent: "space-between" }}>
          <h1 style={{ margin: 0 }}>{DOC_LABEL[doc.kind]}{doc.language && doc.language !== "English" ? ` (${doc.language})` : ""}</h1>
          <span className={`pill ${doc.status}`}>{doc.status}</span>
        </div>
        <p className="muted noprint">
          Drafted by {doc.draftModel} on {when(doc.createdAt)}.{doc.finalisedAt ? ` Finalised by ${doc.finalisedBy} on ${when(doc.finalisedAt)}.` : ""}
        </p>

        {isDraft ? (
          <>
            {info.isMock ? <div className="banner warn noprint">Demo assistant: this is placeholder text, not written from the note.</div> : null}
            <div className="banner warn noprint">
              This is an AI draft. Read all of it against the approved note and correct anything wrong or missing before you finalise.
              {doc.language && doc.language !== "English" ? ` It is written in ${doc.language}; have someone who speaks it check it first.` : ""}
              {doc.kind === "patient_summary" ? " Once finalised it appears on the patient's link." : " It is not sent anywhere: print it or copy it."}
            </div>
            <ActionForm action={finaliseDocumentAction} hidden={{ id, docId }} submitLabel="Finalise" extraButtons={[{ label: "Save draft", name: "intent", value: "save", className: "" }]}>
              {letter ? (
                <>
                  <label htmlFor="subject">Subject</label>
                  <input id="subject" name="subject" defaultValue={doc.subject} maxLength={150} />
                </>
              ) : <input type="hidden" name="subject" value="" />}
              <label htmlFor="body">{letter ? "Letter" : "Summary"}</label>
              <textarea id="body" name="body" defaultValue={doc.body} style={{ minHeight: 300 }} />
            </ActionForm>
            <div style={{ marginTop: 12 }}>
              <ActionForm action={deleteDocumentAction} hidden={{ id, docId }} submitLabel="Delete this draft" submitClass="danger" confirmText="Delete this draft?" />
            </div>
          </>
        ) : (
          <>
            {letter ? (
              <article className="card" style={{ lineHeight: 1.5 }}>
                <p style={{ margin: 0 }}><strong>{c.clinicName}</strong></p>
                <p className="muted" style={{ marginTop: 0 }}>{day(doc.finalisedAt ?? doc.createdAt)}</p>
                <p>{doc.kind === "referral" ? "Dear Colleague," : c.gpName ? `Dear ${c.gpName},` : "Dear Doctor,"}{c.gpPractice ? <><br /><span className="muted">{c.gpPractice}</span></> : null}</p>
                <p><strong>Re: {c.patientName}{c.dob ? `, date of birth ${c.dob}` : ""}</strong>{address ? <><br />{address}</> : null}</p>
                {doc.subject ? <p><strong>{doc.subject}</strong></p> : null}
                {doc.body.split(/\n{2,}/).map((para, i) => <p key={i} style={{ whiteSpace: "pre-wrap" }}>{para}</p>)}
                <p>Yours sincerely,<br /><br />{doc.finalisedBy ?? c.practitioner}<br /><span className="muted">Physiotherapist, {c.clinicName}</span></p>
              </article>
            ) : (
              <article className="card" style={{ lineHeight: 1.5 }}>
                {doc.body.split(/\n{2,}/).map((para, i) => <p key={i} style={{ whiteSpace: "pre-wrap" }}>{para}</p>)}
                <p className="muted">{doc.status === "final" ? "This is shown on the patient's link." : "Withdrawn: the patient no longer sees this."}</p>
              </article>
            )}
            <div className="row noprint">
              <PrintButton />
              {doc.status === "final" && !letter ? <ActionForm action={withdrawDocumentAction} hidden={{ id, docId }} submitLabel="Withdraw from the patient's link" submitClass="danger" confirmText="The patient will no longer see this summary. Withdraw?" /> : null}
            </div>
          </>
        )}
      </main>
    </>
  );
}
