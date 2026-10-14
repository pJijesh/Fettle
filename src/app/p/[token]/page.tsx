import type { Metadata } from "next";
import { getPublicService } from "@/lib/app";
import { checkInAction } from "../../actions";
import { ActionForm } from "../../Forms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your exercise programme", robots: { index: false, follow: false } };

function dose(d: { sets: number; reps: number | null; holdSeconds: number | null; frequencyPerWeek: number }) {
  const parts: string[] = [];
  parts.push(d.reps !== null ? `${d.sets} sets of ${d.reps}` : `${d.sets} sets`);
  if (d.holdSeconds !== null) parts.push(`hold ${d.holdSeconds} seconds`);
  parts.push(`${d.frequencyPerWeek} days a week`);
  return parts.join(", ");
}

export default async function PatientPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await getPublicService().getPatientView(token);

  if (!view) {
    return (
      <main style={{ maxWidth: 560 }}>
        <h1>This link is no longer active</h1>
        <p>Please contact your physiotherapist for a new one.</p>
      </main>
    );
  }

  const p = view.programme;
  return (
    <main style={{ maxWidth: 560 }}>
      <h1>{p.title}</h1>
      <p className="muted">From {view.practitioner}</p>
      {p.intro ? <p>{p.intro}</p> : null}

      {p.safetyAdvice.length ? (
        <div className="banner warn">
          <strong>Before you start</strong>
          <ul>
            {p.safetyAdvice.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <ol style={{ paddingLeft: 20 }}>
        {p.items.map((it, i) => (
          <li key={i} className="card" style={{ listStylePosition: "inside" }}>
            <strong>{it.name}</strong>
            <div>{dose(it.dose)}</div>
            {it.cue ? <p style={{ margin: "6px 0 0" }}>{it.cue}</p> : null}
            {it.progression ? <p className="muted" style={{ margin: "6px 0 0" }}>When it feels easy: {it.progression}</p> : null}
          </li>
        ))}
      </ol>
      {p.reviewInWeeks ? <p>Your physio will review how you are getting on in about {p.reviewInWeeks} weeks.</p> : null}

      <section className="card">
        <h2>How is it going?</h2>
        <ActionForm action={checkInAction} hidden={{ token }} submitLabel="Send">
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend><strong>Did you do your exercises?</strong></legend>
            <div className="tap">
              <label><input type="radio" name="adherence" value="all" required /><span>All of them</span></label>
              <label><input type="radio" name="adherence" value="some" /><span>Some</span></label>
              <label><input type="radio" name="adherence" value="none" /><span>None</span></label>
            </div>
          </fieldset>
          <fieldset style={{ border: 0, padding: 0, margin: "16px 0 0" }}>
            <legend><strong>How is your pain?</strong></legend>
            <div className="tap">
              <label><input type="radio" name="painChange" value="better" required /><span>Better</span></label>
              <label><input type="radio" name="painChange" value="same" /><span>Same</span></label>
              <label><input type="radio" name="painChange" value="worse" /><span>Worse</span></label>
            </div>
          </fieldset>
          <label htmlFor="comment">Anything to tell your physio? (optional)</label>
          <textarea id="comment" name="comment" maxLength={500} />
        </ActionForm>
        <p className="muted">
          If your pain is getting much worse, or you have new numbness, weakness or trouble with your bladder or bowels, stop and contact your physio, NHS 111 or a doctor. In an emergency call 999.
          This form is not checked in real time.
        </p>
      </section>
    </main>
  );
}
