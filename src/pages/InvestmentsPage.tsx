import { useState, useEffect, useMemo, Fragment } from "react";
import { Link } from "react-router-dom";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";
import { TrendingUp, TrendingDown, ChevronRight, ChevronDown, Info } from "lucide-react";
import { getDb } from "@/lib/db";
import { formatCurrency, formatDate } from "@/lib/utils";
import { holdingRoiPct } from "@/lib/netWorth";
import { useProfileStore } from "@/stores/profileStore";
import InfoTooltip from "@/components/InfoTooltip";
import { Skeleton, TableSkeleton } from "@/components/Skeleton";
import type { Holding, SecurityType } from "@/lib/types";

const SECTION_LABELS: Record<SecurityType, string> = {
  stock: "Stocks",
  etf: "ETFs",
  mutual_fund: "Mutual Funds",
  cash: "Cash",
  other: "Other",
};

const SECTION_ORDER: SecurityType[] = ["stock", "etf", "mutual_fund", "other", "cash"];

interface HoldingGroup {
  key: string;
  symbol: string | null;
  description: string;
  securityType: SecurityType;
  totalShares: number | null;
  totalMarketValueCents: number;
  totalCostBasisCents: number | null;
  estAnnualIncomeCents: number;
  lots: Holding[];
}

interface ValuePoint {
  as_of_date: string;
  total: number;
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
        estAnnualIncomeCents: 0,
        lots: [],
      };
      groups.set(key, g);
    }
    if (row.shares !== null) g.totalShares = (g.totalShares ?? 0) + row.shares;
    if (row.market_value_cents !== null) g.totalMarketValueCents += row.market_value_cents;
    if (row.cost_basis_cents !== null) g.totalCostBasisCents = (g.totalCostBasisCents ?? 0) + row.cost_basis_cents;
    if (row.est_annual_income_cents !== null) g.estAnnualIncomeCents += row.est_annual_income_cents;
    g.lots.push(row);
  }
  // Highest ROI% first; groups without a cost basis (ROI unknown) sort to the bottom.
  return [...groups.values()].sort((a, b) => {
    const roiA = holdingRoiPct(a.totalMarketValueCents, a.totalCostBasisCents);
    const roiB = holdingRoiPct(b.totalMarketValueCents, b.totalCostBasisCents);
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const db = await getDb();
      const [latestRow, historyRows] = await Promise.all([
        db.select<{ d: string | null }[]>(
          "SELECT MAX(as_of_date) as d FROM holdings WHERE profile_id=?",
          [profileId]
        ),
        db.select<{ as_of_date: string; total: number }[]>(
          `SELECT as_of_date, SUM(COALESCE(market_value_cents, 0)) as total
           FROM holdings WHERE profile_id=? GROUP BY as_of_date ORDER BY as_of_date`,
          [profileId]
        ),
      ]);
      const latest = latestRow[0]?.d ?? null;
      if (cancelled) return;
      setAsOfDate(latest);
      setValueOverTime(historyRows.map((r) => ({ as_of_date: r.as_of_date, total: r.total })));
      if (latest) {
        const rows = await db.select<Holding[]>(
          "SELECT * FROM holdings WHERE profile_id=? AND as_of_date=? ORDER BY security_type, description",
          [profileId, latest]
        );
        if (!cancelled) setHoldings(rows);
      } else {
        setHoldings([]);
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

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

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

  if (!asOfDate || holdings.length === 0) {
    return (
      <div className="p-6 max-w-3xl mx-auto w-full text-center py-16">
        <div className="flex justify-center mb-4 text-[hsl(var(--muted-foreground))]"><TrendingUp size={48} /></div>
        <p className="font-medium mb-1">No investments yet</p>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mb-6">
          Import a brokerage portfolio positions export to track your stocks, ETFs, and dividends here.
        </p>
        <Link to="/import" className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity inline-block">
          Import Portfolio
        </Link>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Investments</h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">Priced as of {formatDate(asOfDate)}</p>
        </div>
        <Link to="/import" className="px-4 py-1.5 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors">
          Import New Statement
        </Link>
      </div>

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
          <p className={`text-xl font-bold flex items-center justify-center gap-1 ${kpis.unrealized === null ? "" : kpis.unrealized >= 0 ? "text-green-600" : "text-red-500"}`}>
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

      {/* Section breakdown */}
      <div className="flex flex-wrap gap-2">
        {SECTION_ORDER.filter((t) => sectionTotals.has(t)).map((t) => (
          <span key={t} className="px-3 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1.5">
            {SECTION_LABELS[t]}
            <span className="text-[hsl(var(--muted-foreground))]">{formatCurrency(sectionTotals.get(t) ?? 0)}</span>
          </span>
        ))}
      </div>

      {/* Value over time */}
      {chartData.length >= 2 && (
        <div className="border rounded-xl p-5">
          <h2 className="font-semibold mb-4">Portfolio Value Over Time</h2>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData} margin={{ left: 8, right: 8, top: 4, bottom: 4 }}>
              <XAxis dataKey="as_of_date" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={(v) => `$${Math.round(v / 100)}`} tick={{ fontSize: 11 }} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => formatCurrency(v as number)} />
              <Line type="monotone" dataKey="value" name="Portfolio Value" stroke="#6366f1" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
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
                  const roiPct = holdingRoiPct(g.totalMarketValueCents, g.totalCostBasisCents);
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
                        <td className={`px-4 py-2 text-right text-xs font-mono ${roiPct === null ? "text-[hsl(var(--muted-foreground))]" : roiPct >= 0 ? "text-green-600" : "text-red-500"}`}>
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
      </p>
    </div>
  );
}
