import { AnthropicAssist } from "./anthropic";
import { MockAssist } from "./mock";
import type { AssistProvider } from "./provider";

export * from "./provider";

/** Uses the same AI_PROVIDER, ANTHROPIC_API_KEY and ANTHROPIC_MODEL as note drafting. */
export function createAssist(env: Record<string, string | undefined> = process.env): AssistProvider {
  if ((env.AI_PROVIDER ?? "mock").toLowerCase() === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) throw new Error("AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY");
    return new AnthropicAssist(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL || "claude-sonnet-5-5");
  }
  return new MockAssist();
}
