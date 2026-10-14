import pg from "pg";
import { migrate } from "../src/lib/migrate";

/**
 * Builds a template database once (schema, policies, the restricted application role). Each test then
 * clones it in a few milliseconds, so every test starts from an empty, real Postgres and runs under
 * the same row-level security as production.
 */
const ADMIN = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/postgres";

function withDb(url: string, name: string) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

export default async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  const stale = await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'fettle_t_%' OR datname = 'fettle_template'");
  for (const r of stale.rows) await admin.query(`DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE)`);
  await admin.query("CREATE DATABASE fettle_template");
  await migrate(withDb(ADMIN, "fettle_template"));
  await admin.query("ALTER ROLE fettle_app LOGIN PASSWORD 'fettle_app'");
  await admin.end();

  return async () => {
    const a = new pg.Client({ connectionString: ADMIN });
    await a.connect();
    const dbs = await a.query("SELECT datname FROM pg_database WHERE datname LIKE 'fettle_t_%' OR datname = 'fettle_template'");
    for (const r of dbs.rows) await a.query(`DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE)`);
    await a.end();
  };
}
