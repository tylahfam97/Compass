import type { Insight, InsightType } from "../types";

/**
 * Ordering for the insight list. Severity still forms the bands (a warning always sits above
 * an observation), but inside a band the money at stake decides, so a $1,500 bill sits above
 * a $6 coffee habit. Housekeeping rows (is the data current, is it categorized) are pinned to
 * the top of their band because every other figure depends on them; `budget_gap` stays at the
 * bottom of its band, as before, since it is a suggestion rather than a finding.
 */

const BAND: Record<Insight["severity"], number> = { warning: 0, info: 1, success: 2 };

const PINNED = new Set<InsightType>(["stale_data", "uncategorized_share"]);
/** Always-on descriptions of state rather than findings; they sink to the end of their band. */
const STATUS = new Set<InsightType>([
  "top_merchants", "subscription_total", "year_end_projection", "loan_payoff_projection",
  "investment_performance", "dividend_income_projected", "investment_income_received", "realized_gains_ytd",
]);
const TRAILING = new Set<InsightType>(["budget_gap"]);
/** Soft ceiling on the whole list; warnings are never dropped to meet it. */
const MAX_ROWS = 24;

/** Maximum rows per type after ranking, so one noisy family cannot flood the list. */
export const TYPE_CAPS: Partial<Record<InsightType, number>> = {
  budget_pace: 3,
  goal_off_track: 3,
  goal_projection: 2,
  duplicate_charge: 3,
  recurring_price_change: 3,
  new_recurring_charge: 3,
  frequent_merchant: 2,
  stale_data: 3,
  scheduled_missing: 4,
  annual_renewal: 3,
};

/** Tie-breaker inside a band once impact is equal (lower first). */
const TYPE_PRIORITY: Partial<Record<InsightType, number>> = {
  bills_this_week: 0,
  scheduled_missing: 1,
  duplicate_charge: 2,
  budget_pace: 3,
  goal_off_track: 4,
  emergency_fund_runway: 5,
  overdraft_alert: 6,
  credit_card_debt_growing: 7,
  loan_debt_growing: 8,
  spending_velocity: 9,
  fixed_costs_high: 10,
  interest_paid: 11,
  recurring_price_change: 12,
  income_expected: 13,
  new_recurring_charge: 14,
  subscription_total: 15,
  top_merchants: 16,
  category_creep: 17,
  unusual_spike: 18,
  frequent_merchant: 19,
  goal_projection: 20,
  year_end_projection: 21,
  annual_renewal: 22,
  investment_fees: 23,
};

function sortKey(i: Insight): number {
  const band = BAND[i.severity] * 10;
  if (PINNED.has(i.type)) return band;
  if (TRAILING.has(i.type)) return band + 9;
  if (STATUS.has(i.type)) return band + 8;
  return band + 5;
}

export function rankInsights(insights: Insight[]): Insight[] {
  const seen = new Map<InsightType, number>();
  const capped = insights.filter((i) => {
    const cap = TYPE_CAPS[i.type];
    if (cap === undefined) return true;
    const n = (seen.get(i.type) ?? 0) + 1;
    seen.set(i.type, n);
    return n <= cap;
  });
  const ranked = capped
    .map((insight, index) => ({ insight, index }))
    .sort((a, b) =>
      sortKey(a.insight) - sortKey(b.insight)
      || Math.abs(b.insight.impactCents ?? 0) - Math.abs(a.insight.impactCents ?? 0)
      || (TYPE_PRIORITY[a.insight.type] ?? 50) - (TYPE_PRIORITY[b.insight.type] ?? 50)
      || a.index - b.index)
    .map((x) => x.insight);
  if (ranked.length <= MAX_ROWS) return ranked;
  const warnings = ranked.filter((i) => i.severity === "warning");
  return [...warnings, ...ranked.filter((i) => i.severity !== "warning").slice(0, Math.max(0, MAX_ROWS - warnings.length))];
}

/** The Dashboard's short list: the top rows, at most one per type, favouring rows the user can act on. */
export function pickDashboardInsights(ranked: Insight[], limit = 3): Insight[] {
  const out: Insight[] = [];
  const types = new Set<InsightType>();
  const pass = (predicate: (i: Insight) => boolean) => {
    for (const i of ranked) {
      if (out.length >= limit) break;
      if (types.has(i.type) || !predicate(i)) continue;
      out.push(i);
      types.add(i.type);
    }
  };
  pass((i) => !!i.action);
  pass(() => true);
  return out;
}
