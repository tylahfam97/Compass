import { describe, it, expect } from "vitest";
import { groupRowsForReview, reviewedCategory, groupCategory } from "./importReview";
import type { ReviewRow } from "./importReview";

const row = (rowIndex: number, description: string, amountCents: number, suggestedCategoryId: number): ReviewRow =>
  ({ rowIndex, date: "2026-03-01", description, amountCents, suggestedCategoryId });

describe("import category review", () => {
  const rows = [
    row(0, "GREEN MARKET #12 03/01 PURCHASE", -4500, 3),
    row(1, "Coffee Corner", -500, 2),
    row(2, "GREEN MARKET #40", -1200, 3),
    row(3, "GREEN MARKET #12", -900, 3),
  ];

  it("groups repeat merchants, keeps every row and preserves amounts", () => {
    const groups = groupRowsForReview(rows);
    expect(groups.map((g) => g.rows.map((r) => r.rowIndex))).toEqual([[0, 2, 3], [1]]);
    expect(groups.flatMap((g) => g.rows).map((r) => r.amountCents).sort()).toEqual(rows.map((r) => r.amountCents).sort());
    expect(groups[0].label).toBe("GREEN MARKET #12 03/01 PURCHASE");
  });

  it("uses staged choices over rule suggestions and reports a mixed group after an exception", () => {
    const [market] = groupRowsForReview(rows);
    const staged = new Map<number, number>([[0, 7], [2, 7], [3, 7]]);
    expect(groupCategory(market, staged)).toBe(7);
    staged.set(2, 9); // pharmacy aisle at the grocer: an exception, still imported
    expect(groupCategory(market, staged)).toBeNull();
    expect(market.rows.map((r) => reviewedCategory(r, staged))).toEqual([7, 9, 7]);
    expect(reviewedCategory(rows[1], new Map())).toBe(2);
  });
});
