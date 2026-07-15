import { useState, useEffect, useCallback, useMemo } from "react";
import { getDb } from "@/lib/db";
import { formatCurrency } from "@/lib/utils";
import { useCategoryStore } from "@/stores/categoryStore";
import { useAutoMonth } from "@/hooks/useAutoMonth";
import { useProfileStore } from "@/stores/profileStore";
import WeeklyMiniBar from "@/components/WeeklyMiniBar";
import PinModal from "@/components/PinModal";
import type { Profile } from "@/lib/types";

interface BudgetRow {
  id: number;
  category_id: number;
  category_parent_id: number | null;
  category_name: string;
  category_color: string;
  amount_cents: number;
  period: string;
  spent_cents: number;
  earned_cents: number;
  is_global: number;
  /** Daily amounts Mon-Sun in cents for the current week */
  weeklyAmounts: number[];
}

/** localStorage key for view mode per profile */
function viewModeKey(profileId: number) {
  return `compass_budget_view_${profileId}`;
}

function monthBounds(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  return [
    `${y}-${String(m).padStart(2, "0")}-01`,
    new Date(y, m, 1).toISOString().split("T")[0],
  ];
}

/** Start (Mon) and end (Sun+1) of the current ISO week as ISO strings */
function currentWeekBounds(): [string, string] {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7; // 0=Mon
  const mon = new Date(now);
  mon.setDate(now.getDate() - dow);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 7);
  return [
    mon.toISOString().split("T")[0],
    sun.toISOString().split("T")[0],
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

export default function BudgetsPage() {
  const [month, setMonth] = useAutoMonth();
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const categories = useCategoryStore((s) => s.categories);
  const { activeProfile, profiles, unlockedIds, unlockProfile } = useProfileStore();
  const profileId = activeProfile?.id ?? 1;

  // View mode: "profile" | "global" -- persisted in localStorage per profile
  const [viewMode, setViewMode] = useState<"profile" | "global">(() => {
    const saved = localStorage.getItem(viewModeKey(activeProfile?.id ?? 1));
    return saved === "global" ? "global" : "profile";
  });

  // New budget form state
  const [formCatId, setFormCatId] = useState<number>(0);
  const [formAmount, setFormAmount] = useState("");
  const [formPeriod, setFormPeriod] = useState<"monthly" | "weekly">("monthly");
  const [formIsGlobal, setFormIsGlobal] = useState(false);
  const [saving, setSaving] = useState(false);

  // PIN unlock sequence for global view
  const [pinQueue, setPinQueue] = useState<Profile[]>([]);
  const [pinQueueIdx, setPinQueueIdx] = useState(0);

  // Re-sync viewMode from localStorage whenever the active profile changes
  useEffect(() => {
    const saved = localStorage.getItem(viewModeKey(profileId));
    setViewMode(saved === "global" ? "global" : "profile");
  }, [profileId]);

  const navMonth = (dir: -1 | 1) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + dir, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  /** IDs of profiles whose transaction data is visible (no PIN, already unlocked, or active) */
  const unlockedProfileIds = useMemo(
    () =>
      profiles
        .filter(
          (p) =>
            !p.pin_hash ||
            p.id === profileId ||
            unlockedIds.has(p.id)
        )
        .map((p) => p.id),
    [profiles, profileId, unlockedIds]
  );

  const loadBudgets = useCallback(async () => {
    setLoading(true);
    const db = await getDb();
    const [start, end] = monthBounds(month);
    const [weekStart, weekEnd] = currentWeekBounds();

    let rawBudgets: Omit<BudgetRow, "weeklyAmounts">[];
    let weeklyRows: { category_id: number; dow: number; total: number }[];

    if (viewMode === "global") {
      const ids = unlockedProfileIds.length > 0 ? unlockedProfileIds : [profileId];
      const ph = ids.map(() => "?").join(",");

      rawBudgets = await db.select<Omit<BudgetRow, "weeklyAmounts">[]>(
        `SELECT b.id, b.category_id, c.parent_id as category_parent_id,
                c.name as category_name, c.color as category_color,
                b.amount_cents, b.period, b.is_global,
                COALESCE(SUM(CASE WHEN t.amount_cents<0 THEN ABS(t.amount_cents) ELSE 0 END),0) as spent_cents,
                COALESCE(SUM(CASE WHEN t.amount_cents>0 THEN t.amount_cents ELSE 0 END),0) as earned_cents
         FROM budgets b
         JOIN categories c ON b.category_id=c.id
         LEFT JOIN transactions t ON t.category_id=b.category_id
           AND t.date>=? AND t.date<? AND t.profile_id IN (${ph})
         WHERE b.is_global=1
         GROUP BY b.id
         ORDER BY c.name`,
        [start, end, ...ids]
      );

      weeklyRows = await db.select<{ category_id: number; dow: number; total: number }[]>(
        `SELECT category_id,
                (strftime('%w', date) + 6) % 7 as dow,
                SUM(ABS(amount_cents)) as total
         FROM transactions
         WHERE date>=? AND date<? AND profile_id IN (${ph}) AND amount_cents<0
         GROUP BY category_id, dow`,
        [weekStart, weekEnd, ...ids]
      );
    } else {
      rawBudgets = await db.select<Omit<BudgetRow, "weeklyAmounts">[]>(
        `SELECT b.id, b.category_id, c.parent_id as category_parent_id,
                c.name as category_name, c.color as category_color,
                b.amount_cents, b.period, b.is_global,
                COALESCE(SUM(CASE WHEN t.amount_cents<0 THEN ABS(t.amount_cents) ELSE 0 END),0) as spent_cents,
                COALESCE(SUM(CASE WHEN t.amount_cents>0 THEN t.amount_cents ELSE 0 END),0) as earned_cents
         FROM budgets b
         JOIN categories c ON b.category_id=c.id
         LEFT JOIN transactions t ON t.category_id=b.category_id
           AND t.date>=? AND t.date<? AND t.profile_id=?
         WHERE b.profile_id=? AND b.is_global=0
         GROUP BY b.id
         ORDER BY c.name`,
        [start, end, profileId, profileId]
      );

      weeklyRows = await db.select<{ category_id: number; dow: number; total: number }[]>(
        `SELECT category_id,
                (strftime('%w', date) + 6) % 7 as dow,
                SUM(ABS(amount_cents)) as total
         FROM transactions
         WHERE date>=? AND date<? AND profile_id=? AND amount_cents<0
         GROUP BY category_id, dow`,
        [weekStart, weekEnd, profileId]
      );
    }

    const weeklyMap: Record<number, number[]> = {};
    for (const row of weeklyRows) {
      if (!weeklyMap[row.category_id]) weeklyMap[row.category_id] = Array(7).fill(0);
      weeklyMap[row.category_id][row.dow] = row.total;
    }

    setBudgets(
      rawBudgets.map((b) => ({
        ...b,
        weeklyAmounts: weeklyMap[b.category_id] ?? Array(7).fill(0),
      }))
    );
    setLoading(false);
  }, [month, profileId, viewMode, unlockedProfileIds]);

  useEffect(() => {
    loadBudgets().catch(console.error);
  }, [loadBudgets]);

  useEffect(() => {
    if (categories.length > 0 && formCatId === 0) {
      setFormCatId(categories[0].id);
    }
  }, [categories, formCatId]);

  /** Switch to global view -- prompt PIN for any locked+not-yet-unlocked profiles first */
  const handleSwitchToGlobal = () => {
    const locked = profiles.filter(
      (p) => p.pin_hash && p.id !== profileId && !unlockedIds.has(p.id)
    );
    if (locked.length > 0) {
      setPinQueue(locked);
      setPinQueueIdx(0);
    } else {
      localStorage.setItem(viewModeKey(profileId), "global");
      setViewMode("global");
    }
  };

  const handleSwitchToProfile = () => {
    localStorage.setItem(viewModeKey(profileId), "profile");
    setViewMode("profile");
  };

  /** Advance through the PIN queue (success = pass id, skip = omit id) */
  const advancePinQueue = (unlockedId?: number) => {
    if (unlockedId !== undefined) unlockProfile(unlockedId);
    const next = pinQueueIdx + 1;
    if (next >= pinQueue.length) {
      setPinQueue([]);
      setPinQueueIdx(0);
      localStorage.setItem(viewModeKey(profileId), "global");
      setViewMode("global");
    } else {
      setPinQueueIdx(next);
    }
  };

  const addBudget = async () => {
    const amount = parseFloat(formAmount);
    if (isNaN(amount) || amount <= 0 || formCatId === 0) return;
    setSaving(true);
    const db = await getDb();
    const [start] = monthBounds(month);
    await db.execute(
      "INSERT INTO budgets (category_id, amount_cents, period, start_date, profile_id, is_global) VALUES (?,?,?,?,?,?)",
      [
        formCatId,
        Math.round(amount * 100),
        formPeriod,
        start,
        formIsGlobal ? null : profileId,
        formIsGlobal ? 1 : 0,
      ]
    );
    setFormAmount("");
    setSaving(false);
    await loadBudgets();
  };

  const deleteBudget = async (id: number) => {
    const db = await getDb();
    await db.execute("DELETE FROM budgets WHERE id=?", [id]);
    await loadBudgets();
  };

  const toggleBudgetScope = async (b: BudgetRow) => {
    const db = await getDb();
    if (b.is_global) {
      await db.execute(
        "UPDATE budgets SET is_global=0, profile_id=? WHERE id=?",
        [profileId, b.id]
      );
    } else {
      await db.execute(
        "UPDATE budgets SET is_global=1, profile_id=NULL WHERE id=?",
        [b.id]
      );
    }
    await loadBudgets();
  };

  // Current PIN target during the unlock sequence
  const pinTarget =
    pinQueue.length > 0 && pinQueueIdx < pinQueue.length
      ? pinQueue[pinQueueIdx]
      : null;

  // Profiles that are still locked while in global mode (shown in the notice banner)
  const lockedExcluded =
    viewMode === "global"
      ? profiles.filter(
          (p) => p.pin_hash && p.id !== profileId && !unlockedIds.has(p.id)
        )
      : [];

  return (
    <>
      {/* PIN unlock sequence modal */}
      {pinTarget && (
        <PinModal
          profile={pinTarget}
          onSuccess={() => advancePinQueue(pinTarget.id)}
          onCancel={() => advancePinQueue()}
        />
      )}

      <div className="p-6 max-w-2xl space-y-6 mx-auto w-full">
        {/* Header: title + view toggle + month nav */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold">Budgets</h1>
            <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
              Soft limits — no penalties, just awareness.
            </p>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {/* Global / Profile view toggle */}
            <div
              className="flex rounded-lg border overflow-hidden text-xs font-semibold shrink-0"
              style={{ height: "34px" }}
            >
              <button
                onClick={handleSwitchToProfile}
                style={{
                  backgroundColor: viewMode === "profile" ? "#3b82f6" : undefined,
                  color: viewMode === "profile" ? "#fff" : undefined,
                  padding: "0 14px",
                  transition: "background-color 0.15s, color 0.15s",
                  whiteSpace: "nowrap",
                }}
                className={
                  viewMode !== "profile"
                    ? "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] transition-colors"
                    : ""
                }
              >
                Profile
              </button>
              <button
                onClick={handleSwitchToGlobal}
                style={{
                  backgroundColor: viewMode === "global" ? "#C08A1C" : undefined,
                  color: viewMode === "global" ? "#fff" : undefined,
                  padding: "0 14px",
                  transition: "background-color 0.15s, color 0.15s",
                  borderLeft: "1px solid hsl(var(--border))",
                  whiteSpace: "nowrap",
                }}
                className={
                  viewMode !== "global"
                    ? "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] transition-colors"
                    : ""
                }
              >
                Global
              </button>
            </div>

            {/* Month navigation */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => navMonth(-1)}
                aria-label="Previous month"
                className="p-1.5 border rounded-lg text-base leading-none
                           hover:bg-[hsl(var(--muted))] transition-colors"
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
                className="p-1.5 border rounded-lg text-base leading-none
                           hover:bg-[hsl(var(--muted))] transition-colors"
              >
                ›
              </button>
            </div>
          </div>
        </div>

        {/* Locked-profile warning in global mode */}
        {lockedExcluded.length > 0 && (
          <div className="border border-amber-500/40 bg-amber-500/10 rounded-xl px-4 py-3 text-sm flex flex-col gap-2">
            <p className="font-medium" style={{ color: "#b45309" }}>
              {lockedExcluded.length === 1
                ? "1 profile is PIN-locked"
                : `${lockedExcluded.length} profiles are PIN-locked`}{" "}
              — their transactions are excluded from global totals.
            </p>
            <div className="flex flex-wrap gap-2">
              {lockedExcluded.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setPinQueue([p]);
                    setPinQueueIdx(0);
                  }}
                  className="text-xs px-3 py-1 rounded-md border border-amber-500/60
                             hover:bg-amber-500/20 transition-colors"
                  style={{ color: "#92400e" }}
                >
                  🔒 Unlock {p.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Global mode info chip (all profiles unlocked) */}
        {viewMode === "global" && lockedExcluded.length === 0 && (
          <div
            className="border rounded-xl px-4 py-2.5 text-sm flex items-center gap-2"
            style={{ borderColor: "#C08A1C55", backgroundColor: "#C08A1C12" }}
          >
            <span className="font-medium" style={{ color: "#C08A1C" }}>
              Global view
            </span>
            <span className="text-[hsl(var(--muted-foreground))]">
              — budgets shared across all profiles
              {profiles.length > 1 && `, aggregating ${profiles.length} profiles`}
            </span>
          </div>
        )}

        {/* Add budget form */}
        <div className="border rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">Add Budget</h2>
            {/* Scope toggle */}
            <div
              className="flex rounded-lg border overflow-hidden text-xs font-semibold"
              style={{ height: "28px" }}
            >
              <button
                onClick={() => setFormIsGlobal(false)}
                style={{
                  backgroundColor: !formIsGlobal ? "#3b82f6" : undefined,
                  color: !formIsGlobal ? "#fff" : undefined,
                  padding: "0 10px",
                  transition: "background-color 0.15s, color 0.15s",
                  whiteSpace: "nowrap",
                }}
                className={
                  formIsGlobal
                    ? "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] transition-colors"
                    : ""
                }
              >
                Profile
              </button>
              <button
                onClick={() => setFormIsGlobal(true)}
                style={{
                  backgroundColor: formIsGlobal ? "#C08A1C" : undefined,
                  color: formIsGlobal ? "#fff" : undefined,
                  padding: "0 10px",
                  transition: "background-color 0.15s, color 0.15s",
                  borderLeft: "1px solid hsl(var(--border))",
                  whiteSpace: "nowrap",
                }}
                className={
                  !formIsGlobal
                    ? "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] transition-colors"
                    : ""
                }
              >
                Global
              </button>
            </div>
          </div>
          <div className="flex gap-3 flex-wrap">
            <select
              value={formCatId}
              onChange={(e) => setFormCatId(parseInt(e.target.value))}
              className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-36
                         bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
            >
              {categories
                .filter((c) => !c.is_system || c.id !== 15)
                .map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
            </select>
            <input
              type="number"
              min="1"
              step="0.01"
              placeholder="Amount ($)"
              value={formAmount}
              onChange={(e) => setFormAmount(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm w-36
                         bg-[hsl(var(--background))] text-[hsl(var(--foreground))]
                         placeholder:text-[hsl(var(--muted-foreground))]"
            />
            <select
              value={formPeriod}
              onChange={(e) => setFormPeriod(e.target.value as "monthly" | "weekly")}
              className="border rounded-lg px-3 py-2 text-sm
                         bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
            >
              <option value="monthly">Monthly</option>
              <option value="weekly">Weekly</option>
            </select>
            <button
              onClick={addBudget}
              disabled={saving || !formAmount}
              className="px-5 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]
                         rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90
                         transition-opacity"
            >
              {saving ? "Saving..." : "Add"}
            </button>
          </div>
        </div>

        {/* Budget list */}
        {loading && <p className="text-[hsl(var(--muted-foreground))]">Loading...</p>}

        {!loading && budgets.length === 0 && (
          <p className="text-[hsl(var(--muted-foreground))] text-center py-8">
            {viewMode === "global"
              ? "No global budgets yet. Add one above using the Global toggle."
              : "No budgets set. Add one above to start tracking."}
          </p>
        )}

        {!loading && budgets.map((b) => {
          const isIncome = b.category_id === 1 || b.category_parent_id === 1;
          const displayCents = isIncome ? b.earned_cents : b.spent_cents;
          const displayLabel = isIncome ? "earned" : "spent";
          const pct = b.amount_cents > 0
            ? Math.min(100, Math.round((displayCents / b.amount_cents) * 100))
            : 0;
          const over = !isIncome && displayCents > b.amount_cents;
          const under = isIncome && displayCents < b.amount_cents;

          const totalDays = daysInMonth(month);
          const elapsed = daysElapsed(month);
          const remaining = totalDays - elapsed;
          const dailyLimit = b.amount_cents / totalDays;
          const dailyRemaining = remaining > 0
            ? (b.amount_cents - displayCents) / remaining
            : 0;
          const projectedEnd = elapsed > 0
            ? Math.round((displayCents / elapsed) * totalDays)
            : 0;
          const projectedOver = !isIncome && projectedEnd > b.amount_cents;
          const projectedOverBy = projectedEnd - b.amount_cents;

          const barColor = over ? "#ef4444" : b.is_global ? "#C08A1C" : b.category_color;

          return (
            <div key={b.id} className="border rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: b.category_color }}
                  />
                  <span className="font-medium">{b.category_name}</span>
                  <span className="text-xs text-[hsl(var(--muted-foreground))] capitalize">
                    ({b.period})
                  </span>
                  {b.is_global ? (
                    <span
                      className="text-xs px-1.5 py-0.5 rounded font-medium"
                      style={{ backgroundColor: "#C08A1C22", color: "#C08A1C" }}
                    >
                      Global
                    </span>
                  ) : (
                    <span
                      className="text-xs px-1.5 py-0.5 rounded font-medium"
                      style={{ backgroundColor: "#3b82f622", color: "#3b82f6" }}
                    >
                      Profile
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {projectedOver && remaining > 0 && (
                    <span className="text-xs text-red-500 font-medium hidden sm:inline">
                      Projected +{formatCurrency(projectedOverBy)} over
                    </span>
                  )}
                  <button
                    onClick={() => toggleBudgetScope(b)}
                    title={b.is_global ? "Make profile-specific" : "Make global"}
                    className="text-xs text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]
                               transition-colors whitespace-nowrap"
                  >
                    {b.is_global ? "↓ Profile" : "↑ Global"}
                  </button>
                  <button
                    onClick={() => deleteBudget(b.id)}
                    className="text-xs text-[hsl(var(--muted-foreground))] hover:text-red-500
                               transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>

              <div className="h-3 rounded-full bg-[hsl(var(--muted))] overflow-hidden mb-2">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${pct}%`, backgroundColor: barColor }}
                />
              </div>

              <div className="flex justify-between text-sm mb-1">
                <span className={
                  over ? "text-red-500 font-medium"
                  : under ? "text-orange-500 font-medium"
                  : "text-[hsl(var(--muted-foreground))]"
                }>
                  {formatCurrency(displayCents)} {displayLabel}
                  {over && " — over budget"}
                  {under && " — below target"}
                </span>
                <span className="text-[hsl(var(--muted-foreground))]">
                  {isIncome ? "Target:" : "Limit:"} {formatCurrency(b.amount_cents)} · {pct}%
                </span>
              </div>

              {!isIncome && elapsed > 0 && projectedEnd > 0 && (
                <p className={`text-xs mb-3 ${
                  projectedOver
                    ? over ? "text-red-500 font-medium" : "text-amber-500 font-medium"
                    : "text-[hsl(var(--muted-foreground))]"
                }`}>
                  On pace for {formatCurrency(projectedEnd)} by month-end
                  {projectedOver && !over && " — approaching limit"}
                </p>
              )}

              {!isIncome && remaining > 0 && (
                <div className="flex items-end justify-between gap-4 pt-2 border-t">
                  <div>
                    <p className="text-xs text-[hsl(var(--muted-foreground))]">Daily remaining</p>
                    <p className={`text-sm font-semibold ${
                      dailyRemaining < 0 ? "text-red-500" : "text-[hsl(var(--foreground))]"
                    }`}>
                      {dailyRemaining < 0
                        ? `Over by ${formatCurrency(Math.abs(dailyRemaining))}/day`
                        : `${formatCurrency(Math.max(0, dailyRemaining))}/day`}
                    </p>
                  </div>
                  <WeeklyMiniBar
                    dailyAmounts={b.weeklyAmounts}
                    dailyTarget={dailyLimit}
                    overIsBad={true}
                    className="w-28 shrink-0"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
