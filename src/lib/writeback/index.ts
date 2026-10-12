import { ClinikoTarget } from "./cliniko";
import type { WritebackTarget } from "./types";

export function createTargets(env: NodeJS.ProcessEnv = process.env): Record<string, WritebackTarget> {
  return {
    cliniko: new ClinikoTarget({
      apiKey: env.CLINIKO_API_KEY || undefined,
      userAgent: env.CLINIKO_USER_AGENT || undefined,
      templateId: env.CLINIKO_TEMPLATE_ID || undefined,
    }),
  };
}
