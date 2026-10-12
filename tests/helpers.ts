import { openDb } from "@/lib/db";
import { Service } from "@/lib/service";
import { MockProvider } from "@/lib/ai/mock";
import type { DraftingProvider } from "@/lib/ai/provider";
import type { WritebackInput, WritebackTarget } from "@/lib/writeback/types";

export const TRANSCRIPT = [
  "Patient: My left knee has been sore for three weeks since I started running again. Pain is about 6/10 on stairs.",
  "Physio: I have screened for red flags and found none.",
  "Physio: On examination there is mild swelling. Left knee flexion 110 degrees, extension 0 degrees.",
  "Physio: Plan is quads strengthening and a home exercise programme, review in two weeks.",
].join("\n");

export class FakeTarget implements WritebackTarget {
  name = "cliniko";
  label = "Cliniko";
  calls: WritebackInput[] = [];
  failNext = false;
  hang = false;
  configured = true;
  isConfigured() {
    return this.configured;
  }
  async createNote(input: WritebackInput) {
    this.calls.push(input);
    if (this.hang) throw new Error("simulated crash");
    if (this.failNext) {
      this.failNext = false;
      throw new Error("Cliniko responded with status 503");
    }
    return { externalId: `note-${this.calls.length}` };
  }
}

export function setup(opts: { provider?: DraftingProvider } = {}) {
  const db = openDb(":memory:");
  const target = new FakeTarget();
  const clock = { now: new Date("2026-10-12T10:00:00Z") };
  const service = new Service({
    db,
    clinicId: "clinic-1",
    provider: opts.provider ?? new MockProvider(),
    targets: { cliniko: target },
    now: () => clock.now,
  });
  return { db, service, target, clock };
}

/** Runs a consultation through to the point where it can be approved. */
export async function draftedConsult(s: ReturnType<typeof setup>) {
  const id = s.service.createConsult({ patientLabel: "J.B.", practitioner: "Sam Physio", pmsPatientId: "12345" }, "sam");
  s.service.recordConsent(id, { method: "verbal", by: "Sam Physio" }, "sam");
  s.service.saveTranscript(id, TRANSCRIPT, "sam");
  await s.service.generateDrafts(id, "sam");
  return id;
}

export function confirmScreening(s: ReturnType<typeof setup>, id: string) {
  const view = s.service.getConsult(id);
  s.service.saveDrafts(
    id,
    { note: { ...view.note, redFlags: { ...view.note.redFlags, screened: true } }, programme: view.programme },
    "sam",
  );
}
