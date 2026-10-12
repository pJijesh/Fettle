export interface WritebackInput {
  /** The patient's id in the practice system. */
  patientId: string;
  title: string;
  text: string;
  practitioner: string;
  /** Our own consult id, included so a human can trace the note back. */
  reference: string;
}

export interface WritebackTarget {
  name: string;
  label: string;
  isConfigured(): boolean;
  /** Creates the note in the practice system and returns its id there. */
  createNote(input: WritebackInput): Promise<{ externalId: string }>;
}
