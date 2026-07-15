import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { getDb } from "@/lib/db";
import { formatCurrency } from "@/lib/utils";
import { useProfileStore } from "@/stores/profileStore";
import { generateInsights, getSpendingProfile, getSavingsHistory } from "@/lib/agent";
import type { Insight } from "@/lib/types";
import InsightCard from "@/components/InsightCard";

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

export default function AgentPage() {
  const navigate = useNavigate();
  const { activeProfile, dismissedInsights, clearDismissed } = useProfileStore();
  const profileId = activeProfile?.id ?? 1;

  const [loading, setLoading] = useState(true);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [savingsHistory, setSavingsHistory] = useState<{ month: string; rate: number; net: number }[]>([]);
  const [spendingProfile, setSpendingProfile] = useState<Awaited<ReturnType<typeof getSpendingProfile>>>(null);
  const [subscriptions, setSubscriptions] = useState<SubItem[]>([]);
  const [catDeltas, setCatDeltas] = useState<CatDelta[]>([]);
  const [hasEnoughData, setHasEnoughData] = useState(true);

  useEffect(() => {
    if (!activeProfile) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      const db = await getDb();

      const [allInsights, history, profile] = await Promise.all([
        generateInsights(profileId),
        getSavingsHistory(profileId, 12),
        getSpendingProfile(profileId),
      ]);

      if (cancelled) return;

      if (!profile || history.length < 2) {
        setHasEnoughData(false);
        setLoading(false);
        return;
      }
      setHasEnoughData(true);
      setInsights(allInsights);
      setSavingsHistory(history);
      setSpendingProfile(profile);

      // Subscription inventory
      const subs = await db.select<SubItem[]>(
        `SELECT t.description, t.amount_cents,
                COUNT(DISTINCT strftime('%Y-%m', t.date)) as month_count,
                c.name as category_name, c.color as category_color
         FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
         WHERE t.profile_id=? AND t.amount_cents<0
         GROUP BY t.description, t.amount_cents HAVING month_count>=2
         ORDER BY month_count DESC, ABS(t.amount_cents) DESC LIMIT 10`,
        [profileId]
      );
      if (!cancelled) setSubscriptions(subs);

      // Category MoM deltas
      const thisMonth = currentYM();
      const lMonth = prevYM(thisMonth);
      const [ts, te] = monthBounds(thisMonth);
      const [ls, le] = monthBounds(lMonth);

      const [thisCats, lastCats] = await Promise.all([
        db.select<{ category_id: number; category_name: string; category_color: string; total: number }[]>(
          `SELECT t.category_id, c.name as category_name, c.color as category_color,
                  SUM(ABS(t.amount_cents)) as total
           FROM transactions t LEFT JOIN categories c ON t.category_id=c.id
           WHERE t.profile_id=? AND t.date>=? AND t.date<? AND t.amount_cents<0 AND t.category_id!=15
           GROUP BY t.category_id ORDER BY total DESC LIMIT 8`,
          [profileId, ts, te]
        ),
        db.select<{ category_id: number; total: number }[]>(
          `SELECT category_id, SUM(ABS(amount_cents)) as total
           FROM transactions WHERE profile_id=? AND date>=? AND date<? AND amount_cents<0
           GROUP BY category_id`,
          [profileId, ls, le]
        ),
      ]);

      const lastMap = new Map(lastCats.map((c) => [c.category_id, c.total]));
      const deltas: CatDelta[] = thisCats.map((c) => {
        const prev = lastMap.get(c.category_id) ?? 0;
        const delta_pct = prev > 0 ? Math.round(((c.total - prev) / prev) * 100) : 100;
        return {
          category_name: c.category_name,
          category_color: c.category_color,
          this_month: c.total,
          last_month: prev,
          delta_pct,
        };
      });
      if (!cancelled) setCatDeltas(deltas);
      setLoading(false);
    }

    load().catch(console.error);
    return () => { cancelled = true; };
  }, [profileId, activeProfile]);

  const visibleInsights = insights.filter((i) => !dismissedInsights.includes(i.dismissKey));
  const warningInsights = visibleInsights.filter((i) => i.severity === "warning");
  const infoInsights = visibleInsights.filter((i) => i.severity === "info");
  const successInsights = visibleInsights.filter((i) => i.severity === "success");

  const handleApply = async (insight: Insight) => {
    if (!insight.action) return;
    if (insight.action.type === "create_budget") {
      navigate("/budgets", { state: { prefillBudget: insight.action.payload } });
    } else {
      navigate("/goals");
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold mb-6">Agent</h1>
        <p className="text-[hsl(var(--muted-foreground))]">Analysing your data…</p>
      </div>
    );
  }

  if (!hasEnoughData) {
    return (
      <div className="p-6 max-w-2xl">
        <h1 className="text-2xl font-semibold mb-2">Agent</h1>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mb-8">
          Smart, rule-based analysis of your habits.
        </p>
        <div className="border-2 border-dashed rounded-xl p-14 text-center">
          <p className="font-medium mb-2">Not enough data yet</p>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mb-6">
            Import at least 2 months of transactions to unlock insights.
          </p>
          <Link
            to="/import"
            className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                       rounded-lg text-sm font-medium"
          >
            Import Transactions
          </Link>
        </div>
      </div>
    );
  }

  const totalSubCost = subscriptions.reduce((s, r) => s + Math.abs(r.amount_cents), 0);
  const annualSubCost = totalSubCost * 12;

  return (
    <div className="p-6 max-w-3xl space-y-8 mx-auto w-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Agent</h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
            Rule-based analysis of your financial habits.
          </p>
        </div>
        {dismissedInsights.length > 0 && (
          <button
            onClick={clearDismissed}
            className="text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]
                       transition-colors"
          >
            Restore {dismissedInsights.length} dismissed
          </button>
        )}
      </div>

      {/* ── Section 1: Insights ── */}
      <section className="space-y-4">
        <h2 className="font-semibold text-base">Insights</h2>

        {visibleInsights.length === 0 && (
          <p className="text-sm text-[hsl(var(--muted-foreground))] py-4 text-center border rounded-xl">
            No active insights. Great shape!
          </p>
        )}

        {[
          { label: "Needs attention", items: warningInsights },
          { label: "Observations", items: infoInsights },
          { label: "Wins", items: successInsights },
        ].map(({ label, items }) =>
          items.length > 0 ? (
            <div key={label}>
              <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] uppercase tracking-wider mb-2">
                {label}
              </p>
              <div className="space-y-2">
                {items.map((insight) => (
                  <InsightCard
                    key={insight.id}
                    insight={insight}
                    onApply={handleApply}
                  />
                ))}
              </div>
            </div>
          ) : null
        )}
      </section>

      {/* ── Section 2: Spending Profile ── */}
      {spendingProfile && (
        <section className="border rounded-xl p-5 space-y-4">
          <h2 className="font-semibold text-base">Spending Profile</h2>
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            Based on the last {spendingProfile.monthsAnalysed} months of data
          </p>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              {
                label: "Avg monthly income",
                value: formatCurrency(spendingProfile.avgMonthlyIncome),
                cls: "text-green-600",
              },
              {
                label: "Avg monthly spend",
                value: formatCurrency(spendingProfile.avgMonthlyExpenses),
                cls: "text-red-500",
              },
              {
                label: "Avg savings rate",
                value: `${Math.round(spendingProfile.avgSavingsRate * 100)}%`,
                cls: spendingProfile.avgSavingsRate >= 0.2 ? "text-green-600" : "text-amber-500",
              },
              {
                label: "Top category",
                value: spendingProfile.topCategory,
                cls: "text-[hsl(var(--foreground))]",
              },
            ].map(({ label, value, cls }) => (
              <div key={label}>
                <p className="text-xs text-[hsl(var(--muted-foreground))]">{label}</p>
                <p className={`text-lg font-bold ${cls}`}>{value}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Section 3: Savings Rate Sparkline ── */}
      {savingsHistory.length >= 2 && (
        <section className="border rounded-xl p-5">
          <h2 className="font-semibold text-base mb-4">Savings Rate (12 months)</h2>
          <ResponsiveContainer width="100%" height={120}>
            <LineChart data={savingsHistory} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
              <XAxis
                dataKey="month"
                tick={{ fontSize: 10 }}
                tickFormatter={(v: string) => v.slice(5)}
              />
              <YAxis
                tick={{ fontSize: 10 }}
                tickFormatter={(v: number) => `${v}%`}
                width={32}
              />
              <Tooltip
                formatter={(v) => [`${v ?? 0}%`, "Savings rate"]}
                contentStyle={{
                  backgroundColor: "hsl(var(--background))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "8px",
                  fontSize: "12px",
                }}
              />
              <ReferenceLine y={20} stroke="#f59e0b" strokeDasharray="3 3" />
              <Line
                type="monotone"
                dataKey="rate"
                stroke="#6366f1"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">
            Dashed line = 20% target
          </p>
        </section>
      )}

      {/* ── Section 4: Category MoM Deltas ── */}
      {catDeltas.length > 0 && (
        <section className="border rounded-xl overflow-hidden">
          <div className="px-5 py-3 bg-[hsl(var(--muted))] border-b">
            <h2 className="font-semibold text-base">Category Trends (this vs last month)</h2>
          </div>
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
                      <span className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: r.category_color }} />
                      {r.category_name}
                    </div>
                  </td>
                  <td className="px-5 py-2.5 text-right font-mono">{formatCurrency(r.this_month)}</td>
                  <td className="px-5 py-2.5 text-right font-mono text-[hsl(var(--muted-foreground))]">
                    {r.last_month > 0 ? formatCurrency(r.last_month) : "—"}
                  </td>
                  <td className={`px-5 py-2.5 text-right font-medium ${
                    r.last_month === 0
                      ? "text-[hsl(var(--muted-foreground))]"
                      : r.delta_pct > 0
                      ? "text-red-500"
                      : "text-green-600"
                  }`}>
                    {r.last_month === 0
                      ? "New"
                      : `${r.delta_pct > 0 ? "+" : ""}${r.delta_pct}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* ── Section 5: Subscription Inventory ── */}
      {subscriptions.length > 0 && (
        <section className="border rounded-xl overflow-hidden">
          <div className="px-5 py-3 bg-[hsl(var(--muted))] border-b flex items-center justify-between">
            <h2 className="font-semibold text-base">Subscription Inventory</h2>
            <span className="text-sm text-[hsl(var(--muted-foreground))]">
              ~{formatCurrency(annualSubCost)}/year
            </span>
          </div>
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
                  <td className="px-5 py-2.5 text-[hsl(var(--muted-foreground))]">
                    {s.month_count} months
                  </td>
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
        </section>
      )}
    </div>
  );
}
