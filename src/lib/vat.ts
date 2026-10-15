/**
 * Reads a UK VAT registration number. Accepts "GB 980 7806 84", "980780684" and the like; returns it as
 * "GB980780684", or null if it cannot be a UK number. The nine-digit form is checked with HMRC's modulus-97 test
 * (both the original and the later variant), which catches most typing errors. This does not prove the number is
 * registered; that needs HMRC's online check.
 */
export function normaliseVatNumber(text: string): string | null {
  const t = text.replace(/[\s-]/g, "").toUpperCase().replace(/^GB/, "");
  if (/^(GD[0-4]\d\d|HA[5-9]\d\d)$/.test(t)) return `GB${t}`;
  const m = /^(\d{9})(\d{3})?$/.exec(t);
  if (!m) return null;
  const d = m[1].split("").map(Number);
  const weighted = d.slice(0, 7).reduce((s, n, i) => s + n * (8 - i), 0);
  const total = weighted + Number(m[1].slice(7));
  if (total % 97 !== 0 && (total + 55) % 97 !== 0) return null;
  return `GB${m[1]}${m[2] ?? ""}`;
}

/** For display: GB 980 7806 84. */
export function formatVatNumber(n: string): string {
  const m = /^GB(\d{3})(\d{4})(\d{2})(\d{3})?$/.exec(n);
  return m ? `GB ${m[1]} ${m[2]} ${m[3]}${m[4] ? ` ${m[4]}` : ""}` : n;
}
