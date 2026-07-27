import { describe, it, expect } from "vitest";
import { computeNextOccurrence, daysUntil, formatCadenceLabel } from "./recurring";

describe("computeNextOccurrence - monthly", () => {
  it("returns this month's occurrence if it hasn't passed yet", () => {
    const rule = { cadence: "monthly" as const, day_of_month: 15, day_of_week: null, start_date: "2026-01-01" };
    const next = computeNextOccurrence(rule, new Date(2026, 6, 1)); // July 1, 2026
    expect(next).toEqual(new Date(2026, 6, 15));
  });

  it("rolls over to next month once this month's day has passed", () => {
    const rule = { cadence: "monthly" as const, day_of_month: 15, day_of_week: null, start_date: "2026-01-01" };
    const next = computeNextOccurrence(rule, new Date(2026, 6, 20)); // July 20, 2026
    expect(next).toEqual(new Date(2026, 7, 15)); // Aug 15, 2026
  });

  it("clamps a day-of-month beyond a shorter month's length instead of overflowing", () => {
    const rule = { cadence: "monthly" as const, day_of_month: 31, day_of_week: null, start_date: "2025-01-01" };
    const next = computeNextOccurrence(rule, new Date(2026, 1, 1)); // Feb 1, 2026 (28-day, non-leap)
    expect(next).toEqual(new Date(2026, 1, 28));
  });

  it("never returns a date before the rule's start_date", () => {
    const rule = { cadence: "monthly" as const, day_of_month: 5, day_of_week: null, start_date: "2026-09-10" };
    const next = computeNextOccurrence(rule, new Date(2026, 6, 1)); // July 1, 2026 - before start
    expect(next.getTime()).toBeGreaterThanOrEqual(new Date(2026, 8, 10).getTime());
  });
});

describe("computeNextOccurrence - weekly/biweekly", () => {
  // Jan 1, 2024 is a known Monday (day_of_week 0 in this app's Mon=0..Sun=6 convention).
  const mondayAnchor = "2024-01-01";

  it("returns the anchor date itself when `from` lands exactly on it", () => {
    const rule = { cadence: "weekly" as const, day_of_month: null, day_of_week: 0, start_date: mondayAnchor };
    expect(computeNextOccurrence(rule, new Date(2024, 0, 1))).toEqual(new Date(2024, 0, 1));
  });

  it("weekly: finds the next matching weekday on/after `from`", () => {
    const rule = { cadence: "weekly" as const, day_of_month: null, day_of_week: 0, start_date: mondayAnchor };
    // Jan 20, 2024 is a Saturday - next Monday on/after it is Jan 22.
    expect(computeNextOccurrence(rule, new Date(2024, 0, 20))).toEqual(new Date(2024, 0, 22));
  });

  it("biweekly: stays anchored to a stable 14-day cadence from start_date", () => {
    const rule = { cadence: "biweekly" as const, day_of_month: null, day_of_week: 0, start_date: mondayAnchor };
    // Occurrences: Jan 1, 15, 29... next on/after Jan 20 (Sat) is Jan 29, NOT Jan 22.
    expect(computeNextOccurrence(rule, new Date(2024, 0, 20))).toEqual(new Date(2024, 0, 29));
  });
});

describe("daysUntil", () => {
  it("counts whole days between two dates, floored to local midnight", () => {
    expect(daysUntil(new Date(2026, 6, 20), new Date(2026, 6, 15))).toBe(5);
  });

  it("returns a negative number for a date in the past", () => {
    expect(daysUntil(new Date(2026, 6, 10), new Date(2026, 6, 15))).toBe(-5);
  });
});

describe("formatCadenceLabel", () => {
  it.each([
    [1, "Monthly on the 1st"],
    [2, "Monthly on the 2nd"],
    [3, "Monthly on the 3rd"],
    [4, "Monthly on the 4th"],
    [21, "Monthly on the 21st"],
    [31, "Monthly on the 31st"],
  ])("formats monthly day %i as %s", (day, expected) => {
    expect(formatCadenceLabel({ cadence: "monthly", day_of_month: day, day_of_week: null, start_date: "2026-01-01" })).toBe(expected);
  });

  it("formats a weekly rule", () => {
    expect(formatCadenceLabel({ cadence: "weekly", day_of_month: null, day_of_week: 4, start_date: "2026-01-01" })).toBe("Weekly on Friday");
  });

  it("formats a biweekly rule", () => {
    expect(formatCadenceLabel({ cadence: "biweekly", day_of_month: null, day_of_week: 0, start_date: "2026-01-01" })).toBe("Every other Monday");
  });
});
