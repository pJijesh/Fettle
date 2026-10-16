import type { SpokenLine, Transcriber } from "./types";

/** For trying the screen without a speech service. It ignores the audio and returns fixed, invented text. */
export class MockTranscriber implements Transcriber {
  name = "Demo transcriber";
  isMock = true;
  async transcribe(audio: Uint8Array): Promise<SpokenLine[]> {
    if (!audio.length) return [];
    return [
      { speaker: 1, text: "What brings you in today?" },
      { speaker: 2, text: "My right shoulder has been sore for about a month, and it is worse when I reach overhead." },
    ];
  }
}
