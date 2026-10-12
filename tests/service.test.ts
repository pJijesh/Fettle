import { describe, expect, it } from "vitest";
import { DomainError } from "@/lib/service";
import { getExercise } from "@/lib/ai/catalogue";
import { confirmScreening, draftedConsult, setup, TRANSCRIPT } from "./helpers";

async function expectCode(promise: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`Expected a ${code} error but nothing was thrown`);
}

describe("R1 consent", () => {
  it("blocks transcript capture and drafting until consent is recorded", async () => {
    const s = setup();
    const id = s.service.createConsult({ patientLabel: "J.B.", practitioner: "Sam" }, "sam");
    await expectCode(() => s.service.saveTranscript(id, TRANSCRIPT, "sam"), "consent_required");
    await expectCode(s.service.generateDrafts(id, "sam"), "consent_required");
  });

  it("logs consent once and keeps the first record", () => {
    const s = setup();
    const id = s.service.createConsult({ patientLabel: "J.B.", practitioner: "Sam" }, "sam");
    s.service.recordConsent(id, { method: "verbal", by: "Sam" }, "sam");
    s.clock.now = new Date("2026-10-12T11:00:00Z");
    s.service.recordConsent(id, { method: "written", by: "Other" }, "other");
    const view = s.service.getConsult(id);
    expect(view.consent).toMatchObject({ method: "verbal", by: "Sam", at: "2026-10-12T10:00:00.000Z" });
    expect(view.audit.filter((a) => a.action === "consent.recorded")).toHaveLength(1);
  });

  it("deletes the transcript and drafts when consent is withdrawn", async () => {
    const s = setup();
    const id = await draftedConsult(s);
    s.service.withdrawConsent(id, "sam");
    const view = s.service.getConsult(id);
    expect(view.status).toBe("created");
    expect(view.transcript).toBe("");
    expect(view.note.problems).toHaveLength(0);
    expect(view.consentWithdrawnAt).not.toBeNull();
    await expectCode(() => s.service.saveTranscript(id, "more", "sam"), "consent_required");
  });

  it("will not withdraw consent on an approved record", async () => {
    const s = setup();
    const id = await draftedConsult(s);
    confirmScreening(s, id);
    s.service.approve(id, "Sam Physio");
    await expectCode(() => s.service.withdrawConsent(id, "sam"), "invalid_state");
  });
});

describe("R2 and R4 drafting", () => {
  it("produces discrete note fields and exercises linked to problems", async () => {
    const s = setup();
    const id = await draftedConsult(s);
    const view = s.service.getConsult(id);
    expect(view.status).toBe("drafted");
    expect(view.note.problems.map((p) => p.id)).toEqual(["p1"]);
    expect(view.note.problems[0].side).toBe("left");
    expect(view.note.rom.map((r) => [r.movement, r.value, r.side])).toEqual([
      ["flexion", "110", "left"],
      ["extension", "0", "left"],
    ]);
    expect(view.note.outcomeMeasures[0]).toMatchObject({ name: "Pain (NPRS)", score: "6", scale: "0-10" });
    expect(view.programme.items.length).toBeGreaterThan(0);
    for (const item of view.programme.items) {
      expect(view.note.problems.some((p) => p.id === item.problemId)).toBe(true);
      expect(getExercise(item.exerciseId)).toBeDefined();
    }
  });

  it("never lets the model confirm red-flag screening", async () => {
    const s = setup({
      provider: {
        name: "cheeky",
        model: "m",
        isMock: false,
        draft: async () => ({
          note: {
            subjective: "x",
            objective: "",
            rom: [],
            outcomeMeasures: [],
            specialTests: [],
            redFlags: { screened: true, findings: [], notes: "" },
            problems: [],
            assessment: "",
            plan: "",
          },
          programme: { title: "t", patientIntro: "", items: [], safetyAdvice: [], reviewInWeeks: null },
        }),
      },
    });
    const id = await draftedConsult(s);
    expect(s.service.getConsult(id).note.redFlags.screened).toBe(false);
  });

  it("drops invented exercises and unlinked items, and says so in the audit log", async () => {
    const s = setup({
      provider: {
        name: "sloppy",
        model: "m",
        isMock: false,
        draft: async () => ({
          note: {
            subjective: "x",
            objective: "",
            rom: [{ joint: "knee", side: "left", movement: "flexion", value: "100", unit: "deg", evidence: [1, 99] }],
            outcomeMeasures: [],
            specialTests: [],
            redFlags: { screened: false, findings: [], notes: "" },
            problems: [{ id: "p1", title: "Knee pain", side: "left", evidence: [1] }],
            assessment: "",
            plan: "",
          },
          programme: {
            title: "t",
            patientIntro: "",
            items: [
              { exerciseId: "quad-set", problemId: "p1", sets: 3, reps: 10, holdSeconds: null, frequencyPerWeek: 5, cue: "", progression: "", evidence: [] },
              { exerciseId: "made-up-move", problemId: "p1", sets: 3, reps: 10, holdSeconds: null, frequencyPerWeek: 5, cue: "", progression: "", evidence: [] },
              { exerciseId: "glute-bridge", problemId: "p9", sets: 3, reps: 10, holdSeconds: null, frequencyPerWeek: 5, cue: "", progression: "", evidence: [] },
            ],
            safetyAdvice: [],
            reviewInWeeks: null,
          },
        }),
      },
    });
    const id = await draftedConsult(s);
    const view = s.service.getConsult(id);
    expect(view.programme.items.map((i) => i.exerciseId)).toEqual(["quad-set"]);
    expect(view.note.rom[0].evidence).toEqual([1]);
    const audit = view.audit.find((a) => a.action === "drafts.generated");
    expect(audit?.detail).toContain("made-up-move");
  });

  it("rejects malformed provider output without storing anything", async () => {
    const s = setup({ provider: { name: "bad", model: "m", isMock: false, draft: async () => ({ nope: true }) } });
    const id = s.service.createConsult({ patientLabel: "J.B.", practitioner: "Sam" }, "sam");
    s.service.recordConsent(id, { method: "verbal", by: "Sam" }, "sam");
    s.service.saveTranscript(id, TRANSCRIPT, "sam");
    await expectCode(s.service.generateDrafts(id, "sam"), "draft_failed");
    expect(s.service.getConsult(id).status).toBe("captured");
  });

  it("lets a physio write the note by hand when there is no AI draft", () => {
    const s = setup();
    const id = s.service.createConsult({ patientLabel: "J.B.", practitioner: "Sam" }, "sam");
    s.service.recordConsent(id, { method: "verbal", by: "Sam" }, "sam");
    const v = s.service.getConsult(id);
    s.service.saveDrafts(id, { note: { ...v.note, subjective: "Knee pain", redFlags: { screened: true, findings: [], notes: "" } }, programme: v.programme }, "sam");
    expect(s.service.getConsult(id).status).toBe("drafted");
    expect(() => s.service.approve(id, "Sam")).not.toThrow();
  });
});

