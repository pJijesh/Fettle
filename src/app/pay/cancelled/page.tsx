import type { Metadata } from "next";
import { PublicShell } from "../../PublicShell";

export const metadata: Metadata = { title: "Payment not taken", robots: { index: false, follow: false } };

export default function Page() {
  return (
    <PublicShell clinicName="Payment">
      <h1>Payment not taken</h1>
      <p>You left the payment page, so nothing has been charged. Use the link you were sent to try again, or contact the clinic.</p>
    </PublicShell>
  );
}
