import { getDb } from "./db";
import type { SecurityType } from "./types";

/** Net worth broken into its three components. `debtCents` is <= 0 (credit
 *  card balances are stored negative), so netWorthCents = liquid + debt + investment. */
export interface NetWorthSnapshot {
  liquidCents: number;
  debtCents: number;
  investmentCents: number;
  netWorthCents: number;
}

/** A profile's investment return, computed from cost basis vs. market value
 *  of its latest portfolio snapshot. `annualizedReturnPct` is null unless at
 *  least some holdings carry a trade date to estimate an average holding period. */
export interface InvestmentReturn {
  absoluteReturnPct: number | null;
  annualizedReturnPct: number | null;
  hasCostBasis: boolean;
}

export interface TopRoiHolding {
  description: string;
  symbol: string | null;
  roiPct: number;
  marketValueCents: number;
}

/** ROI% for a single holding (or aggregated group). Null if cost basis is unavailable/zero. */
export function holdingRoiPct(marketValueCents: number | null, costBasisCents: number | null): number | null {
  if (costBasisCents === null || costBasisCents === 0 || marketValueCents === null) return null;
  return ((marketValueCents - costBasisCents) / costBasisCents) * 100;
}

/**
 * Computes a net-worth snapshot for one or more profiles: liquid cash (checking
 * accounts), debt (credit card balances, stored negative), and investment
 * holdings (latest snapshot). Pass `asOfDate` to reconstruct a historical
 * snapshot (all lookups are capped to that date, inclusive).
 */
export async function computeNetWorth(profileIds: number[], asOfDate?: string): Promise<NetWorthSnapshot> {
  if (profileIds.length === 0) return { liquidCents: 0, debtCents: 0, investmentCents: 0, netWorthCents: 0 };
  const db = await getDb();
  const ph = profileIds.map(() => "?").join(",");

  // Latest balance per checking/credit account, optionally capped at asOfDate.
  // Note: the date-filter "?" appears textually before the profile-id "?"s below
  // (it's inside the correlated subquery, which is in the SELECT list), so it
  // must be the first bound parameter.
  const dateFilter = asOfDate ? "AND t.date <= ?" : "";
  const balParams = asOfDate ? [asOfDate, ...profileIds] : [...profileIds];
  const balRows = await db.select<{ account_type: string; balance_cents: number | null }[]>(
    `SELECT a.account_type,
       (SELECT t.balance_cents FROM transactions t WHERE t.account_id=a.id AND t.balance_cents IS NOT NULL ${dateFilter}
        ORDER BY t.date DESC, t.id DESC LIMIT 1) as balance_cents
     FROM accounts a WHERE a.profile_id IN (${ph}) AND a.account_type IN ('checking','credit')`,
    balParams
  );
  let liquidCents = 0, debtCents = 0;
  for (const row of balRows) {
    if (row.balance_cents === null) continue;
    if (row.account_type === "credit") debtCents += row.balance_cents;
    else liquidCents += row.balance_cents;
  }

  // Latest holdings snapshot total, optionally capped at asOfDate.
  const holdingDateFilter = asOfDate ? "AND as_of_date <= ?" : "";
  const invParams = asOfDate ? [...profileIds, ...profileIds, asOfDate] : [...profileIds, ...profileIds];
  const [invRow] = await db.select<{ total: number | null }[]>(
    `SELECT SUM(market_value_cents) as total FROM holdings
     WHERE profile_id IN (${ph}) AND as_of_date = (
       SELECT MAX(as_of_date) FROM holdings WHERE profile_id IN (${ph}) ${holdingDateFilter}
     )`,
    invParams
  );
  const investmentCents = invRow?.total ?? 0;

  return {
    liquidCents,
    debtCents,
    investmentCents,
    netWorthCents: liquidCents + debtCents + investmentCents,
  };
}

/** Returns a month-by-month net worth history (oldest first) for a sparkline/trend. */
export async function getNetWorthHistory(
  profileIds: number[],
  months = 12
): Promise<{ month: string; netWorthCents: number }[]> {
  if (profileIds.length === 0) return [];
  const now = new Date();
  const points: { month: string; cutoff: string }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthLabel = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const isCurrent = i === 0;
    const cutoff = isCurrent
      ? now.toISOString().split("T")[0]
      : new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().split("T")[0]; // last day of that month
    points.push({ month: monthLabel, cutoff });
  }
  const snapshots = await Promise.all(points.map((p) => computeNetWorth(profileIds, p.cutoff)));
  return points.map((p, i) => ({ month: p.month, netWorthCents: snapshots[i].netWorthCents }));
}

