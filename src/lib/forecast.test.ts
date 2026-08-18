import { describe, it, expect } from "vitest";
import {
  expandOccurrences,
  detectedChargeToRule,
  monthlyEquivalentCents,
  deriveDailyBaselineCents,
  projectCashFlow,
  deriveNextActions,
  chargeMatchesRule,
  resolveForecastWindow,
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

describe("chargeMatchesRule", () => {
  const rule = { description: "SoFi", amount_cents: -60127 };

  it("matches a hand-typed name against the bank's full ACH descriptor", () => {
    const charge = {
      description: "SoFi Bank PL DES:PL PYMT ID:T86083200 INDN:Tyler Fameli CO ID:3452499527 WEB",
      amount_cents: -60127,
    };
    expect(chargeMatchesRule(charge, rule)).toBe(true);
  });

  it("matches on a shared payee even when neither description contains the other", () => {
    expect(chargeMatchesRule({ description: "SoFi Bank PL PYMT", amount_cents: -60127 }, { description: "SoFi Loan", amount_cents: -60127 })).toBe(true);
  });

  it("tolerates a few cents of drift between months", () => {
    expect(chargeMatchesRule({ description: "SoFi Bank PL", amount_cents: -60180 }, rule)).toBe(true);
  });

  it("does not match a different payee that happens to cost the same", () => {
    expect(chargeMatchesRule({ description: "MOHELA DES:QDR", amount_cents: -60127 }, rule)).toBe(false);
  });

  it("does not match the same payee at a clearly different amount", () => {
    expect(chargeMatchesRule({ description: "SoFi Bank PL", amount_cents: -1200 }, rule)).toBe(false);
  });

  it("still matches identical descriptions regardless of amount", () => {
    expect(chargeMatchesRule({ description: "Rent", amount_cents: -120000 }, { description: "rent", amount_cents: -100000 })).toBe(true);
  });

  it("refuses to match on a payee fragment too short to be distinctive", () => {
    expect(chargeMatchesRule({ description: "PG Electric", amount_cents: -5000 }, { description: "PG", amount_cents: -5000 })).toBe(false);
  });

  it("handles descriptions that normalise to nothing", () => {
    expect(chargeMatchesRule({ description: "***", amount_cents: -5000 }, { description: "---", amount_cents: -5000 })).toBe(false);
  });
});

describe("resolveForecastWindow", () => {
  // Mirrors a real setup: biweekly Friday paycheck, rent on the 24th, a loan payment on the
  // 25th. "Today" is Tue 18 Aug 2026.
  const today = new Date(2026, 7, 18);
  const rules: ForecastRule[] = [
    { id: 1, description: "Paycheck", amount_cents: 233_100, source: "rule", cadence: "biweekly", day_of_month: null, day_of_week: 4, start_date: "2026-08-21" },
    { id: 2, description: "Rent", amount_cents: -102_400, source: "rule", cadence: "monthly", day_of_month: 24, day_of_week: null, start_date: "2026-01-24" },
    { id: 3, description: "SoFi", amount_cents: -60_127, source: "rule", cadence: "monthly", day_of_month: 25, day_of_week: null, start_date: "2026-01-25" },
  ];
  const allEvents = expandOccurrences(rules, today, new Date(2026, 10, 21));

  it("covers today through the last day of the month for the month window", () => {
    const w = resolveForecastWindow(allEvents, today, "month");
    expect(w.days).toBe(14); // 18th-31st inclusive
    expect(w.endDate).toBe("2026-08-31");
    expect(w.usedFallback).toBe(false);
  });

  it("ends on the day the next paycheck lands", () => {
    const w = resolveForecastWindow(allEvents, today, "paycheck");
    expect(w.endDate).toBe("2026-08-21");
    expect(w.days).toBe(4); // 18th, 19th, 20th, 21st
  });

  it("covers exactly 30 days, crossing the month boundary", () => {
    const w = resolveForecastWindow(allEvents, today, "days30");
    expect(w.days).toBe(30);
    expect(w.endDate).toBe("2026-09-16");
  });

  it("falls back to the rest of the month when no income is scheduled", () => {
    const noIncome = expandOccurrences(rules.filter((r) => r.amount_cents < 0), today, new Date(2026, 10, 21));
    const w = resolveForecastWindow(noIncome, today, "paycheck");
    expect(w.usedFallback).toBe(true);
    expect(w.endDate).toBe("2026-08-31");
  });

  it("ignores a paycheck that already landed earlier today or before", () => {
    const past = expandOccurrences(rules, new Date(2026, 7, 1), new Date(2026, 10, 21));
    const w = resolveForecastWindow(past, today, "paycheck");
    expect(w.endDate).toBe("2026-08-21");
  });

  it("handles the last day of the month without producing a zero-length window", () => {
    const w = resolveForecastWindow(allEvents, new Date(2026, 7, 31), "month");
    expect(w.days).toBe(1);
    expect(w.endDate).toBe("2026-08-31");
  });
});

describe("window projections include the right scheduled items", () => {
  const today = new Date(2026, 7, 18);
  const rules: ForecastRule[] = [
    { id: 1, description: "Paycheck", amount_cents: 233_100, source: "rule", cadence: "biweekly", day_of_month: null, day_of_week: 4, start_date: "2026-08-21" },
    { id: 2, description: "Rent", amount_cents: -102_400, source: "rule", cadence: "monthly", day_of_month: 24, day_of_week: null, start_date: "2026-01-24" },
    { id: 3, description: "SoFi", amount_cents: -60_127, source: "rule", cadence: "monthly", day_of_month: 25, day_of_week: null, start_date: "2026-01-25" },
  ];
  const allEvents = expandOccurrences(rules, today, new Date(2026, 10, 21));

  function projectFor(mode: "month" | "paycheck" | "days30") {
    const w = resolveForecastWindow(allEvents, today, mode);
    return projectCashFlow({
      startingBalanceCents: 500_000,
      startDate: "2026-08-18",
      days: w.days,
      events: allEvents.filter((e) => e.date <= w.endDate),
      dailyBaselineCents: 0,
    });
  }

  it("counts one paycheck, rent and the loan payment for the rest of the month", () => {
    const r = projectFor("month");
    expect(r.totalIncomeCents).toBe(233_100);
    expect(r.totalBillsCents).toBe(102_400 + 60_127);
  });

  it("counts only the paycheck itself in the to-next-paycheck window", () => {
    // Rent (24th) and SoFi (25th) both fall AFTER the 21st, so this window genuinely has no
    // bills in it - that's the honest answer, not a missing calculation.
    const r = projectFor("paycheck");
    expect(r.totalIncomeCents).toBe(233_100);
    expect(r.totalBillsCents).toBe(0);
  });

  it("counts two paychecks but only one rent over 30 days, because of where the window lands", () => {
    const r = projectFor("days30");
    expect(r.totalIncomeCents).toBe(233_100 * 2); // Aug 21 + Sep 4
    expect(r.totalBillsCents).toBe(102_400 + 60_127); // Sep rent/SoFi fall past Sep 16
  });
});

describe("discretionary and committed money", () => {
  const base = {
    startingBalanceCents: 100_000,
    startDate: "2026-08-01",
    days: 10,
    dailyBaselineCents: 1_000,
  };

  it("totals everyday spending across the window", () => {
    const r = projectCashFlow({ ...base, events: [] });
    expect(r.baselineTotalCents).toBe(10_000);
  });

  it("leaves income minus scheduled bills as what's free after bills", () => {
    const r = projectCashFlow({
      ...base,
      events: [event("2026-08-02", 200_000, "pay"), event("2026-08-04", -50_000, "rent")],
    });
    expect(r.afterBillsCents).toBe(150_000);
  });

  it("does not net off the everyday baseline, which already contains discretionary spending", () => {
    const r = projectCashFlow({
      ...base,
      events: [event("2026-08-02", 200_000, "pay")],
      dailyBaselineCents: 5_000,
    });
    expect(r.afterBillsCents).toBe(200_000);
  });

  it("goes negative when scheduled bills outrun the income in the window", () => {
    const r = projectCashFlow({
      ...base,
      events: [event("2026-08-02", 100_000, "pay"), event("2026-08-04", -150_000, "rent")],
    });
    expect(r.afterBillsCents).toBe(-50_000);
  });

  it("reports the balance projected for the final day", () => {
    const r = projectCashFlow({ ...base, events: [event("2026-08-02", 50_000)] });
    // $1000 start + $500 in - 10 days of $10 everyday spending
    expect(r.endingBalanceCents).toBe(100_000 + 50_000 - 10_000);
  });

  it("falls back to the opening balance when the window is empty", () => {
    const r = projectCashFlow({ ...base, days: 0, events: [] });
    expect(r.endingBalanceCents).toBe(100_000);
  });

  it("commits nothing on the final day of the window", () => {
    const r = projectCashFlow({ ...base, events: [] });
    expect(r.days[r.days.length - 1].committedCents).toBe(0);
  });

  it("counts only bills still to come, not the everyday spending estimate", () => {
    const r = projectCashFlow({ ...base, events: [event("2026-08-05", -30_000)] });
    expect(r.days[0].committedCents).toBe(30_000);
  });

  it("stays flat on days with no bill, so the band only steps at real obligations", () => {
    const r = projectCashFlow({ ...base, events: [event("2026-08-05", -30_000)] });
    expect(r.days[0].committedCents).toBe(r.days[1].committedCents);
    expect(r.days[1].committedCents).toBe(r.days[2].committedCents);
  });

  it("drops by exactly the bill amount once it's paid", () => {
    const r = projectCashFlow({ ...base, events: [event("2026-08-05", -30_000)] });
    expect(r.days[3].committedCents - r.days[4].committedCents).toBe(30_000);
  });

  it("ignores incoming money when working out what is committed", () => {
    const r = projectCashFlow({ ...base, events: [event("2026-08-05", 500_000)] });
    expect(r.days[0].committedCents).toBe(0);
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
