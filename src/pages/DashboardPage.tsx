import { useState, useEffect, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { XAxis, Tooltip, ResponsiveContainer, AreaChart, Area } from "recharts";
import { motion, AnimatePresence } from "motion/react";
import { PlusIcon } from "@phosphor-icons/react";
import {
  getDb, recomputeCalculatedBalances, setAccountHiddenFromDashboard,
  getLoanAccountsForProfile, getLoanBalanceHistory, type LoanAccount,
} from "@/lib/db";
import { seedDemoData } from "@/lib/demoData";
import { formatCurrency, formatDate, formatMonthLabel, formatMonthLong, combineAccountBalances, separateAccountBalances, accountChartColor } from "@/lib/utils";
import { staggerContainer, riseIn } from "@/lib/motionPresets";
import type { Transaction, Insight } from "@/lib/types";
import { EXCLUSION_DISCLAIMER_TEXT } from "@/lib/types";
import { useAutoMonth } from "@/hooks/useAutoMonth";
import { useIsDark } from "@/hooks/useIsDark";
import { useProfileStore } from "@/stores/profileStore";
import { handleLoadFailure } from "@/stores/toastStore";
import { generateInsights } from "@/lib/agent";
import { latestHoldingPerAccount } from "@/lib/netWorth";
import { incomeSumSql, expenseSumSql } from "@/lib/reportingSql";
import { toISODate, summarizePlanned } from "@/lib/forecast";
import { getPlannedEvents } from "@/lib/forecastData";
import { loadScenario } from "@/lib/planScenario";
import { monthBoundsIso } from "@/lib/bearing";
import { series, chartTooltipStyle, chartTooltipText, chartTooltipWrapper, harmonizeColor } from "@/lib/chartTheme";
import InsightCard from "@/components/InsightCard";
import LoanUploaderModal from "@/components/LoanUploaderModal";
import InfoTooltip from "@/components/InfoTooltip";
import CountUp from "@/components/CountUp";
import TrendChip from "@/components/TrendChip";
import AccountDetailModal, { type AccountDetailAccount } from "@/components/AccountDetailModal";
import { Skeleton, CardListSkeleton } from "@/components/Skeleton";
import StatRow from "@/components/StatRow";
import SectionHeading from "@/components/SectionHeading";
import EmptyState from "@/components/EmptyState";
import MonthPicker from "@/components/MonthPicker";
import AccountRow from "@/components/AccountRow";
import RankedBars from "@/components/RankedBars";
import ActivityRow from "@/components/ActivityRow";
import BearingBar from "@/components/BearingBar";

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
  /** Collapsed on the dashboard and excluded from net worth - toggled per-card, independent
   *  of every other account (see setCreditHidden). */
  hidden: boolean;
  /** Credit cards only (optional, entered on import) - null for bank accounts. */
  interestRateBps: number | null;
  /** Credit cards only (optional, entered on import) - null for bank accounts. */
  minimumPaymentCents: number | null;
  /** The account's true latest known balance, independent of the selected month - the tile's
   *  headline number must never depend on whether the current month happens to have any
   *  activity/statement for this account (see loadData for why). */
  balanceCents: number | null;
  balanceDate: string | null;
}

interface CreditBalanceRow {
  date: string;
  [accountKey: string]: string | number;
}

interface CheckingBalancePoint {
  date: string;
  balance: number;
}

/** Scheduled money still ahead in the selected month, for the bearing bar. */
interface PlannedAhead {
  dueCents: number;
  incomeCents: number;
  billCount: number;
  hasAny: boolean;
}

const INCLUDE_INVESTMENTS_KEY = "compass_include_investments";

function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const end = new Date(y, m, 1).toISOString().split("T")[0];
  return [start, end];
}

