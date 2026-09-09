import { useState, useEffect, useMemo } from "react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { Repeat2, ChevronRight } from "lucide-react";
import { getDb } from "@/lib/db";
import { incomeSumSql, expenseSumSql, categorySpendSql } from "@/lib/reportingSql";
import { detectRecurringCharges } from "@/lib/agent";
import { formatCurrency, formatDate, formatMonthLabel, formatAxisCurrency, combineAccountBalances } from "@/lib/utils";
import type { Transaction, RecurringCharge } from "@/lib/types";
import { useAutoMonth } from "@/hooks/useAutoMonth";
import { useProfileStore } from "@/stores/profileStore";
import { handleLoadFailure } from "@/stores/toastStore";
import { Skeleton } from "@/components/Skeleton";
import TransactionDetailModal from "@/components/TransactionDetailModal";

interface BalanceTrendPoint {
  month: string;
  balance: number;
}

interface CatRow {
  category_id: number | null;
  category_name: string;
  category_color: string;
  total_cents: number;
}

interface MonthTotal {
  month: string;
  income_cents: number;
  expense_cents: number;
  net_cents: number;
}

interface RecurringItem {
  description: string;
  count: number;
  total_cents: number;
  avg_cents: number;
  category_name: string;
  category_color: string;
}

function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  return [
    `${y}-${String(m).padStart(2, "0")}-01`,
    new Date(y, m, 1).toISOString().split("T")[0],
  ];
}

