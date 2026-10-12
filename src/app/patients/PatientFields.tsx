import type { Patient } from "@/lib/scheduling";

export function PatientFields({ p }: { p?: Patient }) {
  return (
    <>
      <div className="grid2">
        <div>
          <label htmlFor="firstName">First name</label>
          <input id="firstName" name="firstName" defaultValue={p?.firstName} required maxLength={80} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="lastName">Last name</label>
          <input id="lastName" name="lastName" defaultValue={p?.lastName} required maxLength={80} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="dob">Date of birth</label>
          <input id="dob" name="dob" type="date" defaultValue={p?.dob ?? ""} />
        </div>
        <div>
          <label htmlFor="phone">Mobile</label>
          <input id="phone" name="phone" type="tel" defaultValue={p?.phone ?? ""} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" defaultValue={p?.email ?? ""} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="gpName">GP</label>
          <input id="gpName" name="gpName" defaultValue={p?.gpName ?? ""} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="gpPractice">GP practice</label>
          <input id="gpPractice" name="gpPractice" defaultValue={p?.gpPractice ?? ""} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="address">Address</label>
          <input id="address" name="address" defaultValue={p?.address ?? ""} maxLength={200} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="postcode">Postcode</label>
          <input id="postcode" name="postcode" defaultValue={p?.postcode ?? ""} maxLength={12} autoComplete="off" />
        </div>
      </div>
      <fieldset>
        <legend>What the patient has agreed to</legend>
        <label className="inline"><input type="checkbox" name="emailConsent" value="yes" defaultChecked={!!p?.emailConsentAt} /> Appointment emails</label>
        <label className="inline"><input type="checkbox" name="smsConsent" value="yes" defaultChecked={!!p?.smsConsentAt} /> Appointment texts (needs a mobile number)</label>
        <label className="inline"><input type="checkbox" name="marketingConsent" value="yes" defaultChecked={!!p?.marketingConsentAt} /> News and offers by email</label>
        <p className="muted">Appointment emails are service messages. Texts and marketing only go to people who have agreed.</p>
      </fieldset>
    </>
  );
}
