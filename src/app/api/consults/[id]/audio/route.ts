import { requireUser } from "@/lib/auth";
import { getService, withClinic } from "@/lib/app";
import { logError } from "@/lib/log";
import { MAX_AUDIO_BYTES } from "@/lib/speech/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * Receives one recording (the request body is the audio itself), turns it into text and adds it to the consultation's
 * transcript. The audio is processed in memory and not kept. Owner and clinicians only.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser(["owner", "clinician"]);
  const { id } = await ctx.params;
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_AUDIO_BYTES) return json(413, { ok: false, message: "The recording is too large. Keep it under 100 MB." });
  const audio = new Uint8Array(await req.arrayBuffer());
  try {
    const res = await withClinic(user.clinicId, () =>
      getService(user.clinicId).captureAudio(
        id,
        { audio, mime: req.headers.get("content-type") ?? "", audioConsent: req.headers.get("x-audio-consent") === "yes" },
        user.name,
        req.signal,
      ),
    );
    return json(200, { ok: true, added: res.added });
  } catch (err) {
    const e = err as { name?: string; code?: string; message?: string; issues?: unknown };
    if (e?.name === "DomainError") {
      const status = e.code === "not_found" ? 404 : e.code === "validation" ? 400 : e.code === "draft_failed" ? 502 : 409;
      return json(status, { ok: false, message: e.message, issues: e.issues });
    }
    logError("audio", err);
    return json(500, { ok: false, message: "Something went wrong. Nothing was saved. Try again." });
  }
}
