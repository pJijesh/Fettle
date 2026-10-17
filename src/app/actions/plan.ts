"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getPlatform } from "@/lib/app";
import { DomainError } from "@/lib/errors";
import { logError } from "@/lib/log";
import { baseUrl } from "@/lib/action-util";

// These keep working after a trial ends, since they are how a clinic gets back in.

function back(message: string): never {
  redirect(`/settings/plan?error=${encodeURIComponent(message)}`);
}

async function go(run: (url: string) => Promise<{ url: string }>): Promise<never> {
  let target: string;
  try {
    target = (await run(await baseUrl())).url;
  } catch (err) {
    if (err instanceof DomainError) back(err.message);
    logError("plan", err);
    back("Could not reach the payment page. Nothing was charged; try again in a moment.");
  }
  redirect(target);
}

export async function subscribeAction(): Promise<void> {
  const user = await requireUser(["owner"], { allowReadOnly: true });
  await go((url) => getPlatform().plans.startSubscription(user, url));
}

export async function managePlanAction(): Promise<void> {
  const user = await requireUser(["owner"], { allowReadOnly: true });
  await go((url) => getPlatform().plans.openPortal(user, url));
}
