import { AnthropicProvider } from "./anthropic";
import { MockProvider } from "./mock";
import type { DraftingProvider } from "./provider";

export function createProvider(env: NodeJS.ProcessEnv = process.env): DraftingProvider {
  const wanted = (env.AI_PROVIDER ?? "mock").toLowerCase();
  if (wanted === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error("AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY");
    }
    return new AnthropicProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL || "claude-sonnet-5-5");
  }
  return new MockProvider();
}
