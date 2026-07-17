import { useState, useEffect } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";
import { Ghost } from "lucide-react";
import { getDb } from "@/lib/db";
import { formatCurrency, formatDate, combineAccountBalances } from "@/lib/utils";
import type { Transaction } from "@/lib/types";
import { useAutoMonth } from "@/hooks/useAutoMonth";
import { useProfileStore } from "@/stores/profileStore";
import { Skeleton } from "@/components/Skeleton";

interface BalanceTrendPoint {
  month: string;
  balance: number;
}

interface CatRow {
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

interface Subscription {
  description: string;
  amount_cents: number;
  month_count: number;
  first_seen: string;
  last_seen: string;
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
  const [month, setMonth] = useAutoMonth();
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
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [balanceTrend, setBalanceTrend] = useState<BalanceTrendPoint[]>([]);

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
      setLoading(true);
      const db = await getDb();
      const [start, end] = effectiveRange();
      const [prevStart, prevEnd] = rangeMode === "month"
        ? monthBounds(prevYM(month))
        : [start, start]; // custom mode: no "prev" comparison (same range = 0% change)

      // Start date for totals chart — use selected range
      const chartStart = rangeMode === "custom" ? customStart : (() => {
        const d6 = new Date();
        d6.setMonth(d6.getMonth() - 5);
        d6.setDate(1);
        return d6.toISOString().split("T")[0];
      })();

      const [thisMonthCats, prevMonthCats, totals, top, rec, subs, balTrend] = await Promise.all([
        db.select<CatRow[]>(
          `SELECT c.name as category_name, c.color as category_color,
                  SUM(ABS(t.amount_cents)) as total_cents
           FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
           WHERE t.date>=? AND t.date<? AND t.amount_cents<0 AND t.profile_id=?
             AND (t.category_id IS NULL OR t.category_id != 20)
           GROUP BY t.category_id ORDER BY total_cents DESC`,
          [start, end, profileId]
        ),
        db.select<CatRow[]>(
          `SELECT c.name as category_name, c.color as category_color,
                  SUM(ABS(t.amount_cents)) as total_cents
           FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
           WHERE t.date>=? AND t.date<? AND t.amount_cents<0 AND t.profile_id=?
             AND (t.category_id IS NULL OR t.category_id != 20)
           GROUP BY t.category_id ORDER BY total_cents DESC`,
          [prevStart, prevEnd, profileId]
        ),
        db.select<{ month: string; income_cents: number; expense_cents: number }[]>(
          `SELECT strftime('%Y-%m', t.date) as month,
                  SUM(CASE WHEN t.amount_cents>0 AND (t.category_id IS NULL OR t.category_id!=20) AND a.account_type NOT IN ('credit','loan') THEN t.amount_cents ELSE 0 END) as income_cents,
                  SUM(CASE WHEN t.amount_cents<0 AND (t.category_id IS NULL OR t.category_id!=20) THEN ABS(t.amount_cents) ELSE 0 END) as expense_cents
           FROM transactions t JOIN accounts a ON a.id=t.account_id
           WHERE t.date>=? AND t.date<? AND t.profile_id=? GROUP BY month ORDER BY month`,
          [chartStart, end, profileId]
        ),
        db.select<Transaction[]>(
          `SELECT t.*, c.name as category_name, c.color as category_color
           FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
           WHERE t.date>=? AND t.date<? AND t.amount_cents<0 AND t.profile_id=?
             AND (t.category_id IS NULL OR t.category_id != 20)
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
             AND (t.category_id IS NULL OR t.category_id != 20)
           GROUP BY t.description HAVING count>=2
           ORDER BY count DESC, total_cents DESC LIMIT 10`,
          [profileId]
        ),
        db.select<Subscription[]>(
          `SELECT t.description, t.amount_cents,
                  COUNT(DISTINCT strftime('%Y-%m', t.date)) as month_count,
                  MIN(t.date) as first_seen, MAX(t.date) as last_seen,
                  c.name as category_name, c.color as category_color
           FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
           WHERE t.amount_cents<0 AND t.profile_id=?
             AND (t.category_id IS NULL OR t.category_id != 20)
           GROUP BY t.description, t.amount_cents
           HAVING month_count>=2
           ORDER BY month_count DESC, ABS(t.amount_cents) DESC`,
          [profileId]
        ),
        db.select<{ date: string; account_id: number; balance_cents: number }[]>(
          `SELECT t.date, t.account_id, t.balance_cents FROM transactions t
           JOIN accounts a ON a.id=t.account_id
           WHERE t.profile_id=? AND t.balance_cents IS NOT NULL AND a.account_type IN ('checking','credit')
           ORDER BY t.date ASC, t.id ASC`,
          [profileId]
        ),
      ]);

