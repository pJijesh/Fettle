import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPlatform } from "@/lib/app";
import { portalVerifyAction } from "../../../actions/public";
import { ActionForm } from "../../../Forms";
import { PublicShell } from "../../../PublicShell";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Enter your code", robots: { index: false, follow: false } };

export default async function PortalCode({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ email?: string }> }) {
  const { slug } = await params;
  const { email = "" } = await searchParams;
  const c = getPlatform().scheduling.clinicBySlug(slug);
  if (!c) notFound();
  return (
    <PublicShell clinicName={c.name}>
      <h1>Check your email</h1>
      <p>If that address is on our records, we have sent a 6-digit code. It works for 15 minutes.</p>
      <div className="card">
        <ActionForm action={portalVerifyAction} hidden={{ slug, email }} submitLabel="Sign in">
          <label htmlFor="code">Code</label>
          <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required />
        </ActionForm>
      </div>
    </PublicShell>
  );
}
