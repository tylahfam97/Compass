import { describe, it, expect } from "vitest";
import { buildPortfolioHistory, summarizeHoldings, holdingIdentity, assetClassAllocation, pairedReinvestIds } from "./InvestmentsPage";
import type { HoldingClass, InvestmentActivity } from "@/lib/types";

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

describe("asset-class labels and allocation", () => {
  const h = (account_id: number, symbol: string | null, description: string, market_value_cents: number | null) => ({ account_id, symbol, description, market_value_cents });
  const cls = (identity: string, asset_class: HoldingClass["asset_class"], equity_region: string | null = null, equity_size: string | null = null): [string, HoldingClass] =>
    [identity, { identity, asset_class, equity_region, equity_size, bond_detail: null }];

  it("keys labels by symbol across accounts, and by account + description without one", () => {
    expect(holdingIdentity(h(1, " zztmx ", "Synthetic fund", 0))).toBe("symbol:ZZTMX");
    expect(holdingIdentity(h(2, "ZZTMX", "Other name", 0))).toBe("symbol:ZZTMX");
    expect(holdingIdentity(h(1, null, "Synthetic Stable Value", 0))).not.toBe(holdingIdentity(h(2, null, "Synthetic Stable Value", 0)));
  });

  it("counts unlabeled value as unclassified and splits equity by independent region and size", () => {
    const classes = new Map([cls("symbol:ZZTMX", "equity", "us", "large"), cls("symbol:ZZINT", "equity", "developed"), cls("symbol:ZZBDX", "bond")]);
    const a = assetClassAllocation([
      h(1, "ZZTMX", "a", 60000), h(2, "ZZTMX", "a", 40000), h(1, "ZZINT", "b", 50000),
      h(1, "ZZBDX", "c", 30000), h(1, "ZZTDF", "target-date (mixed)", 20000), h(1, null, "no value", null),
    ], classes);
    expect(a.byClass).toEqual({ cash: 0, equity: 150000, bond: 30000, unclassified: 20000 });
    expect(a.total).toBe(200000);
    expect(a.incomplete).toBe(true);
    expect(Object.fromEntries(a.region)).toEqual({ us: 100000, developed: 50000 });
    expect(Object.fromEntries(a.size)).toEqual({ large: 100000, unset: 50000 });
  });

  it("returns zero totals for an empty scope rather than fake shares", () => {
    expect(assetClassAllocation([], new Map()).total).toBe(0);
    expect(assetClassAllocation([h(1, "ZZTMX", "Short", -100)], new Map()).incomplete).toBe(true);
    expect(holdingIdentity(h(1, "N/A", "No symbol", 0))).toBe("account:1:no symbol");
  });
});

describe("pairedReinvestIds", () => {
  const a = (id: number, activity_type: InvestmentActivity["activity_type"], amount_cents: number, source_json: string | null, account_id = 1) =>
    ({ id, account_id, activity_type, amount_cents, source_json, symbol: "ZZTMX", trade_date: "2026-01-15" }) as InvestmentActivity;

  it("drops only a Vanguard reinvestment that repeats a dividend in the same account", () => {
    expect([...pairedReinvestIds([a(1, "dividend", 1234, "{}"), a(2, "reinvest", -1234, "{}")])]).toEqual([2]);
    expect([...pairedReinvestIds([a(1, "dividend", 1234, "{}"), a(2, "reinvest", -1234, "{}"), a(3, "reinvest", -1234, "{}")])]).toEqual([2]);
    // Reinvestment-only income, another account's dividend and other formats keep counting.
    expect(pairedReinvestIds([a(2, "reinvest", -1234, "{}")]).size).toBe(0);
    expect(pairedReinvestIds([a(1, "dividend", 1234, "{}", 9), a(2, "reinvest", -1234, "{}")]).size).toBe(0);
    expect(pairedReinvestIds([a(1, "dividend", 1234, null), a(2, "reinvest", -1234, null)]).size).toBe(0);
  });
});
