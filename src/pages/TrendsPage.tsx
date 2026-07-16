import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Legend, LineChart, Line, ReferenceLine,
} from "recharts";
import { motion, AnimatePresence } from "motion/react";
import { getDb } from "@/lib/db";
import { formatCurrency, combineAccountBalances } from "@/lib/utils";
import { useProfileStore } from "@/stores/profileStore";
import type { Profile } from "@/lib/types";
import PinModal from "@/components/PinModal";

interface MonthRow { month: string; income: number; expenses: number; }
interface CatMonthRow { month: string; category: string; color: string; categoryId: number | null; total: number; }
interface StackedRow { month: string; [cat: string]: string | number; }
interface CumulativeRow { month: string; net: number; running: number; }
interface BalanceMonthRow { month: string; balance: number; }

const RANGE_OPTIONS = [3, 6, 12];
const VIEW_KEY = "compass_trends_view";

function ScopeToggle({ isGlobal, onToggle }: { isGlobal: boolean; onToggle: () => void }) {
  return (
    <button role="switch" aria-checked={isGlobal} onClick={onToggle}
      style={{ width:52,height:28,borderRadius:14,padding:3,backgroundColor:isGlobal?"#C08A1C":"#3b82f6",transition:"background-color 0.3s",cursor:"pointer",display:"inline-flex",alignItems:"center",border:"none",flexShrink:0,boxShadow:"inset 0 1px 3px rgba(0,0,0,0.18)" }}>
      <div style={{ width:22,height:22,borderRadius:11,backgroundColor:"white",transition:"transform 0.25s cubic-bezier(0.4,0,0.2,1)",transform:isGlobal?"translateX(24px)":"translateX(0)",boxShadow:"0 1px 4px rgba(0,0,0,0.28)",flexShrink:0 }} />
    </button>
  );
}

