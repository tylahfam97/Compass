import { describe, expect, it } from "vitest";
import { projectCashFlow, type ForecastEvent } from "./forecast";
import { clampToLimit, niceStep, scenarioLimits, validateScenario, BUFFER_LIMIT, INCOME_LIMIT, SPEND_LIMIT } from "./planScenario";
import { buildPlanCalendar, buildPlanFlow } from "./planViews";

const event = (date: string, amountCents: number, description: string, categoryName: string | null = null): ForecastEvent =>
  ({ key: `${date}-${description}`, date, description, amountCents, source: "rule", categoryName, categoryColor: categoryName ? "#3b82f6" : null });

describe("slider limits follow liquid cash (#123)", () => {
  it("tops the cushion out at the liquid cash instead of a fixed $2,000", () => {
    const limits = scenarioLimits({ liquidCents: 1_234_567 });
    expect(limits.fallback).toBe(false);
    expect(limits.buffer.step).toBe(25_000);
    expect(limits.buffer.max).toBe(1_225_000); // $12,345.67 floored to the $250 step
    expect(limits.buffer.max).toBeGreaterThan(BUFFER_LIMIT.max);
    expect(scenarioLimits({ liquidCents: 100_000 }).buffer).toEqual({ min: 0, max: 100_000, step: 1_000 });
    expect(scenarioLimits({ liquidCents: 35_000 }).buffer).toEqual({ min: 0, max: 35_000, step: 500 });
  });
  it("falls back to the old ranges with no balance on file, zero or an overdraft", () => {
    for (const liquidCents of [null, 0, -50_000, 99]) {
      const limits = scenarioLimits({ liquidCents });
      expect(limits.fallback).toBe(true);
      expect(limits.buffer).toEqual({ min: 0, ...BUFFER_LIMIT });
      expect(limits.spend.month).toEqual({ min: 0, ...SPEND_LIMIT.month });
      expect(limits.spend.day).toEqual({ min: 0, ...SPEND_LIMIT.day });
      expect(limits.income).toEqual({ min: 0, ...INCOME_LIMIT });
    }
  });
  it("scales spending and income to the larger of cash and monthly income", () => {
    const lowCash = scenarioLimits({ liquidCents: 30_000, monthlyIncomeCents: 400_000 });
    expect(lowCash.buffer.max).toBe(30_000);
    expect(lowCash.flowScaleCents).toBe(400_000);
    expect(lowCash.income.max).toBe(400_000);
    expect(lowCash.spend.month.max).toBe(400_000);
    expect(lowCash.spend.day.max).toBe(13_200); // $4,000 / 30 = $133.33 a day, floored to the $2 step
    // Income alone keeps the flow sliders usable even with nothing in checking.
    const noCash = scenarioLimits({ liquidCents: null, monthlyIncomeCents: 250_000 });
    expect(noCash.fallback).toBe(true);
    expect(noCash.income.max).toBe(250_000);
  });
  it("lets a cut reach all of typical spending and no further", () => {
    const limits = scenarioLimits({ liquidCents: 500_000, typicalDailyCents: 4_321 });
    expect(limits.spend.day.min).toBeLessThanOrEqual(-4_321);
    expect(limits.spend.day.min).toBeGreaterThan(-4_321 - limits.spend.day.step);
    expect(limits.spend.month.min).toBeLessThanOrEqual(-4_321 * 31);
    expect(scenarioLimits({ liquidCents: 500_000 }).spend.month.min).toBe(0);
  });
  it("picks round steps and clamps saved values without rewriting them", () => {
    expect([niceStep(4_000), niceStep(200_000), niceStep(50_000_000), niceStep(500_000_000)]).toEqual([100, 2_500, 500_000, 1_000_000]);
    const saved = validateScenario({ buffer: 300_000 });
    const limits = scenarioLimits({ liquidCents: 100_000 });
    expect(clampToLimit(saved.buffer, limits.buffer)).toBe(100_000);
    expect(saved.buffer).toBe(300_000);
    expect(clampToLimit(-90_000, scenarioLimits({ liquidCents: 100_000, typicalDailyCents: 1_000 }).spend.month)).toBe(-31_000);
  });
  it("keeps layout preferences and drops unknown ones", () => {
    expect(validateScenario({})).toMatchObject({ view: "line", hidden: [], markers: true });
    expect(validateScenario({ view: "map", hidden: ["payoff", "bogus", "actions"] as never, markers: false }))
      .toMatchObject({ view: "map", hidden: ["actions", "payoff"], markers: false });
    expect(validateScenario({ view: "radar" as never }).view).toBe("line");
  });
});

