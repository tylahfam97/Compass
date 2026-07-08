import { useState, useEffect, useCallback } from "react";
import { getDb } from "@/lib/db";
import { formatCurrency } from "@/lib/utils";
import { useCategoryStore } from "@/stores/categoryStore";
import { useAutoMonth } from "@/hooks/useAutoMonth";
import { useProfileStore } from "@/stores/profileStore";
import WeeklyMiniBar from "@/components/WeeklyMiniBar";

type GoalType = "net_savings" | "reduce_spend" | "increase_income";

interface GoalRow {
  id: number;
  name: string;
  type: GoalType;
  category_id: number | null;
  target_cents: number;
  active: number;
  category_name?: string;
  category_color?: string;
}

interface GoalWithProgress extends GoalRow {
  current_cents: number;
  on_track: boolean;
  pct: number;
  weeklyAmounts: number[];
}

const LABELS: Record<GoalType, string> = {
  net_savings: "Net Savings",
  reduce_spend: "Spending Limit",
  increase_income: "Income Target",
};

const DESCS: Record<GoalType, string> = {
  net_savings: "Keep monthly net (income − expenses) at or above this amount.",
  reduce_spend: "Keep spending in a category at or below this amount per month.",
  increase_income: "Bring in at least this much income per month.",
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
        if (g.type === "net_savings") {
          const [r] = await db.select<{ v: number }[]>(
            "SELECT COALESCE(SUM(amount_cents),0) as v FROM transactions WHERE date>=? AND date<? AND profile_id=?",
            [start, end, profileId]
          );
          current = r?.v ?? 0;
        } else if (g.type === "reduce_spend") {
          const extra = g.category_id ? " AND category_id=?" : "";
          const params: unknown[] = g.category_id
            ? [start, end, profileId, g.category_id]
            : [start, end, profileId];
          const [r] = await db.select<{ v: number }[]>(
            `SELECT COALESCE(SUM(ABS(amount_cents)),0) as v FROM transactions WHERE date>=? AND date<? AND profile_id=? AND amount_cents<0${extra}`,
            params
          );
          current = r?.v ?? 0;
        } else {
          const extra = g.category_id ? " AND category_id=?" : "";
          const params: unknown[] = g.category_id
            ? [start, end, profileId, g.category_id]
            : [start, end, profileId];
          const [r] = await db.select<{ v: number }[]>(
            `SELECT COALESCE(SUM(amount_cents),0) as v FROM transactions WHERE date>=? AND date<? AND profile_id=? AND amount_cents>0${extra}`,
            params
          );
          current = r?.v ?? 0;
        }

        const on_track = g.type === "reduce_spend"
          ? current <= g.target_cents
          : current >= g.target_cents;

        const pct = g.target_cents > 0
          ? Math.min(150, Math.round((current / g.target_cents) * 100))
          : 0;

        return { ...g, current_cents: current, on_track, pct, weeklyAmounts: [] };
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

  useEffect(() => {
    loadGoals().catch(console.error);
  }, [loadGoals]);

  useEffect(() => {
    if (categories.length === 0 || formCatId !== 0) return;
    const validCats = formType === "increase_income"
      ? categories.filter((c) => c.id === 1 || c.parent_id === 1)
      : categories.filter((c) => c.id !== 1 && c.parent_id !== 1 && c.id !== 15);
    const first = validCats[0];
    if (first) setFormCatId(first.id);
  }, [categories, formCatId, formType]);

  const handleTypeChange = (t: GoalType) => {
    setFormType(t);
    setFormCatId(0); // reset so the useEffect picks the right category for the new type
    const defaults: Record<GoalType, string> = {
      net_savings: "Save each month",
      reduce_spend: "Limit spending",
      increase_income: "Income target",
    };
    setFormName(defaults[t]);
  };

  const addGoal = async () => {
    const amount = parseFloat(formTarget);
    if (isNaN(amount) || amount <= 0) return;
    setSaving(true);
    const db = await getDb();
    const catId = formType === "net_savings" ? null : formCatId || null;
    await db.execute(
      "INSERT INTO goals (name, type, category_id, target_cents, profile_id) VALUES (?,?,?,?,?)",
      [formName || "Goal", formType, catId, Math.round(amount * 100), profileId]
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
  const spendCats = categories.filter((c) => c.id !== 1 && c.parent_id !== 1 && c.id !== 15);
  const formCats = formType === "increase_income" ? incomeCats : spendCats;

  return (
    <div className="p-6 max-w-2xl space-y-6 mx-auto w-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Goals</h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
            Track your financial intentions — no pressure, just direction.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => navMonth(-1)} aria-label="Previous month"
            className="p-1.5 border rounded-lg text-base leading-none hover:bg-[hsl(var(--muted))] transition-colors">
            ‹
          </button>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]" />
          <button onClick={() => navMonth(1)} aria-label="Next month"
            className="p-1.5 border rounded-lg text-base leading-none hover:bg-[hsl(var(--muted))] transition-colors">
            ›
          </button>
        </div>
      </div>

      {/* Add goal form */}
      <div className="border rounded-xl p-5 space-y-4">
        <h2 className="font-semibold">Add Goal</h2>
        <div className="grid grid-cols-3 gap-2">
          {(["net_savings", "reduce_spend", "increase_income"] as const).map((t) => (
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
        <div className="flex gap-3 flex-wrap">
          <input type="text" placeholder="Goal name" value={formName}
            onChange={(e) => setFormName(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-36
                       bg-[hsl(var(--background))] text-[hsl(var(--foreground))]
                       placeholder:text-[hsl(var(--muted-foreground))]" />
          {formType !== "net_savings" && formCats.length > 0 && (
            <select value={formCatId} onChange={(e) => setFormCatId(parseInt(e.target.value))}
              className="border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
              {formCats.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          )}
          <input type="number" min="1" step="0.01" placeholder="Target ($)" value={formTarget}
            onChange={(e) => setFormTarget(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm w-32
                       bg-[hsl(var(--background))] text-[hsl(var(--foreground))]
                       placeholder:text-[hsl(var(--muted-foreground))]" />
          <button onClick={addGoal} disabled={saving || !formTarget}
            className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                       rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity">
            {saving ? "Saving…" : "Add"}
          </button>
        </div>
      </div>

      {loading && <p className="text-[hsl(var(--muted-foreground))]">Loading…</p>}

      {!loading && goals.length === 0 && (
        <p className="text-[hsl(var(--muted-foreground))] text-center py-10">
          No goals yet. Add one above to start tracking your progress.
        </p>
      )}

      {!loading && goals.map((g) => {
        const isSpend = g.type === "reduce_spend";
        const isIncome = g.type === "increase_income";
        const barPct = Math.min(100, g.pct);
        const barColor = isSpend
          ? (g.on_track ? "#22c55e" : "#ef4444")
          : (g.on_track ? "#22c55e" : g.pct >= 75 ? "#f97316" : "#9ca3af");

        // Daily pace for spend/income goals in the current month
        const totalDays = daysInMonth(month);
        const elapsed = daysElapsed(month);
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
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium
                  ${g.type === "net_savings"
                    ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                    : g.type === "reduce_spend"
                    ? "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300"
                    : "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"}`}>
                  {LABELS[g.type]}
                </span>
                {g.category_name && (
                  <span className="text-xs px-2 py-0.5 rounded-full text-white"
                    style={{ backgroundColor: g.category_color ?? "#9ca3af" }}>
                    {g.category_name}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className={`text-xs font-medium ${g.on_track ? "text-green-600" : "text-orange-500"}`}>
                  {g.on_track ? "✓ On track" : "⚠ Needs attention"}
                </span>
                <button onClick={() => removeGoal(g.id)}
                  className="text-xs text-[hsl(var(--muted-foreground))] hover:text-red-500 transition-colors">
                  Remove
                </button>
              </div>
            </div>

            <div className="h-2.5 rounded-full bg-[hsl(var(--muted))] overflow-hidden mb-3">
              <div className="h-full rounded-full transition-all"
                style={{ width: `${barPct}%`, backgroundColor: barColor }} />
            </div>

            <div className="flex justify-between text-sm text-[hsl(var(--muted-foreground))] mb-3">
              <span>
                {isSpend ? "Spent: " : isIncome ? "Earned: " : "Net: "}
                <span className="font-medium text-[hsl(var(--foreground))]">
                  {formatCurrency(g.current_cents)}
                </span>
              </span>
              <span>
                {isSpend ? "Limit: " : "Target: "}
                <span className="font-medium text-[hsl(var(--foreground))]">
                  {formatCurrency(g.target_cents)}
                </span>
                {" · "}{g.pct}%
              </span>
            </div>

            {/* Daily pace + weekly bar */}
            {showPace && (
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
                      ? dailyNeeded < 0
                        ? "Over limit"
                        : `${formatCurrency(dailyNeeded)}/day left`
                      : dailyNeeded <= 0
                      ? "Goal reached!"
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
