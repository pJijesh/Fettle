import type { Metadata } from "next";
import { PublicShell } from "../../PublicShell";

export const metadata: Metadata = { title: "Thank you", robots: { index: false, follow: false } };

export default function Page() {
  return (
    <PublicShell clinicName="Payment">
      <h1>Thank you</h1>
      <p>Your card payment has been received. The clinic will have it recorded within a few moments. You do not need to do anything else.</p>
    </PublicShell>
  );
}
