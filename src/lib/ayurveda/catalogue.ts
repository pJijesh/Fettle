import type { Dosha, PlanKind } from "./schemas";

/**
 * Starter library for Ayurvedic treatment plans: therapies, diet and daily routine.
 *
 * STARTER CONTENT. It was written to give a practitioner something to begin from and has NOT been reviewed by a
 * qualified Ayurvedic practitioner or a clinical safety officer. The wording is general and traditional in
 * character; it makes no claim that any item treats a condition. A qualified practitioner must review and edit
 * all of it before it is used with patients.
 *
 * There are deliberately no herbs here, and no doses. Herbs and preparations are written into the plan by the
 * practitioner, who is responsible for the form, dose, duration, interactions and the product's legal status.
 * The intensive cleansing procedures (such as vamana, virechana and basti) are left out because they need
 * supervision this software cannot provide.
 */
export interface LibraryItem {
  id: string;
  kind: Exclude<PlanKind, "herb">;
  name: string;
  where: "home" | "clinic";
  instructions: string;
  cautions: string;
  /** Doshas the item is traditionally chosen for. Informational only. */
  doshas: Dosha[];
}

export const LIBRARY_REVIEWED = false;

export const LIBRARY: LibraryItem[] = [
  // Therapies given in clinic
  {
    id: "abhyanga",
    kind: "therapy",
    name: "Abhyanga (warm oil massage)",
    where: "clinic",
    instructions: "Full or partial body massage with warm medicated or plain oil, followed by rest.",
    cautions: "Check for skin allergies and the oil's ingredients (sesame, nuts). Avoid over broken or inflamed skin, during a fever, or on a full stomach. Take care with slippery floors afterwards.",
    doshas: ["vata"],
  },
  {
    id: "shirodhara",
    kind: "therapy",
    name: "Shirodhara (oil stream over the forehead)",
    where: "clinic",
    instructions: "A steady stream of warm oil or other liquid poured over the forehead while the patient lies down.",
    cautions: "Avoid with a fever, an acute head or ear condition, or when the patient cannot lie flat comfortably. Check oil allergies.",
    doshas: ["vata", "pitta"],
  },
  {
    id: "swedana",
    kind: "therapy",
    name: "Swedana (herbal steam or sweating)",
    where: "clinic",
    instructions: "Controlled warm steam applied to the body, usually after oil massage.",
    cautions: "Do not use in pregnancy, with heart or blood-pressure conditions, fever, dehydration, diabetes with reduced skin sensation, or when the patient is unwell. Monitor throughout and keep the face and head cool.",
    doshas: ["vata", "kapha"],
  },
  {
    id: "udvartana",
    kind: "therapy",
    name: "Udvartana (dry powder massage)",
    where: "clinic",
    instructions: "Firm massage with dry herbal powder.",
    cautions: "Avoid over broken, inflamed or very sensitive skin. Check the powder's ingredients for allergies.",
    doshas: ["kapha"],
  },
  {
    id: "nasya",
    kind: "therapy",
    name: "Nasya (nasal oil)",
    where: "clinic",
    instructions: "A small amount of warm oil or preparation applied into the nostrils after a gentle face and neck massage.",
    cautions: "Avoid in pregnancy, with an acute nasal or sinus infection, nosebleeds, or after a recent meal or bath. Check ingredients for allergies.",
    doshas: ["vata", "kapha"],
  },
  {
    id: "kati_basti",
    kind: "therapy",
    name: "Kati basti (warm oil pooled on the lower back)",
    where: "clinic",
    instructions: "Warm oil held over the lower back in a dough ring for a set time.",
    cautions: "Avoid over broken or inflamed skin, with a fever, or where there are signs of a serious back condition. Check the temperature before and during treatment.",
    doshas: ["vata"],
  },
  // Diet
  {
    id: "regular_meals",
    kind: "diet",
    name: "Regular meal times",
    where: "home",
    instructions: "Eat at similar times each day and avoid skipping meals.",
    cautions: "Adjust around any medical dietary needs, diabetes medicines or pregnancy advice.",
    doshas: ["vata", "pitta", "kapha"],
  },
  {
    id: "warm_cooked_food",
    kind: "diet",
    name: "Warm, freshly cooked food",
    where: "home",
    instructions: "Favour warm, freshly cooked meals over cold or heavily processed food.",
    cautions: "Follow any dietary restrictions, allergies or medical advice first.",
    doshas: ["vata"],
  },
  {
    id: "cooling_food",
    kind: "diet",
    name: "Less hot, spicy and fried food",
    where: "home",
    instructions: "Cut down on very spicy, sour, salty and fried food; favour fresh, mildly seasoned meals.",
    cautions: "Follow any dietary restrictions, allergies or medical advice first.",
    doshas: ["pitta"],
  },
  {
    id: "light_food",
    kind: "diet",
    name: "Lighter meals, less heavy and sweet food",
    where: "home",
    instructions: "Favour lighter meals and go easy on heavy, oily, sweet and dairy-rich foods.",
    cautions: "Not suitable as weight-loss advice for anyone underweight, pregnant, a child, or with a history of disordered eating. Follow medical dietary advice first.",
    doshas: ["kapha"],
  },
  {
    id: "main_meal_midday",
    kind: "diet",
    name: "Main meal at midday",
    where: "home",
    instructions: "Make lunch the largest meal and keep the evening meal lighter and earlier.",
    cautions: "Adjust around shift work and any diabetes medicines.",
    doshas: ["vata", "pitta", "kapha"],
  },
  {
    id: "warm_water",
    kind: "diet",
    name: "Sip warm water through the day",
    where: "home",
    instructions: "Drink warm or room-temperature water in small amounts through the day.",
    cautions: "Do not use if a doctor has restricted your fluids.",
    doshas: ["vata", "kapha"],
  },
  // Lifestyle
  {
    id: "daily_routine",
    kind: "lifestyle",
    name: "Regular daily routine (dinacharya)",
    where: "home",
    instructions: "Wake, eat and go to bed at similar times each day.",
    cautions: "Adapt to shift work, caring duties and health conditions.",
    doshas: ["vata", "pitta", "kapha"],
  },
  {
    id: "early_bed",
    kind: "lifestyle",
    name: "Wind down and get to bed early",
    where: "home",
    instructions: "Switch off screens an hour before bed and aim to be in bed by about 10:30pm.",
    cautions: "If sleep problems are severe or long-lasting, see a doctor.",
    doshas: ["vata", "pitta"],
  },
  {
    id: "self_abhyanga",
    kind: "lifestyle",
    name: "Self-massage with warm oil",
    where: "home",
    instructions: "Before a bath or shower, massage warm oil gently into the skin, then wash off.",
    cautions: "Patch-test the oil first. Avoid over broken, inflamed or infected skin, and during a fever. Oils make floors and baths slippery. Check for sesame and nut allergy.",
    doshas: ["vata"],
  },
  {
    id: "nadi_shodhana",
    kind: "lifestyle",
    name: "Alternate-nostril breathing (nadi shodhana)",
    where: "home",
    instructions: "Sit comfortably and breathe slowly and gently through alternate nostrils for about five minutes.",
    cautions: "Keep it gentle and never hold the breath strongly. Stop if dizzy or short of breath. Take advice first with breathing, heart or blood-pressure conditions, or in pregnancy.",
    doshas: ["vata", "pitta", "kapha"],
  },
  {
    id: "gentle_movement",
    kind: "lifestyle",
    name: "Daily walk or gentle yoga",
    where: "home",
    instructions: "Take a walk, or do gentle stretching or yoga, for 20 to 30 minutes most days.",
    cautions: "Match to your fitness and any injury. Stop if it hurts, and ask your practitioner or doctor if unsure.",
    doshas: ["vata", "pitta", "kapha"],
  },
  {
    id: "tongue_scraping",
    kind: "lifestyle",
    name: "Tongue scraping each morning",
    where: "home",
    instructions: "Use a clean, smooth tongue scraper gently each morning, then rinse.",
    cautions: "Be gentle. Stop if it causes pain or bleeding.",
    doshas: ["kapha"],
  },
];

export function getLibraryItem(id: string): LibraryItem | undefined {
  return LIBRARY.find((i) => i.id === id);
}
