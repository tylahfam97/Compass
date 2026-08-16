import { useState, useEffect, useMemo, Fragment } from "react";
import { Link } from "react-router-dom";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell,
  BarChart, Bar,
} from "recharts";
import { TrendingUp, TrendingDown, ChevronRight, ChevronDown, Info } from "lucide-react";
import { getDb } from "@/lib/db";
import { formatCurrency, formatDate, formatAxisCurrency, accountChartColor } from "@/lib/utils";
import { holdingRoiPct, latestHoldingPerAccount } from "@/lib/netWorth";
import { useProfileStore } from "@/stores/profileStore";
import InfoTooltip from "@/components/InfoTooltip";
import { Skeleton, TableSkeleton } from "@/components/Skeleton";
import type { Holding, SecurityType, ActivityType, InvestmentActivity, InvestmentSummary } from "@/lib/types";

const SECTION_LABELS: Record<SecurityType, string> = {
  stock: "Stocks",
  etf: "ETFs",
  mutual_fund: "Mutual Funds",
  cash: "Cash",
  other: "Other",
};

const SECTION_ORDER: SecurityType[] = ["stock", "etf", "mutual_fund", "other", "cash"];

const ACTIVITY_LABELS: Record<ActivityType, string> = {
  buy: "Buy", sell: "Sell", dividend: "Dividend", reinvest: "Reinvestment",
  interest: "Interest", deposit: "Deposit", withdrawal: "Withdrawal",
  transfer: "Transfer", fee: "Fee", tax: "Tax", other: "Other",
};

/** Activity types that represent income actually received, as opposed to a trade or transfer. */
const INCOME_ACTIVITY_TYPES: ActivityType[] = ["dividend", "interest", "reinvest"];

type InvestmentTab = "holdings" | "activity" | "income";

interface HoldingGroup {
  key: string;
  symbol: string | null;
  description: string;
  securityType: SecurityType;
  totalShares: number | null;
  totalMarketValueCents: number;
  totalCostBasisCents: number | null;
  /** Market value of ONLY the lots that also have a cost basis - paired 1:1 with
   *  totalCostBasisCents so ROI compares like-for-like instead of mixing in market
   *  value from lots whose cost basis is unknown (which would overstate ROI). */
  costBasisTrackedMarketValueCents: number;
  estAnnualIncomeCents: number;
  lots: Holding[];
}

interface ValuePoint {
  as_of_date: string;
  total: number;
}

/** One investment account's own latest snapshot - accounts report on different schedules, so
 *  each carries its own as-of date. */
interface AccountSnapshot {
  id: number;
  name: string;
  institution: string | null;
  as_of_date: string;
  total: number;
  positions: number;
}

/**
 * Combines per-account snapshot totals into one portfolio value series, carrying each account's
 * most recent value forward across dates it has no statement for.
 *
 * Accounts report on different schedules (a 401(k) quarterly, a brokerage monthly), so plotting
 * `SUM(market_value) GROUP BY as_of_date` makes the portfolio appear to crash on every date
 * where only one account happened to file - the others contribute nothing rather than their
 * last known value.
 */
export function buildPortfolioHistory(
  rows: { account_id: number; as_of_date: string; total: number }[]
): ValuePoint[] {
  const dates = [...new Set(rows.map((r) => r.as_of_date))].sort();
  const byAccount = new Map<number, { as_of_date: string; total: number }[]>();
  for (const r of rows) {
    const arr = byAccount.get(r.account_id) ?? [];
    arr.push(r);
    byAccount.set(r.account_id, arr);
  }
  return dates.map((date) => {
    let total = 0;
    for (const snapshots of byAccount.values()) {
      // An account contributes nothing until its first snapshot, then its latest value at or
      // before this date.
      const latest = snapshots.filter((s) => s.as_of_date <= date).sort((a, b) => a.as_of_date.localeCompare(b.as_of_date)).pop();
      if (latest) total += latest.total;
    }
    return { as_of_date: date, total };
  });
}

