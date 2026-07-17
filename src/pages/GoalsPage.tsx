import { useState, useEffect, useCallback } from "react";
import { getDb } from "@/lib/db";
import { formatCurrency } from "@/lib/utils";
import { useCategoryStore } from "@/stores/categoryStore";
import { useAutoMonth } from "@/hooks/useAutoMonth";
import { useProfileStore } from "@/stores/profileStore";
import CategoryOptions from "@/components/CategoryOptions";
import { CardListSkeleton } from "@/components/Skeleton";
import WeeklyMiniBar from "@/components/WeeklyMiniBar";

type GoalType =
  | "net_savings"
  | "reduce_spend"
  | "increase_income"
  | "savings_target"
  | "balance_floor"
  | "budget_streak"
  | "savings_rate_habit";

interface GoalRow {
  id: number;
  name: string;
  type: GoalType;
  category_id: number | null;
  target_cents: number;
  target_months: number | null;
  active: number;
  created_at: string;
  category_name?: string;
  category_color?: string;
}

interface GoalWithProgress extends GoalRow {
  current_cents: number;
  current_streak: number;
  on_track: boolean;
  pct: number;
  weeklyAmounts: number[];
  noBalanceData?: boolean;
  noBudgetData?: boolean;
}

const LABELS: Record<GoalType, string> = {
  net_savings:        "Net Savings",
  reduce_spend:       "Spending Limit",
  increase_income:    "Income Target",
  savings_target:     "Savings Target",
  balance_floor:      "Balance Floor",
  budget_streak:      "Under-Budget Streak",
  savings_rate_habit: "Savings Rate Habit",
};

const DESCS: Record<GoalType, string> = {
  net_savings:        "Keep monthly net (income minus expenses) at or above this amount.",
  reduce_spend:       "Keep spending in a category at or below this amount per month.",
  increase_income:    "Bring in at least this much income per month.",
  savings_target:     "Accumulate this much in total net savings (sum of positive monthly nets since goal creation).",
  balance_floor:      "Keep your account balance above this amount. Requires a balance column to be imported.",
  budget_streak:      "Stay under budget on a specific category for N consecutive months.",
  savings_rate_habit: "Maintain at least X% savings rate for N consecutive months.",
};

const STREAK_TYPES = new Set<GoalType>(["budget_streak", "savings_rate_habit"]);
const CLASSIC_TYPES = new Set<GoalType>(["net_savings", "reduce_spend", "increase_income"]);

// Goal-type badge colors, grouped by meaning rather than one hue per type - 7 nearly
// indistinguishable pastels read as visual noise; 3 clear groups read as intentional.
const GOAL_TYPE_STYLE: Record<GoalType, string> = {
  net_savings:        "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  savings_target:     "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  balance_floor:      "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  savings_rate_habit: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  reduce_spend:       "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  budget_streak:      "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  increase_income:    "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
};

function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  return [
    `${y}-${String(m).padStart(2, "0")}-01`,
    new Date(y, m, 1).toISOString().split("T")[0],
  ];
}

function daysInMonth(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

function daysElapsed(ym: string): number {
  const now = new Date();
  const [y, m] = ym.split("-").map(Number);
  const isCurrentMonth = now.getFullYear() === y && now.getMonth() + 1 === m;
  if (!isCurrentMonth) return daysInMonth(ym);
  return now.getDate();
}

function currentWeekBounds(): [string, string] {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;
  const mon = new Date(now);
  mon.setDate(now.getDate() - dow);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 7);
  return [mon.toISOString().split("T")[0], sun.toISOString().split("T")[0]];
}

