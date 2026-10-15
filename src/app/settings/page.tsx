import Link from "next/link";
import { requireUser } from "@/lib/auth";
import type { SessionUser } from "@/lib/accounts";
import { getPlatform, withClinic } from "@/lib/app";
import { formatPence, poundsField } from "@/lib/money";
import { minutesToClock } from "@/lib/tz";
import { saveBillingSettingsAction } from "../actions/billing";
import { createUserAction, deactivateUserAction, icalRevokeAction, resetMfaAction, resetPasswordAction, saveHoursAction, saveTypeAction } from "../actions/staff";
import { ActionForm } from "../Forms";
import { Header } from "../Header";
import { IcalMaker } from "./IcalMaker";

export const dynamic = "force-dynamic";
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const COLOURS = ["blue", "green", "amber", "red", "purple", "grey"];

export default async function Settings() {
  const user = await requireUser(["owner", "clinician"]);
  return withClinic(user.clinicId, () => SettingsBody(user));
}

async function SettingsBody(user: SessionUser) {
  const p = getPlatform();
  const isOwner = user.role === "owner";
  const hasFeed = await p.ical.hasActive(user.clinicId, user.id);
  const types = isOwner ? await p.scheduling.listTypes(user.clinicId) : [];
  const billing = isOwner ? await p.billing.getSettings(user.clinicId) : null;
  const staff = isOwner ? await p.accounts.listUsers(user.clinicId) : [];
  const clinic = await p.scheduling.clinic(user.clinicId);
  const clinicianHours = isOwner
    ? await Promise.all((await p.scheduling.clinicians(user.clinicId)).map(async (c) => ({ c, hrs: await p.scheduling.getHours(user.clinicId, c.id) })))
    : [];
  const base = p.baseUrl();

  return (
    <>
      <Header user={user} />
      <main style={{ maxWidth: 900 }}>
        <h1>Settings</h1>
        {isOwner ? (
          <p className="row">
            <Link className="btn" href="/settings/forms">Intake forms</Link>
            <Link className="btn" href="/settings/import">Switch from another system</Link>
            <Link className="btn" href="/dev/outbox">Outbox</Link>
          </p>
        ) : null}

        <section className="card" aria-labelledby="feed">
          <h2 id="feed">My calendar feed</h2>
          <p className="muted">Shows your appointments in Google, Apple or Outlook Calendar, read-only. Events show patient initials and appointment type only. Anyone with the link can read it, so keep it private. Making a new link stops the old one.</p>
          <IcalMaker hasActive={hasFeed} />
          {hasFeed ? <div style={{ marginTop: 8 }}><ActionForm action={icalRevokeAction} submitLabel="Stop my calendar link" submitClass="danger" /></div> : null}
        </section>

        {isOwner ? (
          <>
            <section className="card" aria-labelledby="online">
              <h2 id="online">Online booking</h2>
              <p>Patients book at <span className="mono">{base}/book/{clinic.slug}</span> and sign in to their account at <span className="mono">{base}/portal/{clinic.slug}</span>.</p>
              <p><Link href={`/book/${clinic.slug}`}>Open the booking page</Link></p>
            </section>

            <section className="card" aria-labelledby="types">
              <h2 id="types">Appointment types</h2>
              {types.map((t) => (
                <details key={t.id} className="sub">
                  <summary>{t.name} · {t.durationMin} min{t.pricePence ? ` · ${formatPence(t.pricePence)}` : ""}{t.bufferMin ? ` + ${t.bufferMin} buffer` : ""}{t.active ? "" : " · not offered"}{t.onlineBookable ? " · online" : ""}</summary>
                  <ActionForm action={saveTypeAction} hidden={{ id: t.id }} submitLabel="Save type" submitClass="">
                    <div className="grid2">
                      <div><label htmlFor={`n${t.id}`}>Name</label><input id={`n${t.id}`} name="name" defaultValue={t.name} required /></div>
                      <div><label htmlFor={`d${t.id}`}>Minutes</label><input id={`d${t.id}`} name="durationMin" type="number" min={5} max={480} defaultValue={t.durationMin} required /></div>
                      <div><label htmlFor={`b${t.id}`}>Buffer after (minutes)</label><input id={`b${t.id}`} name="bufferMin" type="number" min={0} max={120} defaultValue={t.bufferMin} /></div>
                      <div><label htmlFor={`c${t.id}`}>Colour</label><select id={`c${t.id}`} name="colour" defaultValue={t.colour}>{COLOURS.map((c) => <option key={c}>{c}</option>)}</select></div>
                      <div><label htmlFor={`p${t.id}`}>Price (£)</label><input id={`p${t.id}`} name="price" inputMode="decimal" defaultValue={poundsField(t.pricePence)} /></div>
                    </div>
                    <label className="inline"><input type="checkbox" name="onlineBookable" value="yes" defaultChecked={t.onlineBookable} /> Patients can book this online</label>
                    <label className="inline"><input type="checkbox" name="active" value="yes" defaultChecked={t.active} /> Offered</label>
                  </ActionForm>
                </details>
              ))}
              <h3>Add a type</h3>
              <ActionForm action={saveTypeAction} submitLabel="Add type" submitClass="">
                <div className="grid2">
                  <div><label htmlFor="nn">Name</label><input id="nn" name="name" required /></div>
                  <div><label htmlFor="nd">Minutes</label><input id="nd" name="durationMin" type="number" min={5} max={480} defaultValue={30} required /></div>
                  <div><label htmlFor="nb">Buffer after (minutes)</label><input id="nb" name="bufferMin" type="number" min={0} max={120} defaultValue={5} /></div>
                  <div><label htmlFor="nc">Colour</label><select id="nc" name="colour">{COLOURS.map((c) => <option key={c}>{c}</option>)}</select></div>
                  <div><label htmlFor="np">Price (£)</label><input id="np" name="price" inputMode="decimal" defaultValue="0.00" /></div>
                </div>
                <label className="inline"><input type="checkbox" name="onlineBookable" value="yes" defaultChecked /> Patients can book this online</label>
              </ActionForm>
            </section>

            {billing ? (
              <section className="card" aria-labelledby="billing">
                <h2 id="billing">Billing</h2>
                <p className="muted">Prices are set on each appointment type above. These settings apply to every invoice from now on; invoices already issued do not change.</p>
                <ActionForm action={saveBillingSettingsAction} submitLabel="Save billing settings" submitClass="">
                  <div className="grid2">
                    <div><label htmlFor="ip">Invoice number prefix</label><input id="ip" name="invoicePrefix" defaultValue={billing.invoicePrefix} maxLength={8} required /></div>
                    <div><label htmlFor="cp">Credit note prefix</label><input id="cp" name="creditPrefix" defaultValue={billing.creditPrefix} maxLength={8} required /></div>
                    <div><label htmlFor="vr">VAT rate (%)</label><input id="vr" name="vatRate" inputMode="decimal" defaultValue={String(billing.vatRateBp / 100)} /></div>
                    <div><label htmlFor="pt">Payment terms (days)</label><input id="pt" name="paymentTermsDays" type="number" min={0} max={365} defaultValue={billing.paymentTermsDays} required /></div>
                  </div>
                  <label htmlFor="bd">Details printed on invoices</label>
                  <textarea id="bd" name="billingDetails" rows={4} maxLength={1000} defaultValue={billing.billingDetails} />
                  <p className="muted">Your trading name, address, VAT number if you are registered, and how to pay (bank details). Leave the VAT rate at 0 if you are not VAT registered.</p>
                </ActionForm>
              </section>
            ) : null}

            <section className="card" aria-labelledby="hours">
              <h2 id="hours">Working hours</h2>
              <p className="muted">Online booking only offers times inside these hours. Leave a day empty for days off; use the second row for a split day (for example 09:00–12:30 and 14:00–17:30).</p>
              {clinicianHours.map(({ c, hrs }) => {
                return (
                  <details key={c.id} className="sub">
                    <summary>{c.name}</summary>
                    <ActionForm action={saveHoursAction} hidden={{ userId: c.id }} submitLabel="Save hours" submitClass="">
                      <div className="tablewrap" tabIndex={0} role="region" aria-label="Scrollable table">
                        <table>
                          <thead><tr><th scope="col">Day</th><th scope="col">From</th><th scope="col">To</th><th scope="col">From (2nd block)</th><th scope="col">To</th></tr></thead>
                          <tbody>
                            {DAYS.map((d, i) => {
                              const blocks = hrs.filter((h) => h.weekday === i + 1);
                              return (
                                <tr key={d}>
                                  <th scope="row">{d}</th>
                                  {[0, 1].flatMap((n) => [
                                    <td key={`s${n}`}><input aria-label={`${d} block ${n + 1} start, 24-hour`} name={`d${i + 1}_${n + 1}_start`} defaultValue={blocks[n] ? minutesToClock(blocks[n].startMin) : ""} placeholder="09:00" pattern="[0-9]{1,2}:[0-9]{2}" /></td>,
                                    <td key={`e${n}`}><input aria-label={`${d} block ${n + 1} end, 24-hour`} name={`d${i + 1}_${n + 1}_end`} defaultValue={blocks[n] ? minutesToClock(blocks[n].endMin) : ""} placeholder="17:00" pattern="[0-9]{1,2}:[0-9]{2}" /></td>,
                                  ])}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </ActionForm>
                  </details>
                );
              })}
            </section>

            <section className="card" aria-labelledby="staff">
              <h2 id="staff">Staff</h2>
              <div className="tablewrap" tabIndex={0} role="region" aria-label="Scrollable table">
                <table>
                  <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Two-step</th><th scope="col">Status</th></tr></thead>
                  <tbody>
                    {staff.map((s) => (
                      <tr key={s.id}>
                        <td>{s.name}</td><td>{s.email}</td><td>{s.role}</td><td>{s.mfa ? "On" : "Not yet set up"}</td><td>{s.active ? "Active" : "Deactivated"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3>Add a person</h3>
              <ActionForm action={createUserAction} submitLabel="Add person" submitClass="">
                <div className="grid2">
                  <div><label htmlFor="sn">Name</label><input id="sn" name="name" required autoComplete="off" /></div>
                  <div><label htmlFor="se">Email</label><input id="se" name="email" type="email" required autoComplete="off" /></div>
                  <div><label htmlFor="sp">First password (they should change it)</label><input id="sp" name="password" type="password" minLength={12} required autoComplete="new-password" /></div>
                  <div><label htmlFor="sr">Role</label><select id="sr" name="role"><option value="clinician">Clinician (diary, patients, notes)</option><option value="reception">Reception (diary and patients, no clinical notes)</option><option value="owner">Owner (everything)</option></select></div>
                </div>
              </ActionForm>
              <h3>Reset a password, reset two-step sign-in, or deactivate</h3>
              {staff.filter((s) => s.id !== user.id).map((s) => (
                <details key={s.id} className="sub">
                  <summary>{s.name}</summary>
                  <ActionForm action={resetPasswordAction} hidden={{ id: s.id }} submitLabel="Set new password" submitClass="">
                    <label htmlFor={`pw${s.id}`}>New password</label>
                    <input id={`pw${s.id}`} name="password" type="password" minLength={12} required autoComplete="new-password" />
                  </ActionForm>
                  {s.mfa ? <div style={{ marginTop: 8 }}><ActionForm action={resetMfaAction} hidden={{ id: s.id }} submitLabel="Reset two-step sign-in" submitClass="" confirmText={`Reset two-step sign-in for ${s.name}? They will be signed out and must set it up again. Use this if they lost their phone and have no recovery codes.`} /></div> : null}
                  {s.active ? <div style={{ marginTop: 8 }}><ActionForm action={deactivateUserAction} hidden={{ id: s.id }} submitLabel={`Deactivate ${s.name}`} submitClass="danger" confirmText={`Deactivate ${s.name}? They will be signed out.`} /></div> : null}
                </details>
              ))}
            </section>
          </>
        ) : null}
      </main>
    </>
  );
}
