import { useState, useEffect, useMemo, Fragment } from "react";
import { Link } from "react-router-dom";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar,
} from "recharts";
import { TrendUpIcon, CaretRightIcon, CaretDownIcon, InfoIcon } from "@phosphor-icons/react";
import { getDb } from "@/lib/db";
import { formatCurrency, formatDate, formatAxisCurrency, accountChartColor } from "@/lib/utils";
import { holdingRoiPct, latestHoldingPerAccount } from "@/lib/netWorth";
import { useProfileStore } from "@/stores/profileStore";
import InfoTooltip from "@/components/InfoTooltip";
import StatRow from "@/components/StatRow";
import { Skeleton, TableSkeleton } from "@/components/Skeleton";
import type { Holding, SecurityType, ActivityType, InvestmentActivity, InvestmentSummary } from "@/lib/types";

const SECTION_LABELS: Record<SecurityType, string> = {
  stock: "Stocks",
  etf: "ETFs",
  mutual_fund: "Mutual Funds",
  cash: "Cash",
  crypto: "Crypto",
  other: "Other",
};

const SECTION_ORDER: SecurityType[] = ["stock", "etf", "mutual_fund", "crypto", "other", "cash"];

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

/** One investment account with any imported positions, activity or statements. */
interface InvestmentAccount {
  id: number;
  name: string;
  institution: string | null;
}

/** Rows belonging to the selected account, or every row for "all". */
function scopeToAccount<T extends { account_id: number }>(rows: T[], accountFilter: number | "all"): T[] {
  return accountFilter === "all" ? rows : rows.filter((r) => r.account_id === accountFilter);
}

/**
 * Headline figures for a set of current holdings. Unrealized gain compares cost basis only with
 * the market value of the SAME lots: a lot whose cost basis is unknown (a 401(k) balance line, a
 * wallet export) has no gain to report, and counting its whole value as gain would invent profit.
 * A zero cost basis counts as unknown, matching `holdingRoiPct` and the return calculation.
 */