describe("R3 approval gate", () => {
  it("sends and saves nothing before approval", async () => {
    const s = setup();
    const id = await draftedConsult(s);
    await expectCode(() => s.service.createPatientLink(id, "sam"), "invalid_state");
    await expectCode(() => s.service.approvedNoteText(id), "invalid_state");
    await expectCode(s.service.writeBack(id, "cliniko", "sam"), "invalid_state");
    expect(s.target.calls).toHaveLength(0);
  });

  it("requires red-flag screening to be confirmed", async () => {
    const s = setup();
    const id = await draftedConsult(s);
    try {
      s.service.approve(id, "Sam");
      throw new Error("should not approve");
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).issues.map((i) => i.path)).toContain("note.redFlags.screened");
    }
  });

  it("blocks approval when an exercise is not linked to a problem", async () => {
    const s = setup();
    const id = await draftedConsult(s);
    const v = s.service.getConsult(id);
    s.service.saveDrafts(
      id,
      {
        note: { ...v.note, redFlags: { ...v.note.redFlags, screened: true } },
        programme: { ...v.programme, items: [{ ...v.programme.items[0], problemId: "p7" }] },
      },
      "sam",
    );
    await expectCode(() => s.service.approve(id, "Sam"), "validation");
  });

  it("freezes the approved content and keeps a hash of it", async () => {
    const s = setup();
    const id = await draftedConsult(s);
    confirmScreening(s, id);
    const { hash } = s.service.approve(id, "Sam Physio");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    await expectCode(() => s.service.saveDrafts(id, { note: {}, programme: {} }, "sam"), "invalid_state");
    await expectCode(() => s.service.saveTranscript(id, "changed", "sam"), "invalid_state");
    expect(s.service.getConsult(id).approval?.hash).toBe(hash);
    await expectCode(() => s.service.approve(id, "Sam"), "invalid_state");
  });

  it("labels the copy-ready note as AI-assisted and approved", async () => {
    const s = setup();
    const id = await draftedConsult(s);
    confirmScreening(s, id);
    s.service.approve(id, "Sam Physio");
    const text = s.service.approvedNoteText(id);
    expect(text).toContain("Drafted with AI assistance (mock-keyword-v1), reviewed and approved by Sam Physio");
    expect(text).toContain("Range of movement");
    expect(text).toContain("Home exercise programme issued");
  });
});

