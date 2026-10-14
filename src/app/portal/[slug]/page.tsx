import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPlatform } from "@/lib/app";
import { portalRequestCodeAction } from "../../actions/public";
import { ActionForm } from "../../Forms";
import { PublicShell } from "../../PublicShell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };

export default async function PortalSignIn({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const c = await getPlatform().scheduling.clinicBySlug(slug);
  if (!c) notFound();
  return (
    <PublicShell clinicName={c.name}>
      <h1>Your appointments</h1>
      <p>Enter the email address you gave the clinic. We will email you a code. No password needed.</p>
      <div className="card">
        <ActionForm action={portalRequestCodeAction} hidden={{ slug }} submitLabel="Email me a code">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" required autoComplete="email" />
        </ActionForm>
      </div>
    </PublicShell>
  );
}
