import { describe, it, expect } from "vitest";
import { buildPortfolioHistory } from "./InvestmentsPage";

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
