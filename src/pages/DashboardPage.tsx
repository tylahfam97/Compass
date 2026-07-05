import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell,
} from "recharts";
import { getDb } from "@/lib/db";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Transaction } from "@/lib/types";
import { useAutoMonth } from "@/hooks/useAutoMonth";
interface MonthStats {
  income: number;
  expenses: number;
  net: number;
}

interface CatStat {
  name: string;
  color: string;
  total: number;
}

function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const end = new Date(y, m, 1).toISOString().split("T")[0];
  return [start, end];
}

export default function DashboardPage() {
  const [month, setMonth] = useAutoMonth();
  const [stats, setStats] = useState<MonthStats>({ income: 0, expenses: 0, net: 0 });
  const [cats, setCats] = useState<CatStat[]>([]);
  const [recent, setRecent] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [monthTxnCount, setMonthTxnCount] = useState(0);
  const [totalTxnCount, setTotalTxnCount] = useState(0);
  const [confirmClear, setConfirmClear] = useState<"month" | "all" | null>(null);

  const navMonth = (dir: -1 | 1) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + dir, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    const db = await getDb();
    const [start, end] = monthBounds(month);
    const [incRow, expRow, catRows, recentRows, monthCountRow, totalCountRow] = await Promise.all([
      db.select<{ total: number }[]>(
        "SELECT COALESCE(SUM(amount_cents),0) as total FROM transactions WHERE date>=? AND date<? AND amount_cents>0",
        [start, end]
      ),
      db.select<{ total: number }[]>(
        "SELECT COALESCE(SUM(amount_cents),0) as total FROM transactions WHERE date>=? AND date<? AND amount_cents<0",
        [start, end]
      ),
      db.select<{ name: string; color: string; total: number }[]>(
        `SELECT c.name, c.color, SUM(t.amount_cents) as total
         FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
         WHERE t.date>=? AND t.date<? AND t.amount_cents<0
         GROUP BY t.category_id ORDER BY total ASC LIMIT 7`,
        [start, end]
      ),
      db.select<Transaction[]>(
        `SELECT t.*, c.name as category_name, c.color as category_color
         FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
         ORDER BY t.date DESC, t.id DESC LIMIT 10`
      ),
      db.select<{ n: number }[]>(
        "SELECT COUNT(*) as n FROM transactions WHERE date>=? AND date<?",
        [start, end]
      ),
      db.select<{ n: number }[]>("SELECT COUNT(*) as n FROM transactions"),
    ]);
    const inc = incRow[0]?.total ?? 0;
    const exp = expRow[0]?.total ?? 0;
    setStats({ income: inc, expenses: exp, net: inc + exp });
    setCats(catRows.map((r) => ({ ...r, total: Math.abs(r.total) })));
    setRecent(recentRows);
    setMonthTxnCount(monthCountRow[0]?.n ?? 0);
    setTotalTxnCount(totalCountRow[0]?.n ?? 0);
    setLoading(false);
  }, [month]);

  const handleClear = async (scope: "month" | "all") => {
    const db = await getDb();
    if (scope === "month") {
      const [start, end] = monthBounds(month);
      await db.execute("DELETE FROM transactions WHERE date>=? AND date<?", [start, end]);
    } else {
      await db.execute("DELETE FROM transactions");
    }
    setConfirmClear(null);
    loadData().catch(console.error);
  };

  useEffect(() => {
    loadData().catch(console.error);
  }, [loadData]);

  const hasData = stats.income !== 0 || stats.expenses !== 0;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <div className="flex items-center gap-1">
          <button
            onClick={() => navMonth(-1)}
            aria-label="Previous month"
            className="p-1.5 border rounded-lg text-base leading-none hover:bg-[hsl(var(--muted))]
                       transition-colors"
          >
            ‹
          </button>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm bg-[hsl(var(--background))]
                       text-[hsl(var(--foreground))]"
          />
          <button
            onClick={() => navMonth(1)}
            aria-label="Next month"
            className="p-1.5 border rounded-lg text-base leading-none hover:bg-[hsl(var(--muted))]
                       transition-colors"
          >
            ›
          </button>
        </div>
      </div>

      {loading && (
        <p className="text-[hsl(var(--muted-foreground))]">Loading…</p>
      )}

      {!loading && !hasData && (
        <div className="border-2 border-dashed rounded-xl p-16 text-center">
          <p className="font-medium mb-2">No transactions for this month</p>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mb-6">
            Import a bank statement to get started.
          </p>
          <Link
            to="/import"
            className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                       rounded-lg text-sm font-medium"
          >
            Import Transactions
          </Link>
        </div>
      )}

      {!loading && hasData && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: "Income", value: stats.income, cls: "text-green-600" },
              { label: "Expenses", value: Math.abs(stats.expenses), cls: "text-red-500" },
              { label: "Net", value: stats.net, cls: stats.net >= 0 ? "text-green-600" : "text-red-500" },
            ].map(({ label, value, cls }) => (
              <div key={label} className="border rounded-xl p-5">
                <p className="text-sm text-[hsl(var(--muted-foreground))] mb-1">{label}</p>
                <p className={`text-2xl font-bold ${cls}`}>{formatCurrency(value)}</p>
              </div>
            ))}
          </div>

          {/* Top categories */}
          {cats.length > 0 && (
            <div className="border rounded-xl p-5">
              <h2 className="font-semibold mb-4">Top Spending Categories</h2>
              <ResponsiveContainer width="100%" height={cats.length * 36 + 20}>
                <BarChart
                  layout="vertical"
                  data={cats}
                  margin={{ left: 8, right: 32, top: 0, bottom: 0 }}
                >
                  <XAxis
                    type="number"
                    tickFormatter={(v) => `$${Math.round(v / 100)}`}
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fontSize: 12 }}
                    width={110}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--background))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "8px",
                      fontSize: "12px",
                    }}
                    labelStyle={{ color: "hsl(var(--foreground))" }}
                    itemStyle={{ color: "hsl(var(--foreground))" }}
                    formatter={(v) => formatCurrency(v as number)}
                  />
                  <Bar dataKey="total" radius={[0, 4, 4, 0]}>
                    {cats.map((c, i) => (
                      <Cell key={i} fill={c.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Recent transactions */}
          {recent.length > 0 && (
            <div className="border rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b bg-[hsl(var(--muted))] flex items-center justify-between">
                <h2 className="font-semibold">Recent Transactions</h2>
                <Link to="/transactions" className="text-sm text-[hsl(var(--primary))]">
                  View all →
                </Link>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {recent.map((t) => (
                    <tr key={t.id} className="border-b last:border-0 hover:bg-[hsl(var(--muted))]">
                      <td className="px-5 py-3 text-[hsl(var(--muted-foreground))] whitespace-nowrap w-28">
                        {formatDate(t.date)}
                      </td>
                      <td className="px-5 py-3 max-w-xs truncate">{t.description}</td>
                      <td className="px-5 py-3">
                        <span
                          className="inline-block px-2 py-0.5 rounded-full text-xs text-white"
                          style={{ backgroundColor: t.category_color ?? "#9ca3af" }}
                        >
                          {t.category_name ?? "Uncategorized"}
                        </span>
                      </td>
                      <td
                        className={`px-5 py-3 text-right font-mono ${t.amount_cents < 0 ? "text-red-500" : "text-green-600"}`}
                      >
                        {formatCurrency(t.amount_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── MANAGE DATA — only shown when there is something to clear ── */}
      {(monthTxnCount > 0 || totalTxnCount > 0) && (
        <div className="border rounded-xl p-4">
          <p className="text-sm font-medium text-[hsl(var(--muted-foreground))] mb-3">Manage Data</p>
          {confirmClear === null ? (
            <div className="flex gap-4 text-sm flex-wrap">
              {monthTxnCount > 0 && (
                <button
                  onClick={() => setConfirmClear("month")}
                  className="text-[hsl(var(--muted-foreground))] hover:text-red-500 transition-colors"
                >
                  Clear {month}
                </button>
              )}
              {monthTxnCount > 0 && totalTxnCount > 0 && (
                <span className="text-[hsl(var(--border))]">|</span>
              )}
              {totalTxnCount > 0 && (
                <button
                  onClick={() => setConfirmClear("all")}
                  className="text-[hsl(var(--muted-foreground))] hover:text-red-500 transition-colors"
                >
                  Clear all transactions
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3 flex-wrap">
              <p className="text-sm text-red-500">
                {confirmClear === "month"
                  ? `Delete all transactions for ${month}? This cannot be undone.`
                  : "Delete ALL transactions? This cannot be undone."}
              </p>
              <button
                onClick={() => handleClear(confirmClear)}
                className="px-3 py-1 bg-red-500 text-white rounded-lg text-sm font-medium
                           hover:bg-red-600 transition-colors"
              >
                Yes, delete
              </button>
              <button
                onClick={() => setConfirmClear(null)}
                className="text-sm text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]
                           transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

