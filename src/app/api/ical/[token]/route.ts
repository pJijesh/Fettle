import { getPlatform } from "@/lib/app";
import { allow } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (!allow(`ical:${ip}`, 120, 15 * 60_000)) return new Response("Too many requests", { status: 429 });
  const feed = getPlatform().ical.feed(token);
  if (!feed) return new Response("Not found", { status: 404 });
  return new Response(feed, { headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "private, max-age=300" } });
}
