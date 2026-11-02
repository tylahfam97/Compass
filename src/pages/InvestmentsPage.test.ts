import { describe, it, expect } from "vitest";
import { buildPortfolioHistory, summarizeHoldings } from "./InvestmentsPage";

describe("summarizeHoldings", () => {
  const lot = (mv: number, cost: number | null, income: number | null = null) =>
    ({ market_value_cents: mv, cost_basis_cents: cost, est_annual_income_cents: income });

  it("compares cost basis only with the value of the same lots", () => {
    // A $1,000 stock bought for $800, plus $5,000 of crypto with unknown cost basis. The crypto
    // has no knowable gain; counting its whole value would report a $5,200 "gain".
    const s = summarizeHoldings([lot(100_000, 80_000, 1_200), lot(500_000, null)]);
    expect(s).toEqual({ marketValue: 600_000, costBasis: 80_000, unrealized: 20_000, costBasisCoverage: 100_000 / 600_000, estIncome: 1_200 });
  });

  it("reports unknown, not zero, gain when no lot has a cost basis, and handles an empty scope", () => {
    expect(summarizeHoldings([lot(500_000, null)]).unrealized).toBeNull();
    // A zero cost basis is unknown too, as in holdingRoiPct, not a $5,000 gain.
    expect(summarizeHoldings([lot(500_000, 0)]).unrealized).toBeNull();
    expect(summarizeHoldings([])).toEqual({ marketValue: 0, costBasis: null, unrealized: null, costBasisCoverage: null, estIncome: null });
  });
});

describe("buildPortfolioHistory", () => {
  // Accounts report on different schedules - a 401(k) quarterly, a brokerage monthly. Summing
  // by as_of_date alone makes the portfolio look like it crashes on every date where only one
  // account filed a statement.
  const rows = [
    { account_id: 1, as_of_date: "2026-03-31", total: 1_260_053 }, // 401(k), quarterly
    { account_id: 1, as_of_date: "2026-06-30", total: 1_465_620 },
    { account_id: 2, as_of_date: "2026-06-30", total: 166_714 },   // brokerage, monthly
    { account_id: 2, as_of_date: "2026-07-31", total: 119_267 },
  ];

  it("carries each account's latest value forward across dates it did not report", () => {
    expect(buildPortfolioHistory(rows)).toEqual([
      { as_of_date: "2026-03-31", total: 1_260_053 },
      { as_of_date: "2026-06-30", total: 1_465_620 + 166_714 },
      // The 401(k) has no July statement, so it keeps its June value instead of dropping to 0.
      { as_of_date: "2026-07-31", total: 1_465_620 + 119_267 },
    ]);
  });

  it("does not back-fill an account before its first snapshot", () => {
    // The brokerage did not exist in March - it must contribute 0, not its June value.
    expect(buildPortfolioHistory(rows)[0].total).toBe(1_260_053);
  });

  it("handles a single account and an empty portfolio", () => {
    expect(buildPortfolioHistory([{ account_id: 1, as_of_date: "2026-01-31", total: 500 }]))
      .toEqual([{ as_of_date: "2026-01-31", total: 500 }]);
    expect(buildPortfolioHistory([])).toEqual([]);
  });

  it("returns dates in ascending order regardless of input order", () => {
    const shuffled = [rows[3], rows[0], rows[2], rows[1]];
    expect(buildPortfolioHistory(shuffled).map((p) => p.as_of_date))
      .toEqual(["2026-03-31", "2026-06-30", "2026-07-31"]);
  });
});
