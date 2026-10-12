import crypto from "node:crypto";
import { getPlatform } from "@/lib/app";

export const dynamic = "force-dynamic";

/** For an external scheduler (cron, Vercel Cron, a systemd timer). Disabled unless CRON_SECRET is set. */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return new Response("Not found", { status: 404 });
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return new Response("Unauthorised", { status: 401 });
  return Response.json(await getPlatform().tick());
}
