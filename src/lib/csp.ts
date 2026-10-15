/**
 * The Content-Security-Policy sent with every page. Scripts need a fresh per-request nonce, so no injected
 * script can run. Styles allow inline attributes because the pages use them for layout; that is a much smaller
 * risk than inline script and is the usual trade-off.
 */
export function buildCsp(nonce: string, opts: { dev?: boolean; https?: boolean } = {}): string {
  const parts = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (opts.https) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

export const HSTS = "max-age=63072000; includeSubDomains";
export const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()";

/** True when the request reached us over https, directly or through a proxy that says so. */
export function isHttps(url: string, forwardedProto: string | null): boolean {
  if (forwardedProto) return forwardedProto.split(",")[0].trim().toLowerCase() === "https";
  return url.startsWith("https:");
}
