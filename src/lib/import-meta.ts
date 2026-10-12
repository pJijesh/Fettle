/** Safe for the browser: no server imports. Field lists and per-system guidance for the switching import. */

export type ImportKind = "patients" | "appointments";
export type ImportSource = "cliniko" | "tm3" | "writeupp" | "other";

export interface FieldDef {
  key: string;
  label: string;
  /** Column heading used in the downloadable template. Always matched automatically on upload. */
  header: string;
  /** Example value in the template. */
  example: string;
}

export const PATIENT_FIELDS: FieldDef[] = [
  { key: "firstName", header: "First name", label: "First name", example: "Asha" },
  { key: "lastName", header: "Last name", label: "Last name", example: "Patel" },
  { key: "fullName", header: "Full name", label: "Full name (if first and last are together)", example: "Asha Patel" },
  { key: "dob", header: "Date of birth", label: "Date of birth", example: "14/03/1985" },
  { key: "email", header: "Email", label: "Email", example: "asha@example.com" },
  { key: "phone", header: "Mobile", label: "Mobile or phone", example: "07700 900123" },
  { key: "address", header: "Address", label: "Address", example: "12 High Street, Feltham" },
  { key: "postcode", header: "Postcode", label: "Postcode", example: "TW13 4AB" },
  { key: "gpName", header: "GP", label: "GP", example: "Dr Jones" },
  { key: "gpPractice", header: "GP practice", label: "GP practice", example: "Feltham Surgery" },
  { key: "ref", header: "Patient ID", label: "Id in your old system", example: "10482" },
];

export const APPOINTMENT_FIELDS: FieldDef[] = [
  { key: "patientRef", header: "Patient ID", label: "Patient id in your old system", example: "10482" },
  { key: "patientEmail", header: "Patient email", label: "Patient email", example: "asha@example.com" },
  { key: "patientName", header: "Patient name", label: "Patient name", example: "Asha Patel" },
  { key: "start", header: "Start", label: "Start (date and time together)", example: "03/11/2026 14:30" },
  { key: "date", header: "Date", label: "Date (if separate from time)", example: "03/11/2026" },
  { key: "time", header: "Time", label: "Start time (if separate from date)", example: "14:30" },
  { key: "end", header: "End", label: "End (time or date and time)", example: "15:15" },
  { key: "clinician", header: "Clinician", label: "Clinician", example: "Sam Carter" },
  { key: "type", header: "Appointment type", label: "Appointment type", example: "Follow-up" },
  { key: "status", header: "Status", label: "Status", example: "Attended" },
];

export const FIELDS: Record<ImportKind, FieldDef[]> = { patients: PATIENT_FIELDS, appointments: APPOINTMENT_FIELDS };

export interface SourceInfo {
  label: string;
  /** What we actually know about getting data out, with where it came from. Never invented. */
  howTo: string[];
  /** What this app can read from that system today. */
  support: string;
  sourceUrl?: string;
  /** What the linked page is, so the link is not mistaken for the vendor's own. */
  sourceLabel?: string;
}

/**
 * Only facts published by the vendors themselves. Column headings are NOT listed because none of these
 * vendors publish them, so every import goes through the column check and can be corrected by hand.
 */
export const SOURCES: Record<ImportSource, SourceInfo> = {
  cliniko: {
    label: "Cliniko",
    howTo: [
      "Sign in as an administrator (only administrators can export patients).",
      "Go to Settings, then Data exports.",
      "Choose the data type, and for all patients set the date range to “Any time”.",
      "Click Export data and download the CSV when it is ready (the file is named like Patients-Cliniko-20261012.csv).",
    ],
    support: "Patient CSV: yes, through the column check. Appointment CSV: yes if you can export one, but the steps for it are not confirmed here.",
    sourceUrl: "https://help.cliniko.com/en/articles/1780957-exporting-patients",
    sourceLabel: "Cliniko help: exporting patients",
  },
  writeupp: {
    label: "WriteUpp",
    howTo: [
      "Open the menu at the top left and choose Tools, then Data Export.",
      "Choose the Patients tab (or Appointments) and click Export to CSV or Export to Excel.",
      "Treatment notes come out as separate PDFs and invoices as CSV in a ZIP; this app does not import either.",
    ],
    support: "Patients and appointments as CSV or Excel: yes, through the column check.",
    sourceUrl: "https://help.writeupp.com/en/article/how-do-i-export-data-out-of-writeupp-101pynw/",
    sourceLabel: "WriteUpp help: exporting data",
  },
  tm3: {
    label: "TM3",
    howTo: [
      "TM3 does not publish a ready-made patient CSV. Other providers say you should follow TM3's own export steps for each type of data and ask TM3 support about formats.",
      "Ask TM3 support for your patient list and appointment list as Excel or CSV. Many TM3 reports can be opened in Excel; upload that file here and check the columns.",
      "If you are leaving TM3, its data extraction tool produces a folder called tmBase. This app cannot read that format yet.",
    ],
    support: "A patient or appointment list saved as CSV or Excel: yes, through the column check. The tmBase extraction: no. If you have one, send a sample so a reader can be built and tested against it.",
    sourceUrl: "https://help.cliniko.com/en/articles/4365780-transfer-data-from-tm3-to-cliniko",
    sourceLabel: "Cliniko's guide to transferring from TM3",
  },
  other: {
    label: "Another system",
    howTo: [
      "Export a patient list (and then an appointment list) as CSV or Excel.",
      "Or download the template below, paste your data into it and upload it.",
    ],
    support: "Any CSV or Excel file with a header row, through the column check.",
  },
};

export const IMPORT_NOT_BROUGHT_ACROSS =
  "Treatment notes, documents, invoices and payments are not imported. Marketing, text and email consent are not imported either: a patient's consent has to be recorded again here, because it has to be provable.";
