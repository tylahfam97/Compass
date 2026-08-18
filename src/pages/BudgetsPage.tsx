import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, CheckCircle, ChevronLeft, ChevronRight } from "lucide-react";
import { getDb } from "@/lib/db";
import { categorySpendSql } from "@/lib/reportingSql";
import { formatCurrency, formatMonthLabel } from "@/lib/utils";
import { pickVariantIndex } from "@/lib/voice";
import { detectNewMilestones } from "@/lib/milestones";
import { useCategoryStore } from "@/stores/categoryStore";
import { useAutoMonth } from "@/hooks/useAutoMonth";
import { useMilestoneQueue } from "@/hooks/useMilestoneQueue";
import { useProfileStore } from "@/stores/profileStore";
import { reportLoadError, toast } from "@/stores/toastStore";
import CategoryOptions from "@/components/CategoryOptions";
import WeeklyMiniBar from "@/components/WeeklyMiniBar";
import PinModal from "@/components/PinModal";
import MilestoneCelebration from "@/components/MilestoneCelebration";
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
  start_date: string;
  spent_cents: number;
  earned_cents: number;
  is_global: number;
  rollover: number;
  /** Unspent amount carried forward from prior months (0 unless `rollover` is enabled and
   *  this is a monthly budget) - added to `amount_cents` to get the effective limit for the
   *  currently-viewed month. See `computeRolloverCents`. */
  rolloverCents: number;
  weeklyAmounts: number[];
}

/** Safety cap on how many months of history a rollover computation will walk back through -
 *  rollover chains compound month over month, so this bounds the query cost for a budget
 *  that's existed a very long time instead of walking back indefinitely. */
const MAX_ROLLOVER_MONTHS = 36;

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

function nextYM(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m, 1); // m is 1-indexed here, so this already advances one month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** The most recent month that has actually finished - the only period a "you held your budget"
 *  celebration can honestly be based on. */
