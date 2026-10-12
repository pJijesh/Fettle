import crypto from "node:crypto";

/** Password hashing, random tokens and TOTP (RFC 6238), using only Node's built-in crypto. */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64");
  let actual: Buffer;
  try {
    actual = crypto.scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** A hash to compare against when the account does not exist, so timing does not reveal it. */
export const DUMMY_HASH = hashPassword("not-a-real-password-for-timing");

export function passwordProblem(password: string, email: string): string | null {
  if (password.length < 12) return "Use at least 12 characters";
  if (password.length > 200) return "Use fewer than 200 characters";
  if (password.toLowerCase().includes(email.split("@")[0].toLowerCase()) && email.split("@")[0].length >= 4) {
    return "Do not include your email name in the password";
  }
  if (/^(.)\1+$/.test(password)) return "Choose a less repetitive password";
  return null;
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Six digits, uniformly random. */
export function randomCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

// ---------------------------------------------------------------- TOTP

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const code = ((hmac[offset] & 127) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 30_000);
}

/** Returns the matching time step (for replay protection) or null. Allows one step either side. */
export function verifyTotp(secret: string, code: string, now: Date, afterStep?: number | null): number | null {
  const cleaned = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleaned)) return null;
  const current = totpStep(now);
  for (const step of [current, current - 1, current + 1]) {
    if (afterStep != null && step <= afterStep) continue;
    const a = Buffer.from(totpAt(secret, step));
    const b = Buffer.from(cleaned);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return step;
  }
  return null;
}

export function otpauthUri(secret: string, account: string, issuer = "Consult-to-Programme"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
