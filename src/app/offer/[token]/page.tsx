import type { Metadata } from "next";
import { getPlatform } from "@/lib/app";
import { formatLocal } from "@/lib/tz";
import { acceptOfferAction } from "../../actions/public";
import { ActionForm } from "../../Forms";
import { PublicShell } from "../../PublicShell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "An earlier appointment", robots: { index: false, follow: false } };

export default async function OfferPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const o = await getPlatform().waitlist.offerByToken(token);
  if (!o) return <PublicShell clinicName="Appointment"><h1>This link is not valid</h1><p>Please check the link in your message, or phone the clinic.</p></PublicShell>;
  const when = formatLocal(o.startAt, o.timezone);
  return (
    <PublicShell clinicName={o.clinicName}>
      <h1>An earlier appointment is free</h1>
      <div className="card">
        <p style={{ margin: 0 }}><strong>{o.typeName}</strong><br />{when} with {o.clinicianName}</p>
      </div>
      {o.status === "sent" ? (
        <>
          <p>This is offered to a few people on the waiting list. It goes to whoever accepts first, and the offer ends at {formatLocal(o.expiresAt, o.timezone, "time")}.</p>
          <ActionForm action={acceptOfferAction} hidden={{ token }} submitLabel="Take this appointment" />
        </>
      ) : o.status === "accepted" ? (
        <div className="banner good">This appointment has been booked.</div>
      ) : o.status === "taken" ? (
        <div className="banner warn">Sorry, someone else took this time first. You stay on the waiting list.</div>
      ) : (
        <div className="banner warn">This offer has ended. You stay on the waiting list.</div>
      )}
    </PublicShell>
  );
}