      if (cancelled) return;
      setCatThis(thisMonthCats);
      setCatPrev(prevMonthCats);
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
          .map(([month, balance_cents]) => ({ month, balance: balance_cents / 100 }))
      );
      setLoading(false);
    }
    load().catch(console.error);
    return () => { cancelled = true; };
  }, [month, rangeMode, customStart, customEnd, profileId]);

  const prevMap = new Map(catPrev.map((r) => [r.category_name, r.total_cents]));
  const hasData = catThis.length > 0 || topExpenses.length > 0;

  return (
    <div className="p-8 space-y-8 max-w-4xl mx-auto w-full">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Reports</h1>
          {/* Mode toggle */}
          <div className="flex rounded-lg border overflow-hidden text-sm">
            <button
              onClick={() => setRangeMode("month")}
              className={`px-3 py-1.5 transition-colors ${rangeMode === "month" ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]" : "hover:bg-[hsl(var(--muted))]"}`}
            >Month</button>
            <button
              onClick={() => setRangeMode("custom")}
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
              <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)}
                className="border rounded-lg px-3 py-1.5 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]" />
              <span className="text-[hsl(var(--muted-foreground))] text-sm">to</span>
              <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)}
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

      {loading && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
          </div>
          <Skeleton className="h-64 rounded-xl" />
        </div>
      )}

      {!loading && !hasData && (
        <p className="text-[hsl(var(--muted-foreground))] text-center py-16">
          No data for this period. Import a bank statement to generate reports.
        </p>
      )}

      {!loading && hasData && (
        <>
          {/* ── CATEGORY BREAKDOWN ── */}
          <section>
            <h2 className="font-semibold mb-3">Spending by Category</h2>
            <div className="border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-[hsl(var(--muted-foreground))]">
                    <th className="px-4 py-2.5 font-medium">Category</th>
                    <th className="px-4 py-2.5 font-medium text-right">{rangeMode === "custom" ? "Selected Period" : "This Month"}</th>
                    <th className="px-4 py-2.5 font-medium text-right">{rangeMode === "custom" ? "" : "Last Month"}</th>
                    <th className="px-4 py-2.5 font-medium text-right">{rangeMode === "custom" ? "" : "Change"}</th>
                  </tr>
                </thead>
                <tbody>
                  {catThis.map((cat) => {
                    const prev = prevMap.get(cat.category_name) ?? 0;
                    const pct = changePct(cat.total_cents, prev);
                    return (
                      <tr key={cat.category_name} className="border-t hover:bg-[hsl(var(--muted))]">
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
                        <td className="px-4 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                          {prev > 0 ? formatCurrency(prev) : "—"}
                        </td>
                        <td className={`px-4 py-2.5 text-right font-medium
                          ${pct > 10 ? "text-red-500" : pct < -10 ? "text-green-600" : "text-[hsl(var(--muted-foreground))]"}`}>
                          {prev > 0 ? `${pct > 0 ? "+" : ""}${pct}%` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── MONTHLY TOTALS ── */}
          {monthTotals.length > 0 && (
            <section>
              <h2 className="font-semibold mb-3">Month over Month</h2>
              <div className="border rounded-xl overflow-hidden">
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
                        <td className="px-4 py-2.5 font-medium">{r.month}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-green-600">
                          {formatCurrency(r.income_cents)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-red-500">
                          {formatCurrency(r.expense_cents)}
                        </td>
                        <td className={`px-4 py-2.5 text-right font-mono font-medium
                          ${r.net_cents >= 0 ? "text-green-600" : "text-red-500"}`}>
                          {formatCurrency(r.net_cents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ── BALANCE OVER TIME ── */}
          {balanceTrend.length > 1 && (
            <section>
              <h2 className="font-semibold mb-3">Balance Over Time</h2>
              <div className="border rounded-xl p-5">
                <ResponsiveContainer width="100%" height={180}>
                  <AreaChart data={balanceTrend} margin={{ top: 4, right: 16, bottom: 4, left: 16 }}>
                    <defs>
                      <linearGradient id="balTrendGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.2} />
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis
                      tickFormatter={(v) => `$${Math.round(v / 1000)}k`}
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
                      formatter={(v) => [`$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}`, "Balance"]}
                    />
                    <Area type="monotone" dataKey="balance" stroke="#3b82f6" strokeWidth={2} fill="url(#balTrendGrad)" dot={{ r: 3 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}

          {/* ── TOP EXPENSES ── */}
          {topExpenses.length > 0 && (
            <section>
              <h2 className="font-semibold mb-3">Top Expenses This Month</h2>
              <div className="border rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <tbody>
                    {topExpenses.map((t, i) => (
                      <tr key={t.id} className="border-b last:border-0 hover:bg-[hsl(var(--muted))]">
                        <td className="px-4 py-3 text-[hsl(var(--muted-foreground))] w-8 text-right">
                          {i + 1}
                        </td>
                        <td className="px-4 py-3 text-[hsl(var(--muted-foreground))] whitespace-nowrap w-28">
                          {formatDate(t.date)}
                        </td>
                        <td className="px-4 py-3 truncate max-w-xs">{t.description}</td>
                        <td className="px-4 py-3">
                          <span className="inline-block px-2 py-0.5 rounded-full text-xs text-white"
                            style={{ backgroundColor: t.category_color ?? "hsl(var(--neutral))" }}>
                            {t.category_name ?? "Uncategorized"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-red-500">
                          {formatCurrency(Math.abs(t.amount_cents))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ── MOST RECURRING ── */}
          {recurring.length > 0 && (
            <section>
              <h2 className="font-semibold mb-3">Most Recurring Payees</h2>
              <div className="border rounded-xl overflow-hidden">
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
            </section>
          )}

          {/* ── GHOST SUBSCRIPTIONS ── */}
          {subscriptions.length > 0 && (
            <section>
              <h2 className="font-semibold mb-1 flex items-center gap-1.5"><Ghost size={16} className="text-[hsl(var(--muted-foreground))]" /> Ghost Subscriptions</h2>
              <p className="text-sm text-[hsl(var(--muted-foreground))] mb-3">
                Transactions with the exact same amount appearing in multiple months — likely recurring subscriptions.
              </p>
              <div className="space-y-3">
                {subscriptions.map((s) => {
                  const yearly = s.amount_cents * 12;
                  return (
                    <div key={`${s.description}-${s.amount_cents}`}
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
                          Seen {s.month_count} months · First: {s.first_seen} · Last: {s.last_seen}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-semibold text-red-500">
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
            </section>
          )}
        </>
      )}
    </div>
  );
}

