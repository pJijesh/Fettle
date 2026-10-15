import { getDb } from "@/lib/db";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

/** For uptime checks and load balancers. Says whether the app can reach its database; reveals nothing else. */
export async function GET() {
  try {
    const db = getDb();
    await db.system(() => db.get("SELECT 1 AS ok"));
    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    logError("health", err);
    return Response.json({ status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
