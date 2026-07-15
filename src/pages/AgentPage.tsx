import { useState, useEffect, useMemo, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { getDb } from "@/lib/db";
import { formatCurrency } from "@/lib/utils";
import { useProfileStore } from "@/stores/profileStore";
import { generateInsights, getSpendingProfile, getSavingsHistory } from "@/lib/agent";
import type { Insight, Profile } from "@/lib/types";
import InsightCard from "@/components/InsightCard";
import PinModal from "@/components/PinModal";

interface SubItem {
  description: string;
  amount_cents: number;
  month_count: number;
  category_name: string;
  category_color: string;
}

interface CatDelta {
  category_name: string;
  category_color: string;
  this_month: number;
  last_month: number;
  delta_pct: number;
}

function currentYM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
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

function viewKey(profileId: number) { return `compass_insight_view_${profileId}`; }

function loadExpandedSections(): { trends: boolean; subs: boolean } {
  try {
    const saved = localStorage.getItem("compass_insight_sections");
    return saved ? JSON.parse(saved) : { trends: false, subs: false };
  } catch { return { trends: false, subs: false }; }
}

interface ScopeToggleProps { isGlobal: boolean; onToggle: () => void; }
function ScopeToggle({ isGlobal, onToggle }: ScopeToggleProps) {
  return (
    <button role="switch" aria-checked={isGlobal} onClick={onToggle}
      style={{
        width: 52, height: 28, borderRadius: 14, padding: 3,
        backgroundColor: isGlobal ? "#C08A1C" : "#3b82f6",
        transition: "background-color 0.3s",
        cursor: "pointer", display: "inline-flex", alignItems: "center",
        border: "none", flexShrink: 0, boxShadow: "inset 0 1px 3px rgba(0,0,0,0.18)",
      }}>
      <div style={{
        width: 22, height: 22, borderRadius: 11, backgroundColor: "white",
        transition: "transform 0.25s cubic-bezier(0.4,0,0.2,1)",
        transform: isGlobal ? "translateX(24px)" : "translateX(0)",
        boxShadow: "0 1px 4px rgba(0,0,0,0.28)", flexShrink: 0,
      }} />
    </button>
  );
}

interface CollapsibleSectionProps {
  title: string;
  subtitle?: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}
function CollapsibleSection({ title, subtitle, expanded, onToggle, children }: CollapsibleSectionProps) {
  return (
    <section className="border rounded-xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-5 py-3.5 bg-[hsl(var(--muted))] flex items-center justify-between
                   hover:bg-[hsl(var(--muted))/80] transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <h2 className="font-semibold text-sm">{title}</h2>
          {subtitle && <span className="text-xs text-[hsl(var(--muted-foreground))]">{subtitle}</span>}
        </div>
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {expanded && children}
    </section>
  );
}

export default function AgentPage() {
  const navigate = useNavigate();
  const { activeProfile, profiles, unlockedIds, unlockProfile, dismissedInsights, clearDismissed } = useProfileStore();
  const profileId = activeProfile?.id ?? 1;

  const [viewMode, setViewMode] = useState<"profile" | "global">(() => {
    const saved = localStorage.getItem(viewKey(activeProfile?.id ?? 1));
    return saved === "global" ? "global" : "profile";
  });
  const [pinQueue, setPinQueue] = useState<Profile[]>([]);
  const [pinQueueIdx, setPinQueueIdx] = useState(0);

  const [loading, setLoading] = useState(true);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [savingsHistory, setSavingsHistory] = useState<{ month: string; rate: number; net: number }[]>([]);
  const [spendingProfile, setSpendingProfile] = useState<Awaited<ReturnType<typeof getSpendingProfile>>>(null);
  const [subscriptions, setSubscriptions] = useState<SubItem[]>([]);
  const [catDeltas, setCatDeltas] = useState<CatDelta[]>([]);
  const [hasEnoughData, setHasEnoughData] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [expanded, setExpanded] = useState<{ trends: boolean; subs: boolean }>(loadExpandedSections);

  useEffect(() => {
    const saved = localStorage.getItem(viewKey(profileId));
    setViewMode(saved === "global" ? "global" : "profile");
  }, [profileId]);

  const unlockedProfileIds = useMemo(
    () => profiles
      .filter((p) => !p.pin_hash || p.id === profileId || unlockedIds.has(p.id))
      .map((p) => p.id),
    [profiles, profileId, unlockedIds]
  );

  const handleSwitchToGlobal = () => {
    const locked = profiles.filter(
      (p) => p.pin_hash && p.id !== profileId && !unlockedIds.has(p.id)
    );
    if (locked.length > 0) { setPinQueue(locked); setPinQueueIdx(0); }
    else { localStorage.setItem(viewKey(profileId), "global"); setViewMode("global"); }
  };

  const handleSwitchToProfile = () => {
    localStorage.setItem(viewKey(profileId), "profile"); setViewMode("profile");
  };

  const advancePinQueue = (unlockedId?: number) => {
    if (unlockedId !== undefined) unlockProfile(unlockedId);
    const next = pinQueueIdx + 1;
    if (next >= pinQueue.length) {
      setPinQueue([]); setPinQueueIdx(0);
      localStorage.setItem(viewKey(profileId), "global"); setViewMode("global");
    } else { setPinQueueIdx(next); }
  };

  const toggleSection = useCallback((key: "trends" | "subs") => {
    setExpanded((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem("compass_insight_sections", JSON.stringify(next));
      return next;
    });
  }, []);

  const pinTarget = pinQueue.length > 0 && pinQueueIdx < pinQueue.length
    ? pinQueue[pinQueueIdx] : null;
  const lockedExcluded = viewMode === "global"
    ? profiles.filter((p) => p.pin_hash && p.id !== profileId && !unlockedIds.has(p.id))
    : [];

  useEffect(() => {
    if (!activeProfile) return;
    let cancelled = false;
    const ids = viewMode === "global"
      ? (unlockedProfileIds.length > 0 ? unlockedProfileIds : [profileId])
      : [profileId];

    async function load() {
      setLoading(true);
      const db = await getDb();
      const ph = ids.map(() => "?").join(",");

      const [allInsights, history, profile] = await Promise.all([
        generateInsights(ids),
        getSavingsHistory(ids, 12),
        getSpendingProfile(ids),
      ]);

      if (cancelled) return;

      if (!profile || history.length < 2) {
        setHasEnoughData(false); setLoading(false); return;
      }
      setHasEnoughData(true);
      setInsights(allInsights);
      setSavingsHistory(history);
      setSpendingProfile(profile);

      const thisMonth = currentYM();
      const lMonth = prevYM(thisMonth);
      const [ts, te] = monthBounds(thisMonth);
      const [ls, le] = monthBounds(lMonth);

      const [subs, thisCats, lastCats] = await Promise.all([
        db.select<SubItem[]>(
          `SELECT t.description, t.amount_cents,
                  COUNT(DISTINCT strftime('%Y-%m', t.date)) as month_count,
                  c.name as category_name, c.color as category_color
           FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
           WHERE t.profile_id IN (${ph}) AND t.amount_cents<0
             AND (t.category_id IS NULL OR t.category_id != 20)
           GROUP BY t.description, t.amount_cents HAVING month_count>=2
           ORDER BY month_count DESC, ABS(t.amount_cents) DESC LIMIT 10`,
          [...ids]
        ),
        db.select<{ category_id: number; category_name: string; category_color: string; total: number }[]>(
          `SELECT t.category_id, c.name as category_name, c.color as category_color,
                  SUM(ABS(t.amount_cents)) as total
           FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
           WHERE t.profile_id IN (${ph}) AND t.date>=? AND t.date<? AND t.amount_cents<0
             AND t.category_id!=15 AND (t.category_id IS NULL OR t.category_id != 20)
           GROUP BY t.category_id ORDER BY total DESC LIMIT 8`,
          [...ids, ts, te]
        ),
        db.select<{ category_id: number; total: number }[]>(
          `SELECT category_id, SUM(ABS(amount_cents)) as total
           FROM transactions
           WHERE profile_id IN (${ph}) AND date>=? AND date<? AND amount_cents<0
             AND (category_id IS NULL OR category_id != 20)
           GROUP BY category_id`,
          [...ids, ls, le]
        ),
      ]);

      if (cancelled) return;
      setSubscriptions(subs);

      const lastMap = new Map(lastCats.map((c) => [c.category_id, c.total]));
      setCatDeltas(thisCats.map((c) => {
        const prev = lastMap.get(c.category_id) ?? 0;
        return {
          category_name: c.category_name,
          category_color: c.category_color,
          this_month: c.total,
          last_month: prev,
          delta_pct: prev > 0 ? Math.round(((c.total - prev) / prev) * 100) : 100,
        };
      }));
      setRefreshedAt(new Date());
      setLoading(false);
    }

    load().catch(console.error);
    return () => { cancelled = true; };
  }, [profileId, activeProfile, viewMode, unlockedProfileIds]);

  const visibleInsights  = insights.filter((i) => !dismissedInsights.includes(i.dismissKey));
  const warningInsights  = visibleInsights.filter((i) => i.severity === "warning");
  const infoInsights     = visibleInsights.filter((i) => i.severity === "info");
  const successInsights  = visibleInsights.filter((i) => i.severity === "success");

  const handleApply = (insight: Insight) => {
    if (!insight.action) return;
    if (insight.action.type === "create_budget") {
      navigate("/budgets", { state: { prefillBudget: insight.action.payload } });
    } else { navigate("/goals"); }
  };

  // ── Header (shared across all render states) ──────────────────────────────
  const PageHeader = (
    <div className="sticky top-0 z-20 border-b px-8 py-4 flex items-center justify-between gap-6"
      style={{ backgroundColor: "hsl(var(--background))", backdropFilter: "blur(8px)" }}>
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Insights</h1>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
          {refreshedAt
            ? `Last updated ${refreshedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
            : "Rule-based analysis of your financial habits."}
        </p>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-sm font-semibold select-none"
          style={{ color: viewMode !== "profile" ? "hsl(var(--muted-foreground))" : "#3b82f6", transition: "color 0.3s" }}>
          Profile
        </span>
        <ScopeToggle
          isGlobal={viewMode === "global"}
          onToggle={() => viewMode === "global" ? handleSwitchToProfile() : handleSwitchToGlobal()}
        />
        <span className="text-sm font-semibold select-none"
          style={{ color: viewMode === "global" ? "#C08A1C" : "hsl(var(--muted-foreground))", transition: "color 0.3s" }}>
          Global
        </span>
      </div>
    </div>
  );

  if (loading) {
    return (
      <>
        {pinTarget && <PinModal profile={pinTarget} onSuccess={() => advancePinQueue(pinTarget.id)} onCancel={() => advancePinQueue()} />}
        {PageHeader}
        <div className="flex items-center justify-center py-24">
          <div className="flex flex-col items-center gap-3 text-[hsl(var(--muted-foreground))]">
            <div className="w-8 h-8 rounded-full border-2 border-current animate-spin" style={{ borderTopColor: "transparent" }} />
            <p className="text-sm">Analysing your data...</p>
          </div>
        </div>
      </>
    );
  }

  if (!hasEnoughData) {
    return (
      <>
        {pinTarget && <PinModal profile={pinTarget} onSuccess={() => advancePinQueue(pinTarget.id)} onCancel={() => advancePinQueue()} />}
        {PageHeader}
        <div className="p-8 max-w-xl mx-auto">
          <div className="border-2 border-dashed rounded-2xl p-16 text-center mt-8">
            <p className="text-4xl mb-4">📊</p>
            <p className="font-semibold text-lg mb-2">Not enough data yet</p>
            <p className="text-sm text-[hsl(var(--muted-foreground))] mb-6">
              Import at least 2 months of transactions to unlock all insights, spending profiles, and trend analysis.
            </p>
            <Link to="/import"
              className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm font-medium">
              Import Transactions
            </Link>
          </div>
        </div>
      </>
    );
  }

  const totalSubCost = subscriptions.reduce((s, r) => s + Math.abs(r.amount_cents), 0);
  const annualSubCost = totalSubCost * 12;
  const avgSavingsRatePct = spendingProfile ? Math.round(spendingProfile.avgSavingsRate * 100) : 0;

  return (
    <>
      {pinTarget && <PinModal profile={pinTarget} onSuccess={() => advancePinQueue(pinTarget.id)} onCancel={() => advancePinQueue()} />}
      {PageHeader}

      <div className="p-6 max-w-3xl space-y-6 mx-auto w-full">

        {/* Locked-profile notice */}
        {lockedExcluded.length > 0 && (
          <div className="rounded-2xl px-5 py-3 flex flex-col gap-2"
            style={{ border: "1px solid rgba(245,158,11,0.35)", backgroundColor: "rgba(245,158,11,0.07)" }}>
            <p className="text-sm font-semibold" style={{ color: "#b45309" }}>
              {lockedExcluded.length === 1 ? "1 profile is PIN-locked" : `${lockedExcluded.length} profiles are PIN-locked`}
              {" "}-- their data is excluded from global insights.
            </p>
            <div className="flex flex-wrap gap-2">
              {lockedExcluded.map((p) => (
                <button key={p.id} onClick={() => { setPinQueue([p]); setPinQueueIdx(0); }}
                  className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                  style={{ border: "1px solid rgba(245,158,11,0.5)", color: "#92400e", backgroundColor: "transparent" }}>
                  🔒 Unlock {p.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Global mode chip */}
        {viewMode === "global" && lockedExcluded.length === 0 && (
          <div className="rounded-2xl px-5 py-2.5 flex items-center gap-3"
            style={{ border: "1px solid rgba(192,138,28,0.35)", backgroundColor: "rgba(192,138,28,0.07)" }}>
            <span className="font-semibold text-sm" style={{ color: "#C08A1C" }}>Global view</span>
            <span className="text-xs text-[hsl(var(--muted-foreground))]">
              -- insights and data aggregated across {profiles.length} profile{profiles.length !== 1 ? "s" : ""}
            </span>
          </div>
        )}

        {/* ── Financial Health Summary (KPIs + sparkline) ── */}
        {spendingProfile && (
          <section className="border rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b bg-[hsl(var(--muted))/50]">
              <h2 className="font-semibold text-sm">Financial Health Summary</h2>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">
                Based on {spendingProfile.monthsAnalysed} months of data
              </p>
            </div>
            <div className="grid sm:grid-cols-[1fr_200px] divide-y sm:divide-y-0 sm:divide-x">
              {/* KPI tiles */}
              <div className="grid grid-cols-2 divide-x divide-y">
                {[
                  {
                    label: "Avg monthly income",
                    value: formatCurrency(spendingProfile.avgMonthlyIncome),
                    valueColor: "text-green-600",
                  },
                  {
                    label: "Avg monthly spend",
                    value: formatCurrency(spendingProfile.avgMonthlyExpenses),
                    valueColor: "text-red-500",
                  },
                  {
                    label: "Avg savings rate",
                    value: `${avgSavingsRatePct}%`,
                    valueColor: avgSavingsRatePct >= 20 ? "text-green-600" : avgSavingsRatePct >= 10 ? "text-amber-500" : "text-red-500",
                    sub: avgSavingsRatePct >= 20 ? "Healthy" : avgSavingsRatePct >= 10 ? "Building" : "Below target",
                  },
                  {
                    label: "Top spending category",
                    value: spendingProfile.topCategory,
                    valueColor: "text-[hsl(var(--foreground))]",
                  },
                ].map(({ label, value, valueColor, sub }) => (
                  <div key={label} className="px-4 py-4">
                    <p className="text-xs text-[hsl(var(--muted-foreground))] mb-1">{label}</p>
                    <p className={`text-base font-bold ${valueColor}`}>{value}</p>
                    {sub && <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">{sub}</p>}
                  </div>
                ))}
              </div>
              {/* Sparkline */}
              {savingsHistory.length >= 2 && (
                <div className="px-4 py-4">
                  <p className="text-xs text-[hsl(var(--muted-foreground))] mb-2">Savings rate (12 mo)</p>
                  <ResponsiveContainer width="100%" height={90}>
                    <LineChart data={savingsHistory} margin={{ left: 0, right: 4, top: 4, bottom: 0 }}>
                      <XAxis dataKey="month" tick={false} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 9 }} tickFormatter={(v: number) => `${v}%`} width={28} />
                      <Tooltip
                        formatter={(v) => [`${v ?? 0}%`, "Rate"]}
                        contentStyle={{
                          backgroundColor: "hsl(var(--background))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "6px",
                          fontSize: "11px",
                        }}
                      />
                      <ReferenceLine y={20} stroke="#f59e0b" strokeDasharray="3 3" />
                      <Line type="monotone" dataKey="rate" stroke="#6366f1" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                  <p className="text-[10px] text-[hsl(var(--muted-foreground))] mt-1 text-center">
                    Dashed = 20% target
                  </p>
                </div>
              )}
            </div>
          </section>
        )}

        {/* ── Insights ── */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-base">Insights</h2>
            {dismissedInsights.length > 0 && (
              <button onClick={clearDismissed}
                className="text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors">
                Restore {dismissedInsights.length} dismissed
              </button>
            )}
          </div>

          {visibleInsights.length === 0 && (
            <div className="border-2 border-dashed border-emerald-200 dark:border-emerald-900 rounded-xl py-10 text-center">
              <p className="text-3xl mb-3">🎉</p>
              <p className="font-semibold text-emerald-700 dark:text-emerald-400">All clear!</p>
              <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">
                No active insights. Your finances look healthy.
              </p>
            </div>
          )}

          {[
            { label: "Needs attention", items: warningInsights, count: warningInsights.length },
            { label: "Observations",   items: infoInsights,    count: infoInsights.length },
            { label: "Wins",           items: successInsights, count: successInsights.length },
          ].map(({ label, items, count }) =>
            count > 0 ? (
              <div key={label}>
                <div className="flex items-center gap-2 mb-2">
                  <p className="text-xs font-semibold text-[hsl(var(--muted-foreground))] uppercase tracking-wider">
                    {label}
                  </p>
                  <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]">
                    {count}
                  </span>
                </div>
                <div className="space-y-2">
                  {items.map((insight) => (
                    <InsightCard key={insight.id} insight={insight} onApply={handleApply} />
                  ))}
                </div>
              </div>
            ) : null
          )}
        </section>

        {/* ── Category Trends (collapsible) ── */}
        {catDeltas.length > 0 && (
          <CollapsibleSection
            title="Category Trends"
            subtitle="this vs last month"
            expanded={expanded.trends}
            onToggle={() => toggleSection("trends")}
          >
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="px-5 py-2.5 font-medium text-[hsl(var(--muted-foreground))]">Category</th>
                  <th className="px-5 py-2.5 font-medium text-[hsl(var(--muted-foreground))] text-right">This month</th>
                  <th className="px-5 py-2.5 font-medium text-[hsl(var(--muted-foreground))] text-right">Last month</th>
                  <th className="px-5 py-2.5 font-medium text-[hsl(var(--muted-foreground))] text-right">Change</th>
                </tr>
              </thead>
              <tbody>
                {catDeltas.map((r) => (
                  <tr key={r.category_name} className="border-b last:border-0 hover:bg-[hsl(var(--muted))]">
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: r.category_color }} />
                        {r.category_name}
                      </div>
                    </td>
                    <td className="px-5 py-2.5 text-right font-mono">{formatCurrency(r.this_month)}</td>
                    <td className="px-5 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                      {r.last_month > 0 ? formatCurrency(r.last_month) : "--"}
                    </td>
                    <td className={`px-5 py-2.5 text-right font-semibold ${
                      r.last_month === 0 ? "text-[hsl(var(--muted-foreground))]"
                      : r.delta_pct > 0  ? "text-red-500"
                      :                   "text-green-600"}`}>
                      {r.last_month === 0 ? "New" : `${r.delta_pct > 0 ? "+" : ""}${r.delta_pct}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CollapsibleSection>
        )}

        {/* ── Subscription Inventory (collapsible) ── */}
        {subscriptions.length > 0 && (
          <CollapsibleSection
            title="Subscription Inventory"
            subtitle={`~${formatCurrency(annualSubCost)}/year`}
            expanded={expanded.subs}
            onToggle={() => toggleSection("subs")}
          >
            <table className="w-full text-sm">
              <tbody>
                {subscriptions.map((s) => (
                  <tr key={`${s.description}_${s.amount_cents}`}
                    className="border-b last:border-0 hover:bg-[hsl(var(--muted))]">
                    <td className="px-5 py-2.5 max-w-xs truncate">{s.description}</td>
                    <td className="px-5 py-2.5">
                      <span className="text-xs px-2 py-0.5 rounded-full text-white"
                        style={{ backgroundColor: s.category_color ?? "#9ca3af" }}>
                        {s.category_name ?? "Uncategorized"}
                      </span>
                    </td>
                    <td className="px-5 py-2.5 text-[hsl(var(--muted-foreground))]">{s.month_count} months</td>
                    <td className="px-5 py-2.5 text-right font-mono text-red-500">
                      {formatCurrency(Math.abs(s.amount_cents))}/mo
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-5 py-3 border-t text-xs text-[hsl(var(--muted-foreground))]">
              {formatCurrency(totalSubCost)}/month · {formatCurrency(annualSubCost)}/year
            </div>
          </CollapsibleSection>
        )}

        <div className="h-6" />
      </div>
    </>
  );
}
