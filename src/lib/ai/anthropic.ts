import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { DraftOutput } from "../schemas";
import type { DraftInput, DraftingProvider } from "./provider";
import { SYSTEM_PROMPT, userPrompt } from "./prompt";

/**
 * Drafts through the Anthropic Messages API using a forced tool call, so the response is
 * structured JSON rather than prose. Patient data leaves this app when this provider runs:
 * confirm the vendor's data-processing terms and processing region before using real patient data.
 */
export class AnthropicProvider implements DraftingProvider {
  readonly name = "anthropic";
  readonly isMock = false;
  private client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey, timeout: 90_000, maxRetries: 1 });
  }

  async draft(input: DraftInput, signal?: AbortSignal): Promise<unknown> {
    const schema = z.toJSONSchema(DraftOutput, { target: "draft-7", io: "input" }) as Record<string, unknown>;
    delete schema.$schema;

    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 6000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt(input.transcriptLines, input.practitioner) }],
        tools: [
          {
            name: "submit_drafts",
            description: "Submit the structured consultation note and the home exercise programme draft.",
            input_schema: schema as Anthropic.Tool.InputSchema,
          },
        ],
        tool_choice: { type: "tool", name: "submit_drafts" },
      },
      { signal },
    );

    const block = response.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") throw new Error("The model did not return a draft");
    return block.input;
  }
}