function prevMonthOf(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function DashboardPage() {
  const [month, setMonth] = useAutoMonth("dashboard");
  const navigate = useNavigate();
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const dismissedInsights = useProfileStore((s) => s.dismissedInsights);
  const profileId = activeProfile?.id ?? 1;
  const [stats, setStats] = useState<MonthStats>({ income: 0, expenses: 0, net: 0 });
  const [prevStats, setPrevStats] = useState<MonthStats | null>(null);
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
  const [bankAccountsMeta, setBankAccountsMeta] = useState<CreditAccountMeta[]>([]);
  const [bankBalanceRows, setBankBalanceRows] = useState<CreditBalanceRow[]>([]);
  const [creditBalanceAccounts, setCreditBalanceAccounts] = useState<CreditAccountMeta[]>([]);
  const [creditBalanceRows, setCreditBalanceRows] = useState<CreditBalanceRow[]>([]);
  const [loans, setLoans] = useState<LoanAccount[]>([]);
  const [loanSeries, setLoanSeries] = useState<Map<number, { date: string; value: number }[]>>(new Map());
  const [loanModal, setLoanModal] = useState<"new" | LoanAccount | null>(null);
  const [viewAccount, setViewAccount] = useState<AccountDetailAccount | null>(null);
  const [portfolioValueCents, setPortfolioValueCents] = useState(0);
  const [portfolioChange, setPortfolioChange] = useState<{ change: number; periodEnd: string } | null>(null);
  const [expandedCat, setExpandedCat] = useState<CatStat | null>(null);
  const [expandedCatTxns, setExpandedCatTxns] = useState<Transaction[] | null>(null);
  const [includeInvestments, setIncludeInvestments] = useState(
    () => localStorage.getItem(INCLUDE_INVESTMENTS_KEY) !== "false"
  );
  const [planned, setPlanned] = useState<PlannedAhead>({ dueCents: 0, incomeCents: 0, billCount: 0, hasAny: false });
  const isDark = useIsDark();
  const mode = isDark ? "dark" : "light";

  const toggleIncludeInvestments = () => {
    setIncludeInvestments((prev) => {
      const next = !prev;
      localStorage.setItem(INCLUDE_INVESTMENTS_KEY, String(next));
      return next;
    });
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    const db = await getDb();
    const [start, end] = monthBounds(month);
    const [prevStart, prevEnd] = monthBounds(prevMonthOf(month));
    const [incRow, expRow, catRows, recentRows, monthCountRow, totalCountRow, balanceRow, balancePointRows, portfolioRow, portfolioChangeRow, balanceAcctRows, demoAcctRow, prevIncRow, prevExpRow] = await Promise.all([
      db.select<{ total: number }[]>(
        `SELECT ${incomeSumSql()} as total FROM transactions t JOIN accounts a ON a.id=t.account_id
         WHERE t.date>=? AND t.date<? AND t.profile_id=?`,
        [start, end, profileId]
      ),
      db.select<{ total: number }[]>(
        `SELECT -${expenseSumSql()} as total FROM transactions t JOIN accounts a ON a.id=t.account_id
         WHERE t.date>=? AND t.date<? AND t.profile_id=?`,
        [start, end, profileId]
      ),
      db.select<{ categoryId: number | null; name: string; color: string; total: number }[]>(
        `SELECT t.category_id as categoryId, c.name, c.color,
                SUM(CASE WHEN t.amount_cents>0 AND a.account_type IN ('credit','loan') THEN 0 ELSE t.amount_cents END) as total
         FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
         JOIN accounts a ON a.id=t.account_id
         WHERE t.date>=? AND t.date<? AND t.profile_id=?
           AND (t.category_id IS NULL OR t.category_id NOT IN (20,29))
         GROUP BY t.category_id ORDER BY total ASC LIMIT 7`,
        [start, end, profileId]
      ),
      db.select<Transaction[]>(
        `SELECT t.*, c.name as category_name, c.color as category_color, a.name as account_name
         FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
         JOIN accounts a ON a.id=t.account_id
         WHERE t.profile_id=?
         ORDER BY t.date DESC, t.id DESC LIMIT 10`,
        [profileId]
      ),
      db.select<{ n: number }[]>(
        "SELECT COUNT(*) as n FROM transactions WHERE date>=? AND date<? AND profile_id=?",
        [start, end, profileId]
      ),
      db.select<{ n: number }[]>("SELECT COUNT(*) as n FROM transactions WHERE profile_id=?", [profileId]),
      db.select<{ account_id: number; balance_cents: number | null; balance_date: string | null }[]>(
        `SELECT a.id as account_id,
           (SELECT t.balance_cents FROM transactions t WHERE t.account_id=a.id AND t.balance_cents IS NOT NULL
            ORDER BY t.date DESC, t.id DESC LIMIT 1) as balance_cents,
           (SELECT t.date FROM transactions t WHERE t.account_id=a.id AND t.balance_cents IS NOT NULL ORDER BY t.date DESC,t.id DESC LIMIT 1) as balance_date
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
        `SELECT SUM(h.market_value_cents) as total FROM holdings h
         WHERE h.profile_id=? AND ${latestHoldingPerAccount()}`,
        [profileId]
      ),
      db.select<{ change: number | null; period_end: string }[]>(
        `SELECT change_in_value_cents as change, period_end FROM investment_summaries s
         WHERE s.profile_id=? AND s.change_in_value_cents IS NOT NULL
           AND s.period_end = (SELECT MAX(period_end) FROM investment_summaries s2 WHERE s2.profile_id=s.profile_id)
         LIMIT 1`,
        [profileId]
      ),
      db.select<{ id: number; name: string; account_type: string; hidden_from_dashboard: number; interest_rate_bps: number | null; minimum_payment_cents: number | null }[]>(
        "SELECT id, name, account_type, hidden_from_dashboard, interest_rate_bps, minimum_payment_cents FROM accounts WHERE profile_id=? AND account_type IN ('checking','credit') ORDER BY account_type, name",
        [profileId]
      ),
      db.select<{ n: number }[]>(
        "SELECT COUNT(*) as n FROM accounts WHERE profile_id=? AND name IN ('Demo Checking','Demo Credit Card')",
        [profileId]
      ),
      db.select<{ total: number }[]>(
        `SELECT ${incomeSumSql()} as total FROM transactions t JOIN accounts a ON a.id=t.account_id
         WHERE t.date>=? AND t.date<? AND t.profile_id=?`,
        [prevStart, prevEnd, profileId]
      ),
      db.select<{ total: number }[]>(
        `SELECT -${expenseSumSql()} as total FROM transactions t JOIN accounts a ON a.id=t.account_id
         WHERE t.date>=? AND t.date<? AND t.profile_id=?`,
        [prevStart, prevEnd, profileId]
      ),
    ]);
    const inc = incRow[0]?.total ?? 0;
    const exp = expRow[0]?.total ?? 0;
    setStats({ income: inc, expenses: exp, net: inc + exp });
    const prevInc = prevIncRow[0]?.total ?? 0;
    const prevExp = prevExpRow[0]?.total ?? 0;
    // No chips at all for a first month - a delta against an empty month is meaningless.
    setPrevStats(prevInc === 0 && prevExp === 0 ? null : { income: prevInc, expenses: prevExp, net: prevInc + prevExp });
    // Scheduled bills still due and deposits still to come, so the bearing bar can show what
    // is committed and what is free. Past months have nothing left to plan. Uses the same
    // rules and "include detected charges" choice as the Plan page.
    const todayIso = toISODate(new Date());
    const bounds = monthBoundsIso(month);
    const monthState = month < todayIso.slice(0, 7) ? "past" : month > todayIso.slice(0, 7) ? "future" : "current";
    let plannedSummary: PlannedAhead = { dueCents: 0, incomeCents: 0, billCount: 0, hasAny: false };
    if (monthState !== "past") {
      try {
        const events = await getPlannedEvents(profileId, monthState === "current" ? todayIso : bounds.start, bounds.end, loadScenario(profileId).detected);
        const s = summarizePlanned(events);
        plannedSummary = { dueCents: s.plannedPaymentsCents, incomeCents: s.plannedIncomeCents, billCount: s.billCount, hasAny: events.length > 0 };
      } catch (err) {
        console.error(err);
      }
    }
    setPlanned(plannedSummary);
    setCats(catRows.map((r) => ({ ...r, total: Math.max(0, -r.total) })));
    setRecent(recentRows);
    setMonthTxnCount(monthCountRow[0]?.n ?? 0);
    setTotalTxnCount(totalCountRow[0]?.n ?? 0);
    const trackedAccounts = balanceRow.filter((r) => r.balance_cents !== null);
    // Only VISIBLE checking/bank accounts count toward this headline figure - credit card debt
    // and investments are tracked separately (Credit Card Health, Net Worth) rather than
    // blended in. Credit accounts are never excluded from the fetch itself (unlike checking) -
    // hidden cards still need their full data on hand so their tile can collapse in place
    // instead of vanishing, and expand instantly (no reload) when un-hidden.
    const checkingIds = new Set(
      balanceAcctRows.filter((a) => a.account_type === "checking" && !a.hidden_from_dashboard).map((a) => a.id)
    );
    const creditIds = new Set(balanceAcctRows.filter((a) => a.account_type === "credit").map((a) => a.id));
    const checkingTracked = trackedAccounts.filter((r) => checkingIds.has(r.account_id));
    setCurrentBalance(checkingTracked.length > 0 ? checkingTracked.reduce((s, r) => s + (r.balance_cents ?? 0), 0) : null);
    // True latest balance per account, regardless of the selected month - `balanceRow` is a
    // one-shot "most recent balance_cents ever" query per account (no date filtering), unlike
    // `balancePointRows` below which gets filtered down to the selected month for the
    // sparkline. Tiles must show THIS for their headline number, or an account whose most
    // recent statement falls outside the selected month (e.g. right after a historical batch
    // import) would wrongly show $0 instead of its real balance.
    const latestBalanceById = new Map(balanceRow.map((r) => [r.account_id, r.balance_cents]));
    const balanceDates = new Map(balanceRow.map((row) => [row.account_id, row.balance_date]));
    const creditAccountsMeta = balanceAcctRows
      .filter((a) => a.account_type === "credit")
      .map((a, i) => ({
        id: a.id, name: a.name, color: accountChartColor(i), hidden: !!a.hidden_from_dashboard,
        interestRateBps: a.interest_rate_bps, minimumPaymentCents: a.minimum_payment_cents, balanceCents: latestBalanceById.get(a.id) ?? null,
        balanceDate: balanceDates.get(a.id) ?? null,
      }));
    setCreditBalanceAccounts(creditAccountsMeta);
    // Checking accounts combine into one line (there's usually just one); credit cards stay
    // separate per-account so multiple cards never get silently summed into one number.
    const combinedChecking = combineAccountBalances(balancePointRows.filter((r) => checkingIds.has(r.account_id)));
    setCheckingBalancePoints(
      combinedChecking.filter((r) => r.date >= start).map((r) => ({ date: r.date, balance: r.balance_cents / 100 }))
    );
    // Per-account checking tiles (clickable, same pattern as credit cards) - only visible
    // accounts, matching the headline figure above.
    const checkingAccountsMeta = balanceAcctRows
      .filter((a) => a.account_type === "checking" && !a.hidden_from_dashboard)
      .map((a, i) => ({
        id: a.id, name: a.name, color: accountChartColor(i), hidden: false,
        interestRateBps: null, minimumPaymentCents: null, balanceCents: latestBalanceById.get(a.id) ?? null,
        balanceDate: balanceDates.get(a.id) ?? null,
      }));
    setBankAccountsMeta(checkingAccountsMeta);
    const separatedChecking = separateAccountBalances(balancePointRows.filter((r) => checkingIds.has(r.account_id)));
    setBankBalanceRows(
      separatedChecking.filter((r) => r.date >= start).map((r) => {
        const row: CreditBalanceRow = { date: r.date };
        for (const acc of checkingAccountsMeta) row[String(acc.id)] = (r.byAccount[acc.id] ?? 0) / 100;
        return row;
      })
    );
    const separatedCredit = separateAccountBalances(balancePointRows.filter((r) => creditIds.has(r.account_id)));
    setCreditBalanceRows(
      separatedCredit.filter((r) => r.date >= start).map((r) => {
        const row: CreditBalanceRow = { date: r.date };
        for (const acc of creditAccountsMeta) row[String(acc.id)] = (r.byAccount[acc.id] ?? 0) / 100;
        return row;
      })
    );
    setPortfolioValueCents(portfolioRow[0]?.total ?? 0);
    setPortfolioChange(
      portfolioChangeRow[0]?.change != null
        ? { change: portfolioChangeRow[0].change, periodEnd: portfolioChangeRow[0].period_end }
        : null
    );
    setHasDemoAccounts((demoAcctRow[0]?.n ?? 0) > 0);
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
    loadData().catch(handleLoadFailure("your dashboard", setLoading, () => void loadData()));
  };

  useEffect(() => {
    loadData().catch(handleLoadFailure("your dashboard", setLoading, () => void loadData()));
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

  /** Collapses/expands a single credit card tile in place - collapsing also excludes it from
   *  net worth, expanding restores it. Purely a local, per-card, optimistic update (no full
   *  page reload) so toggling one card can never visually affect any other card, and there's
   *  always an obvious, permanent way to reverse it (click the collapsed tile again). */
  const setCreditHidden = async (id: number, hidden: boolean) => {
    setCreditBalanceAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, hidden } : a)));
    await setAccountHiddenFromDashboard(id, hidden);
  };

  const hasData = stats.income !== 0 || stats.expenses !== 0;

  const compareLabel = `vs ${formatMonthLabel(prevMonthOf(month)).split(" ")[0]}`;
  const loanMeta = (rateBps: number | null, minCents: number | null) =>
    [rateBps != null ? `${(rateBps / 100).toFixed(2)}% APR` : null, minCents != null ? `${formatCurrency(minCents)} minimum` : null]
      .filter(Boolean).join(", ") || undefined;

  return (
    <div className="workspace-page dashboard-workspace dash-grid">
      <div className="workspace-heading dash-heading">
        <div>
          <h1>Dashboard</h1>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{formatMonthLong(month)}</p>
        </div>
        <MonthPicker value={month} onChange={setMonth} />
      </div>

      {loading && (
        <div className="dash-hero space-y-6">
          <Skeleton className="h-28" />
          <Skeleton className="h-40" />
          <CardListSkeleton count={3} />
        </div>
      )}

      {!loading && !hasData && (
        <div className="dash-hero">
          <EmptyState
            title="No transactions for this month"
            actions={
              <>
                <Link
                  to="/import"
                  className="px-4 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-md text-sm font-medium hover:opacity-90 transition-opacity"
                >
                  Import transactions
                </Link>
                {/* Demo Mode is only offered when this profile has genuinely never had any real
                    transactions - once any data exists (even in a different month, or after demo
                    data itself was imported), it's no longer relevant. Recomputed live from
                    totalTxnCount, so clearing all transactions brings it back automatically, and
                    each profile is judged independently of every other profile's data. */}
                {!hasDemoAccounts && totalTxnCount === 0 && (
                  <button
                    type="button"
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
                    className="px-4 py-2 border rounded-md text-sm font-medium hover:bg-[hsl(var(--muted))] transition-colors disabled:opacity-50"
                  >
                    {seedingDemo ? "Loading demo data…" : "Try Demo Mode"}
                  </button>
                )}
              </>
            }
          >
            Import a bank statement to get started.
          </EmptyState>
        </div>
      )}

      {!loading && hasData && (
        <>
          {/* ── The bearing: net, income and spending as figures, then the same month as one
              track of income (spent, still due, free). The page's one orchestrated load. ── */}
          <motion.section className="dash-hero" variants={staggerContainer} initial="hidden" animate="show" aria-label="This month">
            <motion.div variants={riseIn}>
              <StatRow
                heroSize="xl"
                items={[
                  {
                    label: "Net this month",
                    hero: true,
                    tone: stats.net < 0 ? "error" : "default",
                    value: <CountUp value={stats.net} format={(v) => `${v >= 0 ? "+" : ""}${formatCurrency(Math.round(v))}`} />,
                    hint: prevStats ? <TrendChip deltaCents={stats.net - prevStats.net} compareLabel={compareLabel} /> : undefined,
                  },
                  {
                    label: <>Income <InfoTooltip text={EXCLUSION_DISCLAIMER_TEXT} /></>,
                    value: <CountUp value={stats.income} format={(v) => formatCurrency(Math.round(v))} />,
                    hint: prevStats ? <TrendChip deltaCents={stats.income - prevStats.income} compareLabel={compareLabel} /> : undefined,
                  },
                  {
                    label: <>Spending <InfoTooltip text={EXCLUSION_DISCLAIMER_TEXT} /></>,
                    value: <CountUp value={Math.abs(stats.expenses)} format={(v) => formatCurrency(Math.round(v))} />,
                    hint: prevStats ? <TrendChip deltaCents={Math.abs(stats.expenses) - Math.abs(prevStats.expenses)} compareLabel={compareLabel} invert /> : undefined,
                  },
                ]}
              />
            </motion.div>
            <motion.div variants={riseIn}>
              <BearingBar
                incomeCents={stats.income + planned.incomeCents}
                spentCents={Math.abs(stats.expenses)}
                dueCents={planned.dueCents}
                dueCount={planned.billCount}
                month={month}
              />
              {!planned.hasAny && (
                <Link to="/plan" className="inline-block mt-2 text-xs text-[hsl(var(--gold-ink))] hover:underline">
                  Manage scheduled bills &amp; income
                </Link>
              )}
            </motion.div>
          </motion.section>

          {/* ── Horizon: the checking balance over the month, drawn wide and quiet ── */}
          {currentBalance != null && (
            <section className="dash-horizon">
              <SectionHeading
                title="Checking balance"
                hint={portfolioValueCents > 0
                  ? `${formatCurrency(currentBalance)} checking${includeInvestments ? ` + ${formatCurrency(portfolioValueCents)} investments` : ""} (excludes credit card debt)`
                  : "Checking and bank accounts only, excludes credit card debt"}
              >
                {portfolioValueCents > 0 && (
                  <button
                    type="button"
                    onClick={toggleIncludeInvestments}
                    aria-pressed={includeInvestments}
                    title="Include investments in this figure"
                    className={`text-xs px-2.5 py-1 rounded-md border font-medium transition-colors ${
                      includeInvestments
                        ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] border-transparent"
                        : "hover:bg-[hsl(var(--muted))]"
                    }`}
                  >
                    Include investments
                  </button>
                )}
              </SectionHeading>
              <p className={`text-[26px] leading-tight font-medium tabular-nums mt-3 ${(currentBalance + (includeInvestments ? portfolioValueCents : 0)) < 0 ? "text-[hsl(var(--error))]" : ""}`}>
                <CountUp value={currentBalance + (includeInvestments ? portfolioValueCents : 0)} format={(v) => formatCurrency(Math.round(v))} />
              </p>
              {includeInvestments && portfolioChange && (
                <p className={`text-xs mt-0.5 ${portfolioChange.change >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--error))]"}`}>
                  {portfolioChange.change >= 0 ? "+" : ""}{formatCurrency(portfolioChange.change)} on your latest statement period
                </p>
              )}
              {checkingBalancePoints.length > 1 && (
                <div
                  className="h-40 mt-3"
                  role="img"
                  aria-label={(() => {
                    const first = checkingBalancePoints[0].balance;
                    const last = checkingBalancePoints[checkingBalancePoints.length - 1].balance;
                    const delta = Math.round((last - first) * 100);
                    return `Checking balance trend: ${delta >= 0 ? "up" : "down"} ${formatCurrency(Math.abs(delta))} over the period shown`;
                  })()}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={checkingBalancePoints} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id="balGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={series.balance} stopOpacity={0.22} />
                          <stop offset="95%" stopColor={series.balance} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="date" hide />
                      <Tooltip
                        contentStyle={chartTooltipStyle}
                        labelStyle={chartTooltipText}
                        itemStyle={chartTooltipText}
                        wrapperStyle={chartTooltipWrapper}
                        formatter={(v) => [`$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}`, "Balance"]}
                        labelFormatter={(l) => formatDate(String(l))}
                      />
                      <Area type="monotone" dataKey="balance" stroke={series.balance} strokeWidth={2} fill="url(#balGrad)" dot={false} isAnimationActive={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </section>
          )}

          {/* ── Accounts: one row per account, grouped, instead of three copies of a tile ── */}
          <section className="dash-accounts">
            <SectionHeading title="Accounts" hint="Latest recorded balance and this month's movement" />

            {bankAccountsMeta.length > 0 && (
              <div className="mt-4">
                <SectionHeading as="h3" title="Bank" />
                {bankAccountsMeta.map((acc) => {
                  const points = bankBalanceRows.map((r) => ({ date: r.date, value: Number(r[String(acc.id)] ?? 0) }));
                  const last = points.length > 0 ? points[points.length - 1].value : 0;
                  const first = points.length > 0 ? points[0].value : 0;
                  const changeCents = Math.round((last - first) * 100);
                  // Headline number is the account's true latest balance, not the month-filtered
                  // series, so an account with no activity this month never shows $0.
                  const lastCents = acc.balanceCents ?? Math.round(last * 100);
                  return (
                    <AccountRow
                      key={acc.id}
                      kind="bank"
                      name={acc.name}
                      balanceCents={lastCents}
                      balanceDate={acc.balanceDate}
                      meta={acc.balanceCents === null ? "No recorded balance" : undefined}
                      trendCents={points.length > 1 ? changeCents : null}
                      series={points.map((p) => ({ date: p.date, balance_cents: Math.round(p.value * 100) }))}
                      onOpen={() => setViewAccount({ id: acc.id, name: acc.name, accountType: "checking", color: acc.color, balanceCents: lastCents, series: points })}
                    />
                  );
                })}
              </div>
            )}

            {creditBalanceAccounts.length > 0 && (
              <div className="mt-6">
                <SectionHeading as="h3" title="Credit cards" />
                {creditBalanceAccounts.map((acc) => {
                  const points = creditBalanceRows.map((r) => ({ date: r.date, value: Number(r[String(acc.id)] ?? 0) }));
                  const last = points.length > 0 ? points[points.length - 1].value : 0;
                  const first = points.length > 0 ? points[0].value : 0;
                  // Balances are stored negative (a liability): a less negative balance means the
                  // card was paid down, which AccountRow's inverted TrendChip shows as good.
                  const changeCents = Math.round((last - first) * 100);
                  const lastCents = acc.balanceCents ?? Math.round(last * 100);
                  return (
                    <AccountRow
                      key={acc.id}
                      kind="credit"
                      name={acc.name}
                      balanceCents={lastCents}
                      balanceDate={acc.balanceDate}
                      meta={acc.balanceCents === null ? "No recorded balance" : loanMeta(acc.interestRateBps, acc.minimumPaymentCents)}
                      trendCents={points.length > 1 ? changeCents : null}
                      series={points.map((p) => ({ date: p.date, balance_cents: Math.round(p.value * 100) }))}
                      hidden={acc.hidden}
                      onToggleHidden={(next) => setCreditHidden(acc.id, next)}
                      onOpen={() => setViewAccount({ id: acc.id, name: acc.name, accountType: "credit", color: acc.color, balanceCents: lastCents, series: points, interestRateBps: acc.interestRateBps, minimumPaymentCents: acc.minimumPaymentCents })}
                    />
                  );
                })}
              </div>
            )}

            {/* Loans are never counted toward liquidity or income and expenses; their history
                comes from statement uploads. Always shown so "Add loan" stays discoverable. */}
            <div className="mt-6">
              <SectionHeading as="h3" title="Loans">
                <button
                  type="button"
                  onClick={() => setLoanModal("new")}
                  className="flex items-center gap-1 text-xs px-2.5 py-1 border rounded-md hover:bg-[hsl(var(--muted))] transition-colors shrink-0"
                >
                  <PlusIcon size={13} /> Add loan
                </button>
              </SectionHeading>
              {loans.length === 0 ? (
                <p className="text-sm text-[hsl(var(--muted-foreground))] mt-2">No loans added yet. Car loans, student loans, mortgages, or personal loans.</p>
              ) : (
                loans.map((loan, i) => {
                  const points = loanSeries.get(loan.id) ?? [];
                  const last = points.length > 0 ? points[points.length - 1].value : (loan.balance_cents ?? 0) / 100;
                  const first = points.length > 0 ? points[0].value : last;
                  const changeCents = Math.round((last - first) * 100);
                  const lastCents = Math.round(last * 100);
                  const color = accountChartColor(i);
                  return (
                    <AccountRow
                      key={loan.id}
                      kind="loan"
                      name={loan.name}
                      balanceCents={lastCents}
                      meta={loanMeta(loan.interest_rate_bps, loan.minimum_payment_cents)}
                      trendCents={points.length > 1 ? changeCents : null}
                      series={points.map((p) => ({ date: p.date, balance_cents: Math.round(p.value * 100) }))}
                      extraAction={{ label: `Add a statement for ${loan.name}`, onClick: () => setLoanModal(loan), icon: <PlusIcon size={14} /> }}
                      onOpen={() => setViewAccount({
                        id: loan.id, name: loan.name, accountType: "loan", color, balanceCents: lastCents, series: points,
                        interestRateBps: loan.interest_rate_bps, minimumPaymentCents: loan.minimum_payment_cents,
                      })}
                    />
                  );
                })
              )}
            </div>
          </section>

          {/* ── Top categories as ranked bars: shares compare by length ── */}
          {cats.length > 0 && (
            <section className="dash-categories">
              <SectionHeading title="Top spending categories" hint="Click a category for its largest transactions" />
              <div className="mt-2">
                <RankedBars
                  items={cats.map((c) => ({ key: c.name, name: c.name, value: c.total, color: c.color ? harmonizeColor(c.color, mode) : "hsl(var(--neutral))" }))}
                  formatValue={formatCurrency}
                  context="of spending"
                  onSelect={(item) => { const cat = cats.find((c) => c.name === item.name); if (cat) void toggleCatExpand(cat); }}
                  selectedKey={expandedCat?.name ?? null}
                />
              </div>
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
                          <span className="w-1.5 h-1.5 rounded-[2px]" style={{ backgroundColor: expandedCat.color ? harmonizeColor(expandedCat.color, mode) : "hsl(var(--neutral))" }} />
                          {expandedCat.name}, {formatCurrency(expandedCat.total)}
                        </p>
                        <Link
                          to="/transactions"
                          state={{ month, category: expandedCat.categoryId }}
                          className="text-[11px] text-[hsl(var(--gold-ink))] hover:underline"
                        >
                          View all
                        </Link>
                      </div>
                      {expandedCatTxns === null ? (
                        <p className="text-xs text-[hsl(var(--muted-foreground))] py-2">Loading…</p>
                      ) : (
                        <div className="space-y-1">
                          {expandedCatTxns.map((t) => (
                            <div key={t.id} className="flex items-center justify-between text-xs py-1">
                              <span className="truncate flex-1 text-[hsl(var(--muted-foreground))]">{t.description}</span>
                              <span className="ml-3 shrink-0 tabular-nums">{formatCurrency(Math.abs(t.amount_cents))}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          )}

          {/* ── Insights, below the numbers they refer to ── */}
          {visibleInsights.length > 0 && (
            <section className="dash-insights">
              <SectionHeading title="Worth a look">
                <Link to="/agent" className="text-xs text-[hsl(var(--gold-ink))] hover:underline">See all insights</Link>
              </SectionHeading>
              <div className="mt-2 space-y-2">
                {visibleInsights.map((insight) => (
                  <InsightCard key={insight.id} insight={insight} onApply={handleApplyInsight} compact />
                ))}
              </div>
            </section>
          )}

          {/* ── Recent activity in the same ledger rows Transactions uses ── */}
          {recent.length > 0 && (
            <section className="dash-activity">
              <SectionHeading title="Recent activity">
                <Link to="/transactions" className="text-xs text-[hsl(var(--gold-ink))] hover:underline">View all</Link>
              </SectionHeading>
              <div className="mt-2">
                {recent.map((t) => {
                  const row = t as Transaction & { account_name?: string | null };
                  return (
                    <ActivityRow
                      key={t.id}
                      compact
                      transaction={{ ...row, category_color: row.category_color ? harmonizeColor(row.category_color, mode) : null }}
                    />
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}

      {/* ── MANAGE DATA, only shown when there is something to clear ── */}
      {(monthTxnCount > 0 || totalTxnCount > 0) && (
        <details className="workspace-disclosure dash-manage border-t pt-3">
          <summary>Manage data</summary>
          {confirmClear === null ? (
            <div className="flex gap-4 text-sm flex-wrap">
              {monthTxnCount > 0 && (
                <button
                  onClick={() => setConfirmClear("month")}
                  className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--error))] transition-colors"
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
                  className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--error))] transition-colors"
                >
                  Clear all transactions
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3 flex-wrap">
              <p className="text-sm text-[hsl(var(--error))]">
                {confirmClear === "month"
                  ? `Delete all transactions for ${month}? This cannot be undone.`
                  : "Delete ALL transactions? This cannot be undone."}
              </p>
              <button
                onClick={() => handleClear(confirmClear)}
                className="px-3 py-1 bg-[hsl(var(--error))] text-white rounded-lg text-sm font-medium
                           hover:opacity-90 transition-colors"
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
        </details>
      )}

      {loanModal && (
        <LoanUploaderModal
          profileId={profileId}
          existingLoan={loanModal === "new" ? undefined : loanModal}
          onClose={() => setLoanModal(null)}
          onSaved={() => loadLoans().catch(console.error)}
        />
      )}

      {viewAccount && (
        <AccountDetailModal
          account={viewAccount}
          insights={insights}
          onApply={handleApplyInsight}
          onClose={() => setViewAccount(null)}
          onUpdated={() => loadData()}
        />
      )}
    </div>
  );
}

