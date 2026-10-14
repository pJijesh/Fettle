import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isOverlap } from "@/lib/db";
import { createTestDb, type TestDb } from "./testdb";

const T = "2026-10-12T10:00:00.000Z";

let t: TestDb;

async function seedClinic(id: string, slug: string) {
  const q = (sql: string, p: unknown[] = []) => t.admin.query(sql, p);
  await q("INSERT INTO clinics (id, name, slug, created_at) VALUES ($1, $2, $3, $4)", [id, `Clinic ${id}`, slug, T]);
  await q("INSERT INTO users (id, clinic_id, email, name, role, password_hash, created_at) VALUES ($1,$2,$3,'Dr','owner','x',$4)", [`u-${id}`, id, `${id}@example.com`, T]);
  await q("INSERT INTO patients (id, clinic_id, first_name, last_name, created_at, updated_at) VALUES ($1,$2,'Ann','Able',$3,$3)", [`p-${id}`, id, T]);
  await q("INSERT INTO appointment_types (id, clinic_id, name, duration_min) VALUES ($1,$2,'Follow-up',30)", [`t-${id}`, id]);
}

beforeAll(async () => {
  t = await createTestDb();
  await seedClinic("a", "a");
  await seedClinic("b", "b");
});
afterAll(() => t.drop());

