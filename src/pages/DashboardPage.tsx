import { useState, useEffect, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell, AreaChart, Area, Rectangle,
} from "recharts";
import { motion, AnimatePresence } from "motion/react";
import { getDb } from "@/lib/db";
import { formatCurrency, formatDate, combineAccountBalances, lightenHex } from "@/lib/utils";
import type { Transaction, Insight } from "@/lib/types";
import { useAutoMonth } from "@/hooks/useAutoMonth";
import { useProfileStore } from "@/stores/profileStore";
import { generateInsights } from "@/lib/agent";
import InsightCard from "@/components/InsightCard";

interface MonthStats {
  income: number;
  expenses: number;
  net: number;
}

interface CatStat {
  categoryId: number | null;
  name: string;
  color: string;
  total: number;
}

interface BalancePoint {
  date: string;
  balance: number;
}

const INCLUDE_INVESTMENTS_KEY = "compass_include_investments";

function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const end = new Date(y, m, 1).toISOString().split("T")[0];
  return [start, end];
}

export default function DashboardPage() {
  const [month, setMonth] = useAutoMonth();
  const navigate = useNavigate();
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const dismissedInsights = useProfileStore((s) => s.dismissedInsights);
  const profileId = activeProfile?.id ?? 1;
  const [stats, setStats] = useState<MonthStats>({ income: 0, expenses: 0, net: 0 });
  const [insights, setInsights] = useState<Insight[]>([]);
  const [cats, setCats] = useState<CatStat[]>([]);
  const [recent, setRecent] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [monthTxnCount, setMonthTxnCount] = useState(0);
  const [totalTxnCount, setTotalTxnCount] = useState(0);
  const [confirmClear, setConfirmClear] = useState<"month" | "all" | null>(null);
  const [currentBalance, setCurrentBalance] = useState<number | null>(null);
  const [balancePoints, setBalancePoints] = useState<BalancePoint[]>([]);
  const [portfolioValueCents, setPortfolioValueCents] = useState(0);
  const [expandedCat, setExpandedCat] = useState<CatStat | null>(null);
  const [expandedCatTxns, setExpandedCatTxns] = useState<Transaction[] | null>(null);
  const [includeInvestments, setIncludeInvestments] = useState(
    () => localStorage.getItem(INCLUDE_INVESTMENTS_KEY) !== "false"
  );

  const toggleIncludeInvestments = () => {
    setIncludeInvestments((prev) => {
      const next = !prev;
      localStorage.setItem(INCLUDE_INVESTMENTS_KEY, String(next));
      return next;
    });
  };

  const navMonth = (dir: -1 | 1) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + dir, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    const db = await getDb();
    const [start, end] = monthBounds(month);
    const [incRow, expRow, catRows, recentRows, monthCountRow, totalCountRow, balanceRow, balancePointRows, portfolioRow] = await Promise.all([
      db.select<{ total: number }[]>(
        "SELECT COALESCE(SUM(amount_cents),0) as total FROM transactions WHERE date>=? AND date<? AND amount_cents>0 AND (category_id IS NULL OR category_id!=20) AND profile_id=?",
        [start, end, profileId]
      ),
      db.select<{ total: number }[]>(
        "SELECT COALESCE(SUM(amount_cents),0) as total FROM transactions WHERE date>=? AND date<? AND amount_cents<0 AND (category_id IS NULL OR category_id!=20) AND profile_id=?",
        [start, end, profileId]
      ),
      db.select<{ categoryId: number | null; name: string; color: string; total: number }[]>(
        `SELECT t.category_id as categoryId, c.name, c.color, SUM(t.amount_cents) as total
         FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
         WHERE t.date>=? AND t.date<? AND t.amount_cents<0 AND t.profile_id=?
           AND (t.category_id IS NULL OR t.category_id != 20)
         GROUP BY t.category_id ORDER BY total ASC LIMIT 7`,
        [start, end, profileId]
      ),
      db.select<Transaction[]>(
        `SELECT t.*, c.name as category_name, c.color as category_color
         FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
         WHERE t.profile_id=?
         ORDER BY t.date DESC, t.id DESC LIMIT 10`,
        [profileId]
      ),
      db.select<{ n: number }[]>(
        "SELECT COUNT(*) as n FROM transactions WHERE date>=? AND date<? AND profile_id=?",
        [start, end, profileId]
      ),
      db.select<{ n: number }[]>("SELECT COUNT(*) as n FROM transactions WHERE profile_id=?", [profileId]),
      db.select<{ account_id: number; balance_cents: number | null }[]>(
        `SELECT a.id as account_id,
           (SELECT t.balance_cents FROM transactions t WHERE t.account_id=a.id AND t.balance_cents IS NOT NULL
            ORDER BY t.date DESC, t.id DESC LIMIT 1) as balance_cents
         FROM accounts a WHERE a.profile_id=? AND a.account_type IN ('checking','credit')`,
        [profileId]
      ),
      db.select<{ date: string; account_id: number; balance_cents: number }[]>(
        `SELECT t.date, t.account_id, t.balance_cents FROM transactions t
         JOIN accounts a ON a.id=t.account_id
         WHERE t.profile_id=? AND t.date<? AND t.balance_cents IS NOT NULL AND a.account_type IN ('checking','credit')
         ORDER BY t.date ASC, t.id ASC`,
        [profileId, end]
      ),
      db.select<{ total: number | null }[]>(
        `SELECT SUM(market_value_cents) as total FROM holdings
         WHERE profile_id=? AND as_of_date=(SELECT MAX(as_of_date) FROM holdings WHERE profile_id=?)`,
        [profileId, profileId]
      ),
    ]);
    const inc = incRow[0]?.total ?? 0;
    const exp = expRow[0]?.total ?? 0;
    setStats({ income: inc, expenses: exp, net: inc + exp });
    setCats(catRows.map((r) => ({ ...r, total: Math.abs(r.total) })));
    setRecent(recentRows);
    setMonthTxnCount(monthCountRow[0]?.n ?? 0);
    setTotalTxnCount(totalCountRow[0]?.n ?? 0);
    const trackedAccounts = balanceRow.filter((r) => r.balance_cents !== null);
    setCurrentBalance(trackedAccounts.length > 0 ? trackedAccounts.reduce((s, r) => s + (r.balance_cents ?? 0), 0) : null);
    const combined = combineAccountBalances(balancePointRows);
    setBalancePoints(combined.filter((r) => r.date >= start).map((r) => ({ date: r.date, balance: r.balance_cents / 100 })));
    setPortfolioValueCents(portfolioRow[0]?.total ?? 0);
    setExpandedCat(null);
    setExpandedCatTxns(null);
    setLoading(false);
  }, [month, profileId]);

  /** Toggles the drill-down panel for a spending category, fetching its top transactions on demand. */
  const toggleCatExpand = async (cat: CatStat) => {
    if (expandedCat && expandedCat.categoryId === cat.categoryId && expandedCat.name === cat.name) {
      setExpandedCat(null);
      setExpandedCatTxns(null);
      return;
    }
    setExpandedCat(cat);
    setExpandedCatTxns(null);
    const db = await getDb();
    const [start, end] = monthBounds(month);
    const catCondition = cat.categoryId === null ? "t.category_id IS NULL" : "t.category_id=?";
    const params = cat.categoryId === null ? [start, end, profileId] : [start, end, profileId, cat.categoryId];
    const rows = await db.select<Transaction[]>(
      `SELECT t.*, c.name as category_name, c.color as category_color
       FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
       WHERE t.date>=? AND t.date<? AND t.profile_id=? AND ${catCondition}
       ORDER BY ABS(t.amount_cents) DESC LIMIT 5`,
      params
    );
    setExpandedCatTxns(rows);
  };

  const handleClear = async (scope: "month" | "all") => {
    const db = await getDb();
    if (scope === "month") {
      const [start, end] = monthBounds(month);
      await db.execute("DELETE FROM transactions WHERE date>=? AND date<? AND profile_id=?", [start, end, profileId]);
      // Remove sessions that no longer have any transactions linked to them
      await db.execute(
        `DELETE FROM import_sessions WHERE profile_id=?
         AND id NOT IN (
           SELECT DISTINCT import_session_id FROM transactions
           WHERE profile_id=? AND import_session_id IS NOT NULL
         )`,
        [profileId, profileId]
      );
    } else {
      await db.execute("DELETE FROM transactions WHERE profile_id=?", [profileId]);
      await db.execute("DELETE FROM import_sessions WHERE profile_id=?", [profileId]);
    }
    setConfirmClear(null);
    loadData().catch(console.error);
  };

  useEffect(() => {
    loadData().catch(console.error);
  }, [loadData]);

  // Load insights separately (not tied to month selection)
  useEffect(() => {
    if (!activeProfile) return;
    generateInsights([profileId]).then(setInsights).catch(console.error);
  }, [profileId, activeProfile]);

  const visibleInsights = insights
    .filter((i) => !dismissedInsights.includes(i.dismissKey))
    .slice(0, 3);

  const handleApplyInsight = async (insight: Insight) => {
    if (!insight.action) return;
    if (insight.action.type === "create_budget") {
      navigate("/budgets", { state: { prefillBudget: insight.action.payload } });
    } else if (insight.action.type === "create_goal") {
      navigate("/goals");
    }
  };

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
          {/* Agent insight cards */}
          {visibleInsights.length > 0 && (
            <div className="space-y-2">
              {visibleInsights.map((insight) => (
                <InsightCard
                  key={insight.id}
                  insight={insight}
                  onApply={handleApplyInsight}
                  compact
                />
              ))}
              <Link
                to="/agent"
                className="block text-xs text-[hsl(var(--primary))] hover:opacity-80 transition-opacity"
              >
                See all Agent insights →
              </Link>
            </div>
          )}

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

          {/* Account balance card + sparkline */}
          {currentBalance != null && (
            <div className="border rounded-xl p-5 flex gap-6 items-center flex-wrap">
              <div className="shrink-0">
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-sm text-[hsl(var(--muted-foreground))]">
                    {portfolioValueCents > 0 && includeInvestments ? "Net Worth" : "Account Balance"}
                  </p>
                  {portfolioValueCents > 0 && (
                    <button
                      onClick={toggleIncludeInvestments}
                      title="Toggle whether investments are included in this figure"
                      className={`text-[10px] px-2 py-0.5 rounded-full border font-medium transition-colors ${
                        includeInvestments
                          ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent"
                          : "hover:bg-[hsl(var(--muted))]"
                      }`}
                    >
                      + Investments
                    </button>
                  )}
                </div>
                <p className={`text-2xl font-bold ${(currentBalance + (includeInvestments ? portfolioValueCents : 0)) >= 0 ? "text-green-600" : "text-red-500"}`}>
                  {formatCurrency(currentBalance + (includeInvestments ? portfolioValueCents : 0))}
                </p>
                <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">
                  {portfolioValueCents > 0
                    ? `${formatCurrency(currentBalance)} cash${includeInvestments ? ` + ${formatCurrency(portfolioValueCents)} investments` : ""}`
                    : "Most recent transaction"}
                </p>
              </div>
              {balancePoints.length > 1 && (
                <div className="flex-1 h-16">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={balancePoints} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                      <defs>
                        <linearGradient id="balGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.2} />
                          <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "hsl(var(--background))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "8px",
                          fontSize: "12px",
                        }}
                        formatter={(v) => [`$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}`, "Balance"]}
                        labelFormatter={(l) => l}
                      />
                      <Area type="monotone" dataKey="balance" stroke="#3b82f6" strokeWidth={2} fill="url(#balGrad)" dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          )}

          {/* Top categories */}
          {cats.length > 0 && (
            <div className="border rounded-xl p-5 chart-clickable">
              <h2 className="font-semibold mb-1">Top Spending Categories</h2>
              <p className="text-[10px] text-[hsl(var(--muted-foreground))] mb-3">Click a bar for details</p>
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
                    cursor={false}
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
                  <Bar
                    dataKey="total"
                    radius={[0, 4, 4, 0]}
                    cursor="pointer"
                    background={false}
                    onClick={(data) => toggleCatExpand(data as unknown as CatStat)}
                    activeBar={(props: unknown) => {
                      const p = props as { payload?: CatStat } & React.SVGProps<SVGPathElement> & Record<string, unknown>;
                      const fill = lightenHex(p.payload?.color ?? "#9ca3af");
                      return <Rectangle {...(p as object)} fill={fill} />;
                    }}
                  >
                    {cats.map((c, i) => (
                      <Cell key={i} fill={c.color} opacity={expandedCat && expandedCat.name !== c.name ? 0.45 : 1} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>

              <AnimatePresence initial={false} mode="wait">
                {expandedCat && (
                  <motion.div
                    key={expandedCat.name}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18 }}
                  >
                    <div className="mt-3 pt-3 border-t">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs font-semibold flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: expandedCat.color }} />
                          {expandedCat.name} - {formatCurrency(expandedCat.total)}
                        </p>
                        <Link
                          to="/transactions"
                          state={{ month, category: expandedCat.categoryId }}
                          className="text-[11px] text-[hsl(var(--primary))] hover:underline"
                        >
                          View all →
                        </Link>
                      </div>
                      {expandedCatTxns === null ? (
                        <p className="text-xs text-[hsl(var(--muted-foreground))] py-2">Loading…</p>
                      ) : (
                        <div className="space-y-1">
                          {expandedCatTxns.map((t) => (
                            <div key={t.id} className="flex items-center justify-between text-xs py-1">
                              <span className="truncate flex-1 text-[hsl(var(--muted-foreground))]">{t.description}</span>
                              <span className="font-mono ml-3 shrink-0">{formatCurrency(Math.abs(t.amount_cents))}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
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

