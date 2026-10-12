import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getPlatform } from "@/lib/app";
import { Header } from "../Header";

export const dynamic = "force-dynamic";

export default async function Patients({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const { q = "" } = await searchParams;
  const list = getPlatform().scheduling.searchPatients(user.clinicId, q, 50);
  return (
    <>
      <Header user={user} />
      <main>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h1>Patients</h1>
          <Link href="/patients/new" className="btn primary">New patient</Link>
        </div>
        <form method="get" className="toolbar" role="search">
          <div>
            <label htmlFor="q">Search by name, email or phone</label>
            <input id="q" name="q" defaultValue={q} style={{ minWidth: 260 }} autoComplete="off" />
          </div>
          <button type="submit">Search</button>
        </form>
        <div className="card tablewrap" tabIndex={0} role="region" aria-label="Scrollable table">
          {list.length === 0 ? (
            <p className="muted">{q ? "No patients match that search." : "No patients yet."}</p>
          ) : (
            <table>
              <caption className="muted" style={{ textAlign: "left" }}>{list.length === 50 ? "Showing the first 50. Search to narrow down." : `${list.length} patient${list.length === 1 ? "" : "s"}`}</caption>
              <thead><tr><th scope="col">Name</th><th scope="col">Date of birth</th><th scope="col">Email</th><th scope="col">Mobile</th></tr></thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id}>
                    <td><Link href={`/patients/${p.id}`}>{p.lastName}, {p.firstName}</Link></td>
                    <td>{p.dob ?? ""}</td>
                    <td>{p.email ?? ""}</td>
                    <td>{p.phone ?? ""}</td>
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
