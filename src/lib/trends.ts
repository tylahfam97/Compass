/** One category's spend in one month, as the Trends category query returns it. */
export interface CategoryMonthRow { month: string; category: string | null; color: string | null; categoryId: number | null; total: number; }
export interface RankedCategory { name: string; color: string | null; categoryId: number | null; total: number; }
export interface CategoryMonths { month: string; [category: string]: string | number; }

/**
 * Trends' category summary for the selected range: the top `topN` categories ranked by spend,
 * the rest folded into "Other" (always last), and each month's spend per ranked name for the
 * selected-category drilldown. Totals are summed from the per-month rows unchanged, so the
 * per-month refund netting and $0 floor of `categorySpendSql` still hold.
 */
export function summarizeCategories(rows: CategoryMonthRow[], topN = 6): { ranked: RankedCategory[]; months: CategoryMonths[] } {
  const byName = new Map<string, RankedCategory>();
  for (const r of rows) {
    const name = r.category ?? "Uncategorized";
    const cat = byName.get(name) ?? { name, color: r.color, categoryId: r.categoryId, total: 0 };
    cat.total += r.total;
    byName.set(name, cat);
  }
  const sorted = [...byName.values()].filter((c) => c.total > 0).sort((a, b) => b.total - a.total);
  const top = sorted.slice(0, topN);
  const otherTotal = sorted.slice(topN).reduce((sum, c) => sum + c.total, 0);
  const ranked = otherTotal > 0 ? [...top, { name: "Other", color: null, categoryId: null, total: otherTotal }] : top;

  const topNames = new Set(top.map((c) => c.name));
  const byMonth = new Map<string, CategoryMonths>();
  for (const r of rows) {
    const row = byMonth.get(r.month) ?? { month: r.month };
    const name = r.category ?? "Uncategorized";
    const key = topNames.has(name) ? name : "Other";
    row[key] = Number(row[key] ?? 0) + r.total;
    byMonth.set(r.month, row);
  }
  return { ranked, months: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)) };
}
