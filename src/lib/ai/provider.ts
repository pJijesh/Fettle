/**
 * The drafting step sits behind this interface so the model vendor, and where it processes
 * data, can change without touching the rest of the app. Providers return an untrusted object;
 * the service validates and filters it before anything is stored.
 */

export interface DraftInput {
  /** Non-empty transcript lines, numbered from 1 by position. */
  transcriptLines: string[];
  practitioner: string;
  patientLabel: string;
}

export interface DraftingProvider {
  /** Short name shown in the UI and written to the audit log. */
  name: string;
  /** Model identifier recorded with every draft. */
  model: string;
  /** True for providers that must not be used with real patient data. */
  isMock: boolean;
  draft(input: DraftInput, signal?: AbortSignal): Promise<unknown>;
}
