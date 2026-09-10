import ScopeToggle from "@/components/ScopeToggle";
import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, LineChart, Line, ReferenceLine, AreaChart, Area,
} from "recharts";
import { motion, AnimatePresence } from "motion/react";
import { TrendUpIcon, TrendDownIcon } from "@phosphor-icons/react";
import { getDb } from "@/lib/db";
import { incomeSumSql, expenseSumSql, categorySpendSql } from "@/lib/reportingSql";
import { formatCurrency, formatMonthLabel, formatAxisCurrency, combineAccountBalances, separateAccountBalances, accountChartColor, lightenHex } from "@/lib/utils";
import { pickVariantIndex } from "@/lib/voice";
import { useProfileStore } from "@/stores/profileStore";
import { handleLoadFailure } from "@/stores/toastStore";
import type { Profile } from "@/lib/types";
import PinModal from "@/components/PinModal";
import { Skeleton } from "@/components/Skeleton";

interface MonthRow { month: string; income: number; expenses: number; }
interface CatMonthRow { month: string; category: string; color: string; categoryId: number | null; total: number; }
interface StackedRow { month: string; [cat: string]: string | number; }
interface CumulativeRow { month: string; net: number; running: number; }
interface CheckingBalanceMonthRow { month: string; balance: number; }
interface CreditBalanceMonthRow { month: string; [accountKey: string]: string | number; }
interface CreditAccountMeta { id: number; name: string; color: string; }

const RANGE_OPTIONS = [3, 6, 12];
const VIEW_KEY = "compass_trends_view";

export default function TrendsPage() {
  const profileId = useProfileStore((state) => state.activeProfile?.id ?? 1);
  return <ProfileTrends key={profileId} />;
}