describe("money map and calendar (#123)", () => {
  const events = [
    event("2026-06-16", -150_000, "Rent", "Housing"),
    event("2026-06-19", 300_000, "Paycheck"),
    event("2026-06-20", -4_500, "Streaming", "Subscriptions"),
    event("2026-06-22", -2_000, "Gym", null),
  ];
  const base = { startingBalanceCents: 100_000, startDate: "2026-06-15", days: 10, events, dailySpendCents: 1_000 };

  const balanced = (flow: ReturnType<typeof buildPlanFlow>) => {
    const sources = flow.nodes.filter((n) => n.column === 0).reduce((s, n) => s + n.cents, 0);
    const uses = flow.nodes.filter((n) => n.column === 2).reduce((s, n) => s + n.cents, 0);
    return { sources, uses };
  };

  it("balances what came in against where it went and what is left", () => {
    const result = projectCashFlow({ ...base, bufferCents: 50_000 });
    const flow = buildPlanFlow({ result, startingBalanceCents: 100_000, bufferCents: 50_000, typicalDailyCents: 1_000 });
    const { sources, uses } = balanced(flow);
    expect(sources).toBe(uses);
    const byId = new Map(flow.nodes.map((n) => [n.id, n]));
    expect(byId.get("now")?.cents).toBe(100_000);
    expect(byId.get("in:paycheck")?.cents).toBe(300_000);
    expect(byId.get("bill:housing")?.cents).toBe(150_000);
    expect(byId.get("bill:other bills")?.kind).toBe("bills");
    expect(byId.get("everyday")?.cents).toBe(10_000);
    expect(byId.get("reserve")?.cents).toBe(50_000);
    expect(byId.get("left")?.cents).toBe(result.endingBalanceCents - 50_000);
    // Every edge fills to its total by the last day, and only once its money has moved.
    for (const e of flow.edges) expect(e.daily[e.daily.length - 1]).toBe(e.cents);
    const rent = flow.edges.find((e) => e.target === "bill:housing")!;
    expect(rent.daily[0]).toBe(0);
    expect(rent.daily[1]).toBe(150_000);
  });

  it("shows what-ifs separately and draws a shortfall when the money runs out", () => {
    const result = projectCashFlow({ ...base, skipNextIncome: true, spendChange: { cents: 2_000, per: "day" }, extraIncomeMonthlyCents: 30_000, purchase: { date: "2026-06-17", amountCents: 20_000 } });
    const flow = buildPlanFlow({ result, startingBalanceCents: 100_000, bufferCents: 0, typicalDailyCents: 1_000 });
    const byId = new Map(flow.nodes.map((n) => [n.id, n]));
    expect(byId.has("in:paycheck")).toBe(false);
    expect(byId.get("whatif:spend")?.cents).toBe(20_000);
    expect(byId.get("whatif:purchase")?.cents).toBe(20_000);
    expect(byId.get("whatif:income")?.cents).toBe(result.scenarioIncomeCents);
    expect(result.endingBalanceCents).toBeLessThan(0);
    expect(byId.get("shortfall")?.cents).toBe(-result.endingBalanceCents);
    expect(byId.has("left")).toBe(false);
    const { sources, uses } = balanced(flow);
    expect(sources).toBe(uses);
  });

  it("covers an overdraft first and splits a spending cut out of everyday spending", () => {
    const result = projectCashFlow({ ...base, startingBalanceCents: -20_000, spendChange: { cents: -400, per: "day" } });
    const flow = buildPlanFlow({ result, startingBalanceCents: -20_000, bufferCents: 0, typicalDailyCents: 1_000 });
    const byId = new Map(flow.nodes.map((n) => [n.id, n]));
    expect(byId.get("overdraft")?.cents).toBe(20_000);
    expect(byId.get("everyday")?.cents).toBe(6_000);
    expect(byId.has("whatif:spend")).toBe(false);
    const { sources, uses } = balanced(flow);
    expect(sources).toBe(uses);
  });

  it("lays the window out as Sunday-first weeks with tones against the cushion", () => {
    const result = projectCashFlow({ ...base, bufferCents: 200_000 });
    const calendar = buildPlanCalendar(result, 200_000);
    // 2026-06-15 is a Monday: one pad before it, and whole weeks throughout.
    expect(calendar.weeks[0][0]).toBeNull();
    expect(calendar.weeks[0][1]?.date).toBe("2026-06-15");
    expect(calendar.weeks.every((week) => week.length === 7)).toBe(true);
    const days = calendar.weeks.flat().filter((d) => d !== null);
    expect(days).toHaveLength(10);
    const rentDay = days.find((d) => d.date === "2026-06-16")!;
    expect(rentDay.outCents).toBe(150_000);
    expect(rentDay.tone).toBe("short");
    expect(days.find((d) => d.date === "2026-06-19")?.tone).toBe("ok");
    expect(Math.min(...days.map((d) => d.level))).toBe(0);
    expect(Math.max(...days.map((d) => d.level))).toBe(1);
  });
});
