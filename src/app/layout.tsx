import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Consult-to-Programme",
  description: "One consultation, a reviewed note and a home exercise programme.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
