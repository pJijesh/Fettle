import { requireUser } from "@/lib/auth";
import { createPatientAction } from "../../actions/staff";
import { ActionForm } from "../../Forms";
import { Header } from "../../Header";
import { PatientFields } from "../PatientFields";

export const dynamic = "force-dynamic";

export default async function NewPatient() {
  const user = await requireUser();
  return (
    <>
      <Header user={user} />
      <main style={{ maxWidth: 720 }}>
        <h1>New patient</h1>
        <div className="card">
          <ActionForm action={createPatientAction} submitLabel="Create patient">
            <PatientFields />
            <label className="inline" style={{ marginTop: 12 }}><input type="checkbox" name="force" value="yes" /> Create anyway if a similar record exists</label>
          </ActionForm>
        </div>
      </main>
    </>
  );
}