export function summarizeHoldings(
  rows: Pick<Holding, "market_value_cents" | "cost_basis_cents" | "est_annual_income_cents">[]
) {
  let marketValue = 0, costBasis = 0, trackedValue = 0, hasCostBasis = false;
  let estIncome: number | null = null;
  for (const h of rows) {
    marketValue += h.market_value_cents ?? 0;
    if (h.cost_basis_cents) {
      costBasis += h.cost_basis_cents;
      trackedValue += h.market_value_cents ?? 0;
      hasCostBasis = true;
    }
    if (h.est_annual_income_cents !== null) estIncome = (estIncome ?? 0) + h.est_annual_income_cents;
  }
  return {
    marketValue,
    costBasis: hasCostBasis ? costBasis : null,
    unrealized: hasCostBasis ? trackedValue - costBasis : null,
    /** Share (0-1) of market value whose cost basis is known; null when there is no value. */
    costBasisCoverage: marketValue > 0 ? trackedValue / marketValue : null,
    /** Null when no lot reports an estimate (not the same as an estimate of $0). */
    estIncome,
  };
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
  const [allHoldings, setAllHoldings] = useState<Holding[]>([]);
  const [historyRows, setHistoryRows] = useState<{ account_id: number; as_of_date: string; total: number }[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [allActivity, setAllActivity] = useState<InvestmentActivity[]>([]);
  const [allSnapshots, setAllSnapshots] = useState<AccountSnapshot[]>([]);
  const [allSummaries, setAllSummaries] = useState<InvestmentSummary[]>([]);
  const [accounts, setAccounts] = useState<InvestmentAccount[]>([]);
  /** "all", or one account id - scopes every figure, tab and statement on the page. */
  const [accountFilter, setAccountFilter] = useState<number | "all">("all");
  const [tab, setTab] = useState<InvestmentTab>("holdings");
  const [activityFilter, setActivityFilter] = useState<ActivityType | "all">("all");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setAccountFilter("all");
      const db = await getDb();
      const [history, activityRows, summaryRows, accountRows, rows, accts] = await Promise.all([
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
        // Each account's OWN latest statement - accounts file on different schedules, so one
        // profile-wide "latest" would show a single account's period as if it were everyone's.
        db.select<InvestmentSummary[]>(
          `SELECT s.* FROM investment_summaries s
           WHERE s.profile_id=? AND s.period_end = (SELECT MAX(s2.period_end) FROM investment_summaries s2
                                                    WHERE s2.account_id = s.account_id)
           ORDER BY s.period_end DESC, s.id DESC`,
          [profileId]
        ),
        db.select<InvestmentAccount[]>(
          `SELECT a.id, a.name, a.institution FROM accounts a
           WHERE a.profile_id=? AND (EXISTS (SELECT 1 FROM holdings h WHERE h.account_id=a.id)
             OR EXISTS (SELECT 1 FROM investment_activity ia WHERE ia.account_id=a.id)
             OR EXISTS (SELECT 1 FROM investment_summaries s WHERE s.account_id=a.id))
           ORDER BY a.name COLLATE NOCASE, a.id`,
          [profileId]
        ),
        db.select<Holding[]>(
          `SELECT h.* FROM holdings h
           WHERE h.profile_id=? AND ${latestHoldingPerAccount()}
           ORDER BY h.security_type, h.description`,
          [profileId]
        ),
        db.select<AccountSnapshot[]>(
          `SELECT a.id, a.name, a.institution, h.as_of_date,
                  SUM(COALESCE(h.market_value_cents, 0)) as total, COUNT(*) as positions
           FROM holdings h JOIN accounts a ON a.id = h.account_id
           WHERE h.profile_id=? AND ${latestHoldingPerAccount()}
           GROUP BY a.id ORDER BY total DESC`,
          [profileId]
        ),
      ]);
      if (cancelled) return;
      setHistoryRows(history);
      setAllActivity(activityRows);
      setAllSummaries(summaryRows); // UNIQUE(account_id, period_end): one latest row per account
      setAccounts(accountRows);
      setAllHoldings(rows);
      setAllSnapshots(accts);
      setLoading(false);
    })().catch(() => setLoading(false));
    return () => { cancelled = true; };
  }, [profileId]);

  const holdings = useMemo(() => scopeToAccount(allHoldings, accountFilter), [allHoldings, accountFilter]);
  const activity = useMemo(() => scopeToAccount(allActivity, accountFilter), [allActivity, accountFilter]);
  const summaries = useMemo(() => scopeToAccount(allSummaries, accountFilter), [allSummaries, accountFilter]);
  const accountSnapshots = useMemo(
    () => allSnapshots.filter((a) => accountFilter === "all" || a.id === accountFilter),
    [allSnapshots, accountFilter]
  );
  const valueOverTime = useMemo(
    () => buildPortfolioHistory(scopeToAccount(historyRows, accountFilter)),
    [historyRows, accountFilter]
  );
  const accountName = (id: number) => accounts.find((a) => a.id === id)?.name ?? "Investment account";
  const selectedAccount = accountFilter === "all" ? null : accounts.find((a) => a.id === accountFilter) ?? null;

  const kpis = useMemo(() => summarizeHoldings(holdings), [holdings]);

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

  /** The type filter, falling back to "all" when the selected account has no activity of that type. */
  const shownType = activityFilter === "all" || activityTypesPresent.includes(activityFilter) ? activityFilter : "all";
  const filteredActivity = useMemo(
    () => (shownType === "all" ? activity : activity.filter((a) => a.activity_type === shownType)),
    [activity, shownType]
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

  /** Sum of each in-scope account's own latest year-to-date figure, counting only statements from
   *  this calendar year (a December statement's YTD belongs to last year); null when none has one. */
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const ytdSummaries = summaries.filter((s) => s.period_end >= yearStart && s.realized_gain_ytd_cents !== null);
  const realizedYtd = ytdSummaries.length > 0
    ? ytdSummaries.reduce((sum, s) => sum + (s.realized_gain_ytd_cents ?? 0), 0)
    : null;

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

  if (allHoldings.length === 0 && allActivity.length === 0 && allSummaries.length === 0) {
    return (
      <div className="workspace-page text-center py-16">
        <div className="flex justify-center mb-4 text-[hsl(var(--muted-foreground))]"><TrendUpIcon size={48} /></div>
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

  const pricedDates = [...new Set(accountSnapshots.map((a) => a.as_of_date))].sort();
  const positions = accountSnapshots.reduce((n, a) => n + a.positions, 0);
  const scopeLabel = selectedAccount
    ? selectedAccount.name
    : `${accounts.length === 1 ? accounts[0].name : `All ${accounts.length} accounts`}`;
  const coverage = kpis.costBasisCoverage;
  // The tab bar is hidden for an account with no activity or statements - show its holdings then.
  const view: InvestmentTab = activity.length > 0 || summaries.length > 0 ? tab : "holdings";
  const positionsHint = `${positions} ${positions === 1 ? "position" : "positions"}`;

  return (
    <div className="workspace-page space-y-6 investments-workspace">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Investments</h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
            {pricedDates.length === 0
              ? "No positions snapshot yet"
              : mixedAsOfDates
                ? `${accountSnapshots.length} accounts, each priced as of its own latest statement`
                : `Priced as of ${formatDate(pricedDates[0])}`}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {accounts.length > 1 && (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-[hsl(var(--muted-foreground))]">Account</span>
              <select
                value={accountFilter}
                onChange={(e) => setAccountFilter(e.target.value === "all" ? "all" : Number(e.target.value))}
                className="border rounded-lg px-2 py-1.5 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))] max-w-[16rem]"
              >
                <option value="all">All accounts ({accounts.length})</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}{a.institution ? `, ${a.institution}` : ""}</option>
                ))}
              </select>
            </label>
          )}
          <Link to="/import" className="px-4 py-1.5 border rounded-lg text-sm hover:bg-[hsl(var(--muted))] transition-colors">
            Import New Statement
          </Link>
        </div>
      </div>

      {holdings.length > 0 && (
        <section className="border rounded-2xl px-5 pt-4 pb-1 bg-[hsl(var(--surface-raised))]">
          <StatRow
            ariaLabel={`Portfolio summary, ${scopeLabel}`}
            className="portfolio-hero"
            columns={3}
            heroSize="xl"
            items={[
              {
                label: selectedAccount ? "Account value" : "Portfolio value",
                value: formatCurrency(kpis.marketValue),
                // Accounts with only activity or statements add nothing to the value - say so.
                hint: !selectedAccount && accountSnapshots.length < accounts.length
                  ? `${accountSnapshots.length} of ${accounts.length} accounts have positions · ${positionsHint}`
                  : `${scopeLabel} · ${positionsHint}`,
                tone: "gold",
                hero: true,
              },
              {
                label: "Unrealized gain/loss",
                value: kpis.unrealized === null ? "Unknown" : formatCurrency(kpis.unrealized),
                tone: kpis.unrealized === null ? "muted" : kpis.unrealized >= 0 ? "success" : "error",
                hint: kpis.unrealized === null
                  ? "No cost basis on these statements"
                  : coverage !== null && coverage < 0.995
                    ? `On the ${Math.round(coverage * 100)}% of value with a known cost basis`
                    : `Against ${formatCurrency(kpis.costBasis ?? 0)} cost basis`,
              },
              {
                label: "Est. annual income",
                value: kpis.estIncome === null ? "Not reported" : formatCurrency(kpis.estIncome),
                tone: kpis.estIncome === null ? "muted" : "default",
                hint: "Brokerage projection, not income received",
              },
              {
                label: pricedDates.length > 1 ? "Valuation dates" : "Priced as of",
                value: pricedDates.length > 1 ? "Mixed" : formatDate(pricedDates[0]),
                tone: pricedDates.length > 1 ? "warning" : "default",
                hint: pricedDates.length > 1
                  ? `Each account's latest, ${formatDate(pricedDates[0])} to ${formatDate(pricedDates[pricedDates.length - 1])}`
                  : selectedAccount ? "Latest statement" : "Each account's latest statement",
              },
            ]}
          />
        </section>
      )}

      {(activity.length > 0 || summaries.length > 0) && (
        <div className="flex gap-1 border-b">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                view === t.id
                  ? "border-[hsl(var(--primary))] text-[hsl(var(--gold-ink))]"
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

      {/* One card per account: statement periods differ by account, so they are never merged. */}
      {summaries.map((summary) => (
        <div key={summary.id} className="border rounded-xl overflow-hidden" aria-label={`Latest statement, ${accountName(summary.account_id)}`} role="region">
          <div className="px-4 py-2.5 border-b flex items-center justify-between gap-2 flex-wrap">
            <span className="font-semibold text-sm">
              Latest statement <span className="text-[hsl(var(--muted-foreground))] font-normal">· {accountName(summary.account_id)}</span>
            </span>
            <span className="text-xs text-[hsl(var(--muted-foreground))]">
              {summary.period_start ? `${formatDate(summary.period_start)} – ` : "Period ending "}
              {formatDate(summary.period_end)}
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px bg-[hsl(var(--border))]">
            {([
              ["Beginning Value", summary.beginning_value_cents, false],
              ["Ending Value", summary.ending_value_cents, false],
              ["Change in Value", summary.change_in_value_cents, true],
              ["Cash Balance", summary.cash_balance_cents, false],
              ["Deposits", summary.deposits_cents, false],
              ["Withdrawals", summary.withdrawals_cents, false],
              ["Income", summary.income_cents, false],
              ["Realized Gain", summary.realized_gain_cents, true],
              ["Realized Gain (YTD)", summary.realized_gain_ytd_cents, true],
              ["Unrealized Gain", summary.unrealized_gain_cents, true],
              ["Fees", summary.fees_cents, false],
            ] as [string, number | null, boolean][])
              .filter(([, v]) => v !== null)
              .map(([label, v, signed]) => (
                <div key={label} className="bg-[hsl(var(--background))] px-4 py-3">
                  <p className={`text-sm font-semibold ${
                    signed ? ((v as number) >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--error))]") : ""
                  }`}>
                    {formatCurrency(v as number)}
                  </p>
                  <p className="text-[hsl(var(--muted-foreground))] text-xs mt-0.5">{label}</p>
                </div>
              ))}
          </div>
        </div>
      ))}

      {view === "activity" && (
        <div className="border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b flex items-center justify-between gap-3 flex-wrap">
            <span className="font-semibold text-sm">
              Activity <span className="text-[hsl(var(--muted-foreground))] font-normal">({filteredActivity.length})</span>
            </span>
            <select
              value={shownType}
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
                    <td className="px-4 py-2 text-xs whitespace-nowrap">{formatDate(a.trade_date)}</td>
                    <td className="px-4 py-2 text-xs">{ACTIVITY_LABELS[a.activity_type]}</td>
                    <td className="px-4 py-2 max-w-xs truncate text-xs">{a.description}</td>
                    <td className="px-4 py-2 text-xs">{a.symbol ?? "-"}</td>
                    <td className="px-4 py-2 text-right text-xs">{a.quantity ?? "-"}</td>
                    <td className="px-4 py-2 text-right text-xs">{a.price_cents !== null ? formatCurrency(a.price_cents) : "-"}</td>
                    <td className={`px-4 py-2 text-right text-xs ${a.amount_cents < 0 ? "text-[hsl(var(--error))]" : "text-[hsl(var(--success))]"}`}>
                      {formatCurrency(a.amount_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {view === "income" && (
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
                (realizedYtd ?? 0) >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--error))]"
              }`}>
                {realizedYtd !== null ? formatCurrency(realizedYtd) : "-"}
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
                  <Bar dataKey="total" name="Income" fill="hsl(var(--success))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b font-semibold text-sm">Realized Gains</div>
            {realizedLots.length === 0 ? (
              <p className="px-4 py-6 text-sm text-[hsl(var(--muted-foreground))] text-center">
                Your statements report realized gains only as an account-level total, not per sale.
                See the <strong>Realized Gain</strong> figures on each account's latest statement above.
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
                      <td className="px-4 py-2 text-xs whitespace-nowrap">{formatDate(a.trade_date)}</td>
                      <td className="px-4 py-2 text-xs whitespace-nowrap">{a.acquired_date ? formatDate(a.acquired_date) : "-"}</td>
                      <td className="px-4 py-2 max-w-xs truncate text-xs">{a.description}</td>
                      <td className="px-4 py-2 text-xs capitalize">{a.term ?? "-"}</td>
                      <td className="px-4 py-2 text-right text-xs">{formatCurrency(a.amount_cents)}</td>
                      <td className="px-4 py-2 text-right text-xs">{a.cost_basis_cents !== null ? formatCurrency(a.cost_basis_cents) : "-"}</td>
                      <td className={`px-4 py-2 text-right text-xs ${(a.realized_gain_cents ?? 0) >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--error))]"}`}>
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

      {view === "holdings" && holdings.length === 0 && (
        <p className="border rounded-xl px-4 py-8 text-sm text-[hsl(var(--muted-foreground))] text-center">
          This statement had no priced positions - only activity. Import a statement with a
          holdings section to see your portfolio here.
        </p>
      )}

      {view === "holdings" && holdings.length > 0 && (
      <>
      {accountFilter === "all" && accountSnapshots.length > 1 && (
        <div className="border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b">
            <span className="font-semibold text-sm">
              Accounts <span className="text-[hsl(var(--muted-foreground))] font-normal">({accountSnapshots.length})</span>
            </span>
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
                    <button type="button" onClick={() => setAccountFilter(a.id)} className="text-left hover:underline" aria-label={`Show only ${a.name}`}>
                      {a.name}
                    </button>
                    {a.institution && <span className="text-[hsl(var(--muted-foreground))]">, {a.institution}</span>}
                  </td>
                  <td className="px-4 py-2 text-xs text-[hsl(var(--muted-foreground))]">{formatDate(a.as_of_date)}</td>
                  <td className="px-4 py-2 text-right text-xs">{a.positions}</td>
                  <td className="px-4 py-2 text-right text-xs">{formatCurrency(a.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {mixedAsOfDates && (
            <p className="px-4 py-2 text-xs text-[hsl(var(--muted-foreground))] border-t flex items-start gap-1">
              <InfoIcon size={12} className="shrink-0 mt-0.5" />
              These accounts were last priced on different dates because they issue statements on
              different schedules. Each one contributes its own most recent snapshot to the totals above.
            </p>
          )}
        </div>
      )}

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
                  <Line type="monotone" dataKey="value" name="Portfolio Value" stroke="hsl(var(--sea))" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          {allocationData.length > 0 && (
            <div className="border rounded-xl p-5">
              <h2 className="font-semibold mb-4">Allocation</h2>
              {/* Ranked bars instead of a donut: shares compare by length, not arc angle. */}
              <div className="space-y-3">
                {allocationData.map((entry) => {
                  const pct = kpis.marketValue > 0 ? (entry.value / kpis.marketValue) * 100 : 0;
                  return (
                    <div key={entry.type}>
                      <div className="flex items-center justify-between gap-2 text-xs mb-1">
                        <span className="truncate flex items-center gap-1.5 min-w-0">
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
                          <span className="truncate">{entry.name}</span>
                        </span>
                        <span className="shrink-0 tabular-nums">
                          <span className="font-medium">{formatCurrency(entry.value)}</span>
                          <span className="text-[hsl(var(--muted-foreground))]">, {Math.round(pct)}%</span>
                        </span>
                      </div>
                      <div
                        className="h-2 rounded-full bg-[hsl(var(--muted))] overflow-hidden"
                        role="img"
                        aria-label={`${entry.name}: ${formatCurrency(entry.value)}, ${Math.round(pct)}% of portfolio`}
                      >
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: entry.color }} />
                      </div>
                    </div>
                  );
                })}
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
                          {hasLots && (isOpen ? <CaretDownIcon size={14} /> : <CaretRightIcon size={14} />)}
                        </td>
                        <td className="px-4 py-2 max-w-xs truncate text-xs">{g.description}</td>
                        <td className="px-4 py-2 text-xs">{g.symbol ?? "-"}</td>
                        <td className="px-4 py-2 text-right text-xs">{g.totalShares !== null ? g.totalShares.toLocaleString() : "-"}</td>
                        <td className="px-4 py-2 text-right text-xs">{formatCurrency(g.totalMarketValueCents)}</td>
                        <td className={`px-4 py-2 text-right text-xs ${roiPct === null ? "text-[hsl(var(--muted-foreground))]" : roiPct >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--error))]"}`}>
                          {roiPct !== null ? `${roiPct >= 0 ? "+" : ""}${roiPct.toFixed(1)}%` : "-"}
                        </td>
                        <td className="px-4 py-2 text-right text-xs text-[hsl(var(--muted-foreground))]">
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
                          <td className="px-4 py-1.5 text-right">{lot.shares ?? "-"}</td>
                          <td className="px-4 py-1.5 text-right">{lot.market_value_cents !== null ? formatCurrency(lot.market_value_cents) : "-"}</td>
                          <td className="px-4 py-1.5 text-right">
                            {holdingRoiPct(lot.market_value_cents, lot.cost_basis_cents) !== null
                              ? `${holdingRoiPct(lot.market_value_cents, lot.cost_basis_cents)! >= 0 ? "+" : ""}${holdingRoiPct(lot.market_value_cents, lot.cost_basis_cents)!.toFixed(1)}%`
                              : "-"}
                          </td>
                          <td className="px-4 py-1.5 text-right">-</td>
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
        <InfoIcon size={12} className="shrink-0 mt-0.5" />
        Est. Annual Income figures reflect the brokerage's projected estimates as of the statement date, not a history of dividends actually paid.
        {activity.length > 0 && <> See the <strong>Income &amp; Gains</strong> tab for income actually received.</>}
      </p>
      </>
      )}
    </div>
  );
}