export default function TrendsPage() {
  const [range, setRange] = useState(6);
  const [monthly, setMonthly] = useState<MonthRow[]>([]);
  const [stacked, setStacked] = useState<StackedRow[]>([]);
  const [catColors, setCatColors] = useState<Record<string, string>>({});
  const [catIds, setCatIds] = useState<Record<string, number | null>>({});
  const [catNames, setCatNames] = useState<string[]>([]);
  const [cumulativeData, setCumulativeData] = useState<CumulativeRow[]>([]);
  const [balanceMonthly, setBalanceMonthly] = useState<BalanceMonthRow[]>([]);
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

  const ids = viewMode === "global" ? (unlockedProfileIds.length > 0 ? unlockedProfileIds : [profileId]) : [profileId];
  const ph = ids.map(() => "?").join(",");

  // ── Chart drill-downs ────────────────────────────────────────────────────
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
      `SELECT c.name, c.color, SUM(ABS(t.amount_cents)) as total
       FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
       WHERE t.date>=? AND t.date<? AND t.amount_cents<0 AND t.profile_id IN (${ph})
         AND (t.category_id IS NULL OR t.category_id!=20)
       GROUP BY t.category_id ORDER BY total DESC LIMIT 3`,
      [start, end, ...ids]
    );
    setExpandedMonthCats(rows);
  };

  const toggleCatSegmentExpand = (cat: string) => {
    setExpandedCatName((cur) => (cur === cat ? null : cat));
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

      const [incExpRows, catRows, allTimeRow, cumRows, balanceRows] = await Promise.all([
        db.select<{ month: string; income: number; expenses: number }[]>(
          `SELECT strftime('%Y-%m', date) as month,
                  SUM(CASE WHEN amount_cents>0 AND (category_id IS NULL OR category_id!=20) THEN amount_cents ELSE 0 END) as income,
                  SUM(CASE WHEN amount_cents<0 AND (category_id IS NULL OR category_id!=20) THEN ABS(amount_cents) ELSE 0 END) as expenses
           FROM transactions WHERE date>=? AND profile_id IN (${ph})
           GROUP BY month ORDER BY month`,
          [start, ...ids]
        ),
        db.select<CatMonthRow[]>(
          `SELECT strftime('%Y-%m', t.date) as month, c.name as category, c.color, t.category_id as categoryId,
                  SUM(ABS(t.amount_cents)) as total
           FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
           WHERE t.date>=? AND t.amount_cents<0 AND t.profile_id IN (${ph})
             AND (t.category_id IS NULL OR t.category_id!=20)
           GROUP BY month, t.category_id ORDER BY month`,
          [start, ...ids]
        ),
        db.select<{ income: number; expenses: number }[]>(
          `SELECT
             SUM(CASE WHEN amount_cents>0 AND (category_id IS NULL OR category_id!=20) THEN amount_cents ELSE 0 END) as income,
             SUM(CASE WHEN amount_cents<0 AND (category_id IS NULL OR category_id!=20) THEN ABS(amount_cents) ELSE 0 END) as expenses
           FROM transactions WHERE profile_id IN (${ph})`,
          [...ids]
        ),
        db.select<{ month: string; net: number }[]>(
          `SELECT strftime('%Y-%m', date) as month,
             SUM(CASE WHEN amount_cents>0 AND (category_id IS NULL OR category_id!=20) THEN amount_cents ELSE 0 END)
             - SUM(CASE WHEN amount_cents<0 AND (category_id IS NULL OR category_id!=20) THEN ABS(amount_cents) ELSE 0 END) as net
           FROM transactions WHERE profile_id IN (${ph})
           GROUP BY month ORDER BY month`,
          [...ids]
        ),
        db.select<{ date: string; account_id: number; balance_cents: number }[]>(
          `SELECT t.date, t.account_id, t.balance_cents FROM transactions t
           JOIN accounts a ON a.id=t.account_id
           WHERE t.profile_id IN (${ph}) AND t.balance_cents IS NOT NULL AND a.account_type IN ('checking','credit')
           ORDER BY t.date ASC, t.id ASC`,
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

      // Combined checking + credit running balance (credit stored negative), downsampled to the
      // last known balance of each month so it lines up with the other monthly charts.
      const combinedBalance = combineAccountBalances(balanceRows);
      const lastPerMonth = new Map<string, number>();
      for (const r of combinedBalance) lastPerMonth.set(r.date.slice(0, 7), r.balance_cents);
      setBalanceMonthly([...lastPerMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, balance]) => ({ month, balance })));

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
    load().catch(console.error);
    return () => { cancelled = true; };
  }, [range, profileId, viewMode, unlockedProfileIds]);

  const hasData = monthly.length > 0;
  const allTimeNet = allTimeIncome - allTimeExpenses;
  const tooltipStyle = { backgroundColor:"hsl(var(--background))",border:"1px solid hsl(var(--border))",borderRadius:"8px",fontSize:"12px" };

  return (
    <>
      {pinTarget && <PinModal profile={pinTarget} onSuccess={() => advancePinQueue(pinTarget.id)} onCancel={() => advancePinQueue()} />}

      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h1 className="text-2xl font-semibold">Spending Trends</h1>
          <div className="flex items-center gap-3 flex-wrap">
            {/* Scope toggle */}
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold select-none" style={{ color: viewMode !== "profile" ? "hsl(var(--muted-foreground))" : "#3b82f6", transition:"color 0.3s" }}>Profile</span>
              <ScopeToggle isGlobal={viewMode === "global"} onToggle={() => viewMode === "global" ? handleSwitchToProfile() : handleSwitchToGlobal()} />
              <span className="text-sm font-semibold select-none" style={{ color: viewMode === "global" ? "#C08A1C" : "hsl(var(--muted-foreground))", transition:"color 0.3s" }}>Global</span>
            </div>
            {/* Range buttons */}
            <div className="flex gap-2">
              {RANGE_OPTIONS.map(r => (
                <button key={r} onClick={() => setRange(r)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${range===r ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]" : "border hover:bg-[hsl(var(--muted))]"}`}>
                  {r}mo
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* All-time summary tiles */}
        <div className="grid grid-cols-3 gap-3">
          <div className="border rounded-xl px-4 py-4 text-center">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))] mb-1">All-Time Income</p>
            <p className="text-xl font-bold text-green-600">{formatCurrency(allTimeIncome)}</p>
          </div>
          <div className="border rounded-xl px-4 py-4 text-center">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))] mb-1">All-Time Expenses</p>
            <p className="text-xl font-bold text-red-500">{formatCurrency(allTimeExpenses)}</p>
          </div>
          <div className="border rounded-xl px-4 py-4 text-center">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))] mb-1">All-Time Net</p>
            <p className={`text-xl font-bold ${allTimeNet >= 0 ? "text-green-600" : "text-red-500"}`}>{formatCurrency(allTimeNet)}</p>
          </div>
        </div>

        {loading && <p className="text-[hsl(var(--muted-foreground))]">Loading...</p>}

        {!loading && !hasData && (
          <p className="text-[hsl(var(--muted-foreground))] text-center mt-16">No data yet. Import a bank statement to see trends.</p>
        )}

        {!loading && hasData && (
          <>
            {/* Cumulative net */}
            {cumulativeData.length >= 2 && (
              <div className="border rounded-xl p-5">
                <h2 className="font-semibold mb-4">Cumulative Net (All Time)</h2>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={cumulativeData} margin={{ left:8,right:8,top:4,bottom:4 }}>
                    <XAxis dataKey="month" tick={{ fontSize:11 }} />
                    <YAxis tickFormatter={v => `$${Math.round(v/100)}`} tick={{ fontSize:11 }} />
                    <Tooltip contentStyle={tooltipStyle} formatter={v => formatCurrency(v as number)} />
                    <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="3 3" />
                    <Line type="monotone" dataKey="running" name="Running Net" stroke="#6366f1" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Running account balance - checking + credit combined, credit counts negative */}
            {balanceMonthly.length >= 2 && (
              <div className="border rounded-xl p-5">
                <h2 className="font-semibold mb-4">Account Balance (All Time)</h2>
                <p className="text-xs text-[hsl(var(--muted-foreground))] mb-4 -mt-2">Checking and credit card balances combined - credit card debt counts negatively against the total.</p>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={balanceMonthly} margin={{ left:8,right:8,top:4,bottom:4 }}>
                    <XAxis dataKey="month" tick={{ fontSize:11 }} />
                    <YAxis tickFormatter={v => `$${Math.round(v/100)}`} tick={{ fontSize:11 }} />
                    <Tooltip contentStyle={tooltipStyle} formatter={v => formatCurrency(v as number)} />
                    <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="3 3" />
                    <Line type="monotone" dataKey="balance" name="Balance" stroke="#3b82f6" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Income vs Expenses */}
            <div className="border rounded-xl p-5 chart-clickable">
              <h2 className="font-semibold mb-1">Income vs Expenses ({range}mo)</h2>
              <p className="text-[10px] text-[hsl(var(--muted-foreground))] mb-3">Click a month for its top categories</p>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart
                  data={monthly}
                  margin={{ left:8,right:8,top:4,bottom:4 }}
                  onClick={(state) => {
                    const label = state?.activeLabel as string | undefined;
                    if (label) toggleMonthExpand(label);
                  }}
                >
                  <XAxis dataKey="month" tick={{ fontSize:11 }} />
                  <YAxis tickFormatter={v => `$${Math.round(v/100)}`} tick={{ fontSize:11 }} />
                  <Tooltip contentStyle={tooltipStyle} formatter={v => formatCurrency(v as number)} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize:"11px",paddingTop:"8px" }} />
                  <Bar dataKey="income" name="Income" fill="#22c55e" radius={[4,4,0,0]} cursor="pointer" />
                  <Bar dataKey="expenses" name="Expenses" fill="#ef4444" radius={[4,4,0,0]} cursor="pointer" />
                </BarChart>
              </ResponsiveContainer>

              <AnimatePresence initial={false}>
                {expandedMonth && (
                  <motion.div
                    key={expandedMonth}
                    layout
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.25, ease: "easeOut" }}
                    className="overflow-hidden"
                  >
                    <div className="mt-1 pt-3 border-t">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs font-semibold">Top categories - {expandedMonth}</p>
                        <Link to="/transactions" state={{ month: expandedMonth }} className="text-[11px] text-[hsl(var(--primary))] hover:underline">
                          View month →
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
                              <span className="font-mono">{formatCurrency(c.total)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Stacked by category */}
            {stacked.length > 0 && catNames.length > 0 && (
              <div className="border rounded-xl p-5 chart-clickable">
                <h2 className="font-semibold mb-1">Spending by Category ({range}mo)</h2>
                <p className="text-[10px] text-[hsl(var(--muted-foreground))] mb-3">Click a category segment for its trend</p>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={stacked} margin={{ left:8,right:8,top:4,bottom:4 }}>
                    <XAxis dataKey="month" tick={{ fontSize:11 }} />
                    <YAxis tickFormatter={v => `$${Math.round(v/100)}`} tick={{ fontSize:11 }} />
                    <Tooltip contentStyle={tooltipStyle} formatter={v => formatCurrency(v as number)} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize:"11px",paddingTop:"8px",lineHeight:"20px" }} />
                    {catNames.map(cat => (
                      <Bar
                        key={cat}
                        dataKey={cat}
                        stackId="cats"
                        fill={catColors[cat] ?? "#9ca3af"}
                        cursor="pointer"
                        onClick={() => toggleCatSegmentExpand(cat)}
                        opacity={expandedCatName && expandedCatName !== cat ? 0.4 : 1}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>

                <AnimatePresence initial={false}>
                  {expandedCatName && (
                    <motion.div
                      key={expandedCatName}
                      layout
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: "easeOut" }}
                      className="overflow-hidden"
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
                              className="text-[11px] text-[hsl(var(--primary))] hover:underline"
                            >
                              View all →
                            </Link>
                          )}
                        </div>
                        <div className="space-y-1">
                          {stacked.map((row) => {
                            const amt = (row[expandedCatName] as number | undefined) ?? 0;
                            if (amt === 0) return null;
                            return (
                              <div key={row.month} className="flex items-center justify-between text-xs py-1">
                                <span className="text-[hsl(var(--muted-foreground))]">{row.month}</span>
                                <span className="font-mono">{formatCurrency(amt)}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
