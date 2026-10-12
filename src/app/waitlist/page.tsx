import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getPlatform } from "@/lib/app";
import { removeWaitlistAction } from "../actions/staff";
import { ActionForm } from "../Forms";
import { Header } from "../Header";

export const dynamic = "force-dynamic";
const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default async function WaitlistPage() {
  const user = await requireUser();
  const list = getPlatform().waitlist.list(user.clinicId);
  return (
    <>
      <Header user={user} />
      <main>
        <h1>Waiting list</h1>
        <p className="muted">When a time is freed, the first five people who match are offered it for 15 minutes. The first to accept gets it. Add someone from their patient record.</p>
        <div className="card tablewrap" tabIndex={0} role="region" aria-label="Scrollable table">
          {list.length === 0 ? <p className="muted">Nobody is waiting.</p> : (
            <table>
              <thead><tr><th scope="col">Patient</th><th scope="col">Wants</th><th scope="col">Between</th><th scope="col">Days</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead>
              <tbody>
                {list.map((w) => (
                  <tr key={w.id}>
                    <td><Link href={`/patients/${w.patientId}`}>{w.patientName}</Link></td>
                    <td>{w.typeName}{w.clinicianName ? ` with ${w.clinicianName}` : ""}</td>
                    <td>{w.earliestDate} to {w.latestDate}</td>
                    <td>{w.weekdays.length === 7 ? "Any" : w.weekdays.map((d) => WD[d - 1]).join(", ")}</td>
                    <td><span className={`pill ${w.status}`}>{w.status}</span></td>
                    <td><ActionForm action={removeWaitlistAction} hidden={{ id: w.id }} submitLabel="Remove" submitClass="" confirmText={`Remove ${w.patientName} from the waiting list?`} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </>
  );
}
