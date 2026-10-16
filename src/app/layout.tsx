import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fettle",
  description: "One consultation, a reviewed note and a home exercise programme.",
  robots: { index: false, follow: false },
};

// Reading the request headers makes every page render per request, which is what lets Next put this request's
// nonce on its scripts (see src/proxy.ts).
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await headers();
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
