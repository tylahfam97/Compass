import { describe, it, expect } from "vitest";
import { formatCurrency, formatAxisCurrency, lightenHex, formatDate, formatMonthLabel, combineAccountBalances } from "./utils";

describe("formatCurrency", () => {
  it("formats positive cents as dollars", () => {
    expect(formatCurrency(123456)).toBe("$1,234.56");
  });

  it("formats negative cents with a leading minus", () => {
    expect(formatCurrency(-1234)).toBe("-$12.34");
  });

  it("formats zero", () => {
    expect(formatCurrency(0)).toBe("$0.00");
  });
});

describe("formatAxisCurrency", () => {
  it("abbreviates four-figure dollar amounts with a k suffix", () => {
    expect(formatAxisCurrency(250_000_00)).toBe("$250k");
  });

  it("shows one decimal for sub-10k thousands", () => {
    expect(formatAxisCurrency(2_500_00)).toBe("$2.5k");
  });

  it("shows whole dollars under 1000", () => {
    expect(formatAxisCurrency(15_000)).toBe("$150");
  });
});

describe("lightenHex", () => {
  it("lightens a hex color toward white", () => {
    expect(lightenHex("#000000", 0.5)).toBe("#808080");
  });

  it("expands 3-digit hex shorthand", () => {
    expect(lightenHex("#000", 0.5)).toBe("#808080");
  });

  it("returns the input unchanged for an invalid hex", () => {
    expect(lightenHex("not-a-color")).toBe("not-a-color");
  });
});

describe("formatDate", () => {
  it("formats a YYYY-MM-DD date without rolling back a day in negative-offset timezones", () => {
    expect(formatDate("2026-07-15")).toBe("Jul 15, 2026");
  });
});

describe("formatMonthLabel", () => {
  it("formats a YYYY-MM key to an abbreviated month + 2-digit year", () => {
    expect(formatMonthLabel("2026-07")).toBe("Jul '26");
  });

  it("returns the input unchanged if it isn't a valid YYYY-MM string", () => {
    expect(formatMonthLabel("not-a-month")).toBe("not-a-month");
  });
});

describe("combineAccountBalances", () => {
  it("forward-fills each account's balance so a day with only one account's activity still reflects the other's current balance", () => {
    const rows = [
      { date: "2026-07-01", account_id: 1, balance_cents: 10000 },
      { date: "2026-07-01", account_id: 2, balance_cents: -5000 },
      { date: "2026-07-02", account_id: 1, balance_cents: 12000 },
    ];
    expect(combineAccountBalances(rows)).toEqual([
      { date: "2026-07-01", balance_cents: 5000 },
      { date: "2026-07-02", balance_cents: 7000 },
    ]);
  });
});
