import { baseMime, type SpokenLine, type Transcriber } from "./types";

/**
 * Azure AI Speech "fast transcription" over its REST API. The endpoint is the clinic's own Speech resource, so the
 * clinic chooses the Azure region the audio is processed in (for a UK clinic, a UK region if the resource supports
 * fast transcription there; check the provider's region table). Speakers are separated for a two-person consultation.
 *
 * Errors are reduced to a status code: the provider's error body can repeat what it was sent.
 */
export class AzureSpeech implements Transcriber {
  name = "Azure AI Speech";
  isMock = false;

  constructor(
    private opts: { endpoint: string; key: string; locale?: string; fetchImpl?: typeof fetch },
  ) {}

  async transcribe(audio: Uint8Array, mime: string, signal?: AbortSignal): Promise<SpokenLine[]> {
    const url = `${this.opts.endpoint.replace(/\/$/, "")}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`;
    const form = new FormData();
    const ext = baseMime(mime).split("/")[1]?.replace("x-", "") || "webm";
    form.append("audio", new Blob([audio as BlobPart], { type: baseMime(mime) }), `consultation.${ext}`);
    form.append("definition", JSON.stringify({ locales: [this.opts.locale ?? "en-GB"], diarization: { enabled: true, maxSpeakers: 2 }, profanityFilterMode: "None" }));
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(url, { method: "POST", headers: { "Ocp-Apim-Subscription-Key": this.opts.key }, body: form, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Error("Speech service could not be reached");
    }
    if (!res.ok) throw new Error(`Speech service ${res.status}`);
    let body: { phrases?: { text?: string; speaker?: number }[]; combinedPhrases?: { text?: string }[] };
    try {
      body = await res.json();
    } catch {
      throw new Error("Speech service gave an unreadable answer");
    }
    const phrases = (body.phrases ?? []).filter((p) => typeof p.text === "string" && p.text.trim());
    if (phrases.length) {
      // Speaker numbers are renumbered 1, 2 in order of first speaking, so the first voice is always speaker 1.
      const order: number[] = [];
      return phrases.map((p) => {
        if (typeof p.speaker !== "number") return { speaker: null, text: p.text as string };
        if (!order.includes(p.speaker)) order.push(p.speaker);
        return { speaker: Math.min(order.indexOf(p.speaker) + 1, 2), text: p.text as string };
      });
    }
    const whole = (body.combinedPhrases ?? []).map((c) => c.text ?? "").join(" ").trim();
    return whole ? [{ speaker: null, text: whole }] : [];
  }
}
