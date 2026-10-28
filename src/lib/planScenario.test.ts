import { describe, expect, it, vi } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { monthlyShareCents, projectCashFlow, type ForecastEvent } from "./forecast";
import { getMonthToDate } from "./forecastData";
import { validateScenario, loadScenario, saveScenario } from "./planScenario";
import { clearProfileLocalState } from "./profileReset";

const pay = (date: string, amountCents: number, key = date): ForecastEvent =>
  ({ key, date, description: "Paycheck", amountCents, source: "rule", categoryName: null, categoryColor: null });

describe("cash-flow scenario", () => {
  it("migrates legacy controls once, isolates profiles and clears only the target", () => {
    const entries = new Map<string, string>([["compass_plan_extra", "12000"]]);
    const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value), removeItem: (key: string) => entries.delete(key) };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);
    try {
      expect(loadScenario(1).spend).toEqual({ cents: 12000, per: "month" });
      expect(loadScenario(2).spend.cents).toBe(0);
      saveScenario(2, { ...loadScenario(2), spend: { cents: 4000, per: "day" } });
      expect(loadScenario(1).spend.cents).toBe(12000);
      clearProfileLocalState(1);
      expect(loadScenario(1).spend.cents).toBe(0);
      expect(loadScenario(2).spend).toEqual({ cents: 4000, per: "day" });
    } finally { vi.unstubAllGlobals(); }
  });
  it("keeps controls usable when storage is unavailable", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    try { expect(() => saveScenario(1, loadScenario(1))).not.toThrow(); } finally { vi.unstubAllGlobals(); }
  });
  it("upgrades a v1 scenario and rejects malformed persisted values", () => {
    expect(validateScenario({ version: 1, extra: 12000, buffer: 5000, purchase: { date: "2026-09-02", amountCents: 100 } })).toMatchObject({
      version: 2, spend: { cents: 12000, per: "month" }, buffer: 5000, purchase: { date: "2026-09-02", amountCents: 100, kind: "out" },
    });
    const result = validateScenario({ extra: -1, buffer: NaN, income: -5, purchase: { date: "2026-02-31", amountCents: 2.5, kind: "x" as never } });
    expect(result.spend.cents).toBe(0);
    expect(result.buffer).toBe(0);
    expect(result.income).toBe(0);
    expect(result.purchase).toEqual({ date: "", amountCents: 0, kind: "out" });
    expect(validateScenario({ spend: { cents: 25_000, per: "day" } }).spend).toEqual({ cents: 0, per: "day" });
    expect(validateScenario({ spend: { cents: -4_000, per: "week" as never } }).spend).toEqual({ cents: -4_000, per: "month" });
    // A skipped paycheck is bound to its date; an old boolean or an impossible date is dropped.
    expect(validateScenario({ skipPay: "2026-10-07" }).skipPay).toBe("2026-10-07");
    expect(validateScenario({ skipPay: true as never }).skipPay).toBe("");
    expect(validateScenario({ skipPay: "2026-02-31" }).skipPay).toBe("");
  });
  it("reset defaults project exactly the expected line", () => {
    const input = { startingBalanceCents: 50_000, startDate: "2026-09-25", days: 10, events: [pay("2026-09-30", 200_000), pay("2026-10-01", -150_000, "rent")], dailySpendCents: 1_200 };
    const reset = validateScenario({});
    const expected = projectCashFlow(input);
    const scenario = projectCashFlow({ ...input, spendChange: reset.spend, extraIncomeMonthlyCents: reset.income, skipNextIncome: reset.skipPay !== "", purchase: reset.purchase });
    expect(scenario.days).toEqual(expected.days);
    expect(scenario.endingBalanceCents).toBe(expected.endingBalanceCents);
  });
});

