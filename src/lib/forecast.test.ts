import { describe, it, expect } from "vitest";
import {
  expandOccurrences,
  detectedChargeToRule,
  monthlyEquivalentCents,
  deriveDailyBaselineCents,
  projectCashFlow,
  deriveNextActions,
  toISODate,
  daysFromToday,
  type ForecastRule,
  type ForecastEvent,
} from "./forecast";

function rule(overrides: Partial<ForecastRule> = {}): ForecastRule {
  return {
    id: 1,
    description: "Rent",
    amount_cents: -150_000,
    source: "rule",
    cadence: "monthly",
    day_of_month: 1,
    day_of_week: null,
    start_date: "2026-01-01",
    ...overrides,
  };
}

function event(date: string, amountCents: number, key = date): ForecastEvent {
  return { key, date, description: "x", amountCents, source: "rule", categoryName: null, categoryColor: null };
}

describe("expandOccurrences", () => {
  it("returns every occurrence inside the window, not just the next one", () => {
    const events = expandOccurrences([rule()], new Date(2026, 0, 1), new Date(2026, 3, 15));
    expect(events.map((e) => e.date)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]);
  });

  it("clamps a day-of-month past the end of a short month", () => {
    const events = expandOccurrences(
      [rule({ day_of_month: 31 })],
      new Date(2026, 1, 1),
      new Date(2026, 1, 28)
    );
    expect(events.map((e) => e.date)).toEqual(["2026-02-28"]); // 2026 is not a leap year
  });

  it("steps biweekly rules a fortnight at a time", () => {
    const events = expandOccurrences(
      [rule({ cadence: "biweekly", day_of_month: null, day_of_week: 4, start_date: "2026-01-02" })],
      new Date(2026, 0, 1),
      new Date(2026, 1, 15)
    );
    // Jan 2 2026 is a Friday (day_of_week 4 = Friday in the app's Mon=0 convention).
    expect(events.map((e) => e.date)).toEqual(["2026-01-02", "2026-01-16", "2026-01-30", "2026-02-13"]);
  });

  it("returns nothing when the window closes before the rule starts", () => {
    const events = expandOccurrences([rule({ start_date: "2026-06-01" })], new Date(2026, 0, 1), new Date(2026, 2, 1));
    expect(events).toEqual([]);
  });

  it("sorts events from several rules by date", () => {
    const events = expandOccurrences(
      [rule({ id: 1, day_of_month: 20 }), rule({ id: 2, description: "Pay", amount_cents: 300_000, day_of_month: 5 })],
      new Date(2026, 0, 1),
      new Date(2026, 0, 31)
    );
    expect(events.map((e) => e.date)).toEqual(["2026-01-05", "2026-01-20"]);
  });

  it("gives every occurrence a distinct key", () => {
    const events = expandOccurrences([rule()], new Date(2026, 0, 1), new Date(2026, 2, 15));
    expect(new Set(events.map((e) => e.key)).size).toBe(events.length);
  });

  it("handles an empty rule list", () => {
    expect(expandOccurrences([], new Date(2026, 0, 1), new Date(2026, 2, 1))).toEqual([]);
  });
});

describe("detectedChargeToRule", () => {
  it("projects an inferred charge monthly from the day it was last seen", () => {
    const r = detectedChargeToRule(
      { description: "NETFLIX", amount_cents: -1599, last_seen: "2026-07-14" },
      0
    );
    expect(r.cadence).toBe("monthly");
    expect(r.day_of_month).toBe(14);
    expect(r.source).toBe("detected");
  });

  it("always treats an inferred charge as money going out", () => {
    const r = detectedChargeToRule({ description: "X", amount_cents: 2500, last_seen: "2026-07-14" }, 0);
    expect(r.amount_cents).toBe(-2500);
  });

  it("uses negative ids so they cannot collide with real rule ids", () => {
    expect(detectedChargeToRule({ description: "A", amount_cents: -1, last_seen: "2026-07-01" }, 0).id).toBeLessThan(0);
    expect(detectedChargeToRule({ description: "B", amount_cents: -1, last_seen: "2026-07-01" }, 3).id).toBeLessThan(0);
  });
});

describe("monthlyEquivalentCents", () => {
  it("leaves a monthly amount alone", () => {
    expect(monthlyEquivalentCents({ cadence: "monthly", amount_cents: -100_000 })).toBe(-100_000);
  });

  it("scales weekly and biweekly onto a monthly basis", () => {
    expect(monthlyEquivalentCents({ cadence: "weekly", amount_cents: -10_000 })).toBe(-43_333);
    expect(monthlyEquivalentCents({ cadence: "biweekly", amount_cents: -10_000 })).toBe(-21_667);
  });
});

