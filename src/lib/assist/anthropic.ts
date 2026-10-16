import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AssistError, type AssistProvider, type AssistTask } from "./provider";

/**
 * Runs each task as a forced tool call so the answer is structured data, then checks it against the task's schema.
 * Patient data leaves this app when this provider runs: confirm the vendor's data-processing terms and processing
 * region before using real patient data. Names and contact details are never put in a task.
 */
export class AnthropicAssist implements AssistProvider {
  readonly name = "anthropic";
  readonly isMock = false;
  private client: Anthropic;

  constructor(apiKey: string, readonly model: string) {
    this.client = new Anthropic({ apiKey, timeout: 90_000, maxRetries: 1 });
  }

  async run<T>(task: AssistTask<T>, signal?: AbortSignal): Promise<T> {
    const schema = z.toJSONSchema(task.schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
    delete schema.$schema;
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 4000,
        system: task.system,
        messages: [{ role: "user", content: task.user }],
        tools: [{ name: "submit", description: "Submit the result.", input_schema: schema as Anthropic.Tool.InputSchema }],
        tool_choice: { type: "tool", name: "submit" },
      },
      { signal },
    );
    const block = response.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") throw new AssistError("The assistant did not return a result");
    const parsed = task.schema.safeParse(block.input);
    if (!parsed.success) throw new AssistError("The assistant returned something that could not be used");
    return parsed.data;
  }
}