function lastCompletedYM(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
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

/** A short, human narrative sentence for one budget's current standing - the "companion voice"
 *  layer applied to budgets (see voice.ts), which otherwise only shows a progress bar and raw
 *  numbers. Picks between a couple of phrasings deterministically (`seedKey`) so it doesn't
 *  read identically for every budget, but stays stable within a single day. */
function budgetNarrative(params: {
  seedKey: string;
  over: boolean;
  effectiveLimit: number;
  displayCents: number;
  remaining: number;
  dailyRemaining: number;
  projectedOver: boolean;
  projectedOverBy: number;
}): { text: string; tone: "warning" | "success" | "info" } {
  const { seedKey, over, effectiveLimit, displayCents, remaining, dailyRemaining, projectedOver, projectedOverBy } = params;
  const daysLeftText = remaining > 0 ? `${remaining} day${remaining !== 1 ? "s" : ""} left` : "the period ends today";

  if (over) {
    const overBy = displayCents - effectiveLimit;
    const variants = [
      `You're ${formatCurrency(overBy)} over, with ${daysLeftText} - might be worth pausing new purchases here.`,
      `Over by ${formatCurrency(overBy)} with ${daysLeftText} to go.`,
    ];
    return { text: variants[pickVariantIndex(seedKey, variants.length)], tone: "warning" };
  }

  const cushion = effectiveLimit - displayCents;
  if (remaining > 0 && projectedOver) {
    return {
      text: `You're under for now, but on pace to go ${formatCurrency(projectedOverBy)} over with ${daysLeftText} - a good spot to ease off.`,
      tone: "warning",
    };
  }
  if (remaining > 0) {
    const variants = [
      `You're ${formatCurrency(cushion)} under, with ${daysLeftText} - ${formatCurrency(Math.max(0, dailyRemaining))}/day of room left.`,
      `${formatCurrency(cushion)} of breathing room left, with ${daysLeftText}.`,
    ];
    return { text: variants[pickVariantIndex(seedKey, variants.length)], tone: "success" };
  }
  return { text: `You came in ${formatCurrency(cushion)} under this period.`, tone: "success" };
}

/** Walks month-by-month from a rollover-enabled budget's creation month up to (but excluding)
 *  the currently-viewed month, compounding each month's leftover (`amountCents - spent`,
 *  floored at 0 - overspending never creates a "debt" that reduces future months, it just
 *  resets that month's carry to 0) into the next month's available amount. Returns the total
 *  carried into the currently-viewed month, added to `amountCents` for the effective limit.
 *  Capped at `MAX_ROLLOVER_MONTHS` months of history to bound query cost. */
async function computeRolloverCents(
  db: Awaited<ReturnType<typeof getDb>>,
  categoryId: number,
  amountCents: number,
  startDate: string,
  currentMonthYM: string,
  spendProfileIds: number[]
): Promise<number> {
  const ph = spendProfileIds.map(() => "?").join(",");
  let cursor = startDate.slice(0, 7); // "YYYY-MM" of the budget's own creation month
  let carry = 0;
  let iterations = 0;
  while (cursor < currentMonthYM && iterations < MAX_ROLLOVER_MONTHS) {
    const [s, e] = monthBounds(cursor);
    const [row] = await db.select<{ spent: number }[]>(
      `SELECT COALESCE(${categorySpendSql()},0) as spent
       FROM transactions t LEFT JOIN accounts a ON a.id=t.account_id
       WHERE t.category_id=? AND t.date>=? AND t.date<? AND t.profile_id IN (${ph})`,
      [categoryId, s, e, ...spendProfileIds]
    );
    const available = amountCents + carry - (row?.spent ?? 0);
    carry = Math.max(0, available);
    cursor = nextYM(cursor);
    iterations++;
  }
  return carry;
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
        backgroundColor: isGlobal ? "var(--gold)" : "hsl(var(--primary))",
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
  const [month, setMonth] = useAutoMonth("budgets");
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
  const [formRollover, setFormRollover] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const [pinQueue, setPinQueue] = useState<Profile[]>([]);
  const [pinQueueIdx, setPinQueueIdx] = useState(0);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const { active: activeMilestone, enqueue: enqueueMilestones, dismiss: dismissMilestone } = useMilestoneQueue();

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

    let rawBudgets: Omit<BudgetRow, "weeklyAmounts" | "rolloverCents">[];
    let weeklyRows: { category_id: number; dow: number; total: number }[];

    if (viewMode === "global") {
      const ids = unlockedProfileIds.length > 0 ? unlockedProfileIds : [profileId];
      const ph = ids.map(() => "?").join(",");
      rawBudgets = await db.select<Omit<BudgetRow, "weeklyAmounts" | "rolloverCents">[]>(
        `SELECT b.id, b.category_id, c.parent_id as category_parent_id,
                c.name as category_name, c.color as category_color,
                b.amount_cents, b.period, b.start_date, b.is_global, b.rollover,
                COALESCE(${categorySpendSql("t", "acc")},0) as spent_cents,
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
      rawBudgets = await db.select<Omit<BudgetRow, "weeklyAmounts" | "rolloverCents">[]>(
        `SELECT b.id, b.category_id, c.parent_id as category_parent_id,
                c.name as category_name, c.color as category_color,
                b.amount_cents, b.period, b.start_date, b.is_global, b.rollover,
                COALESCE(${categorySpendSql("t", "acc")},0) as spent_cents,
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

    const spendProfileIds = viewMode === "global"
      ? (unlockedProfileIds.length > 0 ? unlockedProfileIds : [profileId])
      : [profileId];
    const currentMonthYM = month;
    const rolloverCentsById = new Map<number, number>();
    for (const b of rawBudgets) {
      if (b.rollover && b.period === "monthly") {
        const cents = await computeRolloverCents(db, b.category_id, b.amount_cents, b.start_date, currentMonthYM, spendProfileIds);
        rolloverCentsById.set(b.id, cents);
      }
    }

    setBudgets(
      rawBudgets.map((b) => ({
        ...b,
        rolloverCents: rolloverCentsById.get(b.id) ?? 0,
        weeklyAmounts: weeklyMap[b.category_id] ?? Array(7).fill(0),
      }))
    );
    setLoading(false);
  }, [month, profileId, viewMode, unlockedProfileIds]);

  useEffect(() => { loadBudgets().catch(reportLoadError("your budgets", () => void loadBudgets())); }, [loadBudgets]);

  // Celebrate budgets held for the whole of the last completed month. Deliberately independent
  // of the month being viewed: the win is a fact about a finished period, not about where the
  // user happened to navigate. Only monthly, non-income budgets that already existed before
  // that month started qualify - anything else didn't cover the full period.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const month = lastCompletedYM();
      const [start, end] = monthBounds(month);
      const db = await getDb();
      const rows = await db.select<{ id: number; category_name: string; amount_cents: number; spent_cents: number }[]>(
        `SELECT b.id, c.name as category_name, b.amount_cents,
                COALESCE(${categorySpendSql("t", "acc")},0) as spent_cents
         FROM budgets b
         JOIN categories c ON b.category_id=c.id
         LEFT JOIN transactions t ON t.category_id=b.category_id
           AND t.date>=? AND t.date<? AND t.profile_id=?
         LEFT JOIN accounts acc ON acc.id=t.account_id
         WHERE b.profile_id=? AND b.period='monthly' AND b.start_date<=?
           AND c.id!=1 AND (c.parent_id IS NULL OR c.parent_id!=1)
         GROUP BY b.id`,
        [start, end, profileId, profileId, start]
      );
      if (cancelled) return;
      enqueueMilestones(
        detectNewMilestones(profileId, {
          budgets: rows.map((r) => ({
            id: r.id,
            name: r.category_name,
            month,
            monthLabel: formatMonthLabel(month),
            spentCents: r.spent_cents,
            limitCents: r.amount_cents,
          })),
        })
      );
    })().catch(console.error);
    return () => { cancelled = true; };
  }, [profileId, enqueueMilestones]);

  useEffect(() => {
    // Don't clobber a prefill that was just applied — only default-init when truly empty
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

  /** Creates a starter set of monthly budgets from the last 3 completed months of spending.
   *  A blank Budgets page asks the user to invent numbers they don't have, which is where most
   *  people give up - this turns it into a list they can adjust. */
  const suggestBudgets = async () => {
    setSuggesting(true);
    try {
      const db = await getDb();
      const [y, m] = month.split("-").map(Number);
      const from = new Date(y, m - 1 - 3, 1);
      const start = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-01`;
      const [end] = monthBounds(month);

      const rows = await db.select<{ category_id: number; total: number; months: number }[]>(
        `SELECT t.category_id,
                ${categorySpendSql("t", "a")} as total,
                COUNT(DISTINCT substr(t.date,1,7)) as months
         FROM transactions t
         JOIN categories c ON c.id=t.category_id
         JOIN accounts a ON a.id=t.account_id
         WHERE t.profile_id=? AND t.date>=? AND t.date<?
           AND t.category_id!=1 AND (c.parent_id IS NULL OR c.parent_id!=1)
         GROUP BY t.category_id
         HAVING total > 0
         ORDER BY total DESC
         LIMIT 6`,
        [profileId, start, end]
      );

      if (rows.length === 0) {
        toast.info("Not enough spending history yet to suggest budgets. Import a statement first.");
        return;
      }

      const [budgetStart] = monthBounds(month);
      for (const r of rows) {
        // Round the monthly average up to the nearest $10 so suggestions read as deliberate
        // round numbers rather than an oddly precise average.
        const avg = r.total / Math.max(1, r.months);
        const limit = Math.max(1000, Math.ceil(avg / 1000) * 1000);
        await db.execute(
          "INSERT INTO budgets (category_id, amount_cents, period, start_date, profile_id, is_global, rollover) VALUES (?,?,?,?,?,0,0)",
          [r.category_id, limit, "monthly", budgetStart, profileId]
        );
      }
      await loadBudgets();
      toast.success(`Created ${rows.length} starter budgets from your recent spending. Adjust any of them below.`);
    } catch (e) {
      console.error(e);
      toast.error(`Couldn't suggest budgets: ${String(e)}`);
    } finally {
      setSuggesting(false);
    }
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
    if (editingId) {
      await db.execute(
        "UPDATE budgets SET category_id=?, amount_cents=?, period=?, rollover=? WHERE id=?",
        [formCatId, Math.round(amount * 100), formPeriod, formPeriod === "monthly" && formRollover ? 1 : 0, editingId]
      );
      setEditingId(null);
    } else {
      const [start] = monthBounds(month);
      await db.execute(
        "INSERT INTO budgets (category_id, amount_cents, period, start_date, profile_id, is_global, rollover) VALUES (?,?,?,?,?,?,?)",
        [formCatId, Math.round(amount * 100), formPeriod, start, profileId, formIsGlobal ? 1 : 0, formPeriod === "monthly" && formRollover ? 1 : 0]
      );
    }
    setFormAmount("");
    setFormRollover(false);
    setSaving(false);
    await loadBudgets();
  };

  const startEdit = (b: BudgetRow) => {
    setEditingId(b.id);
    setFormCatId(b.category_id);
    setFormAmount((b.amount_cents / 100).toString());
    setFormPeriod(b.period === "weekly" ? "weekly" : "monthly");
    setFormRollover(!!b.rollover);
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setFormCatId(0);
    setFormAmount("");
    setFormPeriod("monthly");
    setFormRollover(false);
  };

  const deleteBudget = async (id: number) => {
    const db = await getDb();
    await db.execute("DELETE FROM budgets WHERE id=?", [id]);
    setConfirmDeleteId((cur) => (cur === id ? null : cur));
    if (editingId === id) cancelEdit();
    await loadBudgets();
  };

  const toggleBudgetScope = async (b: BudgetRow) => {
    const db = await getDb();
    if (b.is_global) {
      await db.execute("UPDATE budgets SET is_global=0, profile_id=? WHERE id=?", [profileId, b.id]);
      // In global view the budget is no longer global — remove it from the list.
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

  const toggleBudgetRollover = async (b: BudgetRow) => {
    const db = await getDb();
    const next = b.rollover ? 0 : 1;
    await db.execute("UPDATE budgets SET rollover=? WHERE id=?", [next, b.id]);
    await loadBudgets();
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
      <MilestoneCelebration event={activeMilestone} onDismiss={dismissMilestone} />

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
            Soft limits — no penalties, just awareness.
          </p>
        </div>

        {/* Animated scope toggle */}
        <div className="flex items-center gap-3 shrink-0">
          <span
            className="text-sm font-semibold select-none"
            style={{
              color: !isGlobalActive ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))",
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
              color: isGlobalActive ? "var(--gold)" : "hsl(var(--muted-foreground))",
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
            className="p-1.5 border rounded-lg leading-none hover:bg-[hsl(var(--muted))] transition-colors"
          >
            <ChevronLeft size={16} />
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
            className="p-1.5 border rounded-lg leading-none hover:bg-[hsl(var(--muted))] transition-colors"
          >
            <ChevronRight size={16} />
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
              {" "}— their transactions are excluded from global totals.
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
              <p className="text-sm font-semibold" style={{ color: "var(--gold)" }}>Global view active</p>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">
                Showing budgets shared across all profiles
                {profiles.length > 1 ? ` — aggregating ${profiles.length} profiles` : ""}
              </p>
            </div>
          </div>
        )}

        {/* Add Budget form */}
        <div ref={formRef} className="border rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b flex items-center justify-between">
            <h2 className="font-semibold text-base">{editingId ? "Edit Budget" : "New Budget"}</h2>
            {!editingId && (
              <div className="flex items-center gap-2.5">
                <span
                  className="text-xs font-semibold select-none"
                  style={{
                    color: !formIsGlobal ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))",
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
                    color: formIsGlobal ? "var(--gold)" : "hsl(var(--muted-foreground))",
                    transition: "color 0.3s",
                  }}
                >
                  Global
                </span>
              </div>
            )}
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
              {formPeriod === "monthly" && (
                <label className="flex items-center gap-1.5 text-xs font-medium text-[hsl(var(--muted-foreground))] pb-2.5 cursor-pointer select-none"
                  title="Unspent amounts carry forward and increase next month's limit">
                  <input type="checkbox" checked={formRollover} onChange={(e) => setFormRollover(e.target.checked)}
                    className="cursor-pointer" />
                  ↻ Roll over unspent
                </label>
              )}
              <button
                onClick={addBudget}
                disabled={saving || !formAmount}
                className="px-6 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 transition-opacity hover:opacity-90"
                style={{
                  backgroundColor: !editingId && formIsGlobal ? "var(--gold)" : "hsl(var(--primary))",
                  color: "hsl(var(--primary-foreground))",
                  paddingTop: "0.5rem",
                  paddingBottom: "0.5rem",
                  marginBottom: "0",
                  alignSelf: "flex-end",
                }}
              >
                {saving ? "Saving..." : editingId ? "Save Changes" : "Add"}
              </button>
              {editingId && (
                <button
                  onClick={cancelEdit}
                  className="px-4 py-2 border rounded-lg text-sm font-medium hover:bg-[hsl(var(--muted))] transition-colors"
                  style={{ alignSelf: "flex-end" }}
                >
                  Cancel
                </button>
              )}
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
            {isGlobalActive ? (
              <p className="text-sm text-[hsl(var(--muted-foreground))] max-w-xs">
                Create a budget above and toggle it to Global to track spending across all profiles.
              </p>
            ) : (
              <>
                <p className="text-sm text-[hsl(var(--muted-foreground))] max-w-md">
                  A budget is a monthly spending limit for one category. Compass tracks every
                  imported transaction against it and warns you when you're pacing to go over.
                </p>
                <button
                  onClick={suggestBudgets}
                  disabled={suggesting}
                  className="mt-2 px-5 py-2.5 rounded-lg text-sm font-semibold disabled:opacity-40 transition-opacity hover:opacity-90"
                  style={{ backgroundColor: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))" }}
                >
                  {suggesting ? "Working…" : "Suggest budgets from my spending"}
                </button>
                <p className="text-xs text-[hsl(var(--muted-foreground))] max-w-xs">
                  Builds a starter set from your last 3 months, rounded to the nearest $10.
                  Nothing is final - edit or delete any of them afterwards.
                </p>
              </>
            )}
          </div>
        )}

        {/* Budget cards */}
        {!loading && budgets.map((b) => {
          const isIncome = b.category_id === 1 || b.category_parent_id === 1;
          const displayCents = isIncome ? b.earned_cents : b.spent_cents;
          const displayLabel = isIncome ? "earned" : "spent";
          const effectiveLimit = b.amount_cents + (b.rolloverCents || 0);
          const pct = effectiveLimit > 0
            ? Math.min(100, Math.round((displayCents / effectiveLimit) * 100))
            : 0;
          const over = !isIncome && displayCents > effectiveLimit;
          const under = isIncome && displayCents < effectiveLimit;

          const totalDays = daysInMonth(month);
          const elapsed = daysElapsed(month);
          const remaining = totalDays - elapsed;
          const dailyLimit = effectiveLimit / totalDays;
          const dailyRemaining = remaining > 0 ? (effectiveLimit - displayCents) / remaining : 0;
          const projectedEnd = elapsed > 0 ? Math.round((displayCents / elapsed) * totalDays) : 0;
          const projectedOver = !isIncome && projectedEnd > effectiveLimit;
          const projectedOverBy = projectedEnd - effectiveLimit;

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
                        style={{ backgroundColor: "hsl(var(--primary)/0.12)", color: "hsl(var(--primary))" }}
                      >
                        Profile
                      </span>
                    )}
                    {projectedOver && remaining > 0 && (
                      <span className="text-xs font-semibold text-[hsl(var(--error))]">
                        +{formatCurrency(projectedOverBy)} projected over
                      </span>
                    )}
                    {b.period === "monthly" && b.rollover === 1 && b.rolloverCents > 0 && (
                      <span
                        className="text-xs px-2 py-0.5 rounded-full font-semibold"
                        title="Unspent amount carried forward from prior months"
                        style={{ backgroundColor: "hsl(var(--success)/0.12)", color: "hsl(var(--success))" }}
                      >
                        ↻ +{formatCurrency(b.rolloverCents)} rolled over
                      </span>
                    )}
                  </div>

                  {/* Action buttons - always visible but subtle; focus-visible so keyboard
                      users tabbing through can see and reach them, not just on hover */}
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => startEdit(b)}
                      title="Edit budget"
                      className="text-xs px-2.5 py-1 rounded-lg border transition-all opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100"
                      style={{
                        color: "hsl(var(--muted-foreground))",
                        borderColor: "hsl(var(--muted-foreground) / 0.3)",
                        backgroundColor: "transparent",
                      }}
                    >
                      Edit
                    </button>
                    {b.period === "monthly" && (
                      <button
                        onClick={() => toggleBudgetRollover(b)}
                        title={b.rollover ? "Disable rollover" : "Roll over unspent amounts to next month"}
                        className="text-xs px-2.5 py-1 rounded-lg border transition-all opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100"
                        style={{
                          color: b.rollover ? "hsl(var(--success))" : "hsl(var(--muted-foreground))",
                          borderColor: b.rollover ? "hsl(var(--success) / 0.3)" : "hsl(var(--muted-foreground) / 0.3)",
                          backgroundColor: "transparent",
                        }}
                      >
                        {b.rollover ? "↻ Rollover on" : "↻ Rollover off"}
                      </button>
                    )}
                    <button
                      onClick={() => toggleBudgetScope(b)}
                      title={b.is_global ? "Make profile-specific" : "Make global"}
                      className="text-xs px-2.5 py-1 rounded-lg border transition-all opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100"
                      style={{
                        color: b.is_global ? "hsl(var(--primary))" : "var(--gold)",
                        borderColor: b.is_global ? "hsl(var(--primary) / 0.3)" : "rgba(192,138,28,0.3)",
                        backgroundColor: "transparent",
                      }}
                      onMouseOver={(e) => {
                        e.currentTarget.style.backgroundColor = b.is_global
                          ? "hsl(var(--primary) / 0.08)"
                          : "rgba(192,138,28,0.08)";
                      }}
                      onMouseOut={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                    >
                      {b.is_global ? "? Profile" : "? Global"}
                    </button>
                    {confirmDeleteId === b.id ? (
                      <span className="flex items-center gap-1.5">
                        <button
                          onClick={() => deleteBudget(b.id)}
                          className="text-xs px-2.5 py-1 rounded-lg font-medium"
                          style={{ color: "white", backgroundColor: "hsl(var(--error))" }}
                        >
                          Delete?
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(null)}
                          className="text-xs px-2.5 py-1 rounded-lg border hover:bg-[hsl(var(--muted))] transition-colors"
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(b.id)}
                        className="text-xs px-2.5 py-1 rounded-lg border transition-all opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100"
                        style={{ color: "hsl(var(--error))", borderColor: "hsl(var(--error) / 0.3)", backgroundColor: "transparent" }}
                        onMouseOver={(e) => { e.currentTarget.style.backgroundColor = "hsl(var(--error) / 0.07)"; }}
                        onMouseOut={(e) => { e.currentTarget.style.backgroundColor = "transparent"; }}
                      >
                        Remove
                      </button>
                    )}
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
                      <span className="ml-1.5 text-xs font-semibold text-[hsl(var(--error))]">over budget</span>
                    )}
                    {under && (
                      <span className="ml-1.5 text-xs font-semibold text-[hsl(var(--warning))]">below target</span>
                    )}
                  </span>
                  <span className="text-[hsl(var(--muted-foreground))] tabular-nums">
                    {isIncome ? "Target" : "Limit"}: {formatCurrency(effectiveLimit)}
                    {b.rolloverCents > 0 && (
                      <span className="text-xs"> ({formatCurrency(b.amount_cents)} + {formatCurrency(b.rolloverCents)})</span>
                    )}
                    <span className="ml-2 font-semibold" style={{ color: accentColor }}>{pct}%</span>
                  </span>
                </div>

                {/* Narrative callout - the "companion voice" pass over what would otherwise be
                    just a progress bar and raw numbers (see budgetNarrative above). */}
                {!isIncome && elapsed > 0 && effectiveLimit > 0 && (() => {
                  const { text, tone } = budgetNarrative({
                    seedKey: `${b.id}:${month}:${elapsed}`,
                    over,
                    effectiveLimit,
                    displayCents,
                    remaining,
                    dailyRemaining,
                    projectedOver,
                    projectedOverBy,
                  });
                  const ToneIcon = tone === "warning" ? AlertTriangle : CheckCircle;
                  const toneColor = tone === "warning" ? "hsl(var(--warning))" : "hsl(var(--success))";
                  return (
                    <p className="text-xs mt-2 flex items-start gap-1.5" style={{ color: toneColor }}>
                      <ToneIcon size={12} className="shrink-0 mt-0.5" />
                      <span>{text}</span>
                    </p>
                  );
                })()}
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