describe("deriveDailyBaselineCents", () => {
  it("removes known bills so they are not counted twice", () => {
    // $3000/mo total spend, $1500/mo of it already projected as individual bills.
    expect(deriveDailyBaselineCents(300_000, 150_000)).toBe(5_000);
  });

  it("never goes negative when bills exceed average spend", () => {
    expect(deriveDailyBaselineCents(100_000, 400_000)).toBe(0);
  });
});

describe("projectCashFlow", () => {
  const base = {
    startingBalanceCents: 100_000,
    startDate: "2026-08-01",
    days: 30,
    dailyBaselineCents: 0,
  };

  it("produces one day per requested day", () => {
    const r = projectCashFlow({ ...base, events: [] });
    expect(r.days).toHaveLength(30);
    expect(r.days[0].date).toBe("2026-08-01");
    expect(r.days[29].date).toBe("2026-08-30");
  });

  it("applies events on the day they land", () => {
    const r = projectCashFlow({ ...base, events: [event("2026-08-03", -40_000)] });
    expect(r.days[1].balanceCents).toBe(100_000);
    expect(r.days[2].balanceCents).toBe(60_000);
  });

  it("subtracts the daily baseline every day", () => {
    const r = projectCashFlow({ ...base, events: [], dailyBaselineCents: 1_000 });
    expect(r.days[0].balanceCents).toBe(99_000);
    expect(r.days[9].balanceCents).toBe(90_000);
  });

  it("finds the low point rather than just the final balance", () => {
    const r = projectCashFlow({
      ...base,
      events: [event("2026-08-05", -90_000, "a"), event("2026-08-20", 200_000, "b")],
    });
    expect(r.lowPoint?.date).toBe("2026-08-05");
    expect(r.lowPoint?.balanceCents).toBe(10_000);
    expect(r.days[29].balanceCents).toBe(210_000);
  });

  it("reports the first day the balance goes negative", () => {
    const r = projectCashFlow({ ...base, events: [event("2026-08-04", -150_000)] });
    expect(r.firstShortfall?.date).toBe("2026-08-04");
    expect(r.shortfallDays.length).toBeGreaterThan(0);
  });

  it("reports no shortfall when the balance never dips below zero", () => {
    const r = projectCashFlow({ ...base, events: [event("2026-08-04", -10_000)] });
    expect(r.firstShortfall).toBeNull();
    expect(r.shortfallDays).toEqual([]);
  });

  it("treats a zero balance as surviving, not a shortfall", () => {
    const r = projectCashFlow({ ...base, events: [event("2026-08-02", -100_000)] });
    expect(r.firstShortfall).toBeNull();
  });

  it("identifies the next money-in event", () => {
    const r = projectCashFlow({
      ...base,
      events: [event("2026-08-03", -5_000, "a"), event("2026-08-10", 250_000, "b")],
    });
    expect(r.nextIncome?.date).toBe("2026-08-10");
  });

  it("says you make it to payday when the balance holds until then", () => {
    const r = projectCashFlow({
      ...base,
      events: [event("2026-08-05", -50_000, "a"), event("2026-08-15", 200_000, "b")],
    });
    expect(r.makesItToPayday).toBe(true);
  });

  it("says you do not make it when the balance dips before payday", () => {
    const r = projectCashFlow({
      ...base,
      events: [event("2026-08-05", -150_000, "a"), event("2026-08-15", 200_000, "b")],
    });
    expect(r.makesItToPayday).toBe(false);
  });

  it("totals income and bills separately", () => {
    const r = projectCashFlow({
      ...base,
      events: [event("2026-08-03", -20_000, "a"), event("2026-08-10", 300_000, "b"), event("2026-08-12", -5_000, "c")],
    });
    expect(r.totalIncomeCents).toBe(300_000);
    expect(r.totalBillsCents).toBe(25_000);
  });

  it("bases safe-to-spend on the low point, not today's balance", () => {
    const r = projectCashFlow({ ...base, events: [event("2026-08-10", -70_000)] });
    expect(r.safeToSpendCents).toBe(30_000);
  });

  it("subtracts the buffer from safe-to-spend and never returns a negative", () => {
    const r = projectCashFlow({ ...base, events: [event("2026-08-10", -70_000)], bufferCents: 50_000 });
    expect(r.safeToSpendCents).toBe(0);
  });

  it("survives an empty window without throwing", () => {
    const r = projectCashFlow({ ...base, days: 0, events: [] });
    expect(r.days).toEqual([]);
    expect(r.lowPoint).toBeNull();
    expect(r.safeToSpendCents).toBe(100_000);
  });

  it("crosses a month boundary correctly", () => {
    const r = projectCashFlow({ ...base, startDate: "2026-08-30", days: 4, events: [] });
    expect(r.days.map((d) => d.date)).toEqual(["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]);
  });
});

describe("date helpers", () => {
  it("formats a local date without shifting across a timezone boundary", () => {
    expect(toISODate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("counts whole days forward and backward from a reference date", () => {
    const today = new Date(2026, 7, 18);
    expect(daysFromToday("2026-08-24", today)).toBe(6);
    expect(daysFromToday("2026-08-18", today)).toBe(0);
    expect(daysFromToday("2026-08-11", today)).toBe(-7);
  });
});

describe("deriveNextActions", () => {
  const today = new Date(2026, 7, 1);
  const ctx = { hasIncomeRule: true, detectedCount: 0, dailyBaselineCents: 2_000, today };

  function forecastWith(events: ForecastEvent[], startingBalanceCents = 100_000) {
    return projectCashFlow({
      startingBalanceCents,
      startDate: "2026-08-01",
      days: 30,
      events,
      dailyBaselineCents: 2_000,
    });
  }

  it("leads with covering a shortfall when one is projected", () => {
    const actions = deriveNextActions(forecastWith([event("2026-08-05", -200_000)]), ctx);
    expect(actions[0].key).toBe("cover_shortfall");
    expect(actions[0].tone).toBe("urgent");
  });

  it("spells out the daily amount needed to close the gap", () => {
    const actions = deriveNextActions(forecastWith([event("2026-08-11", -200_000)]), ctx);
    expect(actions[0].detail).toMatch(/a day for the next \d+ days/);
  });

  it("urges scheduling income when none exists and nothing else is wrong", () => {
    const actions = deriveNextActions(forecastWith([]), { ...ctx, hasIncomeRule: false });
    const income = actions.find((a) => a.key === "add_income");
    expect(income?.tone).toBe("urgent");
  });

  it("demotes the income prompt below an active shortfall", () => {
    const actions = deriveNextActions(forecastWith([event("2026-08-05", -200_000)]), {
      ...ctx,
      hasIncomeRule: false,
    });
    expect(actions[0].key).toBe("cover_shortfall");
    expect(actions.find((a) => a.key === "add_income")?.tone).toBe("suggested");
  });

  it("offers to confirm detected charges when there are any", () => {
    const actions = deriveNextActions(forecastWith([]), { ...ctx, detectedCount: 3 });
    expect(actions.find((a) => a.key === "confirm_detected")?.title).toContain("3 detected charges");
  });

  it("singularises a lone detected charge", () => {
    const actions = deriveNextActions(forecastWith([]), { ...ctx, detectedCount: 1 });
    expect(actions.find((a) => a.key === "confirm_detected")?.title).toContain("1 detected charge");
  });

  it("flags a thin cushion that still technically survives", () => {
    // $700 against $20/day of baseline: ends at $100, so it holds - but only just.
    const actions = deriveNextActions(forecastWith([], 70_000), ctx);
    expect(actions.some((a) => a.key === "thin_cushion")).toBe(true);
    expect(actions.some((a) => a.key === "cover_shortfall")).toBe(false);
  });

  it("suggests putting a large surplus to work", () => {
    const actions = deriveNextActions(forecastWith([], 5_000_000), ctx);
    expect(actions.some((a) => a.key === "surplus")).toBe(true);
  });

  it("never flags a thin cushion and a surplus at the same time", () => {
    for (const balance of [50_000, 300_000, 5_000_000]) {
      const actions = deriveNextActions(forecastWith([], balance), ctx);
      const keys = actions.map((a) => a.key);
      expect(keys.includes("thin_cushion") && keys.includes("surplus")).toBe(false);
    }
  });

  it("returns nothing to do when the picture is healthy and complete", () => {
    const actions = deriveNextActions(forecastWith([event("2026-08-15", 300_000)], 200_000), ctx);
    expect(actions.filter((a) => a.tone === "urgent")).toEqual([]);
  });

  it("does not divide by zero when there is no baseline spending", () => {
    const r = projectCashFlow({
      startingBalanceCents: 100_000, startDate: "2026-08-01", days: 30, events: [], dailyBaselineCents: 0,
    });
    expect(() => deriveNextActions(r, { ...ctx, dailyBaselineCents: 0 })).not.toThrow();
  });
});
