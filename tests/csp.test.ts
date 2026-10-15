import { describe, expect, it } from "vitest";
import { buildCsp, isHttps } from "@/lib/csp";

describe("content security policy", () => {
  it("allows scripts only with the nonce, and nothing framed, plugged in or posted elsewhere", () => {
    const csp = buildCsp("abc123");
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/);
    for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"]) expect(csp).toContain(d);
    expect(csp).not.toContain("upgrade-insecure-requests");
  });
  it("adds eval only in development and upgrade-insecure-requests only on https", () => {
    expect(buildCsp("n", { dev: true })).toMatch(/script-src[^;]*'unsafe-eval'/);
    expect(buildCsp("n", { https: true })).toContain("upgrade-insecure-requests");
  });
  it("detects https directly or through a proxy header", () => {
    expect(isHttps("https://x.test/a", null)).toBe(true);
    expect(isHttps("http://x.test/a", "https")).toBe(true);
    expect(isHttps("https://x.test/a", "http")).toBe(false);
    expect(isHttps("http://localhost/a", null)).toBe(false);
  });
});
