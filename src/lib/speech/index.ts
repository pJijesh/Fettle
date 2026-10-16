import { AzureSpeech } from "./azure";
import { MockTranscriber } from "./mock";
import type { Transcriber } from "./types";

export * from "./types";

/** The speech service chosen by SPEECH_PROVIDER. Unset means audio capture is off and the screen does not offer it. */
export function createTranscriber(env: Record<string, string | undefined> = process.env): Transcriber | null {
  const wanted = (env.SPEECH_PROVIDER ?? "").toLowerCase();
  if (wanted === "azure") {
    if (!env.AZURE_SPEECH_ENDPOINT || !env.AZURE_SPEECH_KEY) throw new Error("SPEECH_PROVIDER=azure needs AZURE_SPEECH_ENDPOINT and AZURE_SPEECH_KEY");
    if (!/^https:\/\//i.test(env.AZURE_SPEECH_ENDPOINT)) throw new Error("AZURE_SPEECH_ENDPOINT must be an https address");
    return new AzureSpeech({ endpoint: env.AZURE_SPEECH_ENDPOINT, key: env.AZURE_SPEECH_KEY, locale: env.AZURE_SPEECH_LOCALE || undefined });
  }
  if (wanted === "mock") return new MockTranscriber();
  return null;
}
