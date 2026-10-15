import { requireUser } from "@/lib/auth";
import { getPlatform, withClinic } from "@/lib/app";
import type { SessionUser } from "@/lib/accounts";
import { createConsultAction } from "../../actions";
import { ActionForm } from "../../Forms";
import { Header } from "../../Header";

export const dynamic = "force-dynamic";

export default async function NewConsult() {
  const user = await requireUser(["owner", "clinician"]);
  return withClinic(user.clinicId, () => Body(user));
}

async function Body(user: SessionUser) {
  const clinic = await getPlatform().scheduling.clinic(user.clinicId);
  const ayurvedaOnly = clinic.disciplines === "ayurveda";
  return (
    <>
      <Header user={user} />
      <main style={{ maxWidth: 560 }}>
        <h1>New consultation</h1>
        <div className="card">
          <ActionForm action={createConsultAction} submitLabel="Create">
            {clinic.disciplines === "both" ? (
              <>
                <label htmlFor="discipline">Discipline</label>
                <select id="discipline" name="discipline" defaultValue="physio"><option value="physio">Physiotherapy</option><option value="ayurveda">Ayurveda</option></select>
              </>
            ) : (
              <input type="hidden" name="discipline" value={ayurvedaOnly ? "ayurveda" : "physio"} />
            )}
            <label htmlFor="patientLabel">Patient name or initials</label>
            <input id="patientLabel" name="patientLabel" maxLength={80} required />
            <p className="muted">Use the minimum needed to recognise the patient. Clinical detail goes in the note, not here.</p>
            <label htmlFor="practitioner">{ayurvedaOnly ? "Treating practitioner" : "Treating physio (or practitioner)"}</label>
            <input id="practitioner" name="practitioner" defaultValue={user.name} required />
            <label htmlFor="pmsPatientId">Cliniko patient ID (optional, needed for write-back)</label>
            <input id="pmsPatientId" name="pmsPatientId" inputMode="numeric" />
          </ActionForm>
        </div>
      </main>
    </>
  );
}
