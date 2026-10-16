import type { z } from "zod";

/**
 * A small, structured request to the language model: instructions, the data, and the shape the answer must have.
 * Every assistive feature (letters, summaries, checks, suggestions) is one of these, so there is one place that
 * decides which vendor is used and one place that checks the answer is the shape it should be.
 */
export interface AssistTask<T> {
  /** Used in the audit log and as the name of the tool call. */
  name: string;
  system: string;
  /** Everything the model may use. Built by the caller; never includes names or contact details. */
  user: string;
  schema: z.ZodType<T>;
  /** What the offline demo provider returns for this task. Clearly labelled as demo text. */
  demo: () => T;
}

export class AssistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistError";
  }
}

export interface AssistProvider {
  name: string;
  model: string;
  /** True for the offline stand-in, which must not be used with real patients. */
  isMock: boolean;
  /** Returns an answer that already matches the task's schema, or throws AssistError. */
  run<T>(task: AssistTask<T>, signal?: AbortSignal): Promise<T>;
}
