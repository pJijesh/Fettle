import { CATALOGUE, type Region } from "./catalogue";
import type { DraftInput, DraftingProvider } from "./provider";
import type { DraftOutput, Side } from "../schemas";

/**
 * Deterministic offline stand-in so the whole flow runs without an API key and tests are stable.
 * It matches keywords. It is not clinical and must never be used with real patient data.
 */

const REGIONS: { region: Region; label: string; words: RegExp }[] = [
  { region: "knee", label: "knee", words: /\bknee/i },
  { region: "hip", label: "hip", words: /\bhip\b|\bgroin/i },
  { region: "ankle", label: "ankle", words: /\bankle|\bfoot\b|\bheel\b/i },
  { region: "shoulder", label: "shoulder", words: /\bshoulder|\brotator/i },
  { region: "neck", label: "neck", words: /\bneck|\bcervical/i },
  { region: "back", label: "lower back", words: /\blow(er)? back|\blumbar|\bback pain|\bsciatic/i },
];

const RED_FLAGS: [RegExp, string][] = [
  [/night pain/i, "Night pain mentioned"],
  [/weight loss/i, "Unexplained weight loss mentioned"],
  [/numbness|pins and needles/i, "Numbness or pins and needles mentioned"],
  [/bladder|bowel|saddle/i, "Bladder, bowel or saddle symptoms mentioned"],
  [/fever|temperature/i, "Fever mentioned"],
];

function sideOf(text: string): Side {
  const left = /\bleft\b/i.test(text);
  const right = /\bright\b/i.test(text);
  if (left && right) return "both";
  if (left) return "left";
  if (right) return "right";
  return "na";
}

export class MockProvider implements DraftingProvider {
  readonly name = "mock";
  readonly model = "mock-keyword-v1";
  readonly isMock = true;

  async draft(input: DraftInput): Promise<DraftOutput> {
    const lines = input.transcriptLines;
    const numbered = lines.map((text, i) => ({ n: i + 1, text }));

    const found = REGIONS.filter((r) => numbered.some((l) => r.words.test(l.text)));
    const problems = found.slice(0, 3).map((r, i) => {
      const hits = numbered.filter((l) => r.words.test(l.text));
      return {
        id: `p${i + 1}`,
        region: r.region,
        title: `${r.label[0].toUpperCase()}${r.label.slice(1)} pain`,
        side: sideOf(hits.map((h) => h.text).join(" ")),
        evidence: hits.slice(0, 3).map((h) => h.n),
      };
    });

    const patientLines = numbered.filter((l) => /^(patient|pt)\s*:/i.test(l.text));
    const subjectiveSource = patientLines.length ? patientLines : numbered.slice(0, 3);

    const rom: DraftOutput["note"]["rom"] = [];
    const romRe = /(flexion|extension|abduction|external rotation|internal rotation|rotation)[^0-9\n]{0,30}(\d{1,3})\s*(?:degrees|deg|°)/gi;
    for (const l of numbered) {
      for (const m of l.text.matchAll(romRe)) {
        const region = REGIONS.find((r) => r.words.test(l.text));
        rom.push({
          joint: region?.label ?? "",
          side: sideOf(l.text),
          movement: m[1].toLowerCase(),
          value: m[2],
          unit: "deg",
          evidence: [l.n],
        });
      }
    }

    const outcomeMeasures: DraftOutput["note"]["outcomeMeasures"] = [];
    for (const l of numbered) {
      const m = l.text.match(/(?:pain|vas|nprs)[^0-9\n]{0,25}(\d{1,2})\s*(?:\/|out of)\s*10/i);
      if (m) outcomeMeasures.push({ name: "Pain (NPRS)", score: m[1], scale: "0-10", evidence: [l.n] });
    }

    const findings = RED_FLAGS.filter(([re]) => numbered.some((l) => re.test(l.text))).map(([, label]) => label);

    const items: DraftOutput["programme"]["items"] = [];
    for (const p of problems) {
      const picks = CATALOGUE.filter((e) => e.regions.includes(p.region) && e.category !== "stretch").slice(0, 3);
      for (const e of picks) {
        if (items.some((i) => i.exerciseId === e.id)) continue;
        items.push({
          exerciseId: e.id,
          problemId: p.id,
          sets: e.defaultSets,
          reps: e.defaultReps,
          holdSeconds: e.defaultHoldSeconds,
          frequencyPerWeek: e.defaultFrequencyPerWeek,
          cue: e.cue,
          progression: e.progression,
          evidence: p.evidence,
        });
      }
    }

    return {
      note: {
        subjective: subjectiveSource.map((l) => l.text.replace(/^(patient|pt)\s*:\s*/i, "")).join(" ").slice(0, 1500),
        objective: numbered
          .filter((l) => /exam|observ|palpat|swelling|strength|gait/i.test(l.text))
          .map((l) => l.text.replace(/^(physio|pt|physiotherapist)\s*:\s*/i, ""))
          .join(" ")
          .slice(0, 1500),
        rom,
        outcomeMeasures,
        specialTests: [],
        redFlags: { screened: false, findings, notes: "" },
        problems: problems.map(({ id, title, side, evidence }) => ({ id, title, side, evidence })),
        assessment: "MOCK DRAFT: generated offline for testing. Not clinical. Replace with your own assessment.",
        plan: numbered
          .filter((l) => /\b(plan|exercise|programme|review|advice)\b/i.test(l.text))
          .map((l) => l.text.replace(/^(physio|pt|physiotherapist)\s*:\s*/i, ""))
          .join(" ")
          .slice(0, 1500),
      },
      programme: {
        title: "Home exercise programme",
        patientIntro:
          "These exercises are chosen for you by your physiotherapist. Go at a comfortable pace. A mild ache is fine, but stop and tell us if pain gets sharply worse.",
        items,
        safetyAdvice: ["Stop and contact your physiotherapist if you get new numbness, sharp pain or swelling."],
        reviewInWeeks: items.length ? 2 : null,
      },
    };
  }
}
