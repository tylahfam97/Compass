import { describe, it, expect } from "vitest";
import {
  findRecurringStreak, patternLabelFor, amountHistoryOf, detectPriceChange, isNewRecurring, findAnnualCharges,
  type RecurringRow,
} from "./recurringDetection";

const row = (date: string, amount_cents = -1599, description = "Netflix"): RecurringRow =>
  ({ date, amount_cents, description, category_name: null, category_color: null });

describe("findRecurringStreak", () => {
  it("finds a day-of-month streak across consecutive months", () => {
    const streak = findRecurringStreak([row("2026-06-05"), row("2026-07-06"), row("2026-08-05"), row("2026-09-04")]);
    expect(streak?.mode).toBe("day");
    expect(streak?.txns.map((t) => t.date)).toEqual(["2026-06-05", "2026-07-06", "2026-08-05", "2026-09-04"]);
    expect(patternLabelFor(streak!.txns[3], streak!.mode)).toBe("4th of the month");
  });

  it("stops at a gap month", () => {
    const streak = findRecurringStreak([row("2026-05-05"), row("2026-07-05"), row("2026-08-05")]);
    expect(streak?.txns).toHaveLength(2);
  });

  it("prefers an nth-weekday streak when it is longer", () => {
    // First Mondays of 2026: Jun 1, Jul 6, Aug 3, Sep 7. Aug 3 is four days off the anchor's day of
    // month, so the day-of-month streak stops there and the weekday streak wins.
    const streak = findRecurringStreak([row("2026-06-01"), row("2026-07-06"), row("2026-08-03"), row("2026-09-07")]);
    expect(streak?.mode).toBe("weekday");
    expect(streak?.txns).toHaveLength(4);
    expect(patternLabelFor(streak!.txns[3], streak!.mode)).toBe("1st Monday of the month");
  });

  it("returns null for a single occurrence", () => {
    expect(findRecurringStreak([row("2026-09-04")])).toBeNull();
  });
});

describe("detectPriceChange", () => {
  it("flags a step change after a held price", () => {
    const change = detectPriceChange([1599, 1599, 1599, 1799]);
    expect(change).toEqual({ previousCents: 1599, currentCents: 1799, deltaCents: 200, pct: 200 / 1599 });
  });

  it("ignores a utility bill that changes every month", () => {
    expect(detectPriceChange([12000, 11500, 11000])).toBeNull();
  });

  it("ignores changes under a dollar or under 3%", () => {
    expect(detectPriceChange([1599, 1599, 1649])).toBeNull();
    expect(detectPriceChange([100000, 100000, 102000])).toBeNull();
  });

  it("needs the previous price to have held twice", () => {
    expect(detectPriceChange([1599, 1799])).toBeNull();
    expect(detectPriceChange([1399, 1599, 1799])).toBeNull();
  });

  it("reports decreases too", () => {
    expect(detectPriceChange([1799, 1799, 1599])?.deltaCents).toBe(-200);
  });

  it("reads the history off a streak", () => {
    const streak = findRecurringStreak([row("2026-07-05", -1599), row("2026-08-05", -1599), row("2026-09-05", -1799)]);
    expect(amountHistoryOf(streak!)).toEqual([1599, 1599, 1799]);
  });
});

describe("isNewRecurring", () => {
  it("is true for a short streak that started well after the history begins", () => {
    expect(isNewRecurring({ first_seen: "2026-07-10", month_count: 2 }, "2026-01-05", "2026-09-10")).toBe(true);
  });

  it("is false when the history barely predates the charge (a fresh import)", () => {
    expect(isNewRecurring({ first_seen: "2026-06-17", month_count: 3 }, "2026-06-01", "2026-09-10")).toBe(false);
  });

  it("is false for long streaks and for charges that started long ago", () => {
    expect(isNewRecurring({ first_seen: "2026-03-10", month_count: 6 }, "2025-01-01", "2026-09-10")).toBe(false);
    expect(isNewRecurring({ first_seen: "2026-04-01", month_count: 2 }, "2025-01-01", "2026-09-10")).toBe(false);
  });
});

describe("findAnnualCharges", () => {
  const prime = (date: string, cents = -13900) => ({ description: "Amazon Prime Membership", amount_cents: cents, date });

  it("finds a yearly renewal coming up within 30 days", () => {
    const out = findAnnualCharges([prime("2024-09-28"), prime("2025-09-28")], "2026-09-10");
    expect(out).toHaveLength(1);
    expect(out[0].expectedDate).toBe("2026-09-28");
    expect(out[0].amountCents).toBe(13900);
  });

  it("ignores renewals that are months away, monthly charges and small amounts", () => {
    expect(findAnnualCharges([prime("2024-12-01"), prime("2025-12-01")], "2026-09-10")).toHaveLength(0);
    const monthly = ["2025-10-05", "2025-11-05", "2025-12-05", "2026-01-05", "2026-09-05"].map((d) => prime(d, -1599));
    expect(findAnnualCharges(monthly, "2026-09-10")).toHaveLength(0);
    expect(findAnnualCharges([prime("2024-09-28", -900), prime("2025-09-28", -900)], "2026-09-10")).toHaveLength(0);
  });
});
