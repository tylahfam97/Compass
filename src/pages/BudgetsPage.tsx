import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getDb } from "@/lib/db";
import { formatCurrency } from "@/lib/utils";
import { useCategoryStore } from "@/stores/categoryStore";
import { useAutoMonth } from "@/hooks/useAutoMonth";
import { useProfileStore } from "@/stores/profileStore";
import CategoryOptions from "@/components/CategoryOptions";
import WeeklyMiniBar from "@/components/WeeklyMiniBar";
import PinModal from "@/components/PinModal";
import { CardListSkeleton } from "@/components/Skeleton";
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
  weeklyAmounts: number[];
}

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

function currentWeekBounds(): [string, string] {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;
  const mon = new Date(now);
  mon.setDate(now.getDate() - dow);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 7);
  return [mon.toISOString().split("T")[0], sun.toISOString().split("T")[0]];
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

interface ScopeToggleProps {
  isGlobal: boolean;
  onToggle: () => void;
  size?: "sm" | "md";
}
function ScopeToggle({ isGlobal, onToggle, size = "md" }: ScopeToggleProps) {
  const trackW = size === "sm" ? 40 : 52;
  const trackH = size === "sm" ? 22 : 28;
  const thumbS = size === "sm" ? 16 : 22;
  const travel = trackW - 6 - thumbS;
  return (
    <button
      role="switch"
      aria-checked={isGlobal}
      onClick={onToggle}
      style={{
        width: trackW,
        height: trackH,
        borderRadius: trackH / 2,
        padding: 3,
        backgroundColor: isGlobal ? "#C08A1C" : "#3b82f6",
        transition: "background-color 0.3s",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        border: "none",
        flexShrink: 0,
        boxShadow: "inset 0 1px 3px rgba(0,0,0,0.18)",
      }}
    >
      <div
        style={{
          width: thumbS,
          height: thumbS,
          borderRadius: thumbS / 2,
          backgroundColor: "white",
          transition: "transform 0.25s cubic-bezier(0.4,0,0.2,1)",
          transform: isGlobal ? `translateX(${travel}px)` : "translateX(0)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.28)",
          flexShrink: 0,
        }}
      />
    </button>
  );
}

