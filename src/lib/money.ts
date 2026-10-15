/** Money is whole pence everywhere; these two functions are the only place it meets text. */

export function formatPence(pence: number): string {
  const neg = pence < 0;
  const abs = Math.abs(Math.round(pence));
  const pounds = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const p = String(abs % 100).padStart(2, "0");
  return `${neg ? "-" : ""}£${pounds}.${p}`;
}

/**
 * Reads "12", "12.5", "12.50" or "£1,200.00" as pence. Returns null for anything else: negatives, more than
 * two decimal places, letters, or an empty string.
 */
export function parsePounds(text: string): number | null {
  const t = text.trim().replace(/^£\s*/, "").replace(/,/g, "");
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  return Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, "0")) : 0);
}

/** For form fields: 1250 -> "12.50". */
export function poundsField(pence: number): string {
  return (pence / 100).toFixed(2);
}
