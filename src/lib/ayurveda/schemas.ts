import { z } from "zod";

/**
 * The Ayurvedic consultation record and treatment plan. They are stored in the same two columns as the
 * physiotherapy note and programme (`note_json`, `programme_json`) and go through the same consent, approval,
 * immutable snapshot and patient-link steps. Unlike the physiotherapy note they are written by the practitioner:
 * nothing here is drafted by an AI model, and the software supplies no herb or dose.
 */

export const Dosha = z.enum(["vata", "pitta", "kapha"]);
export type Dosha = z.infer<typeof Dosha>;
export const DOSHAS: readonly Dosha[] = ["vata", "pitta", "kapha"];

export const Agni = z.enum(["sama", "vishama", "tikshna", "manda", "unsure"]);
export type Agni = z.infer<typeof Agni>;
export const AGNI_LABEL: Record<Agni, string> = {
  sama: "Sama (balanced)",
  vishama: "Vishama (irregular)",
  tikshna: "Tikshna (sharp)",
  manda: "Manda (slow)",
  unsure: "Not assessed",
};

export const Ama = z.enum(["present", "absent", "unsure"]);
export type Ama = z.infer<typeof Ama>;

export const Pregnancy = z.enum(["not_asked", "yes", "no", "not_applicable"]);
export type Pregnancy = z.infer<typeof Pregnancy>;

const doshaSet = z.object({
  doshas: z.array(Dosha).max(3),
  notes: z.string().trim().max(1000),
});

export const AyurvedaRecord = z.object({
  /** Qualification the approving practitioner practises under. Required to approve. */
  qualifications: z.string().trim().max(200),
  chiefComplaint: z.string().trim().max(2000),
  history: z.string().max(6000),
  pastHistory: z.string().max(4000),
  /** Everything the patient takes, including herbs and supplements. "None" is an answer; blank is not. */
  medications: z.string().trim().max(2000),
  allergies: z.string().trim().max(1000),
  diet: z.string().max(2000),
  sleep: z.string().max(1000),
  digestion: z.string().max(2000),
  mind: z.string().max(2000),
  /** Constitution (prakriti): the person's usual balance. */
  prakriti: doshaSet,
  /** Current imbalance (vikriti). */
  vikriti: doshaSet,
  agni: Agni,
  ama: Ama,
  /** Pulse (nadi), tongue (jihva), and other findings. */
  examination: z.string().max(4000),
  safety: z.object({
    /** True only when the practitioner confirms the safety screen was done. Approval needs it. */
    screened: z.boolean(),
    pregnancy: Pregnancy,
    findings: z.array(z.string().trim().max(200)).max(20),
    notes: z.string().trim().max(1000),
  }),
  assessment: z.string().max(6000),
  plan: z.string().max(6000),
});
export type AyurvedaRecord = z.infer<typeof AyurvedaRecord>;

export const PlanKind = z.enum(["therapy", "herb", "diet", "lifestyle"]);
export type PlanKind = z.infer<typeof PlanKind>;
export const KIND_ORDER: readonly PlanKind[] = ["therapy", "herb", "diet", "lifestyle"];
export const KIND_LABEL: Record<PlanKind, string> = { therapy: "Therapies", herb: "Herbs and preparations", diet: "Diet", lifestyle: "Daily routine and lifestyle" };
export const KIND_SINGULAR: Record<PlanKind, string> = { therapy: "Therapy", herb: "Herb or preparation", diet: "Diet", lifestyle: "Lifestyle" };

export const PlanItem = z.object({
  kind: PlanKind,
  /** Set when the item came from the starter library; empty for anything the practitioner wrote. */
  libraryId: z.string().max(60).nullable(),
  name: z.string().trim().max(120),
  /** How to take or do it. For herbs this is the form, dose and timing, written by the practitioner. */
  instructions: z.string().trim().max(800),
  duration: z.string().trim().max(80),
  where: z.enum(["home", "clinic"]),
  cautions: z.string().trim().max(500),
});
export type PlanItem = z.infer<typeof PlanItem>;

export const AyurvedaPlan = z.object({
  title: z.string().trim().min(1).max(120),
  patientIntro: z.string().trim().max(800),
  items: z.array(PlanItem).max(25),
  safetyAdvice: z.array(z.string().trim().max(300)).max(8),
  reviewInWeeks: z.number().int().min(1).max(26).nullable(),
});
export type AyurvedaPlan = z.infer<typeof AyurvedaPlan>;

export const AyurvedaDraft = z.object({ record: AyurvedaRecord, plan: AyurvedaPlan });
export type AyurvedaDraft = z.infer<typeof AyurvedaDraft>;

export function emptyRecord(): AyurvedaRecord {
  return {
    qualifications: "",
    chiefComplaint: "",
    history: "",
    pastHistory: "",
    medications: "",
    allergies: "",
    diet: "",
    sleep: "",
    digestion: "",
    mind: "",
    prakriti: { doshas: [], notes: "" },
    vikriti: { doshas: [], notes: "" },
    agni: "unsure",
    ama: "unsure",
    examination: "",
    safety: { screened: false, pregnancy: "not_asked", findings: [], notes: "" },
    assessment: "",
    plan: "",
  };
}

export function emptyPlan(): AyurvedaPlan {
  return { title: "Your Ayurvedic plan", patientIntro: "", items: [], safetyAdvice: [], reviewInWeeks: null };
}