describe("R6 patient link and R8 check-in", () => {
  async function approved() {
    const s = setup();
    const id = await draftedConsult(s);
    confirmScreening(s, id);
    s.service.approve(id, "Sam Physio");
    return { s, id };
  }

  it("shows the patient the programme only, never the clinical note", async () => {
    const { s, id } = await approved();
    const { token } = s.service.createPatientLink(id, "sam");
    const view = s.service.getPatientView(token)!;
    expect(view.programme.items.length).toBeGreaterThan(0);
    const json = JSON.stringify(view);
    expect(json).not.toContain("MOCK DRAFT");
    expect(json).not.toContain("J.B.");
    expect(json).not.toContain("redFlags");
  });

  it("stores only a hash of the token", async () => {
    const { s, id } = await approved();
    const { token } = s.service.createPatientLink(id, "sam");
    const rows = JSON.stringify(
      (s as unknown as { service: { db: { prepare: (q: string) => { all: () => unknown[] } } } }).service.db
        .prepare("SELECT * FROM patient_links")
        .all(),
    );
    expect(rows).not.toContain(token);
  });

  it("can be revoked and replaced, and expires", async () => {
    const { s, id } = await approved();
    const first = s.service.createPatientLink(id, "sam");
    const second = s.service.createPatientLink(id, "sam");
    expect(s.service.getPatientView(first.token)).toBeNull();
    expect(s.service.getPatientView(second.token)).not.toBeNull();
    s.service.revokePatientLinks(id, "sam");
    expect(s.service.getPatientView(second.token)).toBeNull();

    const third = s.service.createPatientLink(id, "sam", 7);
    s.clock.now = new Date("2026-10-20T10:00:00Z");
    expect(s.service.getPatientView(third.token)).toBeNull();
  });

  it("rejects unknown tokens", async () => {
    const { s } = await approved();
    expect(s.service.getPatientView("nope")).toBeNull();
    expect(s.service.getPatientView("x".repeat(500))).toBeNull();
  });

  it("records a two-tap check-in and limits spam", async () => {
    const { s, id } = await approved();
    const { token } = s.service.createPatientLink(id, "sam");
    for (let i = 0; i < 5; i++) s.service.submitCheckIn(token, { adherence: "some", painChange: "better" });
    await expectCode(() => s.service.submitCheckIn(token, { adherence: "all", painChange: "same" }), "rate_limited");
    expect(s.service.getConsult(id).checkIns).toHaveLength(5);
    s.clock.now = new Date("2026-10-13T11:00:00Z");
    expect(() => s.service.submitCheckIn(token, { adherence: "all", painChange: "same" })).not.toThrow();
  });

  it("rejects invalid check-in values", async () => {
    const { s, id } = await approved();
    const { token } = s.service.createPatientLink(id, "sam");
    await expectCode(() => s.service.submitCheckIn(token, { adherence: "lots", painChange: "better" }), "validation");
  });
});

describe("R5 write-back", () => {
  async function approved() {
    const s = setup();
    const id = await draftedConsult(s);
    confirmScreening(s, id);
    s.service.approve(id, "Sam Physio");
    return { s, id };
  }

  it("writes once and returns the same result on repeat clicks", async () => {
    const { s, id } = await approved();
    const a = await s.service.writeBack(id, "cliniko", "sam");
    const b = await s.service.writeBack(id, "cliniko", "sam");
    expect(a.status).toBe("succeeded");
    expect(b.id).toBe(a.id);
    expect(s.target.calls).toHaveLength(1);
    expect(s.target.calls[0].patientId).toBe("12345");
    expect(s.target.calls[0].text).toContain("approved by Sam Physio");
  });

  it("records a failure and retries without creating a second row", async () => {
    const { s, id } = await approved();
    s.target.failNext = true;
    const first = await s.service.writeBack(id, "cliniko", "sam");
    expect(first.status).toBe("failed");
    expect(first.error).toContain("503");
    const second = await s.service.writeBack(id, "cliniko", "sam");
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("succeeded");
    expect(second.attempts).toBe(2);
    expect(s.service.getConsult(id).writebacks).toHaveLength(1);
  });

  it("stops and asks a person to check after an attempt that never reported back", async () => {
    const { s, id, db } = await (async () => {
      const x = await approved();
      return { ...x, db: x.s.db };
    })();
    s.target.hang = true;
    // simulate a crash: the row stays 'pending' although the process died mid-call
    const row = await s.service.writeBack(id, "cliniko", "sam");
    db.prepare("UPDATE writebacks SET status = 'pending' WHERE id = ?").run(row.id);
    const callsBefore = s.target.calls.length;
    const again = await s.service.writeBack(id, "cliniko", "sam");
    expect(again.status).toBe("needs_check");
    expect(s.target.calls).toHaveLength(callsBefore);

    s.service.resolveWriteback(id, "cliniko", "not_written", "sam");
    s.target.hang = false;
    const retried = await s.service.writeBack(id, "cliniko", "sam");
    expect(retried.status).toBe("succeeded");
  });

  it("needs a patient id and a configured destination", async () => {
    const s = setup();
    const id = s.service.createConsult({ patientLabel: "J.B.", practitioner: "Sam" }, "sam");
    s.service.recordConsent(id, { method: "verbal", by: "Sam" }, "sam");
    s.service.saveTranscript(id, TRANSCRIPT, "sam");
    await s.service.generateDrafts(id, "sam");
    confirmScreening(s, id);
    s.service.approve(id, "Sam");
    await expectCode(s.service.writeBack(id, "cliniko", "sam"), "validation");
    s.service.setPmsPatientId(id, "99", "sam");
    s.target.configured = false;
    await expectCode(s.service.writeBack(id, "cliniko", "sam"), "writeback_unavailable");
  });
});
