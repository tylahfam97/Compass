import { describe, it, expect } from "vitest";
import { summarizeCategories, type CategoryMonthRow } from "./trends";

const row = (month: string, category: string | null, total: number, categoryId: number | null = 1): CategoryMonthRow =>
  ({ month, category, color: "#22c55e", categoryId, total });

describe("summarizeCategories", () => {
  it("ranks the range's categories by total and folds the rest into a trailing Other", () => {
    const rows = [
      row("2026-08", "Groceries", 40_000), row("2026-09", "Groceries", 45_000),
      row("2026-09", "Rent", 150_000), row("2026-08", "Coffee", 900),
      row("2026-09", "Books", 3_800), row("2026-09", "Refunded", 0),
    ];
    const { ranked, months } = summarizeCategories(rows, 2);
    expect(ranked.map((c) => [c.name, c.total])).toEqual([["Rent", 150_000], ["Groceries", 85_000], ["Other", 4_700]]);
    expect(ranked[2].categoryId).toBeNull();
    // Every cent of the range lands in exactly one ranked bar.
    expect(ranked.reduce((s, c) => s + c.total, 0)).toBe(rows.reduce((s, r) => s + r.total, 0));
    expect(months).toEqual([
      { month: "2026-08", Groceries: 40_000, Other: 900 },
      { month: "2026-09", Groceries: 45_000, Rent: 150_000, Other: 3_800 },
    ]);
  });

  it("handles a single month, no Other, uncategorized rows and an empty range", () => {
    const { ranked, months } = summarizeCategories([row("2026-10", "Groceries", 2_500), row("2026-10", null, 700, null)]);
    expect(ranked.map((c) => c.name)).toEqual(["Groceries", "Uncategorized"]);
    expect(months).toEqual([{ month: "2026-10", Groceries: 2_500, Uncategorized: 700 }]);
    expect(summarizeCategories([])).toEqual({ ranked: [], months: [] });
  });
});
