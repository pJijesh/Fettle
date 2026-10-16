import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AzureSpeech } from "@/lib/speech/azure";
import { MockTranscriber } from "@/lib/speech/mock";
import { createTranscriber } from "@/lib/speech";
import { formatLines, swapSpeakers, MAX_AUDIO_BYTES, type SpokenLine, type Transcriber } from "@/lib/speech/types";
import { Service } from "@/lib/service";
import { MockProvider } from "@/lib/ai/mock";
import { newTestDb } from "./helpers";
import { PERMISSIONS_POLICY } from "@/lib/csp";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function fakeAzure(reply: { status: number; body?: unknown }) {
  const seen: { path: string; key: string; type: string; body: Buffer }[] = [];
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", key: String(req.headers["ocp-apim-subscription-key"]), type: String(req.headers["content-type"]), body: Buffer.concat(parts) });
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

class Scripted implements Transcriber {
  name = "Scripted";
  isMock = false;
  calls = 0;
  constructor(private lines: SpokenLine[] | Error, private before?: () => Promise<void>) {}
  async transcribe() {
    this.calls++;
    await this.before?.();
    if (this.lines instanceof Error) throw this.lines;
    return this.lines;
  }
}

const AUDIO = new Uint8Array([1, 2, 3, 4]);

async function consult(transcriber: Transcriber | null) {
  const t = await newTestDb();
  await t.q.run("INSERT INTO clinics (id, name, slug, created_at) VALUES ('clinic-1', 'Test Physio', 'test', '2026-10-12T00:00:00.000Z')");
  const service = new Service({ db: t.db, clinicId: "clinic-1", provider: new MockProvider(), targets: {}, transcriber, now: () => new Date("2026-10-12T10:00:00Z") });
  const id = await service.createConsult({ patientLabel: "J.B.", practitioner: "Sam" }, "sam");
  return { t, q: t.q, service, id };
}
const withConsent = async (c: Awaited<ReturnType<typeof consult>>) => c.service.recordConsent(c.id, { method: "verbal", by: "Sam" }, "sam");
const WORDS: SpokenLine[] = [{ speaker: 1, text: "What brings you in?" }, { speaker: 2, text: "My knee." }, { speaker: 2, text: "It hurts on stairs." }];

describe("text from speech", () => {
  it("labels the first voice Physio and the second Patient and joins a speaker's consecutive phrases", () => {
    expect(formatLines(WORDS)).toBe("Physio: What brings you in?\nPatient: My knee. It hurts on stairs.");
    expect(formatLines([{ speaker: null, text: "  just  text " }, { speaker: null, text: "" }])).toBe("just text");
    expect(formatLines([{ speaker: 3, text: "x" }])).toBe("Speaker 3: x");
  });

  it("swaps the labels both ways", () => {
    expect(swapSpeakers("Physio: a\nPatient: b\nNo label")).toBe("Patient: a\nPhysio: b\nNo label");
  });

  it("is off unless a provider is chosen, and refuses half a setup", () => {
    expect(createTranscriber({})).toBeNull();
    expect(createTranscriber({ SPEECH_PROVIDER: "mock" })?.isMock).toBe(true);
    expect(() => createTranscriber({ SPEECH_PROVIDER: "azure" })).toThrow(/AZURE_SPEECH_ENDPOINT/);
    expect(() => createTranscriber({ SPEECH_PROVIDER: "azure", AZURE_SPEECH_ENDPOINT: "http://x", AZURE_SPEECH_KEY: "k" })).toThrow(/https/);
    expect(createTranscriber({ SPEECH_PROVIDER: "azure", AZURE_SPEECH_ENDPOINT: "https://uk.example", AZURE_SPEECH_KEY: "k" })?.name).toBe("Azure AI Speech");
  });

  it("the demo transcriber ignores the audio, and says nothing for empty audio", async () => {
    expect((await new MockTranscriber().transcribe(AUDIO)).length).toBeGreaterThan(0);
    expect(await new MockTranscriber().transcribe(new Uint8Array())).toEqual([]);
  });
});

describe("Azure speech provider", () => {
  it("sends the audio with the key, asks for two speakers, and renumbers speakers in order of first speaking", async () => {
    const f = await fakeAzure({ status: 200, body: { phrases: [{ text: "Hello", speaker: 2 }, { text: "Hi", speaker: 1 }, { text: "Right", speaker: 2 }] } });
    const lines = await new AzureSpeech({ endpoint: f.url + "/", key: "secret-key" }).transcribe(AUDIO, "audio/webm;codecs=opus");
    expect(lines).toEqual([{ speaker: 1, text: "Hello" }, { speaker: 2, text: "Hi" }, { speaker: 1, text: "Right" }]);
    const [req] = f.seen;
    expect(req.path).toBe("/speechtotext/transcriptions:transcribe?api-version=2025-10-15");
    expect(req.key).toBe("secret-key");
    expect(req.type).toMatch(/^multipart\/form-data/);
    const body = req.body.toString("latin1");
    expect(body).toContain('name="audio"; filename="consultation.webm"');
    expect(body).toContain("audio/webm");
    expect(body).toContain('"maxSpeakers":2');
    expect(body).toContain('"en-GB"');
  });

  it("falls back to the whole text when speakers are not separated, and to nothing for silence", async () => {
    const a = await fakeAzure({ status: 200, body: { combinedPhrases: [{ text: "All of it" }], phrases: [] } });
    expect(await new AzureSpeech({ endpoint: a.url, key: "k" }).transcribe(AUDIO, "audio/mp4")).toEqual([{ speaker: null, text: "All of it" }]);
    const b = await fakeAzure({ status: 200, body: { phrases: [] } });
    expect(await new AzureSpeech({ endpoint: b.url, key: "k" }).transcribe(AUDIO, "audio/mp4")).toEqual([]);
  });

  it("reduces failures to a status code, never the provider's words", async () => {
    const f = await fakeAzure({ status: 429, body: { error: "echo: the patient said knee" } });
    const err = await new AzureSpeech({ endpoint: f.url, key: "k" }).transcribe(AUDIO, "audio/webm").catch((e) => e as Error);
    expect((err as Error).message).toBe("Speech service 429");
    const down = await new AzureSpeech({ endpoint: "http://127.0.0.1:1", key: "k" }).transcribe(AUDIO, "audio/webm").catch((e) => e as Error);
    expect((down as Error).message).toBe("Speech service could not be reached");
  });
});

describe("capturing audio for a consultation", () => {
  const go = (c: Awaited<ReturnType<typeof consult>>, over: Partial<{ audio: Uint8Array; mime: string; audioConsent: boolean }> = {}) =>
    c.service.captureAudio(c.id, { audio: AUDIO, mime: "audio/webm;codecs=opus", audioConsent: true, ...over }, "sam");

  it("adds the text to the transcript, keeps what was already there, and moves to captured", async () => {
    const c = await consult(new Scripted(WORDS));
    await withConsent(c);
    await c.service.saveTranscript(c.id, "Physio: earlier line", "sam");
    const r = await go(c);
    expect(r.added).toBe("Physio: What brings you in?\nPatient: My knee. It hurts on stairs.");
    const view = await c.service.getConsult(c.id);
    expect(view.transcript).toBe("Physio: earlier line\n" + r.added);
    expect(view.status).toBe("captured");
  });

  it("writes an audit trail of sizes and the confirmation, and never the words", async () => {
    const c = await consult(new Scripted(WORDS));
    await withConsent(c);
    await go(c);
    const rows = await c.q.all("SELECT action, detail FROM audit_log WHERE action LIKE 'audio.%' ORDER BY id");
    expect(rows.map((r) => r.action)).toEqual(["audio.received", "audio.transcribed"]);
    expect(JSON.parse(rows[0].detail as string)).toMatchObject({ bytes: 4, type: "audio/webm", audioConsentConfirmed: true });
    expect(JSON.stringify(rows)).not.toMatch(/knee|stairs/i);
  });

  it("is refused without the patient's consent, without the recording confirmation, or when switched off", async () => {
    const c = await consult(new Scripted(WORDS));
    await expect(go(c)).rejects.toMatchObject({ code: "consent_required" });
    await withConsent(c);
    await expect(go(c, { audioConsent: false })).rejects.toMatchObject({ code: "validation" });
    const off = await consult(null);
    await withConsent(off);
    await expect(go(off)).rejects.toMatchObject({ code: "invalid_state" });
    expect(off.service.audioInfo.enabled).toBe(false);
    expect(c.service.audioInfo).toEqual({ enabled: true, name: "Scripted", isMock: false });
  });

  it("checks the type and size before any audio reaches the speech service", async () => {
    const tr = new Scripted(WORDS);
    const c = await consult(tr);
    await withConsent(c);
    await expect(go(c, { mime: "application/pdf" })).rejects.toMatchObject({ code: "validation" });
    await expect(go(c, { audio: new Uint8Array() })).rejects.toMatchObject({ code: "validation" });
    await expect(go(c, { audio: new Uint8Array(MAX_AUDIO_BYTES + 1) })).rejects.toMatchObject({ code: "validation" });
    expect(tr.calls).toBe(0);
  });

  it("saves nothing when the speech service fails or hears nothing", async () => {
    const bad = await consult(new Scripted(new Error("Speech service 503")));
    await withConsent(bad);
    await expect(go(bad)).rejects.toMatchObject({ code: "draft_failed" });
    expect((await bad.service.getConsult(bad.id)).transcript).toBe("");
    expect((await bad.q.all("SELECT action FROM audit_log WHERE action = 'audio.failed'")).length).toBe(1);
    const quiet = await consult(new Scripted([]));
    await withConsent(quiet);
    await expect(go(quiet)).rejects.toMatchObject({ code: "validation" });
    expect((await quiet.service.getConsult(quiet.id)).status).toBe("consented");
  });

  it("discards the text if consent is withdrawn while the recording is being processed", async () => {
    let c!: Awaited<ReturnType<typeof consult>>;
    c = await consult(new Scripted(WORDS, async () => c.service.withdrawConsent(c.id, "sam")));
    await withConsent(c);
    await expect(go(c)).rejects.toMatchObject({ code: "consent_required" });
    expect((await c.service.getConsult(c.id)).transcript).toBe("");
  });

  it("is for physiotherapy consultations only", async () => {
    const c = await consult(new Scripted(WORDS));
    const ayu = await c.t.q.run("UPDATE consults SET discipline = 'ayurveda' WHERE id = ?", [c.id]);
    expect(ayu).toBe(1);
    await expect(go(c)).rejects.toMatchObject({ code: "invalid_state" });
  });
});

describe("browser permission", () => {
  it("allows the microphone on this site only", () => {
    expect(PERMISSIONS_POLICY).toContain("microphone=(self)");
    expect(PERMISSIONS_POLICY).toContain("camera=()");
  });
});