describe("row-level security", () => {
  it("the application role cannot bypass it", async () => {
    const r = await t.admin.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'fettle_app'");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const owns = await t.admin.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'fettle_app'");
    expect(owns.rows[0].n).toBe(0);
  });

  it("shows a clinic only its own rows, even with no WHERE clause", async () => {
    const a = await t.db.scope("a", () => t.db.all<{ id: string }>("SELECT id FROM patients"));
    const b = await t.db.scope("b", () => t.db.all<{ id: string }>("SELECT id FROM patients"));
    expect(a.map((r) => r.id)).toEqual(["p-a"]);
    expect(b.map((r) => r.id)).toEqual(["p-b"]);
  });

  it("shows nothing outside a scope, and refuses calls with no scope at all", async () => {
    const rows = await t.db.system(() => t.db.all("SELECT id FROM patients"));
    expect(rows).toEqual([]);
    await expect(t.db.all("SELECT 1")).rejects.toThrow(/outside a clinic scope/);
  });

  it("cannot read another clinic's row by id", async () => {
    const row = await t.db.scope("a", () => t.db.get("SELECT * FROM patients WHERE id = ?", ["p-b"]));
    expect(row).toBeUndefined();
  });

  it("cannot update or delete another clinic's row", async () => {
    const changed = await t.db.scope("a", () => t.db.run("UPDATE patients SET last_name = 'Hacked' WHERE id = ?", ["p-b"]));
    const gone = await t.db.scope("a", () => t.db.run("DELETE FROM patients WHERE id = ?", ["p-b"]));
    expect(changed).toBe(0);
    expect(gone).toBe(0);
    const still = await t.admin.query("SELECT last_name FROM patients WHERE id = 'p-b'");
    expect(still.rows[0].last_name).toBe("Able");
  });

  it("cannot write a row into another clinic", async () => {
    await expect(
      t.db.scope("a", () =>
        t.db.run("INSERT INTO patients (id, clinic_id, first_name, last_name, created_at, updated_at) VALUES ('x','b','X','Y',?,?)", [T, T]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot move its own row into another clinic", async () => {
    await expect(t.db.scope("a", () => t.db.run("UPDATE patients SET clinic_id = 'b' WHERE id = 'p-a'"))).rejects.toThrow(/row-level security/);
  });

  it("cannot attach one clinic's records to another clinic's patient", async () => {
    await expect(
      t.db.scope("a", () =>
        t.db.run(
          `INSERT INTO appointments (id, clinic_id, patient_id, user_id, type_id, start_at, end_at, hold_until, status, source, created_by, created_at, updated_at)
           VALUES ('x','a','p-b','u-a','t-a',?,?,?,'booked','staff','t',?,?)`,
          [T, "2026-10-12T10:30:00.000Z", "2026-10-12T10:30:00.000Z", T, T],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("lets anyone read clinics (public pages) but only change their own", async () => {
    const all = await t.db.system(() => t.db.all<{ slug: string }>("SELECT slug FROM clinics ORDER BY slug"));
    expect(all.map((c) => c.slug)).toEqual(["a", "b"]);
    const other = await t.db.scope("a", () => t.db.run("UPDATE clinics SET name = 'Hijacked' WHERE id = 'b'"));
    expect(other).toBe(0);
    await expect(t.db.scope("a", () => t.db.run("INSERT INTO clinics (id, name, slug, created_at) VALUES ('c','C','c',?)", [T]))).rejects.toThrow();
  });

  it("keeps the audit trail append-only for the application", async () => {
    await t.db.scope("a", () => t.db.run("INSERT INTO audit_log (clinic_id, actor, action, at) VALUES ('a','me','test',?)", [T]));
    await expect(t.db.scope("a", () => t.db.run("UPDATE audit_log SET actor = 'x'"))).rejects.toThrow(/permission denied/);
    await expect(t.db.scope("a", () => t.db.run("DELETE FROM audit_log"))).rejects.toThrow(/permission denied/);
  });

  it("answers the pre-sign-in lookups and nothing more", async () => {
    const u = await t.db.system(() => t.db.all<{ clinic_id: string }>("SELECT * FROM auth_user_by_email(?)", ["A@example.com"]));
    expect(u[0].clinic_id).toBe("a");
    expect(await t.db.system(() => t.db.get("SELECT * FROM auth_user_by_email(?)", ["nobody@example.com"]))).toBeUndefined();
    const needed = await t.db.system(() => t.db.get<{ setup_needed: boolean }>("SELECT setup_needed()"));
    expect(needed?.setup_needed).toBe(false);
  });

  it("refuses a second first-run set-up", async () => {
    await expect(
      t.db.system(() => t.db.run("SELECT bootstrap_clinic('z','Z','z','Europe/London','uz','z@example.com','Z','h',?)", [T])),
    ).rejects.toThrow(/setup_done/);
  });
});

describe("double-booking protection", () => {
  const insert = (id: string, start: string, end: string, hold: string, status = "booked") =>
    t.db.run(
      `INSERT INTO appointments (id, clinic_id, patient_id, user_id, type_id, start_at, end_at, hold_until, status, source, created_by, created_at, updated_at)
       VALUES (?,'a','p-a','u-a','t-a',?,?,?,?,'staff','t',?,?)`,
      [id, start, end, hold, status, T, T],
    );

  it("refuses overlapping appointments for one clinician, including the buffer", async () => {
    await t.db.scope("a", async () => {
      await insert("a1", "2026-11-02T09:00:00Z", "2026-11-02T09:30:00Z", "2026-11-02T09:40:00Z");
      const err = await t.db.attempt(() => insert("a2", "2026-11-02T09:35:00Z", "2026-11-02T10:05:00Z", "2026-11-02T10:05:00Z")).catch((e) => e);
      expect(isOverlap(err)).toBe(true);
      await t.db.attempt(() => insert("a3", "2026-11-02T09:40:00Z", "2026-11-02T10:10:00Z", "2026-11-02T10:10:00Z"));
    });
  });

  it("frees the time when an appointment is cancelled", async () => {
    await t.db.scope("a", async () => {
      await insert("c1", "2026-11-03T09:00:00Z", "2026-11-03T09:30:00Z", "2026-11-03T09:30:00Z");
      await t.db.run("UPDATE appointments SET status = 'cancelled' WHERE id = 'c1'");
      await insert("c2", "2026-11-03T09:00:00Z", "2026-11-03T09:30:00Z", "2026-11-03T09:30:00Z");
    });
  });

  it("returns times as ISO strings in UTC", async () => {
    const row = await t.db.scope("a", () => t.db.get<{ start_at: string }>("SELECT start_at FROM appointments WHERE id = 'a1'"));
    expect(row?.start_at).toBe("2026-11-02T09:00:00.000Z");
  });
});
