import { AGNI_LABEL, KIND_LABEL, KIND_ORDER, type AyurvedaPlan, type AyurvedaRecord, type Dosha } from "./schemas";

const cap = (d: Dosha) => d[0].toUpperCase() + d.slice(1);
const doshaText = (s: { doshas: Dosha[]; notes: string }) => [s.doshas.map(cap).join("–"), s.notes.trim()].filter(Boolean).join(". ");

export interface AyurvedaFooter {
  practitioner: string;
  approvedAt: string;
}

/** Plain-text rendering used for write-back and for the copy-ready fallback. */
export function ayurvedaNoteToText(r: AyurvedaRecord, plan: AyurvedaPlan, footer?: AyurvedaFooter): string {
  const out: string[] = [];
  const section = (title: string, body: string) => {
    if (body.trim()) out.push(`${title}\n${body.trim()}`);
  };

  section("Main complaint", r.chiefComplaint);
  section("History", r.history);
  section("Past history", r.pastHistory);
  section("Medicines, herbs and supplements", r.medications);
  section("Allergies", r.allergies);
  section("Diet", r.diet);
  section("Sleep", r.sleep);
  section("Digestion and elimination", r.digestion);
  section("Mind and energy", r.mind);
  section("Constitution (prakriti)", doshaText(r.prakriti));
  section("Current imbalance (vikriti)", doshaText(r.vikriti));
  section("Agni and ama", `Agni: ${AGNI_LABEL[r.agni]}. Ama: ${r.ama === "unsure" ? "not assessed" : r.ama}.`);
  section("Examination", r.examination);

  const pregnancy = { not_asked: "", yes: "Pregnant or breastfeeding.", no: "Not pregnant or breastfeeding.", not_applicable: "Pregnancy not applicable." }[r.safety.pregnancy];
  const screen = r.safety.screened
    ? `Screened. ${pregnancy} ${r.safety.findings.length ? `Findings: ${r.safety.findings.join("; ")}` : "Nothing of concern identified."}`
    : "Not recorded.";
  section("Safety screen", `${screen.replace(/\s+/g, " ").trim()}${r.safety.notes ? `\n${r.safety.notes}` : ""}`);
  section("Assessment", r.assessment);
  section("Plan", r.plan);

  if (plan.items.length) {
    const blocks: string[] = [];
    for (const kind of KIND_ORDER) {
      const items = plan.items.filter((i) => i.kind === kind);
      if (!items.length) continue;
      blocks.push(
        `${KIND_LABEL[kind]}\n` +
          items
            .map((i) => `- ${i.name}${i.where === "clinic" ? " (in clinic)" : ""}: ${i.instructions}${i.duration ? ` For ${i.duration}.` : ""}${i.cautions ? ` Cautions: ${i.cautions}` : ""}`)
            .join("\n"),
      );
    }
    if (plan.reviewInWeeks) blocks.push(`Review in ${plan.reviewInWeeks} week${plan.reviewInWeeks === 1 ? "" : "s"}.`);
    section("Treatment plan issued", blocks.join("\n\n"));
  }

  if (footer) {
    const when = footer.approvedAt.slice(0, 16).replace("T", " ");
    out.push(`Written and approved by ${footer.practitioner}${r.qualifications ? ` (${r.qualifications})` : ""} on ${when} UTC.`);
  }
  return out.join("\n\n");
}
