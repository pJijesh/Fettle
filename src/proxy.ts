import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, HSTS, isHttps } from "@/lib/csp";

/** Adds the Content-Security-Policy (with a fresh nonce) to every page, and HSTS when served over https. */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const https = isHttps(request.url, request.headers.get("x-forwarded-proto"));
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV === "development", https });

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  if (https) response.headers.set("Strict-Transport-Security", HSTS);
  return response;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico|api/consults/[^/]+/audio).*)", missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }] }],
};