function prevYM(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function changePct(now: number, prev: number): number {
  if (prev === 0) return now > 0 ? 100 : 0;
  return Math.round(((now - prev) / prev) * 100);
}

export default function ReportsPage() {
  const [month, setMonth] = useAutoMonth("reports");
  const [rangeMode, setRangeMode] = useState<"month" | "custom">("month");
  const [customStart, setCustomStart] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 2); d.setDate(1);
    return d.toISOString().split("T")[0];
  });
  const [customEnd, setCustomEnd] = useState(() => new Date().toISOString().split("T")[0]);
  const [loading, setLoading] = useState(true);
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const profileId = activeProfile?.id ?? 1;

  const [catThis, setCatThis] = useState<CatRow[]>([]);
  const [catPrev, setCatPrev] = useState<CatRow[]>([]);
  const [monthTotals, setMonthTotals] = useState<MonthTotal[]>([]);
  const [topExpenses, setTopExpenses] = useState<Transaction[]>([]);
  const [recurring, setRecurring] = useState<RecurringItem[]>([]);
  const [subscriptions, setSubscriptions] = useState<RecurringCharge[]>([]);
  const [balanceTrend, setBalanceTrend] = useState<BalanceTrendPoint[]>([]);
  const [periodTotals, setPeriodTotals] = useState({ income_cents: 0, expense_cents: 0 });
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const validRange = rangeMode === "month" ? !!month : !!customStart && !!customEnd && customStart <= customEnd;

  // Compute effective [start, end) for all queries
  const effectiveRange = (): [string, string] => {
    if (rangeMode === "month") return monthBounds(month);
    // end is exclusive: advance customEnd by one day
    const e = new Date(customEnd);
    e.setDate(e.getDate() + 1);
    return [customStart, e.toISOString().split("T")[0]];
  };

  const applyPreset = (preset: "thisQ" | "lastQ" | "ytd" | "12m") => {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth(); // 0-indexed
    let s: Date, e: Date;
    if (preset === "thisQ") {
      const qStart = Math.floor(m / 3) * 3;
      s = new Date(y, qStart, 1);
      e = now;
    } else if (preset === "lastQ") {
      const qStart = Math.floor(m / 3) * 3;
      s = new Date(y, qStart - 3, 1);
      e = new Date(y, qStart, 0);
    } else if (preset === "ytd") {
      s = new Date(y, 0, 1);
      e = now;
    } else {
      s = new Date(y, m - 11, 1);
      e = now;
    }
    setCustomStart(s.toISOString().split("T")[0]);
    setCustomEnd(e.toISOString().split("T")[0]);
    setRangeMode("custom");
  };

  const navMonth = (dir: -1 | 1) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + dir, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!validRange) { setLoading(false); return; }
      setLoading(true);
      const db = await getDb();
      const [start, end] = effectiveRange();
      const [prevStart, prevEnd] = rangeMode === "month"
        ? monthBounds(prevYM(month))
        : [start, start]; // custom mode: no "prev" comparison (same range = 0% change)

      // Start date for totals chart — use selected range
      const chartStart = rangeMode === "custom" ? customStart : (() => {
        const [year, monthNumber] = month.split("-").map(Number);
        const chartDate = new Date(year, monthNumber - 6, 1);
        return `${chartDate.getFullYear()}-${String(chartDate.getMonth() + 1).padStart(2, "0")}-01`;
      })();

      const [thisMonthCats, prevMonthCats, totals, top, rec, subs, balTrend, selectedTotals] = await Promise.all([
        db.select<CatRow[]>(
          `SELECT t.category_id, c.name as category_name, c.color as category_color,
                  ${categorySpendSql()} as total_cents
           FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
           JOIN accounts a ON a.id=t.account_id
           WHERE t.date>=? AND t.date<? AND t.profile_id=?
             AND (t.category_id IS NULL OR t.category_id NOT IN (20,29))
           GROUP BY t.category_id ORDER BY total_cents DESC`,
          [start, end, profileId]
        ),
        db.select<CatRow[]>(
          `SELECT t.category_id, c.name as category_name, c.color as category_color,
                  ${categorySpendSql()} as total_cents
           FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
           JOIN accounts a ON a.id=t.account_id
           WHERE t.date>=? AND t.date<? AND t.profile_id=?
             AND (t.category_id IS NULL OR t.category_id NOT IN (20,29))
           GROUP BY t.category_id ORDER BY total_cents DESC`,
          [prevStart, prevEnd, profileId]
        ),
        db.select<{ month: string; income_cents: number; expense_cents: number }[]>(
          `SELECT strftime('%Y-%m', t.date) as month,
                  ${incomeSumSql()} as income_cents,
                  ${expenseSumSql()} as expense_cents
           FROM transactions t JOIN accounts a ON a.id=t.account_id
           WHERE t.date>=? AND t.date<? AND t.profile_id=? GROUP BY month ORDER BY month`,
          [chartStart, end, profileId]
        ),
        db.select<Transaction[]>(
          `SELECT t.*, c.name as category_name, c.color as category_color
           FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
           WHERE t.date>=? AND t.date<? AND t.amount_cents<0 AND t.profile_id=?
             AND (t.category_id IS NULL OR t.category_id NOT IN (20,29))
           ORDER BY t.amount_cents ASC LIMIT 10`,
          [start, end, profileId]
        ),
        db.select<RecurringItem[]>(
          `SELECT t.description,
                  COUNT(*) as count,
                  SUM(ABS(t.amount_cents)) as total_cents,
                  CAST(AVG(ABS(t.amount_cents)) AS INTEGER) as avg_cents,
                  c.name as category_name, c.color as category_color
           FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
           WHERE t.amount_cents<0 AND t.profile_id=?
             AND (t.category_id IS NULL OR t.category_id NOT IN (20,29))
           GROUP BY t.description HAVING count>=2
           ORDER BY count DESC, total_cents DESC LIMIT 10`,
          [profileId]
        ),
        detectRecurringCharges([profileId]),
        db.select<{ date: string; account_id: number; balance_cents: number }[]>(
          `SELECT t.date, t.account_id, t.balance_cents FROM transactions t
           JOIN accounts a ON a.id=t.account_id
           WHERE t.profile_id=? AND t.date<? AND t.balance_cents IS NOT NULL AND a.account_type IN ('checking','credit') AND a.hidden_from_dashboard=0
           ORDER BY t.date ASC, t.id ASC`,
          [profileId, end]
        ),
        db.select<{ income_cents: number; expense_cents: number }[]>(
          `SELECT COALESCE(${incomeSumSql()},0) as income_cents, COALESCE(${expenseSumSql()},0) as expense_cents
           FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE t.profile_id=? AND t.date>=? AND t.date<?`,
          [profileId, start, end],
        ),
      ]);

      if (cancelled) return;
      setCatThis(thisMonthCats);
      setCatPrev(prevMonthCats);
      setPeriodTotals(selectedTotals[0]);
      setMonthTotals(
        totals.map((r) => ({ ...r, net_cents: r.income_cents - r.expense_cents }))
      );
      setTopExpenses(top);
      setRecurring(rec);
      setSubscriptions(subs);
      const combinedBalance = combineAccountBalances(balTrend);
      const lastPerMonth = new Map<string, number>();
      for (const r of combinedBalance) lastPerMonth.set(r.date.slice(0, 7), r.balance_cents);
      setBalanceTrend(
        [...lastPerMonth.entries()]
          .filter(([month]) => month >= chartStart.slice(0, 7))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, balance_cents]) => ({ month, balance: balance_cents }))
      );
      setLoading(false);
    }
    load().catch(handleLoadFailure("this report", setLoading));
    return () => { cancelled = true; };
  }, [month, rangeMode, customStart, customEnd, profileId, validRange]);

  const prevMap = new Map(catPrev.map((r) => [r.category_id, r.total_cents]));
  const hasData = catThis.length > 0 || topExpenses.length > 0;

  const catChartData = useMemo(() => {
    return catThis.filter((category) => category.total_cents > 0).map((c) => ({
      id: c.category_id,
      name: c.category_name ?? "Uncategorized",
      value: c.total_cents,
      color: c.category_color ?? "#9ca3af",
    }));
  }, [catThis]);
  const catChartTotal = catChartData.reduce((sum, c) => sum + c.value, 0);

  return (
    <div className="workspace-page reports-workspace space-y-7">
      <div className="space-y-3">
        <div className="workspace-heading">
          <div><h1 className="text-2xl font-semibold">Reports</h1><p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">{rangeMode === "month" && month ? formatMonthLabel(month) : "Selected date range"}</p></div>
          {/* Mode toggle */}
          <div className="flex rounded-lg border overflow-hidden text-sm">
            <button
              onClick={() => setRangeMode("month")}
              aria-pressed={rangeMode === "month"}
              className={`px-3 py-1.5 transition-colors ${rangeMode === "month" ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]" : "hover:bg-[hsl(var(--muted))]"}`}
            >Month</button>
            <button
              onClick={() => setRangeMode("custom")}
              aria-pressed={rangeMode === "custom"}
              className={`px-3 py-1.5 border-l transition-colors ${rangeMode === "custom" ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]" : "hover:bg-[hsl(var(--muted))]"}`}
            >Custom</button>
          </div>
        </div>

        {rangeMode === "month" && (
          <div className="flex items-center gap-1 justify-end">
            <button onClick={() => navMonth(-1)} aria-label="Previous month"
              className="p-1.5 border rounded-lg text-base leading-none hover:bg-[hsl(var(--muted))] transition-colors">‹</button>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
              className="border rounded-lg px-3 py-1.5 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]" />
            <button onClick={() => navMonth(1)} aria-label="Next month"
              className="p-1.5 border rounded-lg text-base leading-none hover:bg-[hsl(var(--muted))] transition-colors">›</button>
          </div>
        )}

        {rangeMode === "custom" && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <input type="date" aria-label="Report start date" value={customStart} onChange={(e) => setCustomStart(e.target.value)}
                className="border rounded-lg px-3 py-1.5 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]" />
              <span className="text-[hsl(var(--muted-foreground))] text-sm">to</span>
              <input type="date" aria-label="Report end date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)}
                className="border rounded-lg px-3 py-1.5 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]" />
            </div>
            <div className="flex gap-2 flex-wrap text-xs">
              {([["thisQ","This quarter"],["lastQ","Last quarter"],["ytd","Year to date"],["12m","Last 12 months"]] as const).map(([k,l]) => (
                <button key={k} onClick={() => applyPreset(k)}
                  className="px-2.5 py-1 border rounded-md hover:bg-[hsl(var(--muted))] transition-colors">
                  {l}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {!validRange && <p role="alert" className="text-sm text-[hsl(var(--error))]">Choose a valid start and end date.</p>}

      {loading && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
          </div>
          <Skeleton className="h-64 rounded-xl" />
        </div>
      )}

      {!loading && validRange && !hasData && (
        <p className="text-[hsl(var(--muted-foreground))] text-center py-16">
          No data for this period. Import a bank statement to generate reports.
        </p>
      )}

      {!loading && validRange && hasData && (
        <>
          <div className="goal-summary report-summary">
            <div><p>Income · selected period</p><strong>{formatCurrency(periodTotals.income_cents)}</strong></div>
            <div><p>Spending · selected period</p><strong>{formatCurrency(periodTotals.expense_cents)}</strong></div>
            <div><p>Net · selected period</p><strong className={periodTotals.income_cents < periodTotals.expense_cents ? "text-[hsl(var(--error))]" : ""}>{formatCurrency(periodTotals.income_cents - periodTotals.expense_cents)}</strong></div>
          </div>

          {monthTotals.length > 0 && <section>
            <div className="workspace-heading mb-4"><h2 className="font-semibold">Income &amp; spending trend</h2><div className="flex gap-4 text-xs text-[hsl(var(--muted-foreground))]"><span className="flex items-center gap-1.5"><span className="w-2 h-2 bg-[hsl(var(--primary))]" />Income</span><span className="flex items-center gap-1.5"><span className="w-2 h-2" style={{ background: "var(--gold)" }} />Spending</span></div></div>
            <div className="h-56"><ResponsiveContainer width="100%" height="100%"><BarChart data={monthTotals} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="3 3" />
              <XAxis dataKey="month" tickFormatter={formatMonthLabel} tick={{ fontSize: 11 }} minTickGap={35} />
              <YAxis tickFormatter={formatAxisCurrency} tick={{ fontSize: 11 }} width={55} />
              <Tooltip labelFormatter={(value) => formatMonthLabel(String(value))} formatter={(value, name) => [formatCurrency(Number(value)), name === "income_cents" ? "Income" : "Spending"]} contentStyle={{ backgroundColor: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
              <Bar dataKey="income_cents" fill="hsl(var(--primary))" maxBarSize={28} radius={[3, 3, 0, 0]} />
              <Bar dataKey="expense_cents" fill="var(--gold)" maxBarSize={28} radius={[3, 3, 0, 0]} />
            </BarChart></ResponsiveContainer></div>
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-2">{rangeMode === "month" ? "Up to six months of recorded activity" : "Monthly totals within the selected dates"} · open months are partial</p>
          </section>}
          {/* ── CATEGORY BREAKDOWN ── */}
          <section>
            <h2 className="font-semibold mb-3">Spending by Category</h2>
            <div className="space-y-4">
              {catChartData.length > 0 && (
                <div>
                  {/* Ranked bars instead of a donut: shares compare by length, not arc angle. */}
                  <div className="space-y-2.5 w-full">
                    {catChartData.map((entry) => {
                      const pct = catChartTotal > 0 ? (entry.value / catChartTotal) * 100 : 0;
                      return (
                        <div key={entry.id ?? "uncategorized"} className="report-category-row">
                          <div className="flex items-center justify-between gap-2 text-[11px] mb-1">
                            <span className="truncate flex items-center gap-1.5 min-w-0">
                              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
                              <span className="truncate">{entry.name}</span>
                            </span>
                            <span className="tabular-nums shrink-0">
                              {formatCurrency(entry.value)} <span className="text-[hsl(var(--muted-foreground))]">· {Math.round(pct)}%</span>
                            </span>
                          </div>
                          <div
                            className="h-1.5 rounded-full bg-[hsl(var(--muted))] overflow-hidden"
                            role="img"
                            aria-label={`${entry.name}: ${formatCurrency(entry.value)}, ${Math.round(pct)}% of spending`}
                          >
                            <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: entry.color }} />
                          </div>
                          {rangeMode === "month" && <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{(prevMap.get(entry.id) ?? 0) > 0 ? `${formatCurrency(prevMap.get(entry.id)!)} in ${formatMonthLabel(prevYM(month))} (full month)` : "No spending in the previous month"}</p>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <details className="workspace-disclosure report-table">
                <summary>Exact category comparison</summary>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-[hsl(var(--muted-foreground))]">
                      <th className="px-4 py-2.5 font-medium">Category</th>
                      <th className="px-4 py-2.5 font-medium text-right">{rangeMode === "custom" ? "Selected period" : formatMonthLabel(month)}</th>
                      {rangeMode === "month" && <><th className="px-4 py-2.5 font-medium text-right">{formatMonthLabel(prevYM(month))} (full month)</th>
                      <th className="px-4 py-2.5 font-medium text-right">Change</th></>}
                    </tr>
                  </thead>
                  <tbody>
                    {catThis.map((cat) => {
                      const prev = prevMap.get(cat.category_id) ?? 0;
                      const pct = changePct(cat.total_cents, prev);
                      return (
                        <tr key={cat.category_id ?? "uncategorized"} className="border-t hover:bg-[hsl(var(--muted))]">
                          <td className="px-4 py-2.5">
                            <span className="flex items-center gap-2">
                              <span className="w-2.5 h-2.5 rounded-full shrink-0"
                                style={{ backgroundColor: cat.category_color }} />
                              {cat.category_name}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono">
                            {formatCurrency(cat.total_cents)}
                          </td>
                          {rangeMode === "month" && <><td className="px-4 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                            {prev > 0 ? formatCurrency(prev) : "—"}
                          </td>
                          <td className={`px-4 py-2.5 text-right font-medium
                            ${pct > 10 ? "text-[hsl(var(--error))]" : pct < -10 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--muted-foreground))]"}`}>
                            {prev > 0 ? `${pct > 0 ? "+" : ""}${pct}%` : "—"}
                          </td></>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </details>
            </div>
          </section>

          {/* ── MONTHLY TOTALS ── */}
          {monthTotals.length > 0 && (
            <section>
              <details className="workspace-disclosure report-table">
                <summary>Monthly figures</summary>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-[hsl(var(--muted-foreground))]">
                      <th className="px-4 py-2.5 font-medium">Month</th>
                      <th className="px-4 py-2.5 font-medium text-right">Income</th>
                      <th className="px-4 py-2.5 font-medium text-right">Expenses</th>
                      <th className="px-4 py-2.5 font-medium text-right">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthTotals.map((r) => (
                      <tr key={r.month} className="border-t hover:bg-[hsl(var(--muted))]">
                        <td className="px-4 py-2.5 font-medium">{formatMonthLabel(r.month)}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-[hsl(var(--success))]">
                          {formatCurrency(r.income_cents)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-[hsl(var(--error))]">
                          {formatCurrency(r.expense_cents)}
                        </td>
                        <td className={`px-4 py-2.5 text-right font-mono font-medium
                          ${r.net_cents >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--error))]"}`}>
                          {formatCurrency(r.net_cents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </section>
          )}

          {/* ── BALANCE OVER TIME ── */}
          {balanceTrend.length > 1 && (
            <section>
              <h2 className="font-semibold mb-1">Checking &amp; credit balance</h2>
              <p className="text-xs text-[hsl(var(--muted-foreground))] mb-4">Latest recorded balance per month · through the selected end date</p>
              <div>
                <ResponsiveContainer width="100%" height={180}>
                  <AreaChart data={balanceTrend} margin={{ top: 4, right: 16, bottom: 4, left: 16 }}>
                    <defs>
                      <linearGradient id="balTrendGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.2} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} tickFormatter={formatMonthLabel} />
                    <YAxis
                      tickFormatter={formatAxisCurrency}
                      tick={{ fontSize: 11 }}
                      width={50}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--background))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                        fontSize: "12px",
                      }}
                      labelFormatter={(l) => formatMonthLabel(String(l))}
                      formatter={(v) => [formatCurrency(Number(v)), "Balance"]}
                    />
                    <Area type="monotone" dataKey="balance" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#balTrendGrad)" dot={{ r: 3 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}

          {/* ── TOP EXPENSES ── */}
          {topExpenses.length > 0 && (
            <section>
              <h2 className="font-semibold mb-3">Largest expenses · selected period</h2>
              <div className="divide-y divide-[hsl(var(--border))]">
                {topExpenses.map((transaction) => <button key={transaction.id} onClick={() => setSelectedTransaction(transaction)} className="flex items-center gap-3 py-3 w-full text-left hover:bg-[hsl(var(--muted))]">
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{transaction.description}</span><span className="text-xs text-[hsl(var(--muted-foreground))]">{formatDate(transaction.date)} · {transaction.category_name ?? "Uncategorized"}</span></span>
                  <span className="text-sm font-semibold shrink-0">{formatCurrency(Math.abs(transaction.amount_cents))}</span><ChevronRight size={15} className="shrink-0" />
                </button>)}
              </div>
            </section>
          )}

          {/* ── MOST RECURRING ── */}
          {recurring.length > 0 && (
            <details className="workspace-disclosure">
              <summary>Frequent payees · all time</summary>
              <div className="report-table">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-[hsl(var(--muted-foreground))]">
                      <th className="px-4 py-2.5 font-medium">Payee</th>
                      <th className="px-4 py-2.5 font-medium text-right">Times</th>
                      <th className="px-4 py-2.5 font-medium text-right">Avg</th>
                      <th className="px-4 py-2.5 font-medium text-right">Total Paid</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recurring.map((r) => (
                      <tr key={r.description} className="border-t hover:bg-[hsl(var(--muted))]">
                        <td className="px-4 py-2.5">
                          <span className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: r.category_color ?? "hsl(var(--neutral))" }} />
                            <span className="truncate max-w-xs">{r.description}</span>
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right">{r.count}×</td>
                        <td className="px-4 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                          {formatCurrency(r.avg_cents)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono">
                          {formatCurrency(r.total_cents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          {/* ── GHOST SUBSCRIPTIONS ── */}
          {subscriptions.length > 0 && (
            <details className="workspace-disclosure">
              <summary><Repeat2 size={14} className="inline mr-2" />Detected subscriptions · recent history</summary>
              <div className="space-y-3">
                {subscriptions.map((s) => {
                  const yearly = s.amount_cents * 12;
                  return (
                    <div key={`${s.description}-${s.amount_cents}-${s.last_seen}`}
                      className="border rounded-xl p-4 flex items-center justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <p className="font-medium truncate">{s.description}</p>
                          <span className="text-xs px-2 py-0.5 rounded-full text-white shrink-0"
                            style={{ backgroundColor: s.category_color ?? "#9ca3af" }}>
                            {s.category_name ?? "Uncategorized"}
                          </span>
                        </div>
                        <p className="text-xs text-[hsl(var(--muted-foreground))]">
                          {s.patternLabel} · {s.month_count} months running · First: {s.first_seen} · Last: {s.last_seen}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-semibold text-[hsl(var(--error))]">
                          {formatCurrency(Math.abs(s.amount_cents))}/mo
                        </p>
                        <p className="text-xs text-[hsl(var(--muted-foreground))]">
                          ≈ {formatCurrency(Math.abs(yearly))}/yr
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </details>
          )}
        </>
      )}
      {selectedTransaction && <TransactionDetailModal transaction={selectedTransaction} onClose={() => setSelectedTransaction(null)} />}
    </div>
  );
}

