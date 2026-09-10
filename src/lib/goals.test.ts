import { describe, it, expect } from "vitest";
import { goalIsOnTrack, goalPct, projectGoalCompletion, monthlyPaceFromBalances, monthBounds, daysElapsed, currentWeekBounds } from "./goals";

const base = { target_months: null, streak: 0, noBalanceData: false };

describe("goalIsOnTrack", () => {
  it("evaluates each goal type against its own rule", () => {
    expect(goalIsOnTrack({ ...base, type: "reduce_spend", target_cents: 30000, current: 29999 })).toBe(true);
    expect(goalIsOnTrack({ ...base, type: "reduce_spend", target_cents: 30000, current: 30001 })).toBe(false);
    expect(goalIsOnTrack({ ...base, type: "balance_floor", target_cents: 250000, current: 100000 })).toBe(false);
    expect(goalIsOnTrack({ ...base, type: "balance_floor", target_cents: 250000, current: 300000, noBalanceData: true })).toBe(false);
    expect(goalIsOnTrack({ ...base, type: "debt_paydown", target_cents: 0, current: 0 })).toBe(true);
    expect(goalIsOnTrack({ ...base, type: "budget_streak", target_cents: 0, target_months: 3, current: 200, streak: 2 })).toBe(false);
    expect(goalIsOnTrack({ ...base, type: "savings_rate_habit", target_cents: 2000, target_months: 2, current: 200, streak: 2 })).toBe(true);
    expect(goalIsOnTrack({ ...base, type: "net_savings", target_cents: 50000, current: 50000 })).toBe(true);
  });
});

describe("goalPct", () => {
  it("clamps at 150 and uses months for streak goals", () => {
    expect(goalPct({ ...base, type: "net_savings", target_cents: 10000, current: 25000 })).toBe(150);
    expect(goalPct({ ...base, type: "budget_streak", target_cents: 0, target_months: 4, current: 200, streak: 2 })).toBe(50);
    expect(goalPct({ ...base, type: "debt_paydown", target_cents: 0, current: 5000, debtPaydownPct: 42 })).toBe(42);
    expect(goalPct({ ...base, type: "reduce_spend", target_cents: 0, current: 5000 })).toBe(0);
  });
});

describe("projectGoalCompletion", () => {
  it("rounds months up, returns 0 when done and null when not gaining", () => {
    expect(projectGoalCompletion(250000, 40000)).toBe(7);
    expect(projectGoalCompletion(0, 40000)).toBe(0);
    expect(projectGoalCompletion(250000, 0)).toBeNull();
    expect(projectGoalCompletion(250000, -1000)).toBeNull();
  });
});

describe("monthlyPaceFromBalances", () => {
  it("derives a monthly paydown pace from the first and last balance", () => {
    const pace = monthlyPaceFromBalances([{ date: "2026-06-01", value: -4000 }, { date: "2026-09-01", value: -3400 }]);
    expect(pace?.changeCents).toBe(600);
    expect(pace?.days).toBe(92);
    expect(pace?.paceCents).toBe(Math.round(600 / (92 / 30.4)));
  });

  it("needs at least two months of span", () => {
    expect(monthlyPaceFromBalances([{ date: "2026-08-01", value: -4000 }, { date: "2026-09-01", value: -3400 }])).toBeNull();
    expect(monthlyPaceFromBalances([{ date: "2026-09-01", value: -3400 }])).toBeNull();
  });
});

describe("date helpers", () => {
  it("bound months in local time and count elapsed days only for the current month", () => {
    expect(monthBounds("2026-09")).toEqual(["2026-09-01", "2026-10-01"]);
    expect(monthBounds("2026-12")).toEqual(["2026-12-01", "2027-01-01"]);
    const today = new Date(2026, 8, 10);
    expect(daysElapsed("2026-09", today)).toBe(10);
    expect(daysElapsed("2026-08", today)).toBe(31);
    expect(currentWeekBounds(today)).toEqual(["2026-09-07", "2026-09-14"]);
  });
});
