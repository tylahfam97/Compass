import { useState, useEffect, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Cell, AreaChart, Area, Rectangle,
} from "recharts";
import { motion, AnimatePresence } from "motion/react";
import { TrendingUp, TrendingDown, EyeOff, Eye, Landmark, Plus } from "lucide-react";
import {
  getDb, recomputeCalculatedBalances, setAccountHiddenFromDashboard,
  getLoanAccountsForProfile, getLoanBalanceHistory, type LoanAccount,
} from "@/lib/db";
import { seedDemoData } from "@/lib/demoData";
import { formatCurrency, formatDate, combineAccountBalances, separateAccountBalances, accountChartColor, lightenHex } from "@/lib/utils";
import type { Transaction, Insight } from "@/lib/types";
import { useAutoMonth } from "@/hooks/useAutoMonth";
import { useProfileStore } from "@/stores/profileStore";
import { generateInsights } from "@/lib/agent";
import InsightCard from "@/components/InsightCard";
import LoanUploaderModal from "@/components/LoanUploaderModal";
import { Skeleton, CardListSkeleton } from "@/components/Skeleton";

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

interface CreditAccountMeta {
  id: number;
  name: string;
  color: string;
}

interface HiddenAccountMeta {
  id: number;
  name: string;
}

interface CreditBalanceRow {
  date: string;
  [accountKey: string]: string | number;
}