describe("what-if spending and income", () => {
  it.each([["2026-09-01", 30], ["2028-02-01", 29], ["2026-10-01", 31]])("spreads a monthly amount to the exact cent over %s", (first, days) => {
    for (const monthly of [10_001, -10_001, 29]) {
      let total = 0;
      for (let d = 1; d <= days; d++) total += monthlyShareCents(monthly, `${first.slice(0, 8)}${String(d).padStart(2, "0")}`);
      expect(total).toBe(monthly);
    }
  });
  it("uses each calendar month's own length across a month rollover", () => {
    const result = projectCashFlow({ startingBalanceCents: 100_000, startDate: "2026-09-29", days: 4, events: [], spendChange: { cents: 3_000, per: "month" } });
    // September: 3000/30 = 100 a day. October: 3000/31 = 96 r24, so the 1st and 2nd carry 97.
    expect(result.days.map((day) => day.scenarioSpendCents)).toEqual([100, 100, 97, 97]);
    expect(result.days.map((day) => day.date)).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(result.endingBalanceCents).toBe(100_000 - 394);
  });
  it("applies a per-day change every day", () => {
    const result = projectCashFlow({ startingBalanceCents: 0, startDate: "2026-09-01", days: 3, events: [], spendChange: { cents: 500, per: "day" } });
    expect(result.days.map((day) => day.balanceCents)).toEqual([-500, -1_000, -1_500]);
    expect(result.firstShortfall?.date).toBe("2026-09-01");
  });
  it("never lets a spending cut invent money", () => {
    const cut = { startingBalanceCents: 10_000, startDate: "2026-09-01", days: 5, events: [], spendChange: { cents: -5_000, per: "day" as const } };
    expect(projectCashFlow(cut).endingBalanceCents).toBe(10_000);
    const withTypical = projectCashFlow({ ...cut, dailySpendCents: 1_000 });
    expect(withTypical.endingBalanceCents).toBe(10_000);
    expect(withTypical.days[0].scenarioSpendCents).toBe(-1_000);
    expect(projectCashFlow({ ...cut, dailySpendCents: 1_000, spendChange: { cents: -400, per: "day" } }).endingBalanceCents).toBe(10_000 - 5 * 600);
  });
  it("adds hypothetical income without touching scheduled totals", () => {
    const result = projectCashFlow({ startingBalanceCents: 0, startDate: "2026-09-01", days: 30, events: [pay("2026-09-15", 100_000)], extraIncomeMonthlyCents: 30_000 });
    expect(result.endingBalanceCents).toBe(130_000);
    expect(result.scenarioIncomeCents).toBe(30_000);
    expect(result.totalIncomeCents).toBe(100_000);
  });
  it("skips only the next paycheck, and nothing when none is scheduled", () => {
    const events = [pay("2026-09-03", 200_000, "a"), pay("2026-09-17", 200_000, "b"), pay("2026-09-05", -50_000, "rent")].sort((x, y) => x.date.localeCompare(y.date));
    const input = { startingBalanceCents: 10_000, startDate: "2026-09-01", days: 30, events };
    const expected = projectCashFlow(input);
    const skipped = projectCashFlow({ ...input, skipNextIncome: true });
    expect(skipped.skippedIncome?.key).toBe("a");
    expect(skipped.nextIncome?.key).toBe("b");
    expect(skipped.totalIncomeCents).toBe(200_000);
    expect(expected.totalIncomeCents).toBe(400_000);
    expect(skipped.endingBalanceCents).toBe(expected.endingBalanceCents - 200_000);
    expect(skipped.firstShortfall?.date).toBe("2026-09-05");
    expect(skipped.days.find((day) => day.date === "2026-09-03")?.events).toEqual([]);
    const noIncome = { ...input, events: [pay("2026-09-05", -50_000, "rent")] };
    expect(projectCashFlow({ ...noIncome, skipNextIncome: true }).days).toEqual(projectCashFlow(noIncome).days);
  });
  it("applies a one-off purchase or deposit only on and after its date", () => {
    const input = { startingBalanceCents: 100000, startDate: "2026-09-01", days: 3, events: [] };
    const current = projectCashFlow(input);
    const changed = projectCashFlow({ ...input, purchase: { date: "2026-09-02", amountCents: 25000 } });
    expect(changed.days.map((day) => day.balanceCents)).toEqual([100000, 75000, 75000]);
    expect(current.days.map((day) => day.balanceCents)).toEqual([100000, 100000, 100000]);
    expect(changed.totalBillsCents).toBe(0);
    expect(changed.days[1].events).toEqual([]);
    expect(changed.days[1].oneOffCents).toBe(-25000);
    expect(changed.assumedSpendCents).toBe(25000);
    const deposit = projectCashFlow({ ...input, purchase: { date: "2026-09-02", amountCents: 25000, kind: "in" } });
    expect(deposit.days.map((day) => day.balanceCents)).toEqual([100000, 125000, 125000]);
    expect(deposit.assumedSpendCents).toBe(0);
    expect(deposit.scenarioIncomeCents).toBe(25000);
    expect(deposit.totalIncomeCents).toBe(0);
    expect(projectCashFlow({ ...input, purchase: { date: "2026-10-01", amountCents: 25000 } }).endingBalanceCents).toBe(100000);
    expect(projectCashFlow({ ...input, bufferCents: 20000 }).days).toEqual(current.days);
  });
});

describe("month-to-date actuals", () => {
  const withDb = async (rows: string, today: Date) => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`CREATE TABLE accounts(id INTEGER,profile_id INTEGER,account_type TEXT,excluded_from_insights INTEGER);
        CREATE TABLE transactions(id INTEGER PRIMARY KEY,account_id INTEGER,profile_id INTEGER,date TEXT,category_id INTEGER,amount_cents INTEGER);
        INSERT INTO accounts VALUES(1,1,'checking',0),(2,1,'credit',0),(3,1,'checking',1),(4,2,'checking',0);
        ${rows}`);
      const db = { select: async (sql: string, params: SQLInputValue[]) => database.prepare(sql).all(...params) } as unknown as Parameters<typeof getMonthToDate>[0];
      return await getMonthToDate(db, 1, today);
    } finally { database.close(); }
  };
  it("counts checking income and spending from the local 1st through today only", async () => {
    const result = await withDb(`INSERT INTO transactions(account_id,profile_id,date,category_id,amount_cents) VALUES
      (1,1,'2026-09-30',NULL,-99999),
      (1,1,'2026-10-01',NULL,-2500),(1,1,'2026-10-02',1,300000),(1,1,'2026-10-03',20,-80000),(1,1,'2026-10-03',29,-700),
      (2,1,'2026-10-02',NULL,-4000),(3,1,'2026-10-02',NULL,-6000),(4,2,'2026-10-02',NULL,-8000),
      (1,1,'2026-10-04',NULL,-1234);`, new Date(2026, 9, 3, 23, 30));
    expect(result).toEqual({ monthStart: "2026-10-01", incomeCents: 300000, spentCents: 2500, txCount: 4, lastImportedDate: "2026-10-04" });
  });
  it("reports an empty month and the last import date", async () => {
    expect(await withDb(`INSERT INTO transactions(account_id,profile_id,date,category_id,amount_cents) VALUES (1,1,'2026-08-20',NULL,-500);`, new Date(2026, 9, 1, 0, 5)))
      .toEqual({ monthStart: "2026-10-01", incomeCents: 0, spentCents: 0, txCount: 0, lastImportedDate: "2026-08-20" });
    expect(await withDb("", new Date(2026, 9, 1))).toEqual({ monthStart: "2026-10-01", incomeCents: 0, spentCents: 0, txCount: 0, lastImportedDate: null });
  });
});
