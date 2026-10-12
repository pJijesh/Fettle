import crypto from "node:crypto";

/**
 * Signed links for patients: `<id>.<mac>`. The mac is an HMAC of the link's purpose and id, so nothing
 * secret is stored (a reminder sent later can rebuild the same link) and a link for one purpose cannot be
 * used for another. Keep LINK_SECRET private; changing it invalidates every outstanding link.
 */

export type LinkKind = "manage" | "form" | "offer";

function secretOf(secret?: string): string {
  const s = secret ?? process.env.LINK_SECRET ?? process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("LINK_SECRET (or SESSION_SECRET) must be set to a random string of at least 16 characters");
  return s;
}

function mac(kind: LinkKind, id: string, secret?: string): string {
  return crypto.createHmac("sha256", secretOf(secret)).update(`${kind}:${id}`).digest("base64url").slice(0, 32);
}

export function makeLink(kind: LinkKind, id: string, secret?: string): string {
  return `${id}.${mac(kind, id, secret)}`;
}

/** Returns the id when the token is genuine for this purpose, otherwise null. */
export function readLink(kind: LinkKind, token: string, secret?: string): string | null {
  if (!token || token.length > 120) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const id = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(kind, id, secret));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return id;
}
