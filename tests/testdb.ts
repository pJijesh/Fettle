import crypto from "node:crypto";
import pg from "pg";
import { Db, createPool } from "@/lib/db";

const ADMIN = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/postgres";

function withDb(url: string, name: string, user?: string, password?: string) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  if (user) {
    u.username = user;
    u.password = password ?? "";
  }
  return u.toString();
}

export interface TestDb {
  /** The application's connection: the restricted role, subject to row-level security. */
  db: Db;
  /** A superuser connection to the same database, for arranging and checking things the app cannot see. */
  admin: pg.Pool;
  name: string;
  drop(): Promise<void>;
}

/** A fresh, empty, real database cloned from the migrated template. */
export async function createTestDb(): Promise<TestDb> {
  const name = `fettle_t_${crypto.randomBytes(6).toString("hex")}`;
  const boot = new pg.Client({ connectionString: ADMIN });
  await boot.connect();
  await boot.query(`CREATE DATABASE "${name}" TEMPLATE fettle_template`);
  await boot.end();
  const db = new Db(createPool(withDb(ADMIN, name, "fettle_app", "fettle_app"), 5));
  const admin = new pg.Pool({ connectionString: withDb(ADMIN, name), max: 2 });
  return {
    db,
    admin,
    name,
    async drop() {
      await db.close();
      await admin.end();
      const c = new pg.Client({ connectionString: ADMIN });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await c.end();
    },
  };
}
