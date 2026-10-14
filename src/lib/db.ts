import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

/**
 * Postgres access with row-level security.
 *
 * Every query runs inside a transaction that names a clinic (`scope`) or none (`system`). The clinic is
 * written to the transaction setting `app.clinic_id`, and the database's policies then show that clinic's
 * rows and no others. The application connects as a role that cannot bypass those policies, so a query
 * that forgets its WHERE clause still cannot read another clinic's data.
 *
 * The current transaction travels with the call chain (AsyncLocalStorage), so service code just calls
 * `db.all(...)`; a call made outside any scope is refused rather than guessed at.
 */

// Times come back as ISO strings (UTC), counts and sums as numbers, to match what the service code expects.
pg.types.setTypeParser(1184, (v: string) => {
  if (v === "infinity" || v === "-infinity") return v;
  const iso = v.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
  return new Date(iso).toISOString();
});
pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(1700, (v: string) => Number(v));

export type Row = Record<string, unknown>;

interface Ctx {
  client: pg.PoolClient;
  clinicId: string | null;
  savepoints: number;
}

/** Turns `?` placeholders into `$1, $2, ...`, leaving quoted text alone. */
export function numberPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      out += c;
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
      out += c;
    } else if (c === "?") {
      out += `$${++n}`;
    } else {
      out += c;
    }
  }
  return out;
}

export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "23505";
}

export function isOverlap(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === "23P01" && e.constraint === "appointment_overlap";
}

export class Db {
  private als = new AsyncLocalStorage<Ctx>();

  constructor(readonly pool: pg.Pool) {}

  /** Runs `fn` as one transaction limited to a single clinic. Calls nested inside join the same transaction. */
  async scope<T>(clinicId: string, fn: () => Promise<T>): Promise<T> {
    if (!clinicId) throw new Error("A clinic id is required");
    const cur = this.als.getStore();
    if (cur) {
      if (cur.clinicId !== clinicId) throw new Error("Cannot switch clinic inside an open scope");
      return fn();
    }
    return this.open(clinicId, fn);
  }

  /**
   * Runs `fn` as one transaction with no clinic. Only the pre-sign-in lookup functions and the clinics
   * list work here; every other table shows no rows.
   */
  async system<T>(fn: () => Promise<T>): Promise<T> {
    if (this.als.getStore()) return fn();
    return this.open(null, fn);
  }

  /** The clinic of the transaction in progress, if any. */
  currentClinic(): string | null {
    return this.als.getStore()?.clinicId ?? null;
  }

  private async open<T>(clinicId: string | null, fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (clinicId) await client.query("SELECT set_config('app.clinic_id', $1, true)", [clinicId]);
      const result = await this.als.run({ client, clinicId, savepoints: 0 }, fn);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The connection is already gone; releasing it below discards it.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private ctx(): Ctx {
    const c = this.als.getStore();
    if (!c) throw new Error("Database call outside a clinic scope");
    return c;
  }

  async all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.ctx().client.query(numberPlaceholders(sql), params);
    return res.rows as T[];
  }

  async get<T = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.all<T>(sql, params))[0];
  }

  /** Runs a statement and returns how many rows it changed. */
  async run(sql: string, params: unknown[] = []): Promise<number> {
    const res = await this.ctx().client.query(numberPlaceholders(sql), params);
    return res.rowCount ?? 0;
  }

  /**
   * Runs `fn` so that if it throws, only its own changes are undone and the surrounding transaction stays
   * usable. (After a failed statement Postgres refuses further work in the same transaction otherwise.)
   */
  async attempt<T>(fn: () => Promise<T>): Promise<T> {
    const c = this.ctx();
    const name = `sp_${++c.savepoints}`;
    await c.client.query(`SAVEPOINT ${name}`);
    try {
      const result = await fn();
      await c.client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (err) {
      await c.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await c.client.query(`RELEASE SAVEPOINT ${name}`);
      throw err;
    }
  }

  /** Makes other transactions that lock the same key wait until this one ends. Used per clinician when booking. */
  async lock(key: string): Promise<void> {
    await this.ctx().client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createPool(url: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString: url, max, options: "-c TimeZone=UTC" });
}

const globalForDb = globalThis as unknown as { __fettleDb?: Db };

/** The application's database, connecting as the restricted role named in DATABASE_URL. */
export function getDb(): Db {
  if (!globalForDb.__fettleDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set. See .env.example.");
    globalForDb.__fettleDb = new Db(createPool(url));
  }
  return globalForDb.__fettleDb;
}
