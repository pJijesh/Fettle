"use client";

import { useEffect, useRef, useState } from "react";
import { swapSpeakers } from "@/lib/speech/types";

const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function clock(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Records the consultation in the browser, or takes an audio file, and sends it to be turned into text. The text is
 * added to the transcript box; the audio is not kept anywhere. The physio checks the text before drafting.
 */
export function AudioCapture({ id, providerName, isMock }: { id: string; providerName: string; isMock: boolean }) {
  const [agreed, setAgreed] = useState(false);
  const [phase, setPhase] = useState<"idle" | "recording" | "working">("idle");
  const [seconds, setSeconds] = useState(0);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [added, setAdded] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (phase !== "recording") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase]);
  useEffect(() => () => release(), []);

  function release() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }

  const box = () => document.getElementById("transcript") as HTMLTextAreaElement | null;

  async function send(blob: Blob, type: string) {
    setPhase("working");
    setMsg({ ok: true, text: "Turning the recording into text. This can take a minute for a long consultation." });
    try {
      const res = await fetch(`/api/consults/${id}/audio`, {
        method: "POST",
        headers: { "content-type": type.split(";")[0], "x-audio-consent": "yes" },
        body: blob,
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; added?: string; message?: string } | null;
      if (!res.ok || !body?.ok) {
        setMsg({ ok: false, text: body?.message ?? "That did not work. Nothing was saved and the audio was not kept." });
        return;
      }
      const t = box();
      if (t) t.value = (t.value.trim() ? t.value.trimEnd() + "\n" : "") + body.added;
      setAdded(true);
      setMsg({ ok: true, text: "Added to the transcript below and saved. Check who said what and correct any mistakes before you draft: the first voice is labelled Physio and the second Patient." });
    } catch {
      setMsg({ ok: false, text: "Could not reach the server. Nothing was saved and the audio was not kept." });
    } finally {
      setPhase("idle");
    }
  }

  async function start() {
    setMsg(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMsg({ ok: false, text: "This browser cannot record. You can upload an audio file instead, or type the transcript." });
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch {
      setMsg({ ok: false, text: "The microphone is not available. Allow microphone access for this site in the browser, or upload an audio file." });
      return;
    }
    const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
    const r = new MediaRecorder(stream.current, type ? { mimeType: type } : undefined);
    chunks.current = [];
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.onstop = () => {
      const blob = new Blob(chunks.current, { type: r.mimeType || type || "audio/webm" });
      chunks.current = [];
      release();
      void send(blob, blob.type);
    };
    rec.current = r;
    r.start(5000);
    setSeconds(0);
    timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    setPhase("recording");
  }

  function stop() {
    rec.current?.stop();
  }

  function discard() {
    if (rec.current) rec.current.onstop = null;
    rec.current?.stop();
    chunks.current = [];
    release();
    setPhase("idle");
    setMsg({ ok: true, text: "Recording discarded. Nothing was sent." });
  }

  return (
    <div className="sub" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>Record the consultation</h3>
      {isMock ? <div className="banner warn">Demo transcriber: it ignores the audio and invents text. Never use it with real patients.</div> : null}
      <p className="muted">
        The recording is sent to {providerName} to be turned into text and is not kept by Fettle. Only the text is saved, and you check it before anything is drafted. Tell the patient before you start.
      </p>
      <label className="inline">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} disabled={phase !== "idle"} /> The patient has agreed to this consultation being audio-recorded and turned into text.
      </label>
      <div className="row" style={{ marginTop: 8 }}>
        {phase === "recording" ? (
          <>
            <button type="button" className="primary" onClick={stop}>Stop and turn into text</button>
            <button type="button" onClick={discard}>Discard</button>
            <strong role="timer" aria-label="Recording time" style={{ color: "#b3261e" }}>● Recording {clock(seconds)}</strong>
          </>
        ) : (
          <>
            <button type="button" className="primary" onClick={start} disabled={!agreed || phase !== "idle"}>Start recording</button>
            <label className="btn" style={{ margin: 0, opacity: agreed && phase === "idle" ? 1 : 0.5 }}>
              Upload an audio file
              <input
                type="file"
                accept="audio/*"
                hidden
                disabled={!agreed || phase !== "idle"}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void send(f, f.type || "audio/webm");
                }}
              />
            </label>
            {added ? (
              <button
                type="button"
                onClick={() => {
                  const t = box();
                  if (t) t.value = swapSpeakers(t.value);
                }}
              >
                Swap Physio and Patient labels
              </button>
            ) : null}
          </>
        )}
      </div>
      <div role="status" className={msg && !msg.ok ? "banner bad" : "muted"} style={{ marginTop: 8 }}>{msg?.text}</div>
    </div>
  );
}
