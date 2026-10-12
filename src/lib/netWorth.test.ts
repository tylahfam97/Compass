import { describe, it, expect, vi } from "vitest";

const db = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock("./db", () => ({ getDb: async () => ({ select: async () => db.rows }) }));

import { computeInvestmentReturn } from "./netWorth";

const row = (account_id: number, as_of_date: string, symbol: string, cost: number | null, mv: number) => ({
  account_id, as_of_date, symbol, security_type: "stock", description: symbol,
  cost_basis_cents: cost, market_value_cents: mv, trade_date: null,
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
    db.rows = [row(3, "2026-06-30", "FUND", null, 100_000), row(3, "2026-09-30", "FUND", null, 110_000)];
    expect((await computeInvestmentReturn([1])).absoluteReturnPct).toBeCloseTo(10);
  });
});