function groupHoldings(rows: Holding[]): HoldingGroup[] {
  const groups = new Map<string, HoldingGroup>();
  for (const row of rows) {
    const key = `${row.security_type}|${row.symbol ?? row.description}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        symbol: row.symbol,
        description: row.description,
        securityType: row.security_type,
        totalShares: null,
        totalMarketValueCents: 0,
        totalCostBasisCents: null,
        costBasisTrackedMarketValueCents: 0,
        estAnnualIncomeCents: 0,
        lots: [],
      };
      groups.set(key, g);
    }
    if (row.shares !== null) g.totalShares = (g.totalShares ?? 0) + row.shares;
    if (row.market_value_cents !== null) g.totalMarketValueCents += row.market_value_cents;
    if (row.cost_basis_cents !== null) {
      g.totalCostBasisCents = (g.totalCostBasisCents ?? 0) + row.cost_basis_cents;
      g.costBasisTrackedMarketValueCents += row.market_value_cents ?? 0;
    }
    if (row.est_annual_income_cents !== null) g.estAnnualIncomeCents += row.est_annual_income_cents;
    g.lots.push(row);
  }
  // Highest ROI% first; groups without a cost basis (ROI unknown) sort to the bottom.
  return [...groups.values()].sort((a, b) => {
    const roiA = holdingRoiPct(a.costBasisTrackedMarketValueCents, a.totalCostBasisCents);
    const roiB = holdingRoiPct(b.costBasisTrackedMarketValueCents, b.totalCostBasisCents);
    if (roiA === null && roiB === null) return 0;
    if (roiA === null) return 1;
    if (roiB === null) return -1;
    return roiB - roiA;
  });
}

export default function InvestmentsPage() {
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const profileId = activeProfile?.id ?? 1;

  const [loading, setLoading] = useState(true);
  const [asOfDate, setAsOfDate] = useState<string | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [valueOverTime, setValueOverTime] = useState<ValuePoint[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activity, setActivity] = useState<InvestmentActivity[]>([]);
  const [accountSnapshots, setAccountSnapshots] = useState<AccountSnapshot[]>([]);
  const [latestSummary, setLatestSummary] = useState<InvestmentSummary | null>(null);
  const [tab, setTab] = useState<InvestmentTab>("holdings");
  const [activityFilter, setActivityFilter] = useState<ActivityType | "all">("all");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const db = await getDb();
      const [latestRow, historyRows, activityRows, summaryRows] = await Promise.all([
        db.select<{ d: string | null }[]>(
          "SELECT MAX(as_of_date) as d FROM holdings WHERE profile_id=?",
          [profileId]
        ),
        db.select<{ account_id: number; as_of_date: string; total: number }[]>(
          `SELECT account_id, as_of_date, SUM(COALESCE(market_value_cents, 0)) as total
           FROM holdings WHERE profile_id=?
           GROUP BY account_id, as_of_date ORDER BY as_of_date`,
          [profileId]
        ),
        db.select<InvestmentActivity[]>(
          "SELECT * FROM investment_activity WHERE profile_id=? ORDER BY trade_date DESC, id DESC",
          [profileId]
        ),
        db.select<InvestmentSummary[]>(
          "SELECT * FROM investment_summaries WHERE profile_id=? ORDER BY period_end DESC LIMIT 1",
          [profileId]
        ),
      ]);
      const latest = latestRow[0]?.d ?? null;
      if (cancelled) return;
      setAsOfDate(latest);
      setActivity(activityRows);
      setLatestSummary(summaryRows[0] ?? null);
      setValueOverTime(buildPortfolioHistory(historyRows));
      if (latest) {
        const rows = await db.select<Holding[]>(
          `SELECT h.* FROM holdings h
           WHERE h.profile_id=? AND ${latestHoldingPerAccount()}
           ORDER BY h.security_type, h.description`,
          [profileId]
        );
        const accts = await db.select<AccountSnapshot[]>(
          `SELECT a.id, a.name, a.institution, h.as_of_date,
                  SUM(COALESCE(h.market_value_cents, 0)) as total, COUNT(*) as positions
           FROM holdings h JOIN accounts a ON a.id = h.account_id
           WHERE h.profile_id=? AND ${latestHoldingPerAccount()}
           GROUP BY a.id ORDER BY total DESC`,
          [profileId]
        );
        if (!cancelled) { setHoldings(rows); setAccountSnapshots(accts); }
      } else {
        setHoldings([]);
        setAccountSnapshots([]);
      }
      if (!cancelled) setLoading(false);
    })().catch(() => setLoading(false));
    return () => { cancelled = true; };
  }, [profileId]);

  const kpis = useMemo(() => {
    let marketValue = 0, costBasis = 0, hasCostBasis = false, estIncome = 0;
    for (const h of holdings) {
      marketValue += h.market_value_cents ?? 0;
      if (h.cost_basis_cents !== null) { costBasis += h.cost_basis_cents; hasCostBasis = true; }
      estIncome += h.est_annual_income_cents ?? 0;
    }
    return {
      marketValue,
      costBasis: hasCostBasis ? costBasis : null,
      unrealized: hasCostBasis ? marketValue - costBasis : null,
      estIncome,
    };
  }, [holdings]);

  const sectionTotals = useMemo(() => {
    const totals = new Map<SecurityType, number>();
    for (const h of holdings) {
      totals.set(h.security_type, (totals.get(h.security_type) ?? 0) + (h.market_value_cents ?? 0));
    }
    return totals;
  }, [holdings]);

  const groupsBySection = useMemo(() => {
    const bySection = new Map<SecurityType, HoldingGroup[]>();
    for (const type of SECTION_ORDER) {
      const rows = holdings.filter((h) => h.security_type === type);
      if (rows.length === 0) continue;
      bySection.set(type, groupHoldings(rows));
    }
    return bySection;
  }, [holdings]);

  const allocationData = useMemo(() => {
    return SECTION_ORDER
      .filter((t) => sectionTotals.has(t) && (sectionTotals.get(t) ?? 0) > 0)
      .map((t, i) => ({
        type: t,
        name: SECTION_LABELS[t],
        value: sectionTotals.get(t) ?? 0,
        color: accountChartColor(i),
      }));
  }, [sectionTotals]);

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const activityTypesPresent = useMemo(
    () => [...new Set(activity.map((a) => a.activity_type))] as ActivityType[],
    [activity]
  );

  const filteredActivity = useMemo(
    () => (activityFilter === "all" ? activity : activity.filter((a) => a.activity_type === activityFilter)),
    [activity, activityFilter]
  );

  /** Income actually received (dividends, interest, reinvested distributions), by month -
   *  the counterpart to the brokerage's forward-looking `est_annual_income_cents` estimate. */
  const incomeByMonth = useMemo(() => {
    const byMonth = new Map<string, number>();
    for (const a of activity) {
      if (!INCOME_ACTIVITY_TYPES.includes(a.activity_type)) continue;
      const month = a.trade_date.slice(0, 7);
      byMonth.set(month, (byMonth.get(month) ?? 0) + Math.abs(a.amount_cents));
    }
    return [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, total]) => ({ month, total }));
  }, [activity]);

  const incomeTotals = useMemo(() => {
    let dividends = 0, interest = 0, fees = 0;
    for (const a of activity) {
      if (a.activity_type === "dividend" || a.activity_type === "reinvest") dividends += Math.abs(a.amount_cents);
      else if (a.activity_type === "interest") interest += Math.abs(a.amount_cents);
      else if (a.activity_type === "fee" || a.activity_type === "tax") fees += Math.abs(a.amount_cents);
    }
    return { dividends, interest, fees };
  }, [activity]);

  /** Per-lot realized gains, when a statement prints cost basis next to the sale. Most don't -
   *  the account-level YTD figure from the statement summary is the fallback. */
  const realizedLots = useMemo(
    () => activity.filter((a) => a.realized_gain_cents !== null),
    [activity]
  );

  /** True when accounts were last priced on different dates - normal (a 401(k) files quarterly,
   *  a brokerage monthly), but it means there's no single "as of" date for the whole page. */
  const mixedAsOfDates = useMemo(
    () => new Set(accountSnapshots.map((a) => a.as_of_date)).size > 1,
    [accountSnapshots]
  );

  const chartData = valueOverTime.map((p) => ({ as_of_date: p.as_of_date, value: p.total }));
  const tooltipStyle = { backgroundColor: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: "12px" };

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
        </div>
        <TableSkeleton rows={5} cols={5} />
      </div>
    );
  }

  if (!asOfDate && activity.length === 0) {
    return (
      <div className="p-6 max-w-3xl mx-auto w-full text-center py-16">
        <div className="flex justify-center mb-4 text-[hsl(var(--muted-foreground))]"><TrendingUp size={48} /></div>
        <p className="font-medium mb-1">No investments yet</p>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mb-6">
          Import a brokerage portfolio positions export or a monthly statement to track your stocks,
          ETFs, dividends, and trade activity here.
        </p>
        <Link to="/import" className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity inline-block">
          Import Portfolio
        </Link>
      </div>
    );
  }

  const TABS: { id: InvestmentTab; label: string; count?: number }[] = [
    { id: "holdings", label: "Holdings", count: holdings.length },
    { id: "activity", label: "Activity", count: activity.length },
    { id: "income", label: "Income & Gains" },
  ];

  return (
    <div className="p-8 space-y-6 max-w-6xl mx-auto w-full">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Investments</h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
            {!asOfDate
              ? "No positions snapshot yet"
              : mixedAsOfDates
                ? `${accountSnapshots.length} accounts, each priced as of its own latest statement`
                : `Priced as of ${formatDate(asOfDate)}`}
          </p>
        </div>
        <Link to="/import" className="px-4 py-1.5 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors">
          Import New Statement
        </Link>
      </div>

      {(activity.length > 0 || latestSummary) && (
        <div className="flex gap-1 border-b">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === t.id
                  ? "border-[hsl(var(--primary))] text-[hsl(var(--primary))]"
                  : "border-transparent text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
              }`}
            >
              {t.label}
              {t.count !== undefined && t.count > 0 && (
                <span className="ml-1.5 text-xs text-[hsl(var(--muted-foreground))]">{t.count}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {latestSummary && (
        <div className="border rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b flex items-center justify-between gap-2 flex-wrap">
            <span className="font-semibold text-sm">Latest Statement Period</span>
            <span className="text-xs text-[hsl(var(--muted-foreground))]">
              {latestSummary.period_start ? `${formatDate(latestSummary.period_start)} – ` : ""}
              {formatDate(latestSummary.period_end)}
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px bg-[hsl(var(--border))]">
            {([
              ["Beginning Value", latestSummary.beginning_value_cents, false],
              ["Ending Value", latestSummary.ending_value_cents, false],
              ["Change in Value", latestSummary.change_in_value_cents, true],
              ["Cash Balance", latestSummary.cash_balance_cents, false],
              ["Deposits", latestSummary.deposits_cents, false],
              ["Withdrawals", latestSummary.withdrawals_cents, false],
              ["Income", latestSummary.income_cents, false],
              ["Realized Gain", latestSummary.realized_gain_cents, true],
              ["Realized Gain (YTD)", latestSummary.realized_gain_ytd_cents, true],
              ["Unrealized Gain", latestSummary.unrealized_gain_cents, true],
              ["Fees", latestSummary.fees_cents, false],
            ] as [string, number | null, boolean][])
              .filter(([, v]) => v !== null)
              .map(([label, v, signed]) => (
                <div key={label} className="bg-[hsl(var(--background))] px-4 py-3">
                  <p className={`text-sm font-semibold font-mono ${
                    signed ? ((v as number) >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--error))]") : ""
                  }`}>
                    {formatCurrency(v as number)}
                  </p>
                  <p className="text-[hsl(var(--muted-foreground))] text-xs mt-0.5">{label}</p>
                </div>
              ))}
          </div>
        </div>
      )}

      {tab === "activity" && (
        <div className="border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b flex items-center justify-between gap-3 flex-wrap">
            <span className="font-semibold text-sm">
              Activity <span className="text-[hsl(var(--muted-foreground))] font-normal">({filteredActivity.length})</span>
            </span>
            <select
              value={activityFilter}
              onChange={(e) => setActivityFilter(e.target.value as ActivityType | "all")}
              className="border rounded-lg px-2 py-1 text-xs bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
            >
              <option value="all">All types</option>
              {activityTypesPresent.map((t) => (
                <option key={t} value={t}>{ACTIVITY_LABELS[t]}</option>
              ))}
            </select>
          </div>
          {filteredActivity.length === 0 ? (
            <p className="px-4 py-6 text-sm text-[hsl(var(--muted-foreground))] text-center">
              No activity of this type.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-[hsl(var(--muted-foreground))]">
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Description</th>
                  <th className="px-4 py-2 font-medium">Symbol</th>
                  <th className="px-4 py-2 font-medium text-right">Quantity</th>
                  <th className="px-4 py-2 font-medium text-right">Price</th>
                  <th className="px-4 py-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {filteredActivity.map((a) => (
                  <tr key={a.id} className="border-t">
                    <td className="px-4 py-2 text-xs font-mono whitespace-nowrap">{formatDate(a.trade_date)}</td>
                    <td className="px-4 py-2 text-xs">{ACTIVITY_LABELS[a.activity_type]}</td>
                    <td className="px-4 py-2 max-w-xs truncate text-xs">{a.description}</td>
                    <td className="px-4 py-2 text-xs font-mono">{a.symbol ?? "-"}</td>
                    <td className="px-4 py-2 text-right text-xs font-mono">{a.quantity ?? "-"}</td>
                    <td className="px-4 py-2 text-right text-xs font-mono">{a.price_cents !== null ? formatCurrency(a.price_cents) : "-"}</td>
                    <td className={`px-4 py-2 text-right text-xs font-mono ${a.amount_cents < 0 ? "text-[hsl(var(--error))]" : "text-[hsl(var(--success))]"}`}>
                      {formatCurrency(a.amount_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "income" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="border rounded-xl px-4 py-4 text-center">
              <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] mb-1 flex items-center justify-center gap-1">
                Dividends Received
                <InfoTooltip text="Dividends and reinvested distributions actually paid into this account, taken from imported statement activity - unlike the Est. Annual Income tile, which is the brokerage's forward-looking projection." />
              </p>
              <p className="text-xl font-bold">{formatCurrency(incomeTotals.dividends)}</p>
            </div>
            <div className="border rounded-xl px-4 py-4 text-center">
              <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] mb-1">Interest Received</p>
              <p className="text-xl font-bold">{formatCurrency(incomeTotals.interest)}</p>
            </div>
            <div className="border rounded-xl px-4 py-4 text-center">
              <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] mb-1">Fees &amp; Tax</p>
              <p className="text-xl font-bold">{formatCurrency(incomeTotals.fees)}</p>
            </div>
            <div className="border rounded-xl px-4 py-4 text-center">
              <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] mb-1">Realized Gain (YTD)</p>
              <p className={`text-xl font-bold ${
                (latestSummary?.realized_gain_ytd_cents ?? 0) >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--error))]"
              }`}>
                {latestSummary?.realized_gain_ytd_cents !== null && latestSummary?.realized_gain_ytd_cents !== undefined
                  ? formatCurrency(latestSummary.realized_gain_ytd_cents)
                  : "-"}
              </p>
            </div>
          </div>

          {incomeByMonth.length > 0 && (
            <div className="border rounded-xl p-5">
              <h2 className="font-semibold mb-4">Income Received by Month</h2>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={incomeByMonth} margin={{ left: 8, right: 8, top: 4, bottom: 4 }}>
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={formatAxisCurrency} tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v) => formatCurrency(v as number)} />
                  <Bar dataKey="total" name="Income" fill="#22c55e" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b font-semibold text-sm">Realized Gains</div>
            {realizedLots.length === 0 ? (
              <p className="px-4 py-6 text-sm text-[hsl(var(--muted-foreground))] text-center">
                Your statements report realized gains only as an account-level total, not per sale.
                See the <strong>Realized Gain</strong> figures in the statement period card above.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-[hsl(var(--muted-foreground))]">
                    <th className="px-4 py-2 font-medium">Sold</th>
                    <th className="px-4 py-2 font-medium">Acquired</th>
                    <th className="px-4 py-2 font-medium">Description</th>
                    <th className="px-4 py-2 font-medium">Term</th>
                    <th className="px-4 py-2 font-medium text-right">Proceeds</th>
                    <th className="px-4 py-2 font-medium text-right">Cost Basis</th>
                    <th className="px-4 py-2 font-medium text-right">Gain/Loss</th>
                  </tr>
                </thead>
                <tbody>
                  {realizedLots.map((a) => (
                    <tr key={a.id} className="border-t">
                      <td className="px-4 py-2 text-xs font-mono whitespace-nowrap">{formatDate(a.trade_date)}</td>
                      <td className="px-4 py-2 text-xs font-mono whitespace-nowrap">{a.acquired_date ? formatDate(a.acquired_date) : "-"}</td>
                      <td className="px-4 py-2 max-w-xs truncate text-xs">{a.description}</td>
                      <td className="px-4 py-2 text-xs capitalize">{a.term ?? "-"}</td>
                      <td className="px-4 py-2 text-right text-xs font-mono">{formatCurrency(a.amount_cents)}</td>
                      <td className="px-4 py-2 text-right text-xs font-mono">{a.cost_basis_cents !== null ? formatCurrency(a.cost_basis_cents) : "-"}</td>
                      <td className={`px-4 py-2 text-right text-xs font-mono ${(a.realized_gain_cents ?? 0) >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--error))]"}`}>
                        {formatCurrency(a.realized_gain_cents ?? 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {tab === "holdings" && holdings.length === 0 && (
        <p className="border rounded-xl px-4 py-8 text-sm text-[hsl(var(--muted-foreground))] text-center">
          This statement had no priced positions - only activity. Import a statement with a
          holdings section to see your portfolio here.
        </p>
      )}

      {tab === "holdings" && holdings.length > 0 && (
      <>
      {accountSnapshots.length > 1 && (
        <div className="border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b flex items-center justify-between">
            <span className="font-semibold text-sm">
              Accounts <span className="text-[hsl(var(--muted-foreground))] font-normal">({accountSnapshots.length})</span>
            </span>
            <span className="font-semibold text-sm">{formatCurrency(kpis.marketValue)}</span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-[hsl(var(--muted-foreground))]">
                <th className="px-4 py-2 font-medium">Account</th>
                <th className="px-4 py-2 font-medium">Priced As Of</th>
                <th className="px-4 py-2 font-medium text-right">Positions</th>
                <th className="px-4 py-2 font-medium text-right">Market Value</th>
              </tr>
            </thead>
            <tbody>
              {accountSnapshots.map((a) => (
                <tr key={a.id} className="border-t">
                  <td className="px-4 py-2 text-xs">
                    {a.name}
                    {a.institution && <span className="text-[hsl(var(--muted-foreground))]"> · {a.institution}</span>}
                  </td>
                  <td className="px-4 py-2 text-xs font-mono text-[hsl(var(--muted-foreground))]">{formatDate(a.as_of_date)}</td>
                  <td className="px-4 py-2 text-right text-xs font-mono">{a.positions}</td>
                  <td className="px-4 py-2 text-right text-xs font-mono">{formatCurrency(a.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {mixedAsOfDates && (
            <p className="px-4 py-2 text-xs text-[hsl(var(--muted-foreground))] border-t flex items-start gap-1">
              <Info size={12} className="shrink-0 mt-0.5" />
              These accounts were last priced on different dates because they issue statements on
              different schedules. Each one contributes its own most recent snapshot to the totals above.
            </p>
          )}
        </div>
      )}

      {/* KPI tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="border rounded-xl px-4 py-4 text-center">
          <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] mb-1">Portfolio Value</p>
          <p className="text-xl font-bold">{formatCurrency(kpis.marketValue)}</p>
        </div>
        <div className="border rounded-xl px-4 py-4 text-center">
          <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] mb-1">Cost Basis</p>
          <p className="text-xl font-bold">{kpis.costBasis !== null ? formatCurrency(kpis.costBasis) : "-"}</p>
        </div>
        <div className="border rounded-xl px-4 py-4 text-center">
          <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] mb-1">Unrealized Gain/Loss</p>
          <p className={`text-xl font-bold flex items-center justify-center gap-1 ${kpis.unrealized === null ? "" : kpis.unrealized >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--error))]"}`}>
            {kpis.unrealized !== null && (kpis.unrealized >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />)}
            {kpis.unrealized !== null ? formatCurrency(kpis.unrealized) : "-"}
          </p>
        </div>
        <div className="border rounded-xl px-4 py-4 text-center">
          <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] mb-1 flex items-center justify-center gap-1">
            Est. Annual Income
            <InfoTooltip text="The brokerage's own projected annual income estimate as of the statement date - typically dividends, interest, and other distributions. It's a forward-looking estimate, not a record of income actually paid." />
          </p>
          <p className="text-xl font-bold">{formatCurrency(kpis.estIncome)}</p>
        </div>
      </div>

      {/* Value over time + allocation */}
      {(chartData.length >= 2 || allocationData.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {chartData.length >= 2 && (
            <div className="border rounded-xl p-5">
              <h2 className="font-semibold mb-4">Portfolio Value Over Time</h2>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={chartData} margin={{ left: 8, right: 8, top: 4, bottom: 4 }}>
                  <XAxis dataKey="as_of_date" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={formatAxisCurrency} tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v) => formatCurrency(v as number)} />
                  <Line type="monotone" dataKey="value" name="Portfolio Value" stroke="#6366f1" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          {allocationData.length > 0 && (
            <div className="border rounded-xl p-5">
              <h2 className="font-semibold mb-4">Allocation</h2>
              <div className="flex items-center gap-4">
                <ResponsiveContainer width="50%" height={200}>
                  <PieChart>
                    <Pie
                      data={allocationData}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={50}
                      outerRadius={80}
                      paddingAngle={2}
                      strokeWidth={0}
                    >
                      {allocationData.map((entry) => (
                        <Cell key={entry.type} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(v, _n, item) => [
                        formatCurrency(v as number),
                        item?.payload?.name ?? "",
                      ]}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex-1 space-y-2 min-w-0">
                  {allocationData.map((entry) => (
                    <div key={entry.type} className="flex items-center gap-2 text-xs">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
                      <span className="truncate flex-1">{entry.name}</span>
                      <span className="font-medium text-[hsl(var(--muted-foreground))] shrink-0">
                        {kpis.marketValue > 0 ? Math.round((entry.value / kpis.marketValue) * 100) : 0}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Holdings by section */}
      {SECTION_ORDER.filter((t) => groupsBySection.has(t)).map((type) => {
        const groups = groupsBySection.get(type) ?? [];
        return (
          <div key={type} className="border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <span className="font-semibold text-sm">{SECTION_LABELS[type]} <span className="text-[hsl(var(--muted-foreground))] font-normal">({groups.length})</span></span>
              <span className="font-semibold text-sm">{formatCurrency(sectionTotals.get(type) ?? 0)}</span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-[hsl(var(--muted-foreground))]">
                  <th className="px-4 py-2 font-medium w-6" />
                  <th className="px-4 py-2 font-medium">Description</th>
                  <th className="px-4 py-2 font-medium">Symbol</th>
                  <th className="px-4 py-2 font-medium text-right">Shares</th>
                  <th className="px-4 py-2 font-medium text-right">Market Value</th>
                  <th className="px-4 py-2 font-medium text-right">ROI</th>
                  <th className="px-4 py-2 font-medium text-right">Est. Annual Income</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const hasLots = g.lots.length > 1;
                  const isOpen = expanded.has(g.key);
                  const roiPct = holdingRoiPct(g.costBasisTrackedMarketValueCents, g.totalCostBasisCents);
                  return (
                    <Fragment key={g.key}>
                      <tr className={`border-t ${hasLots ? "cursor-pointer hover:bg-[hsl(var(--muted))]/40" : ""}`}
                        onClick={() => hasLots && toggleExpanded(g.key)}>
                        <td className="px-4 py-2 text-[hsl(var(--muted-foreground))]">
                          {hasLots && (isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
                        </td>
                        <td className="px-4 py-2 max-w-xs truncate text-xs">{g.description}</td>
                        <td className="px-4 py-2 text-xs font-mono">{g.symbol ?? "-"}</td>
                        <td className="px-4 py-2 text-right text-xs font-mono">{g.totalShares !== null ? g.totalShares.toLocaleString() : "-"}</td>
                        <td className="px-4 py-2 text-right text-xs font-mono">{formatCurrency(g.totalMarketValueCents)}</td>
                        <td className={`px-4 py-2 text-right text-xs font-mono ${roiPct === null ? "text-[hsl(var(--muted-foreground))]" : roiPct >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--error))]"}`}>
                          {roiPct !== null ? `${roiPct >= 0 ? "+" : ""}${roiPct.toFixed(1)}%` : "-"}
                        </td>
                        <td className="px-4 py-2 text-right text-xs font-mono text-[hsl(var(--muted-foreground))]">
                          {g.estAnnualIncomeCents > 0 ? formatCurrency(g.estAnnualIncomeCents) : "-"}
                        </td>
                      </tr>
                      {hasLots && isOpen && g.lots.map((lot, i) => (
                        <tr key={`${g.key}-${i}`} className="border-t bg-[hsl(var(--muted))]/20 text-xs text-[hsl(var(--muted-foreground))]">
                          <td className="px-4 py-1.5" />
                          <td className="px-4 py-1.5" colSpan={2}>
                            Lot {i + 1}
                            {lot.trade_date ? ` - purchased ${formatDate(lot.trade_date)}` : ""}
                            {lot.cost_basis_cents !== null ? ` - cost basis ${formatCurrency(lot.cost_basis_cents)}` : ""}
                          </td>
                          <td className="px-4 py-1.5 text-right font-mono">{lot.shares ?? "-"}</td>
                          <td className="px-4 py-1.5 text-right font-mono">{lot.market_value_cents !== null ? formatCurrency(lot.market_value_cents) : "-"}</td>
                          <td className="px-4 py-1.5 text-right font-mono">
                            {holdingRoiPct(lot.market_value_cents, lot.cost_basis_cents) !== null
                              ? `${holdingRoiPct(lot.market_value_cents, lot.cost_basis_cents)! >= 0 ? "+" : ""}${holdingRoiPct(lot.market_value_cents, lot.cost_basis_cents)!.toFixed(1)}%`
                              : "-"}
                          </td>
                          <td className="px-4 py-1.5 text-right font-mono">-</td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}

      <p className="text-xs text-[hsl(var(--muted-foreground))] flex items-start gap-1">
        <Info size={12} className="shrink-0 mt-0.5" />
        Est. Annual Income figures reflect the brokerage's projected estimates as of the statement date, not a history of dividends actually paid.
        {activity.length > 0 && <> See the <strong>Income &amp; Gains</strong> tab for income actually received.</>}
      </p>
      </>
      )}
    </div>
  );
}
