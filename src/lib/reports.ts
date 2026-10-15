import type { Db } from "./db";
import { DomainError } from "./errors";
import { addDays, dayBounds, isDate, utcToZoned, weekdayOf } from "./tz";

export interface ClinicianRow {
  userId: string;
  name: string;
  seen: number;
  noShows: number;
  cancelled: number;
  bookedMinutes: number;
  availableMinutes: number;
  /** Minutes of appointments that took place or are still to come, as a share of working-hours minutes. */
  utilisation: number | null;
}

export interface Report {
  from: string;
  to: string;
  timezone: string;
  total: number;
  seen: number;
  upcoming: number;
  noShows: number;
  cancelled: number;
  /** No-shows as a share of appointments that were due (seen plus no-shows). */
  noShowRate: number | null;
  cancellationRate: number | null;
  newPatients: number;
  bySource: { source: string; count: number }[];
  byType: { type: string; count: number }[];
  byClinician: ClinicianRow[];
}

const MAX_DAYS = 366;

/**
 * Practice figures for a date range in the clinic's own time zone. Counts only; no patient is named, so the
 * page is safe to show to anyone who can see the diary.
 */
export class Reports {
  constructor(
    private db: Db,
    private now: () => Date = () => new Date(),
  ) {}

  async range(clinicId: string, from: string, to: string): Promise<Report> {
    if (!isDate(from) || !isDate(to) || to < from) throw new DomainError("validation", "Choose a start date that is on or before the end date");
    let days = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) if (++days > MAX_DAYS) throw new DomainError("validation", "Choose a range of a year or less");

    return this.db.scope(clinicId, async () => {
      const clinic = (await this.db.get<{ timezone: string }>("SELECT timezone FROM clinics WHERE id = ?", [clinicId]))!;
      const tz = clinic.timezone;
      const fromUtc = dayBounds(from, tz).start.toISOString();
      const toUtc = dayBounds(to, tz).end.toISOString();

      const appts = await this.db.all<{ user_id: string; user_name: string; type_name: string; status: string; source: string; start_at: string; end_at: string }>(
        `SELECT a.user_id, u.name AS user_name, t.name AS type_name, a.status, a.source, a.start_at, a.end_at
         FROM appointments a JOIN users u ON u.id = a.user_id JOIN appointment_types t ON t.id = a.type_id
         WHERE a.clinic_id = ? AND a.start_at >= ? AND a.start_at < ?`,
        [clinicId, fromUtc, toUtc],
      );
      const hours = await this.db.all<{ user_id: string; weekday: number; start_min: number; end_min: number }>(
        "SELECT user_id, weekday, start_min, end_min FROM clinician_hours WHERE clinic_id = ?",
        [clinicId],
      );
      const newPatients = Number((await this.db.get<{ n: number }>("SELECT count(*) AS n FROM patients WHERE clinic_id = ? AND created_at >= ? AND created_at < ? AND import_batch IS NULL", [clinicId, fromUtc, toUtc]))?.n ?? 0);

      const now = this.now().getTime();
      const isSeen = (a: { status: string }) => a.status === "completed" || a.status === "arrived";
      const isUpcoming = (a: { status: string; start_at: string }) => a.status === "booked" && new Date(a.start_at).getTime() > now;
      // A booking still marked "booked" after its time has passed has not been closed off; it counts as neither seen nor missed.
      const mins = (a: { start_at: string; end_at: string }) => Math.round((new Date(a.end_at).getTime() - new Date(a.start_at).getTime()) / 60_000);

      const seen = appts.filter(isSeen).length;
      const noShows = appts.filter((a) => a.status === "no_show").length;
      const cancelled = appts.filter((a) => a.status === "cancelled").length;
      const upcoming = appts.filter(isUpcoming).length;

      const count = (rows: string[]) => {
        const m = new Map<string, number>();
        for (const r of rows) m.set(r, (m.get(r) ?? 0) + 1);
        return [...m].map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v || a.k.localeCompare(b.k));
      };
      const live = appts.filter((a) => a.status !== "cancelled");

      const clinicians = new Map<string, string>();
      for (const a of appts) clinicians.set(a.user_id, a.user_name);
      for (const h of hours) if (!clinicians.has(h.user_id)) {
        const u = await this.db.get<{ name: string }>("SELECT name FROM users WHERE id = ?", [h.user_id]);
        if (u) clinicians.set(h.user_id, u.name);
      }

      const byClinician: ClinicianRow[] = [...clinicians].map(([userId, name]) => {
        const mine = appts.filter((a) => a.user_id === userId);
        const myHours = hours.filter((h) => h.user_id === userId);
        let available = 0;
        for (let d = from; d <= to; d = addDays(d, 1)) {
          for (const h of myHours) if (h.weekday === weekdayOf(d)) available += h.end_min - h.start_min;
        }
        const booked = mine.filter((a) => a.status !== "cancelled" && a.status !== "no_show").reduce((n, a) => n + mins(a), 0);
        return {
          userId, name,
          seen: mine.filter(isSeen).length,
          noShows: mine.filter((a) => a.status === "no_show").length,
          cancelled: mine.filter((a) => a.status === "cancelled").length,
          bookedMinutes: booked,
          availableMinutes: available,
          utilisation: available > 0 ? Math.min(1, booked / available) : null,
        };
      }).sort((a, b) => a.name.localeCompare(b.name));

      const due = seen + noShows;
      return {
        from, to, timezone: tz,
        total: appts.length, seen, upcoming, noShows, cancelled,
        noShowRate: due > 0 ? noShows / due : null,
        cancellationRate: appts.length > 0 ? cancelled / appts.length : null,
        newPatients,
        bySource: count(live.map((a) => a.source)).map(({ k, v }) => ({ source: k, count: v })),
        byType: count(live.map((a) => a.type_name)).map(({ k, v }) => ({ type: k, count: v })),
        byClinician,
      };
    });
  }

  /** Default range: the last 28 days up to and including today, in the clinic's time zone. */
  async defaultRange(clinicId: string): Promise<{ from: string; to: string }> {
    return this.db.scope(clinicId, async () => {
      const tz = (await this.db.get<{ timezone: string }>("SELECT timezone FROM clinics WHERE id = ?", [clinicId]))!.timezone;
      const today = utcToZoned(this.now(), tz).date;
      return { from: addDays(today, -27), to: today };
    });
  }
}
