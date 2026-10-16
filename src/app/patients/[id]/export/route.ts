import { requireUser } from "@/lib/auth";
import { getPlatform, withClinic } from "@/lib/app";

export const dynamic = "force-dynamic";

/** A complete copy of what the clinic holds about one patient, as a JSON file. Owner only, and audited. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser(["owner"]);
  const { id } = await ctx.params;
  try {
    const data = await withClinic(user.clinicId, () => getPlatform().records.exportPatient(user, id));
    const day = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="patient-export-${day}.json"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if ((err as { name?: string; code?: string })?.name === "DomainError" && (err as { code?: string }).code === "not_found") return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    throw err;
  }
}
