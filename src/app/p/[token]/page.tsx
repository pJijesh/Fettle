import type { Metadata } from "next";
import { getPublicService } from "@/lib/app";
import { checkInAction } from "../../actions";
import { ActionForm } from "../../Forms";
import { KIND_LABEL } from "@/lib/ayurveda/schemas";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your plan", robots: { index: false, follow: false } };

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
        <p>Please contact your clinic for a new one.</p>
      </main>
    );
  }

  if (view.ayurveda) return <AyurvedaPlanPage token={token} view={view} />;

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

async function AyurvedaPlanPage({ token, view }: { token: string; view: NonNullable<Awaited<ReturnType<ReturnType<typeof getPublicService>["getPatientView"]>>> }) {
  const a = view.ayurveda!;
  return (
    <main style={{ maxWidth: 560 }}>
      <h1>{a.title}</h1>
      <p className="muted">From {view.practitioner}</p>
      {a.intro ? <p>{a.intro}</p> : null}

      <div className="banner warn">
        <strong>Before you start</strong>
        <ul>
          {a.safetyAdvice.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
          <li>This plan was written for you by your practitioner. Do not stop or change any medicine from your doctor because of it.</li>
          <li>Tell your doctor or pharmacist about any herbs or supplements you take.</li>
          <li>If you feel unwell, have a rash, swelling or trouble breathing after any item, stop it and contact your practitioner, NHS 111 or a doctor. In an emergency call 999.</li>
        </ul>
      </div>

      {a.groups.map((g) => (
        <section key={g.kind}>
          <h2>{KIND_LABEL[g.kind]}</h2>
          {g.items.map((it, i) => (
            <div key={i} className="card">
              <strong>{it.name}</strong>
              <div className="muted">{[it.where === "clinic" ? "In clinic" : "At home", it.duration].filter(Boolean).join(" · ")}</div>
              <p style={{ margin: "6px 0 0" }}>{it.instructions}</p>
              {it.cautions ? <p className="muted" style={{ margin: "6px 0 0" }}>Take care: {it.cautions}</p> : null}
            </div>
          ))}
        </section>
      ))}
      {a.reviewInWeeks ? <p>Your practitioner will review how you are getting on in about {a.reviewInWeeks} weeks.</p> : null}

      <section className="card">
        <h2>How is it going?</h2>
        <ActionForm action={checkInAction} hidden={{ token }} submitLabel="Send">
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend><strong>Did you follow your plan?</strong></legend>
            <div className="tap">
              <label><input type="radio" name="adherence" value="all" required /><span>All of it</span></label>
              <label><input type="radio" name="adherence" value="some" /><span>Some</span></label>
              <label><input type="radio" name="adherence" value="none" /><span>None</span></label>
            </div>
          </fieldset>
          <fieldset style={{ border: 0, padding: 0, margin: "16px 0 0" }}>
            <legend><strong>How are your symptoms?</strong></legend>
            <div className="tap">
              <label><input type="radio" name="painChange" value="better" required /><span>Better</span></label>
              <label><input type="radio" name="painChange" value="same" /><span>Same</span></label>
              <label><input type="radio" name="painChange" value="worse" /><span>Worse</span></label>
            </div>
          </fieldset>
          <label htmlFor="comment">Anything to tell your practitioner? (optional)</label>
          <textarea id="comment" name="comment" maxLength={500} />
        </ActionForm>
        <p className="muted">This form is not checked in real time. If you are getting worse, contact your practitioner, NHS 111 or a doctor.</p>
      </section>
    </main>
  );
}