function ProfileTrends() {
  const currentProfileId = useProfileStore((state) => state.activeProfile?.id ?? 1);
  const [range, setRange] = useState(() => {
    try { const stored = Number(sessionStorage.getItem(`compass_trends_view_${currentProfileId}`)); return RANGE_OPTIONS.includes(stored) ? stored : 6; } catch { return 6; }
  });
  useEffect(() => {
    try { sessionStorage.setItem(`compass_trends_view_${currentProfileId}`, String(range)); } catch { return; }
  }, [currentProfileId, range]);
  const [monthly, setMonthly] = useState<MonthRow[]>([]);
  const [stacked, setStacked] = useState<StackedRow[]>([]);
  const [catColors, setCatColors] = useState<Record<string, string>>({});
  const [catIds, setCatIds] = useState<Record<string, number | null>>({});
  const [catNames, setCatNames] = useState<string[]>([]);
  const [cumulativeData, setCumulativeData] = useState<CumulativeRow[]>([]);
  const [checkingBalanceMonthly, setCheckingBalanceMonthly] = useState<CheckingBalanceMonthRow[]>([]);
  const [creditBalanceMonthly, setCreditBalanceMonthly] = useState<CreditBalanceMonthRow[]>([]);
  const [creditBalanceAccounts, setCreditBalanceAccounts] = useState<CreditAccountMeta[]>([]);
  const [expandedBalanceMonth, setExpandedBalanceMonth] = useState<string | null>(null);
  const [allTimeIncome, setAllTimeIncome] = useState(0);
  const [allTimeExpenses, setAllTimeExpenses] = useState(0);
  const [loading, setLoading] = useState(true);

  const { activeProfile, profiles, unlockedIds, unlockProfile } = useProfileStore();
  const profileId = activeProfile?.id ?? 1;

  const [viewMode, setViewMode] = useState<"profile" | "global">(() => {
    const s = localStorage.getItem(VIEW_KEY);
    return s === "global" ? "global" : "profile";
  });
  const [pinQueue, setPinQueue] = useState<Profile[]>([]);
  const [pinQueueIdx, setPinQueueIdx] = useState(0);

  const unlockedProfileIds = useMemo(
    () => profiles.filter(p => !p.pin_hash || p.id === profileId || unlockedIds.has(p.id)).map(p => p.id),
    [profiles, profileId, unlockedIds]
  );

  const handleSwitchToGlobal = () => {
    const locked = profiles.filter(p => p.pin_hash && p.id !== profileId && !unlockedIds.has(p.id));
    if (locked.length > 0) { setPinQueue(locked); setPinQueueIdx(0); }
    else { localStorage.setItem(VIEW_KEY, "global"); setViewMode("global"); }
  };
  const handleSwitchToProfile = () => { localStorage.setItem(VIEW_KEY, "profile"); setViewMode("profile"); };
  const advancePinQueue = (uid?: number) => {
    if (uid !== undefined) unlockProfile(uid);
    const next = pinQueueIdx + 1;
    if (next >= pinQueue.length) { setPinQueue([]); setPinQueueIdx(0); localStorage.setItem(VIEW_KEY, "global"); setViewMode("global"); }
    else { setPinQueueIdx(next); }
  };
  const pinTarget = pinQueue.length > 0 && pinQueueIdx < pinQueue.length ? pinQueue[pinQueueIdx] : null;

  /** "Companion voice" callout: the biggest single-category $ swing between the two most
   *  recent months in `stacked` - otherwise Trends is pure charts/numbers with no narrative
   *  framing at all (small/noisy categories under $30 last month are ignored, and the swing
   *  itself must be at least $30 to be worth mentioning). */
  const categoryTrendNarrative = useMemo(() => {
    const today = new Date();
    const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
    const completed = stacked.filter((row) => row.month < currentMonth);
    if (completed.length < 2 || catNames.length === 0) return null;
    const last = completed[completed.length - 1];
    const prev = completed[completed.length - 2];
    let best: { cat: string; delta: number; prevTotal: number; curTotal: number } | null = null;
    for (const cat of catNames) {
      const curTotal = Number(last[cat] ?? 0);
      const prevTotal = Number(prev[cat] ?? 0);
      if (prevTotal < 3000) continue;
      const delta = curTotal - prevTotal;
      if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { cat, delta, prevTotal, curTotal };
    }
    if (!best || Math.abs(best.delta) < 3000) return null;
    const rising = best.delta > 0;
    const seedKey = `${best.cat}:${last.month}`;
    const variants = rising
      ? [
          `${best.cat} rose to ${formatCurrency(best.curTotal)}, up from ${formatCurrency(best.prevTotal)}.`,
          `Biggest mover: ${best.cat}, up ${formatCurrency(best.delta)}.`,
        ]
      : [
          `${best.cat} fell to ${formatCurrency(best.curTotal)}, down from ${formatCurrency(best.prevTotal)}.`,
          `Biggest mover: ${best.cat}, down ${formatCurrency(Math.abs(best.delta))}.`,
        ];
    return { text: `${formatMonthLabel(last.month)} vs ${formatMonthLabel(prev.month)}: ${variants[pickVariantIndex(seedKey, variants.length)]}`, rising };
  }, [stacked, catNames]);

  const ids = viewMode === "global" ? (unlockedProfileIds.length > 0 ? unlockedProfileIds : [profileId]) : [profileId];
  const ph = ids.map(() => "?").join(",");

  // -- Chart drill-downs ----------------------------------------------------
  const [expandedMonth, setExpandedMonth] = useState<string | null>(null);
  const [expandedMonthCats, setExpandedMonthCats] = useState<{ name: string; color: string; total: number }[] | null>(null);
  const [expandedCatName, setExpandedCatName] = useState<string | null>(null);

  const toggleMonthExpand = async (month: string) => {
    if (expandedMonth === month) { setExpandedMonth(null); setExpandedMonthCats(null); return; }
    setExpandedMonth(month);
    setExpandedMonthCats(null);
    const db = await getDb();
    const [y, m] = month.split("-").map(Number);
    const start = `${y}-${String(m).padStart(2, "0")}-01`;
    const end = new Date(y, m, 1).toISOString().split("T")[0];
    const rows = await db.select<{ name: string; color: string; total: number }[]>(
      `SELECT c.name, c.color, ${categorySpendSql()} as total
       FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
       JOIN accounts a ON a.id=t.account_id
       WHERE t.date>=? AND t.date<? AND t.profile_id IN (${ph})
         AND (t.category_id IS NULL OR t.category_id NOT IN (20,29))
       GROUP BY t.category_id ORDER BY total DESC LIMIT 3`,
      [start, end, ...ids]
    );
    setExpandedMonthCats(rows);
  };

  const toggleCatSegmentExpand = (cat: string) => {
    setExpandedCatName((cur) => (cur === cat ? null : cat));
  };

  /** Toggles the per-account balance breakdown for a month - purely a lookup into data that's
   *  already loaded (no query needed), since each account's line is already plotted client-side. */
  const toggleBalanceMonthExpand = (month: string) => {
    setExpandedBalanceMonth((cur) => (cur === month ? null : month));
  };

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const db = await getDb();

      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - (range - 1));
      const start = d.toISOString().split("T")[0];

      const [incExpRows, catRows, allTimeRow, cumRows, balanceRows, balanceAcctRows] = await Promise.all([
        db.select<{ month: string; income: number; expenses: number }[]>(
          `SELECT strftime('%Y-%m', t.date) as month,
                  ${incomeSumSql()} as income,
                  ${expenseSumSql()} as expenses
           FROM transactions t JOIN accounts a ON a.id=t.account_id
           WHERE t.date>=? AND t.profile_id IN (${ph})
           GROUP BY month ORDER BY month`,
          [start, ...ids]
        ),
        db.select<CatMonthRow[]>(
          `SELECT strftime('%Y-%m', t.date) as month, c.name as category, c.color, t.category_id as categoryId,
                  ${categorySpendSql()} as total
           FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
           JOIN accounts a ON a.id=t.account_id
           WHERE t.date>=? AND t.profile_id IN (${ph})
             AND (t.category_id IS NULL OR t.category_id NOT IN (20,29))
           GROUP BY month, t.category_id ORDER BY month`,
          [start, ...ids]
        ),
        db.select<{ income: number; expenses: number }[]>(
          `SELECT
             ${incomeSumSql()} as income,
             ${expenseSumSql()} as expenses
           FROM transactions t JOIN accounts a ON a.id=t.account_id
           WHERE t.profile_id IN (${ph})`,
          [...ids]
        ),
        db.select<{ month: string; net: number }[]>(
          `SELECT strftime('%Y-%m', t.date) as month,
             ${incomeSumSql()} - ${expenseSumSql()} as net
           FROM transactions t JOIN accounts a ON a.id=t.account_id
           WHERE t.profile_id IN (${ph})
           GROUP BY month ORDER BY month`,
          [...ids]
        ),
        db.select<{ date: string; account_id: number; balance_cents: number }[]>(
          `SELECT t.date, t.account_id, t.balance_cents FROM transactions t
           JOIN accounts a ON a.id=t.account_id
           WHERE t.profile_id IN (${ph}) AND t.balance_cents IS NOT NULL AND a.account_type IN ('checking','credit') AND a.hidden_from_dashboard=0
           ORDER BY t.date ASC, t.id ASC`,
          [...ids]
        ),
        db.select<{ id: number; name: string; account_type: string }[]>(
          `SELECT id, name, account_type FROM accounts WHERE profile_id IN (${ph}) AND account_type IN ('checking','credit') AND hidden_from_dashboard=0 ORDER BY account_type, name`,
          [...ids]
        ),
      ]);

      if (cancelled) return;

      setMonthly(incExpRows);
      setAllTimeIncome(allTimeRow[0]?.income ?? 0);
      setAllTimeExpenses(allTimeRow[0]?.expenses ?? 0);

      // Build cumulative running total
      let running = 0;
      setCumulativeData(cumRows.map(r => { running += r.net; return { month: r.month, net: r.net, running }; }));

      // Checking accounts combine into one line (there's usually just one); credit cards stay
      // separate per-account, downsampled to the last known balance of each month, so e.g. two
      // credit cards are drawn as two distinct lines instead of being summed with checking.
      const checkingIds = new Set(balanceAcctRows.filter((a) => a.account_type === "checking").map((a) => a.id));
      const creditAccountsMeta = balanceAcctRows
        .filter((a) => a.account_type === "credit")
        .map((a, i) => ({ id: a.id, name: a.name, color: accountChartColor(i) }));
      setCreditBalanceAccounts(creditAccountsMeta);

      const combinedChecking = combineAccountBalances(balanceRows.filter((r) => checkingIds.has(r.account_id)));
      const lastCheckingPerMonth = new Map<string, number>();
      for (const r of combinedChecking) lastCheckingPerMonth.set(r.date.slice(0, 7), r.balance_cents);
      setCheckingBalanceMonthly(
        [...lastCheckingPerMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, balance]) => ({ month, balance }))
      );

      const separatedCredit = separateAccountBalances(balanceRows.filter((r) => !checkingIds.has(r.account_id)));
      const lastCreditPerMonth = new Map<string, Record<number, number>>();
      for (const r of separatedCredit) lastCreditPerMonth.set(r.date.slice(0, 7), r.byAccount);
      setCreditBalanceMonthly(
        [...lastCreditPerMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, byAccount]) => {
          const row: CreditBalanceMonthRow = { month };
          // Kept in cents (not dollars) to match this chart's existing YAxis/Tooltip formatting.
          for (const acc of creditAccountsMeta) row[String(acc.id)] = byAccount[acc.id] ?? 0;
          return row;
        })
      );

      // Bucket categories
      const TOP_N = 6;
      const catTotals: Record<string, number> = {};
      catRows.forEach(r => { catTotals[r.category] = (catTotals[r.category] ?? 0) + r.total; });
      const topCats = Object.entries(catTotals).sort(([,a],[,b]) => b-a).slice(0,TOP_N).map(([n]) => n);
      const topSet = new Set(topCats);
      const hasOther = catRows.some(r => !topSet.has(r.category));
      const colorMap: Record<string, string> = {};
      catRows.forEach(r => { if (topSet.has(r.category)) colorMap[r.category] = r.color; });
      if (hasOther) colorMap["Other"] = "#9ca3af";
      setCatColors(colorMap);
      const idMap: Record<string, number | null> = {};
      catRows.forEach(r => { if (topSet.has(r.category)) idMap[r.category] = r.categoryId; });
      setCatIds(idMap);
      setCatNames([...topCats, ...(hasOther ? ["Other"] : [])]);
      const byMonth: Record<string, StackedRow> = {};
      catRows.forEach(r => {
        if (!byMonth[r.month]) byMonth[r.month] = { month: r.month };
        const key = topSet.has(r.category) ? r.category : "Other";
        byMonth[r.month][key] = ((byMonth[r.month][key] as number) ?? 0) + r.total;
      });
      setStacked(Object.values(byMonth).sort((a,b) => String(a.month).localeCompare(String(b.month))));
      setLoading(false);
    }
    load().catch(handleLoadFailure("your trends", setLoading));
    return () => { cancelled = true; };
  }, [range, profileId, viewMode, unlockedProfileIds]);

  const hasData = monthly.length > 0;
  const allTimeNet = allTimeIncome - allTimeExpenses;
  const tooltipStyle = { backgroundColor:"hsl(var(--background))",border:"1px solid hsl(var(--border))",borderRadius:"8px",fontSize:"12px",boxShadow:"var(--shadow-raised)" };

  // Header readouts: each section carries its own figure so a heading is never just a label.
  const currentMonthKey = useMemo(() => {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  }, []);
  const avgMonthlyNet = useMemo(() => {
    const complete = monthly.filter((m) => m.month < currentMonthKey);
    if (complete.length === 0) return null;
    return Math.round(complete.reduce((s, m) => s + (m.income - m.expenses), 0) / complete.length);
  }, [monthly, currentMonthKey]);
  const topCategoryOfRange = useMemo(() => {
    let best: { name: string; total: number } | null = null;
    for (const cat of catNames) {
      if (cat === "Other") continue;
      const total = stacked.reduce((s, row) => s + Number(row[cat] ?? 0), 0);
      if (!best || total > best.total) best = { name: cat, total };
    }
    return best;
  }, [stacked, catNames]);
  const latestChecking = checkingBalanceMonthly.length > 0 ? checkingBalanceMonthly[checkingBalanceMonthly.length - 1] : null;
  const latestCreditTotal = useMemo(() => {
    if (creditBalanceMonthly.length === 0 || creditBalanceAccounts.length === 0) return null;
    const last = creditBalanceMonthly[creditBalanceMonthly.length - 1];
    return creditBalanceAccounts.reduce((s, a) => s + Number(last[String(a.id)] ?? 0), 0);
  }, [creditBalanceMonthly, creditBalanceAccounts]);
  const firstMonthOnRecord = cumulativeData.length > 0 ? cumulativeData[0].month : null;

  return (
    <>
      {pinTarget && <PinModal profile={pinTarget} onSuccess={() => advancePinQueue(pinTarget.id)} onCancel={() => advancePinQueue()} />}

      <div className="workspace-page space-y-6 trends-workspace">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h1 className="text-2xl font-semibold">Spending Trends</h1>
          <div className="flex items-center gap-3 flex-wrap">
            {/* Scope toggle */}
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold select-none" style={{ color: viewMode !== "profile" ? "hsl(var(--muted-foreground))" : "hsl(var(--gold-ink))", transition:"color 0.3s" }}>Profile</span>
              <ScopeToggle isGlobal={viewMode === "global"} onToggle={() => viewMode === "global" ? handleSwitchToProfile() : handleSwitchToGlobal()} />
              <span className="text-sm font-semibold select-none" style={{ color: viewMode === "global" ? "var(--gold)" : "hsl(var(--muted-foreground))", transition:"color 0.3s" }}>Global</span>
            </div>
            {/* Range: the same segmented control the rest of the workspace uses */}
            <div className="workspace-segments" role="group" aria-label="Range">
              {RANGE_OPTIONS.map(r => (
                <button key={r} onClick={() => setRange(r)} aria-pressed={range === r}>
                  {r}mo
                </button>
              ))}
            </div>
          </div>
        </div>

        {loading && (
          <div className="space-y-6">
            <Skeleton className="h-28 rounded-xl" />
            <Skeleton className="h-48 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        )}

        {!loading && !hasData && (
          <p className="text-[hsl(var(--muted-foreground))] text-center mt-16">
            Nothing in the log yet. <Link to="/import" className="text-[hsl(var(--gold-ink))] hover:underline">Import a statement</Link> and the record starts here.
          </p>
        )}

        {!loading && hasData && (
          <>
            {/* The voyage so far: everything the log records, in one figure and one line */}
            <header className="trends-hero">
              <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
                <div>
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">
                    {firstMonthOnRecord ? `The log since ${formatMonthLabel(firstMonthOnRecord)}` : "All time"}, net of everything in and out
                  </p>
                  <p className="hero-figure" data-size="xl" style={{ color: allTimeNet >= 0 ? "hsl(var(--gold-ink))" : "hsl(var(--error))" }}>
                    {formatCurrency(allTimeNet)}
                  </p>
                </div>
                <dl className="trends-hero-stats">
                  <div>
                    <dt>Came in</dt>
                    <dd className="text-[hsl(var(--success))]">{formatCurrency(allTimeIncome)}</dd>
                  </div>
                  <div>
                    <dt>Went out</dt>
                    <dd className="text-[hsl(var(--error))]">{formatCurrency(allTimeExpenses)}</dd>
                  </div>
                </dl>
              </div>
              {cumulativeData.length >= 2 && (
                <ResponsiveContainer width="100%" height={190}>
                  <AreaChart data={cumulativeData} margin={{ left: 8, right: 8, top: 16, bottom: 0 }}>
                    <defs>
                      <linearGradient id="voyage-fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.32} />
                        <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickFormatter={formatMonthLabel} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={formatAxisCurrency} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} width={64} />
                    <Tooltip contentStyle={tooltipStyle} labelFormatter={(l) => formatMonthLabel(String(l))} formatter={(v) => [formatCurrency(v as number), "Running net"]} />
                    <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="3 3" />
                    <Area type="monotone" dataKey="running" stroke="hsl(var(--gold-ink))" strokeWidth={2} fill="url(#voyage-fill)" dot={false}
                      activeDot={{ r: 3, fill: "hsl(var(--gold-ink))", stroke: "hsl(var(--surface))" }} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </header>

            {categoryTrendNarrative && (
              <p className="trends-note">
                {categoryTrendNarrative.rising
                  ? <TrendUpIcon size={15} className="shrink-0 mt-0.5 text-[hsl(var(--warning))]" />
                  : <TrendDownIcon size={15} className="shrink-0 mt-0.5 text-[hsl(var(--success))]" />}
                <span>{categoryTrendNarrative.text}</span>
              </p>
            )}

            {/* The monthly rhythm: in against out. Gold top rule marks a section you can click into. */}
            <section className="trend-section" data-drill>
              <div className="trend-section-head">
                <div>
                  <h2 className="font-semibold">The monthly rhythm</h2>
                  <p className="trend-kicker">Money in against money out, last {range} months. Click a month for its top categories.</p>
                </div>
                {avgMonthlyNet !== null && (
                  <p className="trend-readout">
                    <strong className={avgMonthlyNet >= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--error))]"}>{formatCurrency(avgMonthlyNet)}</strong>
                    <small>kept in a typical month</small>
                  </p>
                )}
              </div>
              <div className="trend-legend" aria-hidden="true">
                <span><i style={{ background: "hsl(var(--success))" }} /> In</span>
                <span><i style={{ background: "hsl(var(--error))" }} /> Out</span>
              </div>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart
                  data={monthly}
                  margin={{ left:8,right:8,top:4,bottom:4 }}
                  onClick={(state) => {
                    const label = state?.activeLabel as string | undefined;
                    if (label) toggleMonthExpand(label);
                  }}
                >
                  <XAxis dataKey="month" tick={{ fontSize:11, fill: "hsl(var(--muted-foreground))" }} tickFormatter={formatMonthLabel} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={formatAxisCurrency} tick={{ fontSize:11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} width={64} />
                  <Tooltip cursor={false} contentStyle={tooltipStyle} labelFormatter={(l) => formatMonthLabel(String(l))} formatter={v => formatCurrency(v as number)} />
                  <Bar dataKey="income" name="Income" fill="hsl(var(--success))" radius={[4,4,0,0]} cursor="pointer" background={false} activeBar={{ fill: "hsl(var(--success) / 0.75)" }} />
                  <Bar dataKey="expenses" name="Expenses" fill="hsl(var(--error))" radius={[4,4,0,0]} cursor="pointer" background={false} activeBar={{ fill: "hsl(var(--error) / 0.75)" }} />
                </BarChart>
              </ResponsiveContainer>

              <AnimatePresence initial={false} mode="wait">
                {expandedMonth && (
                  <motion.div
                    key={expandedMonth}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18 }}
                  >
                    <div className="mt-1 pt-3 border-t">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs font-semibold">Top categories - {formatMonthLabel(expandedMonth)}</p>
                        <Link to="/transactions" state={{ month: expandedMonth }} className="text-[11px] text-[hsl(var(--gold-ink))] hover:underline">
                          View month
                        </Link>
                      </div>
                      {expandedMonthCats === null ? (
                        <p className="text-xs text-[hsl(var(--muted-foreground))] py-2">Loading…</p>
                      ) : expandedMonthCats.length === 0 ? (
                        <p className="text-xs text-[hsl(var(--muted-foreground))] py-2">No expenses that month.</p>
                      ) : (
                        <div className="space-y-1">
                          {expandedMonthCats.map((c) => (
                            <div key={c.name} className="flex items-center justify-between text-xs py-1">
                              <span className="flex items-center gap-1.5 text-[hsl(var(--muted-foreground))]">
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
                                {c.name}
                              </span>
                              <span>{formatCurrency(c.total)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </section>

            {/* Where it went: the same months, cut by category */}
            {stacked.length > 0 && catNames.length > 0 && (
              <section className="trend-section" data-drill>
                <div className="trend-section-head">
                  <div>
                    <h2 className="font-semibold">Where it went</h2>
                    <p className="trend-kicker">The top categories stacked month by month. Pick a category, in the chart or below it, to follow its line.</p>
                  </div>
                  {topCategoryOfRange && (
                    <p className="trend-readout">
                      <strong>{topCategoryOfRange.name}</strong>
                      <small>{formatCurrency(topCategoryOfRange.total)} over {range} months</small>
                    </p>
                  )}
                </div>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={stacked} margin={{ left:8,right:8,top:4,bottom:4 }}>
                    <XAxis dataKey="month" tick={{ fontSize:11, fill: "hsl(var(--muted-foreground))" }} tickFormatter={formatMonthLabel} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={formatAxisCurrency} tick={{ fontSize:11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} width={64} />
                    <Tooltip cursor={false} contentStyle={tooltipStyle} labelFormatter={(l) => formatMonthLabel(String(l))} formatter={v => formatCurrency(v as number)} />
                    {catNames.map(cat => (
                      <Bar
                        key={cat}
                        dataKey={cat}
                        stackId="cats"
                        fill={catColors[cat] ?? "#9ca3af"}
                        cursor="pointer"
                        background={false}
                        activeBar={{ fill: lightenHex(catColors[cat] ?? "#9ca3af") }}
                        onClick={() => toggleCatSegmentExpand(cat)}
                        opacity={expandedCatName && expandedCatName !== cat ? 0.4 : 1}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
                <div className="trend-chips" role="group" aria-label="Categories">
                  {catNames.map((cat) => (
                    <button
                      key={cat}
                      onClick={() => toggleCatSegmentExpand(cat)}
                      aria-pressed={expandedCatName === cat}
                    >
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: catColors[cat] ?? "#9ca3af" }} />
                      {cat}
                    </button>
                  ))}
                </div>

                <AnimatePresence initial={false} mode="wait">
                  {expandedCatName && (
                    <motion.div
                      key={expandedCatName}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.18 }}
                    >
                      <div className="mt-1 pt-3 border-t">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs font-semibold flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: catColors[expandedCatName] ?? "#9ca3af" }} />
                            {expandedCatName} trend
                          </p>
                          {catIds[expandedCatName] !== undefined && (
                            <Link
                              to="/transactions"
                              state={{ category: catIds[expandedCatName] }}
                              className="text-[11px] text-[hsl(var(--gold-ink))] hover:underline"
                            >
                              View all
                            </Link>
                          )}
                        </div>
                        <div className="space-y-1">
                          {stacked.map((row) => {
                            const amt = (row[expandedCatName] as number | undefined) ?? 0;
                            if (amt === 0) return null;
                            return (
                              <div key={row.month} className="flex items-center justify-between text-xs py-1">
                                <span className="text-[hsl(var(--muted-foreground))]">{formatMonthLabel(row.month)}</span>
                                <span>{formatCurrency(amt)}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </section>
            )}

            {/* Cash on hand: end-of-month checking balance, whole record */}
            {checkingBalanceMonthly.length >= 2 && (
              <section className="trend-section">
                <div className="trend-section-head">
                  <div>
                    <h2 className="font-semibold">Cash on hand</h2>
                    <p className="trend-kicker">End-of-month checking balance, every month on record.</p>
                  </div>
                  {latestChecking && (
                    <p className="trend-readout">
                      <strong>{formatCurrency(latestChecking.balance)}</strong>
                      <small>as of {formatMonthLabel(latestChecking.month)}</small>
                    </p>
                  )}
                </div>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={checkingBalanceMonthly} margin={{ left:8,right:8,top:4,bottom:4 }}>
                    <XAxis dataKey="month" tick={{ fontSize:11, fill: "hsl(var(--muted-foreground))" }} tickFormatter={formatMonthLabel} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={formatAxisCurrency} tick={{ fontSize:11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} width={64} />
                    <Tooltip contentStyle={tooltipStyle} labelFormatter={(l) => formatMonthLabel(String(l))} formatter={v => [formatCurrency(v as number), "Balance"]} />
                    <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="3 3" />
                    <Line type="monotone" dataKey="balance" name="Balance" stroke="hsl(var(--sea))" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </section>
            )}

            {/* What the cards carry: each card's balance line, kept apart from cash */}
            {creditBalanceMonthly.length >= 2 && (
              <section className="trend-section" data-drill>
                <div className="trend-section-head">
                  <div>
                    <h2 className="font-semibold">What the cards carry</h2>
                    <p className="trend-kicker">Each card's end-of-month balance, shown separately - debt counts against its own line. Click a point for the per-card breakdown.</p>
                  </div>
                  {latestCreditTotal !== null && (
                    <p className="trend-readout">
                      <strong className={latestCreditTotal < 0 ? "text-[hsl(var(--error))]" : undefined}>{formatCurrency(latestCreditTotal)}</strong>
                      <small>across {creditBalanceAccounts.length === 1 ? "1 card" : `${creditBalanceAccounts.length} cards`} right now</small>
                    </p>
                  )}
                </div>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart
                    data={creditBalanceMonthly}
                    margin={{ left:8,right:8,top:4,bottom:4 }}
                    onClick={(state) => {
                      const label = state?.activeLabel as string | undefined;
                      if (label) toggleBalanceMonthExpand(label);
                    }}
                  >
                    <XAxis dataKey="month" tick={{ fontSize:11, fill: "hsl(var(--muted-foreground))" }} tickFormatter={formatMonthLabel} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={formatAxisCurrency} tick={{ fontSize:11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} width={64} />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      labelFormatter={(l) => formatMonthLabel(String(l))}
                      formatter={(v, name) => [formatCurrency(v as number), creditBalanceAccounts.find(a => String(a.id) === name)?.name ?? name]}
                    />
                    <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="3 3" />
                    {creditBalanceAccounts.map((acc) => (
                      <Line key={acc.id} type="monotone" dataKey={String(acc.id)} name={acc.name}
                        stroke={acc.color} strokeWidth={2} dot={false} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>

                {creditBalanceAccounts.length > 1 && (
                  <div className="flex flex-wrap gap-3 mt-3">
                    {creditBalanceAccounts.map((acc) => (
                      <span key={acc.id} className="flex items-center gap-1.5 text-[10px] text-[hsl(var(--muted-foreground))]">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: acc.color }} />
                        {acc.name}
                      </span>
                    ))}
                  </div>
                )}

                <AnimatePresence initial={false} mode="wait">
                  {expandedBalanceMonth && (
                    <motion.div
                      key={expandedBalanceMonth}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.18 }}
                    >
                      <div className="mt-3 pt-3 border-t">
                        <p className="text-xs font-semibold mb-2">{formatMonthLabel(expandedBalanceMonth)}</p>
                        <div className="space-y-1">
                          {creditBalanceAccounts.map((acc) => {
                            const row = creditBalanceMonthly.find((r) => r.month === expandedBalanceMonth);
                            const cents = row ? Number(row[String(acc.id)]) : null;
                            if (cents === null) return null;
                            return (
                              <div key={acc.id} className="flex items-center justify-between text-xs py-1">
                                <span className="flex items-center gap-1.5 text-[hsl(var(--muted-foreground))]">
                                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: acc.color }} />
                                  {acc.name}
                                </span>
                                <span className={cents < 0 ? "text-[hsl(var(--error))] font-medium" : "font-medium"}>{formatCurrency(cents)}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}
