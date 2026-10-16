/**
 * Turning a recording into text sits behind this interface, like drafting does, so the vendor and the region
 * it processes in can change without touching the rest of the app. A transcriber is given the audio in memory
 * and returns text; Fettle never writes the audio anywhere.
 */

export interface SpokenLine {
  /** 1, 2, ... in order of first speaking, or null when the provider did not separate speakers. */
  speaker: number | null;
  text: string;
}

export interface Transcriber {
  /** Shown in the UI and written to the audit log. */
  name: string;
  /** True for a stand-in that invents text and must not be used with real patients. */
  isMock: boolean;
  transcribe(audio: Uint8Array, mime: string, signal?: AbortSignal): Promise<SpokenLine[]>;
}

/** Audio types a browser recorder or a phone voice memo produces. */
export const AUDIO_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/aac", "audio/x-m4a", "audio/m4a", "audio/flac",
  // Browsers often label an audio-only recording from a phone or a browser by its container.
  "video/webm", "video/mp4"] as const;

export const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

/** "audio/webm;codecs=opus" to "audio/webm". */
export function baseMime(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

export function isAudioType(mime: string): boolean {
  return (AUDIO_TYPES as readonly string[]).includes(baseMime(mime));
}

/**
 * Transcript text, one speaker turn per line, in the form the drafting step reads. The first speaker is taken to
 * be the physio and the second the patient; the physio checks this before drafting and can swap it.
 */
export function formatLines(lines: SpokenLine[]): string {
  const label = (s: number | null) => (s === 1 ? "Physio: " : s === 2 ? "Patient: " : s ? `Speaker ${s}: ` : "");
  const out: string[] = [];
  let last: number | null | undefined;
  for (const l of lines) {
    const text = l.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    // Consecutive phrases by the same speaker are one turn.
    if (out.length && l.speaker === last) out[out.length - 1] += " " + text;
    else out.push(label(l.speaker) + text);
    last = l.speaker;
  }
  return out.join("\n");
}

/** Swaps the Physio and Patient labels, for when the first speaker was the patient. */
export function swapSpeakers(text: string): string {
  return text.replace(/^(Physio|Patient): /gm, (_m, who: string) => (who === "Physio" ? "Patient: " : "Physio: "));
}