export default function BudgetsPage() {
  const [month, setMonth] = useAutoMonth();
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const categories = useCategoryStore((s) => s.categories);
  const { activeProfile, profiles, unlockedIds, unlockProfile } = useProfileStore();
  const profileId = activeProfile?.id ?? 1;
  const location = useLocation();
  const navigate = useNavigate();
  const formRef = useRef<HTMLDivElement>(null);

  const [viewMode, setViewMode] = useState<"profile" | "global">(() => {
    const saved = localStorage.getItem(viewModeKey(activeProfile?.id ?? 1));
    return saved === "global" ? "global" : "profile";
  });

  const [formCatId, setFormCatId] = useState<number>(0);
  const [formAmount, setFormAmount] = useState("");
  const [formPeriod, setFormPeriod] = useState<"monthly" | "weekly">("monthly");
  const [formIsGlobal, setFormIsGlobal] = useState(false);
  const [saving, setSaving] = useState(false);

  const [pinQueue, setPinQueue] = useState<Profile[]>([]);
  const [pinQueueIdx, setPinQueueIdx] = useState(0);

  useEffect(() => {
    const saved = localStorage.getItem(viewModeKey(profileId));
    setViewMode(saved === "global" ? "global" : "profile");
  }, [profileId]);

  // Prefill form from insight navigation state (e.g. "Set $X budget" action)
  useEffect(() => {
    const prefill = (location.state as { prefillBudget?: { category_id: number; amount_cents: number; period: string } } | null)?.prefillBudget;
    if (!prefill) return;
    setFormCatId(prefill.category_id);
    setFormAmount(String((prefill.amount_cents / 100).toFixed(2)));
    setFormPeriod((prefill.period === "weekly" ? "weekly" : "monthly") as "monthly" | "weekly");
    // Clear the navigation state so it doesn't re-apply on back/forward
    navigate("/budgets", { replace: true, state: {} });
    // Scroll the main content area back to top so the pre-filled form is immediately visible
    setTimeout(() => document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' }), 100);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  const navMonth = (dir: -1 | 1) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + dir, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const unlockedProfileIds = useMemo(
    () =>
      profiles
        .filter((p) => !p.pin_hash || p.id === profileId || unlockedIds.has(p.id))
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
                COALESCE(SUM(CASE WHEN t.amount_cents>0 AND (acc.account_type IS NULL OR acc.account_type NOT IN ('credit','loan')) THEN t.amount_cents ELSE 0 END),0) as earned_cents
         FROM budgets b
         JOIN categories c ON b.category_id=c.id
         LEFT JOIN transactions t ON t.category_id=b.category_id
           AND t.date>=? AND t.date<? AND t.profile_id IN (${ph})
         LEFT JOIN accounts acc ON acc.id=t.account_id
         WHERE b.is_global=1
         GROUP BY b.id ORDER BY c.name`,
        [start, end, ...ids]
      );
      weeklyRows = await db.select<{ category_id: number; dow: number; total: number }[]>(
        `SELECT category_id, (strftime('%w',date)+6)%7 as dow, SUM(ABS(amount_cents)) as total
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
                COALESCE(SUM(CASE WHEN t.amount_cents>0 AND (acc.account_type IS NULL OR acc.account_type NOT IN ('credit','loan')) THEN t.amount_cents ELSE 0 END),0) as earned_cents
         FROM budgets b
         JOIN categories c ON b.category_id=c.id
         LEFT JOIN transactions t ON t.category_id=b.category_id
           AND t.date>=? AND t.date<? AND t.profile_id=?
         LEFT JOIN accounts acc ON acc.id=t.account_id
         WHERE b.profile_id=?
         GROUP BY b.id ORDER BY c.name`,
        [start, end, profileId, profileId]
      );
      weeklyRows = await db.select<{ category_id: number; dow: number; total: number }[]>(
        `SELECT category_id, (strftime('%w',date)+6)%7 as dow, SUM(ABS(amount_cents)) as total
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
      rawBudgets.map((b) => ({ ...b, weeklyAmounts: weeklyMap[b.category_id] ?? Array(7).fill(0) }))
    );
    setLoading(false);
  }, [month, profileId, viewMode, unlockedProfileIds]);

  useEffect(() => { loadBudgets().catch(console.error); }, [loadBudgets]);

  useEffect(() => {
    // Don't clobber a prefill that was just applied � only default-init when truly empty
    const hasPrefill = !!(location.state as { prefillBudget?: unknown } | null)?.prefillBudget;
    if (categories.length > 0 && formCatId === 0 && !hasPrefill) {
      setFormCatId(categories[0].id);
    }
  }, [categories, formCatId, location.state]);

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
      [formCatId, Math.round(amount * 100), formPeriod, start, profileId, formIsGlobal ? 1 : 0]
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
      await db.execute("UPDATE budgets SET is_global=0, profile_id=? WHERE id=?", [profileId, b.id]);
      // In global view the budget is no longer global � remove it from the list.
      // In profile view just flip the badge; the budget still belongs to this profile.
      if (viewMode === "global") {
        setBudgets((prev) => prev.filter((row) => row.id !== b.id));
      } else {
        setBudgets((prev) => prev.map((row) => row.id === b.id ? { ...row, is_global: 0 } : row));
      }
    } else {
      await db.execute("UPDATE budgets SET is_global=1 WHERE id=?", [b.id]);
      // Flip the badge in place; budget remains visible in this profile's view.
      setBudgets((prev) => prev.map((row) => row.id === b.id ? { ...row, is_global: 1 } : row));
    }
  };

  const pinTarget =
    pinQueue.length > 0 && pinQueueIdx < pinQueue.length ? pinQueue[pinQueueIdx] : null;

  const lockedExcluded =
    viewMode === "global"
      ? profiles.filter((p) => p.pin_hash && p.id !== profileId && !unlockedIds.has(p.id))
      : [];

  const isGlobalActive = viewMode === "global";

  return (
    <>
      {pinTarget && (
        <PinModal
          profile={pinTarget}
          onSuccess={() => advancePinQueue(pinTarget.id)}
          onCancel={() => advancePinQueue()}
        />
      )}

      {/* Sticky page header */}
      <div
        className="sticky top-0 z-20 border-b px-8 py-4 flex items-center justify-between gap-6"
        style={{ backgroundColor: "hsl(var(--background))", backdropFilter: "blur(8px)" }}
      >
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Budgets</h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
            Soft limits � no penalties, just awareness.
          </p>
        </div>

        {/* Animated scope toggle */}
        <div className="flex items-center gap-3 shrink-0">
          <span
            className="text-sm font-semibold select-none"
            style={{
              color: !isGlobalActive ? "#3b82f6" : "hsl(var(--muted-foreground))",
              transition: "color 0.3s",
            }}
          >
            Profile
          </span>
          <ScopeToggle
            isGlobal={isGlobalActive}
            onToggle={() => isGlobalActive ? handleSwitchToProfile() : handleSwitchToGlobal()}
          />
          <span
            className="text-sm font-semibold select-none"
            style={{
              color: isGlobalActive ? "#C08A1C" : "hsl(var(--muted-foreground))",
              transition: "color 0.3s",
            }}
          >
            Global
          </span>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="max-w-4xl mx-auto px-10 py-8 space-y-6">

        {/* Month navigation */}
        <div className="flex items-center justify-end gap-1.5">
          <button
            onClick={() => navMonth(-1)}
            aria-label="Previous month"
            className="p-1.5 border rounded-lg text-base leading-none hover:bg-[hsl(var(--muted))] transition-colors"
          >
            �
          </button>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
          />
          <button
            onClick={() => navMonth(1)}
            aria-label="Next month"
            className="p-1.5 border rounded-lg text-base leading-none hover:bg-[hsl(var(--muted))] transition-colors"
          >
            �
          </button>
        </div>

        {/* Locked-profile warning */}
        {lockedExcluded.length > 0 && (
          <div
            className="rounded-2xl px-5 py-4 flex flex-col gap-3"
            style={{ border: "1px solid rgba(245,158,11,0.35)", backgroundColor: "rgba(245,158,11,0.07)" }}
          >
            <p className="text-sm font-semibold" style={{ color: "#b45309" }}>
              {lockedExcluded.length === 1 ? "1 profile is PIN-locked" : `${lockedExcluded.length} profiles are PIN-locked`}
              {" "}� their transactions are excluded from global totals.
            </p>
            <div className="flex flex-wrap gap-2">
              {lockedExcluded.map((p) => (
                <button
                  key={p.id}
                  onClick={() => { setPinQueue([p]); setPinQueueIdx(0); }}
                  className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                  style={{
                    border: "1px solid rgba(245,158,11,0.5)",
                    color: "#92400e",
                    backgroundColor: "transparent",
                  }}
                  onMouseOver={(e) => (e.currentTarget.style.backgroundColor = "rgba(245,158,11,0.12)")}
                  onMouseOut={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                >
                  Lock {p.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Global mode info banner */}
        {isGlobalActive && lockedExcluded.length === 0 && (
          <div
            className="rounded-2xl px-5 py-3 flex items-center gap-3"
            style={{ border: "1px solid rgba(192,138,28,0.35)", backgroundColor: "rgba(192,138,28,0.07)" }}
          >
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-base"
              style={{ backgroundColor: "rgba(192,138,28,0.15)" }}
            >
              &#127760;
            </div>
            <div>
              <p className="text-sm font-semibold" style={{ color: "#C08A1C" }}>Global view active</p>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">
                Showing budgets shared across all profiles
                {profiles.length > 1 ? ` � aggregating ${profiles.length} profiles` : ""}
              </p>
            </div>
          </div>
        )}

        {/* Add Budget form */}
        <div ref={formRef} className="border rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b flex items-center justify-between">
            <h2 className="font-semibold text-base">New Budget</h2>
            <div className="flex items-center gap-2.5">
              <span
                className="text-xs font-semibold select-none"
                style={{
                  color: !formIsGlobal ? "#3b82f6" : "hsl(var(--muted-foreground))",
                  transition: "color 0.3s",
                }}
              >
                Profile
              </span>
              <ScopeToggle
                isGlobal={formIsGlobal}
                onToggle={() => setFormIsGlobal((v) => !v)}
                size="sm"
              />
              <span
                className="text-xs font-semibold select-none"
                style={{
                  color: formIsGlobal ? "#C08A1C" : "hsl(var(--muted-foreground))",
                  transition: "color 0.3s",
                }}
              >
                Global
              </span>
            </div>
          </div>
          <div className="px-6 py-5">
            <div className="flex gap-3 flex-wrap items-end">
              <div className="flex-1 min-w-40 space-y-1.5">
                <label className="text-xs font-medium text-[hsl(var(--muted-foreground))]">Category</label>
                <select
                  value={formCatId}
                  onChange={(e) => setFormCatId(parseInt(e.target.value))}
                  className="w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
                >
                  <CategoryOptions categories={categories.filter((c) => !c.is_system || c.id !== 15)} />
                </select>
              </div>
              <div className="w-36 space-y-1.5">
                <label className="text-xs font-medium text-[hsl(var(--muted-foreground))]">Amount</label>
                <input
                  type="number"
                  min="1"
                  step="0.01"
                  placeholder="$0.00"
                  value={formAmount}
                  onChange={(e) => setFormAmount(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))]"
                />
              </div>
              <div className="w-32 space-y-1.5">
                <label className="text-xs font-medium text-[hsl(var(--muted-foreground))]">Period</label>
                <select
                  value={formPeriod}
                  onChange={(e) => setFormPeriod(e.target.value as "monthly" | "weekly")}
                  className="w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]"
                >
                  <option value="monthly">Monthly</option>
                  <option value="weekly">Weekly</option>
                </select>
              </div>
              <button
                onClick={addBudget}
                disabled={saving || !formAmount}
                className="px-6 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 transition-opacity hover:opacity-90"
                style={{
                  backgroundColor: formIsGlobal ? "#C08A1C" : "hsl(var(--primary))",
                  color: "hsl(var(--primary-foreground))",
                  paddingTop: "0.5rem",
                  paddingBottom: "0.5rem",
                  marginBottom: "0",
                  alignSelf: "flex-end",
                }}
              >
                {saving ? "Saving..." : "Add"}
              </button>
            </div>
          </div>
        </div>

        {/* Loading state */}
        {loading && <CardListSkeleton count={3} />}

        {/* Empty state */}
        {!loading && budgets.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl mb-1"
              style={{ backgroundColor: isGlobalActive ? "rgba(192,138,28,0.1)" : "hsl(var(--muted))" }}
            >
              &#128176;
            </div>
            <p className="font-semibold text-[hsl(var(--foreground))]">
              {isGlobalActive ? "No global budgets yet" : "No budgets yet"}
            </p>
            <p className="text-sm text-[hsl(var(--muted-foreground))] max-w-xs">
              {isGlobalActive
                ? "Create a budget above and toggle it to Global to track spending across all profiles."
                : "Set your first spending limit above to start tracking your progress."}
            </p>
          </div>
        )}

        {/* Budget cards */}
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
          const dailyRemaining = remaining > 0 ? (b.amount_cents - displayCents) / remaining : 0;
          const projectedEnd = elapsed > 0 ? Math.round((displayCents / elapsed) * totalDays) : 0;
          const projectedOver = !isIncome && projectedEnd > b.amount_cents;
          const projectedOverBy = projectedEnd - b.amount_cents;

          const accentColor = over ? "hsl(var(--error))" : b.is_global ? "var(--gold)" : b.category_color;

          return (
            <div
              key={b.id}
              className="group border rounded-2xl overflow-hidden"
              style={{ borderLeft: `4px solid ${accentColor}` }}
            >
              <div className="px-6 pt-5 pb-4">
                {/* Card header row */}
                <div className="flex items-start justify-between gap-4 mb-4">
                  <div className="flex items-center gap-2.5 flex-wrap min-w-0">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: b.category_color }}
                    />
                    <span className="font-semibold text-base">{b.category_name}</span>
                    <span className="text-xs text-[hsl(var(--muted-foreground))] capitalize">
                      {b.period}
                    </span>
                    {b.is_global ? (
                      <span
                        className="text-xs px-2 py-0.5 rounded-full font-semibold"
                        style={{ backgroundColor: "rgba(192,138,28,0.15)", color: "#C08A1C" }}
                      >
                        Global
                      </span>
                    ) : (
                      <span
                        className="text-xs px-2 py-0.5 rounded-full font-semibold"
                        style={{ backgroundColor: "rgba(59,130,246,0.12)", color: "#3b82f6" }}
                      >
                        Profile
                      </span>
                    )}
                    {projectedOver && remaining > 0 && (
                      <span className="text-xs font-semibold text-red-500">
                        +{formatCurrency(projectedOverBy)} projected over
                      </span>
                    )}
                  </div>

                  {/* Action buttons � always visible but subtle */}
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => toggleBudgetScope(b)}
                      title={b.is_global ? "Make profile-specific" : "Make global"}
                      className="text-xs px-2.5 py-1 rounded-lg border transition-all opacity-0 group-hover:opacity-100"
                      style={{
                        color: b.is_global ? "#3b82f6" : "#C08A1C",
                        borderColor: b.is_global ? "rgba(59,130,246,0.3)" : "rgba(192,138,28,0.3)",
                        backgroundColor: "transparent",
                      }}
                      onMouseOver={(e) => {
                        e.currentTarget.style.backgroundColor = b.is_global
                          ? "rgba(59,130,246,0.08)"
                          : "rgba(192,138,28,0.08)";
                      }}
                      onMouseOut={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                    >
                      {b.is_global ? "? Profile" : "? Global"}
                    </button>
                    <button
                      onClick={() => deleteBudget(b.id)}
                      className="text-xs px-2.5 py-1 rounded-lg border transition-all opacity-0 group-hover:opacity-100"
                      style={{ color: "hsl(var(--error))", borderColor: "hsl(var(--error) / 0.3)", backgroundColor: "transparent" }}
                      onMouseOver={(e) => { e.currentTarget.style.backgroundColor = "hsl(var(--error) / 0.07)"; }}
                      onMouseOut={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                    >
                      Remove
                    </button>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="relative h-2.5 rounded-full bg-[hsl(var(--muted))] overflow-hidden mb-3">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: accentColor,
                      transition: "width 0.5s cubic-bezier(0.4,0,0.2,1)",
                    }}
                  />
                </div>

                {/* Amounts row */}
                <div className="flex items-baseline justify-between text-sm">
                  <span
                    className="font-medium"
                    style={{
                      color: over ? "hsl(var(--error))" : under ? "hsl(var(--warning))" : "hsl(var(--muted-foreground))",
                    }}
                  >
                    {formatCurrency(displayCents)}{" "}
                    <span className="font-normal">{displayLabel}</span>
                    {over && (
                      <span className="ml-1.5 text-xs font-semibold text-red-500">over budget</span>
                    )}
                    {under && (
                      <span className="ml-1.5 text-xs font-semibold text-orange-500">below target</span>
                    )}
                  </span>
                  <span className="text-[hsl(var(--muted-foreground))] tabular-nums">
                    {isIncome ? "Target" : "Limit"}: {formatCurrency(b.amount_cents)}
                    <span className="ml-2 font-semibold" style={{ color: accentColor }}>{pct}%</span>
                  </span>
                </div>

                {/* On-pace projection */}
                {!isIncome && elapsed > 0 && projectedEnd > 0 && (
                  <p
                    className="text-xs mt-2"
                    style={{
                      color: projectedOver
                        ? over ? "hsl(var(--error))" : "hsl(var(--warning))"
                        : "hsl(var(--muted-foreground))",
                      fontWeight: projectedOver ? 500 : 400,
                    }}
                  >
                    On pace for {formatCurrency(projectedEnd)} by month-end
                    {projectedOver && !over && " � approaching limit"}
                  </p>
                )}
              </div>

              {/* Footer: daily remaining + weekly bar */}
              {!isIncome && remaining > 0 && (
                <div
                  className="px-6 py-3 flex items-center justify-between gap-4 border-t"
                  style={{ backgroundColor: "hsl(var(--muted)/0.4)" }}
                >
                  <div>
                    <p className="text-xs text-[hsl(var(--muted-foreground))] mb-0.5">Daily remaining</p>
                    <p
                      className="text-sm font-semibold"
                      style={{ color: dailyRemaining < 0 ? "#ef4444" : "hsl(var(--foreground))" }}
                    >
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

        {/* Bottom padding */}
        <div className="h-8" />
      </div>
    </>
  );
}
