import { describe, expect, it } from "vitest";
import { addDays, clockToMinutes, dayBounds, isDate, utcToZoned, weekdayOf, zonedToUtc } from "@/lib/tz";
import { makeLink, readLink } from "@/lib/links";

const TZ = "Europe/London";

describe("clinic time zone handling", () => {
  it("converts winter and summer London times to UTC", () => {
    expect(zonedToUtc("2026-01-15", 9 * 60, TZ)?.toISOString()).toBe("2026-01-15T09:00:00.000Z");
    expect(zonedToUtc("2026-07-15", 9 * 60, TZ)?.toISOString()).toBe("2026-07-15T08:00:00.000Z");
  });

  it("clocks go forward on the last Sunday of March 2026 (the 29th): 01:30 does not exist", () => {
    expect(zonedToUtc("2026-03-29", 90, TZ)).toBeNull();
    expect(zonedToUtc("2026-03-29", 60 * 9, TZ)?.toISOString()).toBe("2026-03-29T08:00:00.000Z"); // BST already
    const { start, end } = dayBounds("2026-03-29", TZ);
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(23);
  });

  it("clocks go back on the last Sunday of October 2026 (the 25th): the day has 25 hours", () => {
    const { start, end } = dayBounds("2026-10-25", TZ);
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(25);
    expect(zonedToUtc("2026-10-25", 9 * 60, TZ)?.toISOString()).toBe("2026-10-25T09:00:00.000Z"); // GMT again
    expect(zonedToUtc("2026-10-24", 9 * 60, TZ)?.toISOString()).toBe("2026-10-24T08:00:00.000Z"); // still BST
    // 01:30 happens twice; the first (BST) one is used
    expect(zonedToUtc("2026-10-25", 90, TZ)?.toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  it("round-trips UTC to local across the change", () => {
    const z = utcToZoned(new Date("2026-03-29T00:59:00Z"), TZ);
    expect(z).toMatchObject({ date: "2026-03-29", minutes: 59 });
    const after = utcToZoned(new Date("2026-03-29T01:00:00Z"), TZ);
    expect(after).toMatchObject({ date: "2026-03-29", minutes: 120 });
  });

  it("works out weekdays and date maths", () => {
    expect(weekdayOf("2026-10-12")).toBe(1); // Monday
    expect(weekdayOf("2026-10-18")).toBe(7);
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(isDate("2026-02-29")).toBe(false);
    expect(clockToMinutes("09:30")).toBe(570);
    expect(clockToMinutes("25:00")).toBeNull();
  });
});

describe("signed patient links", () => {
  const secret = "test-secret-0123456789abcdef";
  it("accepts a genuine link only for its own purpose", () => {
    const t = makeLink("manage", "appt-1", secret);
    expect(readLink("manage", t, secret)).toBe("appt-1");
    expect(readLink("form", t, secret)).toBeNull();
    expect(readLink("manage", t.replace("appt-1", "appt-2"), secret)).toBeNull();
    expect(readLink("manage", "garbage", secret)).toBeNull();
    expect(readLink("manage", t, "another-secret-0123456789")).toBeNull();
  });
});