function recentMonths(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

export default function GoalsPage() {
  const [month, setMonth] = useAutoMonth();
  const [goals, setGoals] = useState<GoalWithProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const categories = useCategoryStore((s) => s.categories);
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const profileId = activeProfile?.id ?? 1;

  const [formType, setFormType] = useState<GoalType>("net_savings");
  const [formName, setFormName] = useState("Save each month");
  const [formCatId, setFormCatId] = useState(0);
  const [formTarget, setFormTarget] = useState("");
  const [formMonths, setFormMonths] = useState("3");
  const [saving, setSaving] = useState(false);

  const navMonth = (dir: -1 | 1) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + dir, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const loadGoals = useCallback(async () => {
    setLoading(true);
    const db = await getDb();
    const [start, end] = monthBounds(month);

    const rows = await db.select<GoalRow[]>(
      `SELECT g.*, c.name as category_name, c.color as category_color
       FROM goals g LEFT JOIN categories c ON g.category_id=c.id
       WHERE g.active=1 AND g.profile_id=? ORDER BY g.created_at`,
      [profileId]
    );

    const withProgress: GoalWithProgress[] = await Promise.all(
      rows.map(async (g) => {
        let current = 0;
        let streak = 0;
        let noBalanceData = false;
        let noBudgetData = false;

        if (g.type === "net_savings") {
          const [r] = await db.select<{ v: number }[]>(
            `SELECT COALESCE(SUM(CASE WHEN a.account_type='credit' AND t.amount_cents>0 THEN 0 ELSE t.amount_cents END),0) as v
             FROM transactions t JOIN accounts a ON a.id=t.account_id
             WHERE t.date>=? AND t.date<? AND t.profile_id=? AND (t.category_id IS NULL OR t.category_id!=20) AND a.account_type!='loan'`,
            [start, end, profileId]
          );
          current = r?.v ?? 0;

        } else if (g.type === "reduce_spend") {
          const extra = g.category_id ? " AND category_id=?" : "";
          const params: unknown[] = g.category_id
            ? [start, end, profileId, g.category_id]
            : [start, end, profileId];
          const [r] = await db.select<{ v: number }[]>(
            `SELECT COALESCE(SUM(ABS(amount_cents)),0) as v FROM transactions WHERE date>=? AND date<? AND profile_id=? AND amount_cents<0 AND (category_id IS NULL OR category_id!=20)${extra}`,
            params
          );
          current = r?.v ?? 0;

        } else if (g.type === "increase_income") {
          const extra = g.category_id ? " AND t.category_id=?" : "";
          const params: unknown[] = g.category_id
            ? [start, end, profileId, g.category_id]
            : [start, end, profileId];
          const [r] = await db.select<{ v: number }[]>(
            `SELECT COALESCE(SUM(t.amount_cents),0) as v FROM transactions t JOIN accounts a ON a.id=t.account_id
             WHERE t.date>=? AND t.date<? AND t.profile_id=? AND t.amount_cents>0 AND a.account_type NOT IN ('credit','loan')${extra}`,
            params
          );
          current = r?.v ?? 0;

        } else if (g.type === "savings_target") {
          // Sum of positive monthly nets since goal creation
          const [r] = await db.select<{ v: number }[]>(
            `SELECT COALESCE(SUM(net),0) as v FROM (
               SELECT strftime('%Y-%m',t.date) as mo,
                 SUM(CASE WHEN t.amount_cents>0 AND (t.category_id IS NULL OR t.category_id!=20) AND a.account_type NOT IN ('credit','loan') THEN t.amount_cents ELSE 0 END)
                 - SUM(CASE WHEN t.amount_cents<0 AND (t.category_id IS NULL OR t.category_id!=20) THEN ABS(t.amount_cents) ELSE 0 END) as net
               FROM transactions t JOIN accounts a ON a.id=t.account_id
               WHERE t.profile_id=? AND t.date>=?
               GROUP BY mo
             ) WHERE net>0`,
            [profileId, g.created_at.slice(0, 10)]
          );
          current = r?.v ?? 0;

        } else if (g.type === "balance_floor") {
          const [r] = await db.select<{ v: number | null }[]>(
            `SELECT t.balance_cents as v FROM transactions t
             JOIN accounts a ON a.id=t.account_id
             WHERE t.profile_id=? AND t.balance_cents IS NOT NULL AND a.account_type='checking'
             ORDER BY t.date DESC, t.id DESC LIMIT 1`,
            [profileId]
          );
          if (r?.v == null) { noBalanceData = true; current = 0; }
          else current = r.v;

        } else if (g.type === "budget_streak") {
          // Count consecutive months (newest first) where spend <= budget
          if (!g.category_id) { noBudgetData = true; }
          else {
            const [budgetRow] = await db.select<{ amount_cents: number }[]>(
              "SELECT amount_cents FROM budgets WHERE profile_id=? AND category_id=? AND is_global=0 ORDER BY created_at DESC LIMIT 1",
              [profileId, g.category_id]
            );
            if (!budgetRow) { noBudgetData = true; }
            else {
              const months12 = recentMonths(12);
              let s = 0;
              for (const mo of months12) {
                const [ms, me] = monthBounds(mo);
                const [r] = await db.select<{ spent: number }[]>(
                  "SELECT COALESCE(SUM(ABS(amount_cents)),0) as spent FROM transactions WHERE profile_id=? AND date>=? AND date<? AND amount_cents<0 AND category_id=?",
                  [profileId, ms, me, g.category_id]
                );
                if ((r?.spent ?? 0) > budgetRow.amount_cents) break;
                s++;
              }
              streak = s;
              current = s * 100; // use cents slot to store streak*100 for pct calc
            }
          }

        } else if (g.type === "savings_rate_habit") {
          const targetRate = g.target_cents / 100; // e.g. 2000 -> 20%
          const months12 = recentMonths(12);
          let s = 0;
          for (const mo of months12) {
            const [ms, me] = monthBounds(mo);
            const [r] = await db.select<{ income: number; expenses: number }[]>(
              `SELECT
                 COALESCE(SUM(CASE WHEN t.amount_cents>0 AND (t.category_id IS NULL OR t.category_id!=20) AND a.account_type NOT IN ('credit','loan') THEN t.amount_cents ELSE 0 END),0) as income,
                 COALESCE(SUM(CASE WHEN t.amount_cents<0 AND (t.category_id IS NULL OR t.category_id!=20) THEN ABS(t.amount_cents) ELSE 0 END),0) as expenses
               FROM transactions t JOIN accounts a ON a.id=t.account_id
               WHERE t.profile_id=? AND t.date>=? AND t.date<?`,
              [profileId, ms, me]
            );
            if (!r || r.income === 0) break;
            const rate = ((r.income - r.expenses) / r.income) * 100;
            if (rate < targetRate) break;
            s++;
          }
          streak = s;
          current = s * 100;
        }

        const targetForPct = STREAK_TYPES.has(g.type)
          ? (g.target_months ?? 3) * 100
          : g.target_cents;
        const pct = targetForPct > 0
          ? Math.min(150, Math.round((current / targetForPct) * 100))
          : 0;

        const on_track = g.type === "reduce_spend"
          ? current <= g.target_cents
          : g.type === "balance_floor"
          ? current >= g.target_cents && !noBalanceData
          : STREAK_TYPES.has(g.type)
          ? streak >= (g.target_months ?? 3)
          : current >= (STREAK_TYPES.has(g.type) ? (g.target_months ?? 3) * 100 : g.target_cents);

        return { ...g, current_cents: current, current_streak: streak, on_track, pct, weeklyAmounts: [], noBalanceData, noBudgetData };
      })
    );

    // Attach weekly amounts for reduce_spend goals
    const [weekStart, weekEnd] = currentWeekBounds();
    const weeklyRows = await db.select<{ category_id: number | null; dow: number; total: number }[]>(
      `SELECT category_id,
              (strftime('%w', date) + 6) % 7 as dow,
              SUM(ABS(amount_cents)) as total
       FROM transactions
       WHERE date>=? AND date<? AND profile_id=? AND amount_cents<0
       GROUP BY category_id, dow`,
      [weekStart, weekEnd, profileId]
    );
    const weeklyAllCats = Array(7).fill(0);
    const weeklyByCat: Record<number, number[]> = {};
    for (const row of weeklyRows) {
      weeklyAllCats[row.dow] = (weeklyAllCats[row.dow] ?? 0) + row.total;
      if (row.category_id !== null) {
        if (!weeklyByCat[row.category_id]) weeklyByCat[row.category_id] = Array(7).fill(0);
        weeklyByCat[row.category_id][row.dow] = row.total;
      }
    }
    const withWeekly = withProgress.map((g) => ({
      ...g,
      weeklyAmounts:
        g.type === "reduce_spend"
          ? g.category_id
            ? weeklyByCat[g.category_id] ?? Array(7).fill(0)
            : weeklyAllCats
          : Array(7).fill(0),
    }));

    setGoals(withWeekly);
    setLoading(false);
  }, [month, profileId]);

  useEffect(() => { loadGoals().catch(console.error); }, [loadGoals]);

  useEffect(() => {
    if (categories.length === 0 || formCatId !== 0) return;
    const validCats = formType === "increase_income"
      ? categories.filter((c) => c.id === 1 || c.parent_id === 1)
      : formType === "budget_streak"
      ? categories.filter((c) => c.id !== 1 && c.parent_id !== 1 && c.id !== 15)
      : categories.filter((c) => c.id !== 1 && c.parent_id !== 1 && c.id !== 15);
    const first = validCats[0];
    if (first) setFormCatId(first.id);
  }, [categories, formCatId, formType]);

  const handleTypeChange = (t: GoalType) => {
    setFormType(t);
    setFormCatId(0);
    const defaults: Record<GoalType, string> = {
      net_savings:        "Save each month",
      reduce_spend:       "Limit spending",
      increase_income:    "Income target",
      savings_target:     "Emergency fund",
      balance_floor:      "Keep buffer above",
      budget_streak:      "Under-budget streak",
      savings_rate_habit: "Savings rate habit",
    };
    setFormName(defaults[t]);
    if (STREAK_TYPES.has(t)) setFormMonths("3");
  };

  const addGoal = async () => {
    const amount = parseFloat(formTarget);
    if (isNaN(amount) || amount <= 0) return;
    setSaving(true);
    const db = await getDb();
    const catId = (formType === "net_savings" || formType === "savings_target" || formType === "balance_floor" || formType === "savings_rate_habit")
      ? null
      : formCatId || null;
    // For savings_rate_habit: store rate*100 in target_cents (e.g. 20% -> 2000)
    const targetCents = formType === "savings_rate_habit"
      ? Math.round(amount * 100)   // amount is the % (e.g. 20), *100 = 2000
      : Math.round(amount * 100);   // amount is dollars
    const targetMonths = STREAK_TYPES.has(formType) ? parseInt(formMonths) || 3 : null;
    await db.execute(
      "INSERT INTO goals (name, type, category_id, target_cents, target_months, profile_id) VALUES (?,?,?,?,?,?)",
      [formName || "Goal", formType, catId, targetCents, targetMonths, profileId]
    );
    setFormTarget("");
    setSaving(false);
    await loadGoals();
  };

  const removeGoal = async (id: number) => {
    const db = await getDb();
    await db.execute("UPDATE goals SET active=0 WHERE id=?", [id]);
    await loadGoals();
  };

  const incomeCats = categories.filter((c) => c.id === 1 || c.parent_id === 1);
  const spendCats  = categories.filter((c) => c.id !== 1 && c.parent_id !== 1 && c.id !== 15);

  const formCats =
    formType === "increase_income" ? incomeCats :
    (formType === "reduce_spend" || formType === "budget_streak") ? spendCats : [];

  const showCatPicker = formType === "reduce_spend" || formType === "budget_streak";
  const showMonthsPicker = STREAK_TYPES.has(formType);
  const isRatePct = formType === "savings_rate_habit";

  const typeGroups: GoalType[][] = [
    ["net_savings", "reduce_spend", "increase_income"],
    ["savings_target", "balance_floor", "budget_streak", "savings_rate_habit"],
  ];

  return (
    <div className="p-8 max-w-3xl space-y-6 mx-auto w-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Goals</h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
            Track intentions across time -- no pressure, just direction.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => navMonth(-1)} aria-label="Previous month"
            className="p-1.5 border rounded-lg text-base leading-none hover:bg-[hsl(var(--muted))] transition-colors">�</button>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]" />
          <button onClick={() => navMonth(1)} aria-label="Next month"
            className="p-1.5 border rounded-lg text-base leading-none hover:bg-[hsl(var(--muted))] transition-colors">�</button>
        </div>
      </div>

      {/* Add goal form */}
      <div className="border rounded-xl p-5 space-y-4">
        <h2 className="font-semibold">Add Goal</h2>

        {/* Type selector -- two rows */}
        {typeGroups.map((row, ri) => (
          <div key={ri} className={`grid gap-2`} style={{ gridTemplateColumns: `repeat(${row.length}, 1fr)` }}>
            {row.map((t) => (
              <button key={t} onClick={() => handleTypeChange(t)}
                className={`border rounded-xl p-3 text-left transition-colors
                  ${formType === t
                    ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10"
                    : "hover:bg-[hsl(var(--muted))]"}`}>
                <p className="text-sm font-medium">{LABELS[t]}</p>
                <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5 leading-snug">{DESCS[t]}</p>
              </button>
            ))}
          </div>
        ))}

        {/* Input row */}
        <div className="flex gap-3 flex-wrap">
          <input type="text" placeholder="Goal name" value={formName}
            onChange={(e) => setFormName(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-36
                       bg-[hsl(var(--background))] text-[hsl(var(--foreground))]
                       placeholder:text-[hsl(var(--muted-foreground))]" />
          {showCatPicker && formCats.length > 0 && (
            <select value={formCatId} onChange={(e) => setFormCatId(parseInt(e.target.value))}
              className="border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
              <CategoryOptions categories={formCats} />
            </select>
          )}
          <div className="flex items-center gap-1">
            {!isRatePct && <span className="text-sm text-[hsl(var(--muted-foreground))]">$</span>}
            <input type="number" min="1" step={isRatePct ? "1" : "0.01"}
              placeholder={isRatePct ? "Rate %" : "Target"}
              value={formTarget}
              onChange={(e) => setFormTarget(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm w-28
                         bg-[hsl(var(--background))] text-[hsl(var(--foreground))]
                         placeholder:text-[hsl(var(--muted-foreground))]" />
            {isRatePct && <span className="text-sm text-[hsl(var(--muted-foreground))]">%</span>}
          </div>
          {showMonthsPicker && (
            <div className="flex items-center gap-1.5">
              <input type="number" min="1" max="24" step="1" value={formMonths}
                onChange={(e) => setFormMonths(e.target.value)}
                className="border rounded-lg px-3 py-2 text-sm w-16
                           bg-[hsl(var(--background))] text-[hsl(var(--foreground))]" />
              <span className="text-sm text-[hsl(var(--muted-foreground))]">months</span>
            </div>
          )}
          <button onClick={addGoal} disabled={saving || !formTarget}
            className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                       rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity">
            {saving ? "Saving..." : "Add"}
          </button>
        </div>
      </div>

      {loading && <CardListSkeleton count={3} />}

      {!loading && goals.length === 0 && (
        <p className="text-[hsl(var(--muted-foreground))] text-center py-10">
          No goals yet. Add one above to start tracking your progress.
        </p>
      )}

      {!loading && goals.map((g) => {
        const isSpend  = g.type === "reduce_spend";
        const isIncome = g.type === "increase_income";
        const isStreak = STREAK_TYPES.has(g.type);
        const isClassic = CLASSIC_TYPES.has(g.type);
        const targetMonths = g.target_months ?? 3;
        const streakCount = g.current_streak;

        const barPct = Math.min(100, g.pct);
        const barColor = isSpend
          ? (g.on_track ? "hsl(var(--success))" : "hsl(var(--error))")
          : (g.on_track ? "hsl(var(--success))" : g.pct >= 75 ? "hsl(var(--warning))" : "hsl(var(--neutral))");

        const totalDays = daysInMonth(month);
        const elapsed   = daysElapsed(month);
        const remaining = totalDays - elapsed;
        const dailyNeeded = remaining > 0
          ? (g.target_cents - g.current_cents) / remaining
          : 0;
        const showPace = remaining > 0 && (isSpend || isIncome);

        return (
          <div key={g.id} className="border rounded-xl p-5">
            <div className="flex items-start justify-between mb-3 gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{g.name}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${GOAL_TYPE_STYLE[g.type]}`}>
                  {LABELS[g.type]}
                </span>
                {g.category_name && (
                  <span className="text-xs px-2 py-0.5 rounded-full text-white"
                    style={{ backgroundColor: g.category_color ?? "hsl(var(--neutral))" }}>
                    {g.category_name}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {!g.noBalanceData && !g.noBudgetData && (
                  <span className={`text-xs font-medium ${g.on_track ? "text-green-600" : "text-orange-500"}`}>
                    {g.on_track ? "On track" : "Needs attention"}
                  </span>
                )}
                <button onClick={() => removeGoal(g.id)}
                  className="text-xs text-[hsl(var(--muted-foreground))] hover:text-red-500 transition-colors">
                  Remove
                </button>
              </div>
            </div>

            {/* No-data banners */}
            {g.noBalanceData && (
              <p className="text-xs text-amber-600 mb-3">
                No balance data yet -- import a CSV with a Balance column to enable this goal.
              </p>
            )}
            {g.noBudgetData && (
              <p className="text-xs text-amber-600 mb-3">
                No budget found for this category. Create a budget first to track your streak.
              </p>
            )}

            {/* Streak display */}
            {isStreak && !g.noBudgetData && (
              <div className="mb-3">
                <div className="flex items-baseline gap-2 mb-2">
                  <span className="text-2xl font-bold">{streakCount}</span>
                  <span className="text-sm text-[hsl(var(--muted-foreground))]">/ {targetMonths} months</span>
                  {streakCount >= targetMonths && (
                    <span className="text-sm font-semibold text-green-600">Goal reached!</span>
                  )}
                </div>
                <div className="flex gap-1">
                  {Array.from({ length: targetMonths }).map((_, i) => (
                    <div key={i}
                      className="h-2 rounded-full flex-1"
                      style={{ backgroundColor: i < streakCount ? "#22c55e" : "hsl(var(--muted))" }}
                    />
                  ))}
                </div>
                {g.type === "savings_rate_habit" && (
                  <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1.5">
                    Target: maintain {formatCurrency(g.target_cents)} savings rate ({g.target_cents / 100}%)
                  </p>
                )}
              </div>
            )}

            {/* Classic + savings_target + balance_floor progress bar */}
            {!isStreak && !g.noBalanceData && (
              <>
                <div className="h-2.5 rounded-full bg-[hsl(var(--muted))] overflow-hidden mb-3">
                  <div className="h-full rounded-full transition-all"
                    style={{ width: `${barPct}%`, backgroundColor: barColor }} />
                </div>

                <div className="flex justify-between text-sm text-[hsl(var(--muted-foreground))] mb-3">
                  <span>
                    {isSpend       ? "Spent: "
                    : isIncome     ? "Earned: "
                    : g.type === "savings_target" ? "Saved: "
                    : g.type === "balance_floor"  ? "Balance: "
                    :                              "Net: "}
                    <span className="font-medium text-[hsl(var(--foreground))]">
                      {formatCurrency(g.current_cents)}
                    </span>
                  </span>
                  <span>
                    {isSpend || g.type === "balance_floor" ? "Target: " : "Goal: "}
                    <span className="font-medium text-[hsl(var(--foreground))]">
                      {formatCurrency(g.target_cents)}
                    </span>
                    {" "}({g.pct}%)
                  </span>
                </div>
              </>
            )}

            {/* Daily pace + weekly bar for classic types */}
            {isClassic && showPace && (
              <div className="flex items-end justify-between gap-4 pt-2 border-t">
                <div>
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">
                    {isSpend ? "Daily allowance left" : "Daily needed"}
                  </p>
                  <p className={`text-sm font-semibold ${
                    isSpend
                      ? dailyNeeded < 0 ? "text-red-500" : "text-emerald-600"
                      : dailyNeeded <= 0 ? "text-emerald-600" : "text-[hsl(var(--foreground))]"
                  }`}>
                    {isSpend
                      ? dailyNeeded < 0 ? "Over limit"
                        : `${formatCurrency(dailyNeeded)}/day left`
                      : dailyNeeded <= 0 ? "Goal reached!"
                      : `${formatCurrency(dailyNeeded)}/day to go`}
                  </p>
                </div>
                {isSpend && g.weeklyAmounts.some((v) => v > 0) && (
                  <WeeklyMiniBar
                    dailyAmounts={g.weeklyAmounts}
                    dailyTarget={g.target_cents / totalDays}
                    overIsBad={true}
                    className="w-28 shrink-0"
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