interface CheckingBalancePoint {
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
  const [seedingDemo, setSeedingDemo] = useState(false);
  const [hasDemoAccounts, setHasDemoAccounts] = useState(false);
  const [currentBalance, setCurrentBalance] = useState<number | null>(null);
  const [checkingBalancePoints, setCheckingBalancePoints] = useState<CheckingBalancePoint[]>([]);
  const [creditBalanceAccounts, setCreditBalanceAccounts] = useState<CreditAccountMeta[]>([]);
  const [creditBalanceRows, setCreditBalanceRows] = useState<CreditBalanceRow[]>([]);
  const [hiddenAccounts, setHiddenAccounts] = useState<HiddenAccountMeta[]>([]);
  const [hideToast, setHideToast] = useState<HiddenAccountMeta | null>(null);
  const [loans, setLoans] = useState<LoanAccount[]>([]);
  const [loanSeries, setLoanSeries] = useState<Map<number, { date: string; value: number }[]>>(new Map());
  const [loanModal, setLoanModal] = useState<"new" | LoanAccount | null>(null);
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
    const [incRow, expRow, catRows, recentRows, monthCountRow, totalCountRow, balanceRow, balancePointRows, portfolioRow, balanceAcctRows, demoAcctRow, hiddenAcctRows] = await Promise.all([
      db.select<{ total: number }[]>(
        `SELECT COALESCE(SUM(t.amount_cents),0) as total FROM transactions t JOIN accounts a ON a.id=t.account_id
         WHERE t.date>=? AND t.date<? AND t.amount_cents>0 AND (t.category_id IS NULL OR t.category_id!=20) AND a.account_type NOT IN ('credit','loan') AND t.profile_id=?`,
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
         FROM accounts a WHERE a.profile_id=? AND a.account_type IN ('checking','credit') AND a.hidden_from_dashboard=0`,
        [profileId]
      ),
      db.select<{ date: string; account_id: number; balance_cents: number }[]>(
        `SELECT t.date, t.account_id, t.balance_cents FROM transactions t
         JOIN accounts a ON a.id=t.account_id
         WHERE t.profile_id=? AND t.date<? AND t.balance_cents IS NOT NULL AND a.account_type IN ('checking','credit')
           AND a.hidden_from_dashboard=0
         ORDER BY t.date ASC, t.id ASC`,
        [profileId, end]
      ),
      db.select<{ total: number | null }[]>(
        `SELECT SUM(market_value_cents) as total FROM holdings
         WHERE profile_id=? AND as_of_date=(SELECT MAX(as_of_date) FROM holdings WHERE profile_id=?)`,
        [profileId, profileId]
      ),
      db.select<{ id: number; name: string; account_type: string }[]>(
        "SELECT id, name, account_type FROM accounts WHERE profile_id=? AND account_type IN ('checking','credit') AND hidden_from_dashboard=0 ORDER BY account_type, name",
        [profileId]
      ),
      db.select<{ n: number }[]>(
        "SELECT COUNT(*) as n FROM accounts WHERE profile_id=? AND name IN ('Demo Checking','Demo Credit Card')",
        [profileId]
      ),
      db.select<HiddenAccountMeta[]>(
        "SELECT id, name FROM accounts WHERE profile_id=? AND account_type IN ('checking','credit') AND hidden_from_dashboard=1 ORDER BY name",
        [profileId]
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
    const checkingIds = new Set(balanceAcctRows.filter((a) => a.account_type === "checking").map((a) => a.id));
    // Only checking/bank accounts count toward this headline figure - credit card debt and
    // investments are tracked separately (Credit Card Health, Net Worth) rather than blended in.
    const checkingTracked = trackedAccounts.filter((r) => checkingIds.has(r.account_id));
    setCurrentBalance(checkingTracked.length > 0 ? checkingTracked.reduce((s, r) => s + (r.balance_cents ?? 0), 0) : null);
    const creditAccountsMeta = balanceAcctRows
      .filter((a) => a.account_type === "credit")
      .map((a, i) => ({ id: a.id, name: a.name, color: accountChartColor(i) }));
    setCreditBalanceAccounts(creditAccountsMeta);
    // Checking accounts combine into one line (there's usually just one); credit cards stay
    // separate per-account so multiple cards never get silently summed into one number.
    const combinedChecking = combineAccountBalances(balancePointRows.filter((r) => checkingIds.has(r.account_id)));
    setCheckingBalancePoints(
      combinedChecking.filter((r) => r.date >= start).map((r) => ({ date: r.date, balance: r.balance_cents / 100 }))
    );
    const separatedCredit = separateAccountBalances(balancePointRows.filter((r) => !checkingIds.has(r.account_id)));
    setCreditBalanceRows(
      separatedCredit.filter((r) => r.date >= start).map((r) => {
        const row: CreditBalanceRow = { date: r.date };
        for (const acc of creditAccountsMeta) row[String(acc.id)] = (r.byAccount[acc.id] ?? 0) / 100;
        return row;
      })
    );
    setPortfolioValueCents(portfolioRow[0]?.total ?? 0);
    setHasDemoAccounts((demoAcctRow[0]?.n ?? 0) > 0);
    setHiddenAccounts(hiddenAcctRows);
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
      const affectedAccounts = await db.select<{ account_id: number }[]>(
        "SELECT DISTINCT account_id FROM transactions WHERE date>=? AND date<? AND profile_id=?",
        [start, end, profileId]
      );
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
      for (const { account_id } of affectedAccounts) await recomputeCalculatedBalances(account_id);
    } else {
      const affectedAccounts = await db.select<{ account_id: number }[]>(
        "SELECT DISTINCT account_id FROM transactions WHERE profile_id=?",
        [profileId]
      );
      await db.execute("DELETE FROM transactions WHERE profile_id=?", [profileId]);
      await db.execute("DELETE FROM import_sessions WHERE profile_id=?", [profileId]);
      // Every account just lost all its transactions - recompute clears each one's stale
      // balance anchor too, so a future reimport doesn't resurrect the old balance.
      for (const { account_id } of affectedAccounts) await recomputeCalculatedBalances(account_id);
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

  const loadLoans = useCallback(async () => {
    const rows = await getLoanAccountsForProfile(profileId);
    setLoans(rows);
    const histories = await Promise.all(rows.map((l) => getLoanBalanceHistory(l.id)));
    setLoanSeries(new Map(rows.map((l, i) => [l.id, histories[i]])));
  }, [profileId]);

  // Loans aren't tied to month selection either - full history, not just the visible month.
  useEffect(() => {
    loadLoans().catch(console.error);
  }, [loadLoans]);

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

  /** Hides an account's chart/balance from the Dashboard (and net worth) - triggered by
   *  clicking its chart, or the eye-off icon for accounts with too little history to chart. */
  const hideAccount = async (id: number, name: string) => {
    await setAccountHiddenFromDashboard(id, true);
    setHideToast({ id, name });
    await loadData();
  };

  const restoreAccount = async (id: number) => {
    await setAccountHiddenFromDashboard(id, false);
    setHideToast(null);
    await loadData();
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
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
          </div>
          <Skeleton className="h-40 rounded-xl" />
          <CardListSkeleton count={3} />
        </div>
      )}

      {!loading && !hasData && (
        <div className="border-2 border-dashed rounded-xl p-16 text-center">
          <p className="font-medium mb-2">No transactions for this month</p>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mb-6">
            Import a bank statement to get started.
          </p>
          <div className="flex items-center justify-center gap-3">
            <Link
              to="/import"
              className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                         rounded-lg text-sm font-medium"
            >
              Import Transactions
            </Link>
            {!hasDemoAccounts && (
              <button
                data-tour="demo-mode"
                onClick={async () => {
                  setSeedingDemo(true);
                  try {
                    await seedDemoData(profileId);
                    await loadData();
                  } finally {
                    setSeedingDemo(false);
                  }
                }}
                disabled={seedingDemo}
                className="px-5 py-2 border rounded-lg text-sm font-medium hover:bg-[hsl(var(--muted))]
                           transition-colors disabled:opacity-50"
              >
                {seedingDemo ? "Loading demo data…" : "✦ Try Demo Mode"}
              </button>
            )}
          </div>
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

          {/* Account balance card + checking sparkline */}
          {currentBalance != null && (
            <div className="border rounded-xl p-5 flex gap-6 items-center flex-wrap">
              <div className="shrink-0">
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-sm text-[hsl(var(--muted-foreground))]">
                    Checking Balance
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
                    ? `${formatCurrency(currentBalance)} checking${includeInvestments ? ` + ${formatCurrency(portfolioValueCents)} investments` : ""} (excludes credit card debt)`
                    : "Checking/bank accounts only - excludes credit card debt"}
                </p>
              </div>
              {checkingBalancePoints.length > 1 && (
                <div className="flex-1 h-16 min-w-[140px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={checkingBalancePoints} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
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
                        wrapperStyle={{ zIndex: 50 }}
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

          {/* Credit card balances - one compact tile per card (balance + trend + mini-sparkline),
              rather than a shared line chart where multiple near-flat debt lines are hard to
              read and don't convey much at a glance. */}
          {creditBalanceAccounts.length > 0 && creditBalanceRows.length > 0 && (
            <div className="space-y-3">
              <div>
                <h2 className="font-semibold">Credit Cards</h2>
                <p className="text-[10px] text-[hsl(var(--muted-foreground))]">Current balance and this month's trend, per card</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {creditBalanceAccounts.map((acc) => {
                  const series = creditBalanceRows.map((r) => ({ date: r.date, value: Number(r[String(acc.id)] ?? 0) }));
                  const last = series.length > 0 ? series[series.length - 1].value : 0;
                  const first = series.length > 0 ? series[0].value : 0;
                  const changeCents = Math.round((last - first) * 100);
                  // Balances are stored negative (a liability) - a LESS negative balance means
                  // the card was paid down (improved), a MORE negative one means debt grew.
                  const improved = changeCents > 0;
                  const lastCents = Math.round(last * 100);
                  return (
                    <div key={acc.id} className="border rounded-xl p-4">
                      <div className="flex items-center justify-between mb-1 gap-2">
                        <span className="text-sm font-medium flex items-center gap-1.5 min-w-0">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: acc.color }} />
                          <span className="truncate">{acc.name}</span>
                        </span>
                        <span className="flex items-center gap-2 shrink-0">
                          {series.length > 1 && Math.abs(changeCents) >= 100 && (
                            <span className={`text-xs font-semibold flex items-center gap-0.5 ${improved ? "text-green-600" : "text-red-500"}`}>
                              {improved ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                              {formatCurrency(Math.abs(changeCents))}
                            </span>
                          )}
                          <button
                            onClick={() => hideAccount(acc.id, acc.name)}
                            title="Hide from dashboard"
                            className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
                          >
                            <EyeOff size={13} />
                          </button>
                        </span>
                      </div>
                      <p className={`text-xl font-bold mb-2 ${lastCents < 0 ? "text-red-500" : "text-green-600"}`}>
                        {formatCurrency(lastCents)}
                      </p>
                      {series.length > 1 && (
                        <div
                          className="h-10 -mx-1 cursor-pointer"
                          title="Click to hide this card from the dashboard"
                          onClick={() => hideAccount(acc.id, acc.name)}
                        >
                          <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={series} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
                              <defs>
                                <linearGradient id={`credit-grad-${acc.id}`} x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%" stopColor={acc.color} stopOpacity={0.3} />
                                  <stop offset="95%" stopColor={acc.color} stopOpacity={0} />
                                </linearGradient>
                              </defs>
                              <Tooltip
                                contentStyle={{ backgroundColor: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: "6px", fontSize: "11px" }}
                                wrapperStyle={{ zIndex: 50 }}
                                formatter={(v) => [formatCurrency(Math.round(Number(v) * 100)), acc.name]}
                                labelFormatter={(l) => formatDate(String(l))}
                              />
                              <Area type="monotone" dataKey="value" stroke={acc.color} strokeWidth={1.5} fill={`url(#credit-grad-${acc.id})`} dot={false} />
                            </AreaChart>
                          </ResponsiveContainer>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {hiddenAccounts.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap text-xs text-[hsl(var(--muted-foreground))]">
                  <span>Hidden from dashboard:</span>
                  {hiddenAccounts.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => restoreAccount(a.id)}
                      title="Show on dashboard again"
                      className="flex items-center gap-1 px-2 py-1 border rounded-lg hover:bg-[hsl(var(--muted))] transition-colors"
                    >
                      <Eye size={11} /> {a.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Loans - same per-account tile pattern as Credit Cards, but never counted toward
              liquidity/income/expenses; balance history comes from statement uploads instead
              of imported transactions. Always shown (even with zero loans) so "Add Loan" stays
              discoverable. */}
          <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="font-semibold flex items-center gap-1.5"><Landmark size={15} /> Loans</h2>
                  <p className="text-[10px] text-[hsl(var(--muted-foreground))]">Not counted toward liquidity or income/expenses</p>
                </div>
                <button
                  onClick={() => setLoanModal("new")}
                  className="flex items-center gap-1 text-xs px-2.5 py-1.5 border rounded-lg hover:bg-[hsl(var(--muted))] transition-colors shrink-0"
                >
                  <Plus size={13} /> Add Loan
                </button>
              </div>
              {loans.length === 0 ? (
                <p className="text-sm text-[hsl(var(--muted-foreground))] italic border rounded-xl p-5 text-center">
                  No loans added yet - car loans, student loans, mortgages, or personal loans.
                </p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {loans.map((loan, i) => {
                    const series = loanSeries.get(loan.id) ?? [];
                    const last = series.length > 0 ? series[series.length - 1].value : (loan.balance_cents ?? 0) / 100;
                    const first = series.length > 0 ? series[0].value : last;
                    const changeCents = Math.round((last - first) * 100);
                    const improved = changeCents > 0; // less negative balance = paid down
                    const lastCents = Math.round(last * 100);
                    const color = accountChartColor(i);
                    return (
                      <div key={loan.id} className="border rounded-xl p-4">
                        <div className="flex items-center justify-between mb-1 gap-2">
                          <span className="text-sm font-medium flex items-center gap-1.5 min-w-0">
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
                            <span className="truncate">{loan.name}</span>
                          </span>
                          <span className="flex items-center gap-2 shrink-0">
                            {series.length > 1 && Math.abs(changeCents) >= 100 && (
                              <span className={`text-xs font-semibold flex items-center gap-0.5 ${improved ? "text-green-600" : "text-red-500"}`}>
                                {improved ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                                {formatCurrency(Math.abs(changeCents))}
                              </span>
                            )}
                            <button
                              onClick={() => setLoanModal(loan)}
                              title="Add a new statement"
                              className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
                            >
                              <Plus size={13} />
                            </button>
                          </span>
                        </div>
                        <p className={`text-xl font-bold mb-1 ${lastCents < 0 ? "text-red-500" : "text-green-600"}`}>
                          {formatCurrency(lastCents)}
                        </p>
                        {(loan.interest_rate_bps != null || loan.minimum_payment_cents != null) && (
                          <p className="text-[11px] text-[hsl(var(--muted-foreground))] mb-2">
                            {loan.interest_rate_bps != null && <>{(loan.interest_rate_bps / 100).toFixed(2)}% APR</>}
                            {loan.interest_rate_bps != null && loan.minimum_payment_cents != null && " · "}
                            {loan.minimum_payment_cents != null && <>{formatCurrency(loan.minimum_payment_cents)} min/mo</>}
                          </p>
                        )}
                        {series.length > 1 && (
                          <div className="h-10 -mx-1">
                            <ResponsiveContainer width="100%" height="100%">
                              <AreaChart data={series} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
                                <defs>
                                  <linearGradient id={`loan-grad-${loan.id}`} x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                                    <stop offset="95%" stopColor={color} stopOpacity={0} />
                                  </linearGradient>
                                </defs>
                                <Tooltip
                                  contentStyle={{ backgroundColor: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: "6px", fontSize: "11px" }}
                                  wrapperStyle={{ zIndex: 50 }}
                                  formatter={(v) => [formatCurrency(Math.round(Number(v) * 100)), loan.name]}
                                  labelFormatter={(l) => formatDate(String(l))}
                                />
                                <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.5} fill={`url(#loan-grad-${loan.id})`} dot={false} />
                              </AreaChart>
                            </ResponsiveContainer>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

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
                          style={{ backgroundColor: t.category_color ?? "hsl(var(--neutral))" }}
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

      {/* Hide-account undo toast - border/rounded live on the inner div, not this
          fixed-positioned one (see CSS specificity note in TransactionsPage). */}
      <AnimatePresence>
        {hideToast && (
          <motion.div
            key="hide-account-toast"
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} transition={{ duration: 0.2 }}
            className="fixed bottom-6 right-6 z-50 max-w-sm"
          >
            <div className="border shadow-xl rounded-xl px-5 py-3 flex items-center gap-4 text-sm bg-[hsl(var(--background))]">
              <span className="flex-1 text-[hsl(var(--foreground))]">
                <strong>{hideToast.name}</strong> hidden from the dashboard.
              </span>
              <button
                onClick={() => restoreAccount(hideToast.id)}
                className="px-3 py-1.5 border rounded-lg font-medium hover:bg-[hsl(var(--muted))] transition-colors shrink-0"
              >
                Undo
              </button>
              <button
                onClick={() => setHideToast(null)}
                className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] text-lg leading-none"
              >
                ✕
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {loanModal && (
        <LoanUploaderModal
          profileId={profileId}
          existingLoan={loanModal === "new" ? undefined : loanModal}
          onClose={() => setLoanModal(null)}
          onSaved={() => loadLoans().catch(console.error)}
        />
      )}
    </div>
  );
}

