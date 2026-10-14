import Link from "next/link";
import { requireUser } from "@/lib/auth";
import type { SessionUser } from "@/lib/accounts";
import { getPlatform, withClinic } from "@/lib/app";
import { Header } from "../../Header";

export const dynamic = "force-dynamic";

export default async function OutboxPage() {
  const user = await requireUser(["owner"]);
  return withClinic(user.clinicId, () => OutboxPageBody(user));
}

async function OutboxPageBody(user: SessionUser) {
  const p = getPlatform();
  const rows = await p.outbox.list(user.clinicId, 100);
  return (
    <>
      <Header user={user} />
      <main>
        <p className="muted"><Link href="/settings">← Settings</Link></p>
        <h1>Outbox</h1>
        {!p.mailer.isReal ? <div className="banner warn">No email or text provider is connected, so nothing below has left this machine. “Sent” means the development mailer accepted it.</div> : null}
        <div className="card tablewrap" tabIndex={0} role="region" aria-label="Scrollable table">
          {rows.length === 0 ? <p className="muted">No messages yet.</p> : (
            <table>
              <thead><tr><th scope="col">Queued for</th><th scope="col">To</th><th scope="col">Kind</th><th scope="col">Status</th><th scope="col">Message</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.send_after).toLocaleString("en-GB", { timeZone: "Europe/London" })}</td>
                    <td>{r.to_addr}<br /><span className="muted">{r.channel}</span></td>
                    <td>{r.kind}</td>
                    <td>{r.status}{r.error ? <span className="muted"> ({r.error})</span> : null}</td>
                    <td><details><summary>{r.subject || r.body.slice(0, 40)}</summary><pre className="transcript">{r.body}</pre></details></td>
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
