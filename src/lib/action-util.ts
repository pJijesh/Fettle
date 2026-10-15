import { headers } from "next/headers";
import { DomainError } from "./errors";
import { logError } from "./log";
import type { Issue } from "./validation";

export interface ActionState {
  ok?: boolean;
  message?: string;
  issues?: Issue[];
  url?: string;
  expiresAt?: string;
  data?: unknown;
}

export function fail(err: unknown): ActionState {
  if (err instanceof DomainError) return { ok: false, message: err.message, issues: err.issues };
  logError("action", err);
  return { ok: false, message: "Something went wrong. Nothing was changed that you need to redo; try again." };
}

export function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
}

export async function clientKey(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

export async function baseUrl(): Promise<string> {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export const cookieSecure = () => (process.env.APP_BASE_URL ?? "").startsWith("https://");

export const PORTAL_COOKIE = "ctp_portal";