/**
 * Estimates the portfolio's return using each profile's latest snapshot:
 * absolute return is (market value - cost basis) / cost basis; annualized
 * return additionally requires at least some holdings to carry a trade date
 * (used to estimate a cost-basis-weighted average holding period).
 */
export async function computeInvestmentReturn(profileIds: number[]): Promise<InvestmentReturn> {
  if (profileIds.length === 0) return { absoluteReturnPct: null, annualizedReturnPct: null, hasCostBasis: false };
  const db = await getDb();
  const ph = profileIds.map(() => "?").join(",");
  const rows = await db.select<{
    cost_basis_cents: number | null; market_value_cents: number | null; trade_date: string | null;
  }[]>(
    `SELECT h.cost_basis_cents, h.market_value_cents, h.trade_date FROM holdings h
     WHERE h.profile_id IN (${ph})
       AND h.as_of_date = (SELECT MAX(as_of_date) FROM holdings h2 WHERE h2.profile_id=h.profile_id)`,
    [...profileIds]
  );

  let totalCost = 0, totalMv = 0, weightedDays = 0;
  const today = Date.now();
  for (const r of rows) {
    if (r.cost_basis_cents === null || r.cost_basis_cents === 0) continue;
    totalCost += r.cost_basis_cents;
    totalMv += r.market_value_cents ?? 0;
    if (r.trade_date) {
      const days = (today - new Date(r.trade_date).getTime()) / 86_400_000;
      if (days > 0) weightedDays += days * r.cost_basis_cents;
    }
  }
  if (totalCost <= 0) return { absoluteReturnPct: null, annualizedReturnPct: null, hasCostBasis: false };

  const absoluteReturnPct = ((totalMv - totalCost) / totalCost) * 100;
  const avgHoldingDays = weightedDays > 0 ? weightedDays / totalCost : null;
  let annualizedReturnPct: number | null = null;
  if (avgHoldingDays && avgHoldingDays >= 30 && totalMv > 0) {
    const growthMultiple = totalMv / totalCost;
    annualizedReturnPct = (Math.pow(growthMultiple, 365 / avgHoldingDays) - 1) * 100;
  }
  return { absoluteReturnPct, annualizedReturnPct, hasCostBasis: true };
}

/**
 * Returns the top holdings by ROI% within each security-type section, from
 * every profile's latest snapshot combined. Holdings are grouped by
 * symbol/description (summing across lots) before ranking, matching how the
 * Investments page groups holdings. Holdings without cost basis are excluded.
 */
export async function getTopRoiHoldings(
  profileIds: number[],
  limitPerSection = 3
): Promise<Partial<Record<SecurityType, TopRoiHolding[]>>> {
  if (profileIds.length === 0) return {};
  const db = await getDb();
  const ph = profileIds.map(() => "?").join(",");
  const rows = await db.select<{
    security_type: SecurityType; description: string; symbol: string | null;
    cost_basis_cents: number | null; market_value_cents: number | null;
  }[]>(
    `SELECT h.security_type, h.description, h.symbol, h.cost_basis_cents, h.market_value_cents FROM holdings h
     WHERE h.profile_id IN (${ph})
       AND h.as_of_date = (SELECT MAX(as_of_date) FROM holdings h2 WHERE h2.profile_id=h.profile_id)`,
    [...profileIds]
  );

  const groups = new Map<string, { securityType: SecurityType; description: string; symbol: string | null; costBasis: number; marketValue: number }>();
  for (const r of rows) {
    if (r.cost_basis_cents === null) continue;
    const key = `${r.security_type}|${r.symbol ?? r.description}`;
    const g = groups.get(key) ?? { securityType: r.security_type, description: r.description, symbol: r.symbol, costBasis: 0, marketValue: 0 };
    g.costBasis += r.cost_basis_cents;
    g.marketValue += r.market_value_cents ?? 0;
    groups.set(key, g);
  }

  const bySection = new Map<SecurityType, TopRoiHolding[]>();
  for (const g of groups.values()) {
    const roi = holdingRoiPct(g.marketValue, g.costBasis);
    if (roi === null) continue;
    const list = bySection.get(g.securityType) ?? [];
    list.push({ description: g.description, symbol: g.symbol, roiPct: roi, marketValueCents: g.marketValue });
    bySection.set(g.securityType, list);
  }

  const result: Partial<Record<SecurityType, TopRoiHolding[]>> = {};
  for (const [type, list] of bySection) {
    result[type] = list.sort((a, b) => b.roiPct - a.roiPct).slice(0, limitPerSection);
  }
  return result;
}
