/** A small in-memory limiter for sign-in and public forms. One process only; move to a shared store when scaled out. */

const buckets = new Map<string, { count: number; reset: number }>();

export function allow(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const entry = buckets.get(key);
  if (!entry || entry.reset <= now) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  entry.count += 1;
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
  }
  return entry.count <= max;
}
