import { describe, it, expect, vi } from "vitest";

const db = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock("./db", () => ({ getDb: async () => ({ select: async () => db.rows }) }));

import { computeInvestmentReturn } from "./netWorth";

const row = (account_id: number, as_of_date: string, symbol: string, cost: number | null, mv: number, shares: number | null = null) => ({
  account_id, as_of_date, symbol, security_type: "stock", description: symbol,
  cost_basis_cents: cost, market_value_cents: mv, trade_date: null, shares,
});

describe("computeInvestmentReturn", () => {
  it("uses each account's latest snapshot: skips sold holdings, keeps other accounts' holdings and no-cost baselines", async () => {
    // Sold XYZ (absent from account 1's latest snapshot) must not drag the return to -20%.
    db.rows = [row(1, "2026-06-30", "XYZ", 1_000_000, 500_000), row(1, "2026-09-30", "ABC", 1_000_000, 1_100_000)];
    expect((await computeInvestmentReturn([1])).absoluteReturnPct).toBeCloseTo(10);

    // Same VOO in two accounts on different schedules: both count -> (42k - 30k) / 30k.
    db.rows = [row(1, "2026-09-30", "VOO", 1_000_000, 1_200_000), row(2, "2026-06-30", "VOO", 2_000_000, 3_000_000)];
    expect((await computeInvestmentReturn([1])).absoluteReturnPct).toBeCloseTo(40);

    // No-cost-basis fund still uses its own earlier snapshot as the baseline.
    db.rows = [row(3, "2026-06-30", "FUND", null, 100_000, 100), row(3, "2026-09-30", "FUND", null, 110_000, 100)];
    expect((await computeInvestmentReturn([1])).absoluteReturnPct).toBeCloseTo(10);
  });

  it("does not count new contributions to a no-cost-basis holding as investment return", async () => {
    // 100 units worth $1,000, then 200 units worth $2,200: the price rose 10%; the other $1,000 of
    // growth is money added. The snapshot-to-snapshot change alone would report +120%.
    db.rows = [row(3, "2026-06-30", "FUND", null, 100_000, 100), row(3, "2026-09-30", "FUND", null, 220_000, 200)];
    expect((await computeInvestmentReturn([1])).absoluteReturnPct).toBeCloseTo(10);
  });

  it("leaves a no-cost-basis holding without unit counts out rather than guessing", async () => {
    // A balance-only 401(k) line: growth can't be split into price vs. deposits.
    db.rows = [row(3, "2026-06-30", "FUND", null, 100_000), row(3, "2026-09-30", "FUND", null, 220_000)];
    expect(await computeInvestmentReturn([1])).toEqual({ absoluteReturnPct: null, annualizedReturnPct: null, hasCostBasis: false });

    // ...while a priced holding with a real cost basis alongside it still reports.
    db.rows = [...db.rows, row(1, "2026-09-30", "ABC", 1_000_000, 1_100_000)];
    expect((await computeInvestmentReturn([1])).absoluteReturnPct).toBeCloseTo(10);
  });

  it("starts the price baseline at the first snapshot that reports units", async () => {
    // An older import without units, then 100 units at $10, then 100 units at $12: +20%.
    db.rows = [row(3, "2026-03-31", "FUND", null, 90_000), row(3, "2026-06-30", "FUND", null, 100_000, 100), row(3, "2026-09-30", "FUND", null, 120_000, 100)];
    expect((await computeInvestmentReturn([1])).absoluteReturnPct).toBeCloseTo(20);
  });

  it("compares cost basis only with the value of lots that have one", async () => {
    // ABC lot 1 cost $800, now $1,000; lot 2 has no cost basis and is worth $5,000. The only
    // knowable return is +25%; adding lot 2's value against lot 1's cost reported +650%.
    db.rows = [row(1, "2026-09-30", "ABC", 80_000, 100_000), row(1, "2026-09-30", "ABC", null, 500_000)];
    expect((await computeInvestmentReturn([1])).absoluteReturnPct).toBeCloseTo(25);
  });
});
