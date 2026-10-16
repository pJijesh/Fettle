import { AssistError, type AssistProvider, type AssistTask } from "./provider";

/** Offline stand-in: returns each task's fixed demo answer. Not clinical. Never use with real patients. */
export class MockAssist implements AssistProvider {
  readonly name = "mock";
  readonly model = "mock-assist-v1";
  readonly isMock = true;
  async run<T>(task: AssistTask<T>): Promise<T> {
    const parsed = task.schema.safeParse(task.demo());
    if (!parsed.success) throw new AssistError("The demo answer was not valid");
    return parsed.data;
  }
}
