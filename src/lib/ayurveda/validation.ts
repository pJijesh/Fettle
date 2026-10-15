import type { Issue } from "../validation";
import { getLibraryItem } from "./catalogue";
import type { AyurvedaDraft } from "./schemas";

/** Rules that apply when the practitioner approves. The record can be saved half-finished; it cannot be approved so. */
export function ayurvedaApprovalIssues(d: AyurvedaDraft): Issue[] {
  const { record: r, plan } = d;
  const issues: Issue[] = [];
  const need = (ok: boolean, path: string, message: string) => {
    if (!ok) issues.push({ path, message });
  };

  need(r.qualifications.trim().length > 0, "record.qualifications", "Enter the qualification you practise under");
  need(r.safety.screened, "record.safety.screened", "Confirm that the safety screen was done before approving");
  need(r.safety.pregnancy !== "not_asked", "record.safety.pregnancy", "Record whether the patient is pregnant or breastfeeding, or choose not applicable");
  need(r.medications.trim().length > 0, "record.medications", "Record what the patient takes, including herbs and supplements. Write “none” if nothing");
  need(r.allergies.trim().length > 0, "record.allergies", "Record any allergies. Write “none known” if there are none");
  need(r.chiefComplaint.trim().length > 0, "record.chiefComplaint", "Enter the main complaint");
  need(r.assessment.trim().length > 0, "record.assessment", "Write your assessment");

  const seen = new Set<string>();
  plan.items.forEach((item, i) => {
    const at = `plan.items.${i}`;
    if (!item.name.trim()) issues.push({ path: `${at}.name`, message: "Name the item" });
    if (!item.instructions.trim()) issues.push({ path: `${at}.instructions`, message: "Say how to do or take it" });
    if (item.kind === "herb") {
      if (!item.duration.trim()) issues.push({ path: `${at}.duration`, message: "Say how long to take it for" });
      if (!item.cautions.trim()) issues.push({ path: `${at}.cautions`, message: "Add cautions for this herb or preparation, or write “none known”" });
    }
    if (item.libraryId) {
      const lib = getLibraryItem(item.libraryId);
      if (!lib) issues.push({ path: `${at}.libraryId`, message: `Unknown library item "${item.libraryId}"` });
      else if (lib.kind !== item.kind) issues.push({ path: `${at}.kind`, message: "This item is not of that kind" });
    }
    const key = `${item.kind}:${item.name.trim().toLowerCase()}`;
    if (seen.has(key)) issues.push({ path: at, message: `“${item.name.trim()}” is listed twice` });
    seen.add(key);
  });
  return issues;
}
