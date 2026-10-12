/**
 * Clinic-local time helpers. Everything is stored in UTC; a clinic's day is cut in its own zone
 * (Europe/London by default), so clock changes are handled by the platform's time-zone data.
 */

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface Zoned {
  date: string; // YYYY-MM-DD
  minutes: number; // minutes since local midnight
  weekday: number; // ISO: 1 = Monday ... 7 = Sunday
}

export function utcToZoned(d: Date, tz: string): Zoned {
  const p: Record<string, string> = {};
  for (const part of fmt(tz).formatToParts(d)) p[part.type] = part.value;
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: weekdayOf(date) };
}

/** UTC offset in minutes of `tz` at the instant `d` (positive east of Greenwich). */
function offsetMinutes(d: Date, tz: string): number {
  const p: Record<string, string> = {};
  for (const part of fmt(tz).formatToParts(d)) p[part.type] = part.value;
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return js === 0 ? 7 : js;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * The UTC instant for a wall-clock time in `tz`. Returns null when that wall time does not exist
 * (the hour skipped when clocks go forward). When it happens twice (clocks go back) the first one wins.
 */
export function zonedToUtc(date: string, minutes: number, tz: string): Date | null {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  let guess = new Date(wall - offsetMinutes(new Date(wall), tz) * 60_000);
  guess = new Date(wall - offsetMinutes(guess, tz) * 60_000);
  // Check by converting back; also look for an earlier occurrence on a repeated hour.
  const back = utcToZoned(guess, tz);
  if (back.date !== date || back.minutes !== minutes) return null;
  const earlier = new Date(guess.getTime() - 3_600_000);
  const eb = utcToZoned(earlier, tz);
  return eb.date === date && eb.minutes === minutes ? earlier : guess;
}

/** UTC bounds [start, end) of a local calendar day. */
export function dayBounds(date: string, tz: string): { start: Date; end: Date } {
  const start = zonedToUtc(date, 0, tz) ?? new Date(Date.UTC(...(date.split("-").map(Number) as [number, number, number]).map((v, i) => (i === 1 ? v - 1 : v)) as [number, number, number]));
  const next = addDays(date, 1);
  const end = zonedToUtc(next, 0, tz) ?? new Date(start.getTime() + 24 * 3_600_000);
  return { start, end };
}

export function minutesToClock(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function clockToMinutes(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi > 0)) return null;
  return h * 60 + mi;
}

export function formatLocal(iso: string, tz: string, style: "time" | "date" | "datetime" = "datetime"): string {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions =
    style === "time"
      ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
      : style === "date"
        ? { weekday: "short", day: "numeric", month: "short", year: "numeric" }
        : { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }).format(d);
}
