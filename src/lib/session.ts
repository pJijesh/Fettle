import { getDb, type Db } from "./db";

/**
 * Rate limiting for sign-in and public forms. Counts live in Postgres, so every app process shares them.
 * Keys are hashed in the database; nothing identifying is stored in the clear.
 */
export async function allowOn(db: Db, key: string, max: number, windowMs: number): Promise<boolean> {
  return db.system(async () => (await db.get<{ ok: boolean }>("SELECT rate_limit_hit(?, ?::int, ?::int) AS ok", [key, max, windowMs]))!.ok);
}

export function allow(key: string, max: number, windowMs: number): Promise<boolean> {
  return allowOn(getDb(), key, max, windowMs);
}
