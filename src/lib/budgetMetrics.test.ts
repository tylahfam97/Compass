import { describe, expect, it } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { categoryNetSql, categorySpendSql } from "./reportingSql";
import { budgetCarryCents, evaluateBudgetPeriod, completedBudgetMonths, type BudgetDefinition } from "./budgetMetrics";

describe("signed category budgets", () => {
  it("never counts a partial current month or skips February at month-end", () => {
    expect(completedBudgetMonths(3, new Date(2026, 2, 31))).toEqual(["2026-02", "2026-01", "2025-12"]);
  });
  it.each([
    ["checking", 24, -5000],
    ["credit", 24, 10000],
    ["loan", 24, 10000],
    ["checking", 20, 0],
    ["checking", 29, 0],
  ])("nets %s category %s correctly", (accountType, categoryId, expected) => {
    const database = new DatabaseSync(":memory:");
    try {
      const result = database.prepare(`WITH t(amount_cents,category_id) AS (VALUES(-10000,?),(15000,?)),
        a(account_type) AS (VALUES(?)) SELECT ${categoryNetSql()} AS net FROM t CROSS JOIN a`).get(categoryId, categoryId, accountType);
      expect(result?.net).toBe(expected);
    } finally { database.close(); }
  });
  it("preserves capped chart semantics", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const result = database.prepare(`WITH t(amount_cents) AS (VALUES(-10000),(15000)),
        a(account_type) AS (VALUES('checking')) SELECT ${categorySpendSql()} AS spent FROM t CROSS JOIN a`).get();
      expect(result?.spent).toBe(0);
    } finally { database.close(); }
  });
  it("caps rollover without losing prior carry", () => {
    expect(budgetCarryCents(20000, -5000)).toBe(20000);
    expect(budgetCarryCents(30000, -5000)).toBe(30000);
    expect(budgetCarryCents(20000, 25000)).toBe(0);
    expect(budgetCarryCents(20000, 5000)).toBe(15000);
  });
  it("evaluates exact weeks, rollover, income targets and unknown coverage", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`CREATE TABLE accounts(id INTEGER,account_type TEXT,excluded_from_insights INTEGER);
        CREATE TABLE transactions(id INTEGER,account_id INTEGER,profile_id INTEGER,date TEXT,category_id INTEGER,amount_cents INTEGER);
        INSERT INTO accounts VALUES(1,'checking',0);
        INSERT INTO transactions VALUES(1,1,1,'2026-07-01',24,-10000),(2,1,1,'2026-07-02',24,15000),
        (3,1,1,'2026-08-01',24,-25000),(4,1,1,'2026-08-10',1,60000);`);
      const db = { select: async (sql: string, params: SQLInputValue[]) => database.prepare(sql).all(...params) } as unknown as Parameters<typeof evaluateBudgetPeriod>[0];
      const budget: BudgetDefinition = { id: 1, profile_id: 1, category_id: 24, category_name: "Gambling", category_parent_id: null, amount_cents: 20000, period: "monthly", start_date: "2026-07-01", rollover: 1, is_global: 0 };
      expect(await evaluateBudgetPeriod(db, budget, [1], "2026-08-01", "2026-09-01")).toMatchObject({ net: 25000, available: 40000, covered: true, onTrack: true });
      expect(await evaluateBudgetPeriod(db, { ...budget, period: "weekly" }, [1], "2026-07-27", "2026-08-03")).toMatchObject({ net: 25000, available: 20000, onTrack: false });
      expect(await evaluateBudgetPeriod(db, { ...budget, category_id: 1 }, [1], "2026-08-01", "2026-09-01")).toMatchObject({ earned: 60000, available: 20000, onTrack: true });
      expect(await evaluateBudgetPeriod(db, budget, [1], "2026-09-01", "2026-10-01")).toMatchObject({ covered: false, onTrack: false });
      expect(await evaluateBudgetPeriod(db, budget, [2], "2026-08-01", "2026-09-01")).toMatchObject({ covered: false, net: 0 });
    } finally { database.close(); }
  });
});