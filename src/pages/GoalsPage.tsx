import { useState, useEffect, useCallback, useRef } from "react";
import { CaretLeftIcon, CaretRightIcon, PlusIcon, PencilSimpleIcon, TrashIcon, TargetIcon, CheckIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { getDb } from "@/lib/db";
import { evaluateGoals, STREAK_TYPES, CLASSIC_TYPES, daysInMonth, daysElapsed, type GoalType, type GoalWithProgress } from "@/lib/goals";
import { formatCurrency } from "@/lib/utils";
import { useCategoryStore } from "@/stores/categoryStore";
import { useAutoMonth } from "@/hooks/useAutoMonth";
import { useProfileStore } from "@/stores/profileStore";
import { handleLoadFailure } from "@/stores/toastStore";
import CategoryOptions from "@/components/CategoryOptions";
import { CardListSkeleton } from "@/components/Skeleton";
import WeeklyMiniBar from "@/components/WeeklyMiniBar";
import MilestoneCelebration from "@/components/MilestoneCelebration";
import { detectNewMilestones } from "@/lib/milestones";
import { useMilestoneQueue } from "@/hooks/useMilestoneQueue";


const LABELS: Record<GoalType, string> = {
  net_savings:        "Net Savings",
  reduce_spend:       "Spending Limit",
  increase_income:    "Income Target",
  savings_target:     "Savings Target",
  balance_floor:      "Balance Floor",
  budget_streak:      "Under-Budget Streak",
  savings_rate_habit: "Savings Rate Habit",
  debt_paydown:       "Debt Paydown",
};

const DESCS: Record<GoalType, string> = {
  net_savings:        "Keep monthly net (income minus expenses) at or above this amount.",
  reduce_spend:       "Keep spending in a category at or below this amount per month.",
  increase_income:    "Bring in at least this much income per month.",
  savings_target:     "Accumulate this much in total net savings (sum of positive monthly nets since goal creation).",
  balance_floor:      "Keep your account balance above this amount. Requires a balance column to be imported.",
  budget_streak:      "Stay under budget on a specific category for N consecutive months.",
  savings_rate_habit: "Maintain at least X% savings rate for N consecutive months.",
  debt_paydown:       "Pay down a specific credit card/loan (or all of them combined) to at or below this amount - use $0 to target a full payoff.",
};


export default function GoalsPage() {
  const [month, setMonth] = useAutoMonth("goals");
  const [goals, setGoals] = useState<GoalWithProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const categories = useCategoryStore((s) => s.categories);
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const profileId = activeProfile?.id ?? 1;

  const [formType, setFormType] = useState<GoalType>("net_savings");
  const [formName, setFormName] = useState("Save each month");
  const [formCatId, setFormCatId] = useState(0);
  const [formAccountId, setFormAccountId] = useState(0); // 0 = "All credit cards & loans" for debt_paydown
  const [formTarget, setFormTarget] = useState("");
  const [formMonths, setFormMonths] = useState("3");
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [goalFilter, setGoalFilter] = useState<"all" | "attention" | "onTrack">("all");
  const formRef = useRef<HTMLDetailsElement>(null);
  const { active: activeMilestone, enqueue: enqueueMilestones, dismiss: dismissMilestone } = useMilestoneQueue();
  const [debtAccounts, setDebtAccounts] = useState<{ id: number; name: string; account_type: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const db = await getDb();
      const rows = await db.select<{ id: number; name: string; account_type: string }[]>(
        "SELECT id, name, account_type FROM accounts WHERE profile_id=? AND account_type IN ('credit','loan') AND hidden_from_dashboard=0 ORDER BY account_type, name",
        [profileId]
      );
      if (!cancelled) setDebtAccounts(rows);
    })().catch(console.error);
    return () => { cancelled = true; };
  }, [profileId]);

  const navMonth = (dir: -1 | 1) => {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(y, m - 1 + dir, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  const loadGoals = useCallback(async () => {
    setLoading(true);
    const db = await getDb();
    const evaluated = await evaluateGoals(db, profileId, month);
    setGoals(evaluated);
    setLoading(false);

    const newMilestones = detectNewMilestones(profileId, {
      goals: evaluated.map((g) => ({ id: g.id, name: g.name, pct: g.pct })),
    });
    enqueueMilestones(newMilestones);
  }, [month, profileId, enqueueMilestones]);

  useEffect(() => { loadGoals().catch(handleLoadFailure("your goals", setLoading, () => void loadGoals())); }, [loadGoals]);

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
    setFormAccountId(0);
    const defaults: Record<GoalType, string> = {
      net_savings:        "Save each month",
      reduce_spend:       "Limit spending",
      increase_income:    "Income target",
      savings_target:     "Emergency fund",
      balance_floor:      "Keep buffer above",
      budget_streak:      "Under-budget streak",
      savings_rate_habit: "Savings rate habit",
      debt_paydown:       "Pay off debt",
    };
    setFormName(defaults[t]);
    if (STREAK_TYPES.has(t)) setFormMonths("3");
  };

  const addGoal = async () => {
    const amount = parseFloat(formTarget);
    // debt_paydown alone may target $0 (a full payoff) - every other type needs a positive amount.
    if (isNaN(amount) || amount < 0 || (amount <= 0 && formType !== "debt_paydown")) return;
    setSaving(true);
    const db = await getDb();
    const catId = (formType === "net_savings" || formType === "savings_target" || formType === "balance_floor" || formType === "savings_rate_habit" || formType === "debt_paydown")
      ? null
      : formCatId || null;
    const accountId = formType === "debt_paydown" ? (formAccountId || null) : null;
    // For savings_rate_habit: store rate*100 in target_cents (e.g. 20% -> 2000)
    const targetCents = formType === "savings_rate_habit"
      ? Math.round(amount * 100)   // amount is the % (e.g. 20), *100 = 2000
      : Math.round(amount * 100);   // amount is dollars
    const targetMonths = STREAK_TYPES.has(formType) ? parseInt(formMonths) || 3 : null;
    if (editingId) {
      await db.execute(
        "UPDATE goals SET name=?, type=?, category_id=?, account_id=?, target_cents=?, target_months=? WHERE id=?",
        [formName || "Goal", formType, catId, accountId, targetCents, targetMonths, editingId]
      );
      setEditingId(null);
    } else {
      await db.execute(
        "INSERT INTO goals (name, type, category_id, account_id, target_cents, target_months, profile_id) VALUES (?,?,?,?,?,?,?)",
        [formName || "Goal", formType, catId, accountId, targetCents, targetMonths, profileId]
      );
    }
    setFormTarget("");
    setSaving(false);
    setFormOpen(false);
    await loadGoals();
  };

  const startEdit = (g: GoalWithProgress) => {
    setFormOpen(true);
    setEditingId(g.id);
    setFormType(g.type);
    setFormName(g.name);
    setFormCatId(g.category_id ?? 0);
    setFormAccountId(g.account_id ?? 0);
    setFormTarget((g.target_cents / 100).toString());
    setFormMonths((g.target_months ?? 3).toString());
    formRef.current?.scrollIntoView({ block: "start" });
  };

  const cancelEdit = () => {
    setFormOpen(false);
    setEditingId(null);
    setFormType("net_savings");
    setFormName("Save each month");
    setFormCatId(0);
    setFormAccountId(0);
    setFormTarget("");
    setFormMonths("3");
  };

  const removeGoal = async (id: number) => {
    const db = await getDb();
    await db.execute("UPDATE goals SET active=0 WHERE id=?", [id]);
    setConfirmDeleteId((cur) => (cur === id ? null : cur));
    await loadGoals();
  };

  const incomeCats = categories.filter((c) => c.id === 1 || c.parent_id === 1);
  const spendCats  = categories.filter((c) => c.id !== 1 && c.parent_id !== 1 && c.id !== 15);

  const formCats =
    formType === "increase_income" ? incomeCats :
    (formType === "reduce_spend" || formType === "budget_streak") ? spendCats : [];

  const showCatPicker = formType === "reduce_spend" || formType === "budget_streak";
  const showAccountPicker = formType === "debt_paydown";
  const showMonthsPicker = STREAK_TYPES.has(formType);
  const isRatePct = formType === "savings_rate_habit";

  const hasData = (goal: GoalWithProgress) => !goal.noBalanceData && !goal.noBudgetData;
  const onTrackCount = goals.filter((goal) => hasData(goal) && goal.on_track).length;
  const attentionCount = goals.filter((goal) => hasData(goal) && !goal.on_track).length;
  const missingDataCount = goals.filter((goal) => !hasData(goal)).length;
  const visibleGoals = goals.filter((goal) => goalFilter === "all" ||
    (goalFilter === "attention" ? !hasData(goal) || !goal.on_track : hasData(goal) && goal.on_track));

  return (
    <div className="workspace-page goals-workspace space-y-6">
      <MilestoneCelebration event={activeMilestone} onDismiss={dismissMilestone} />
      <div className="workspace-heading">
        <div>
          <h1 className="text-2xl font-semibold">Goals</h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-0.5">
            Progress for {new Date(`${month}-01T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" })}
          </p>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          <button onClick={() => navMonth(-1)} aria-label="Previous month"
            className="p-1.5 border rounded-lg leading-none hover:bg-[hsl(var(--muted))] transition-colors"><CaretLeftIcon size={16} /></button>
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]" />
          <button onClick={() => navMonth(1)} aria-label="Next month"
            className="p-1.5 border rounded-lg leading-none hover:bg-[hsl(var(--muted))] transition-colors"><CaretRightIcon size={16} /></button>
          <button onClick={() => { cancelEdit(); setFormOpen(true); }} className="ml-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] text-sm"><PlusIcon size={15} /> New goal</button>
        </div>
      </div>

      {/* Add goal form */}
      <details ref={formRef} hidden={!formOpen} open={formOpen} onToggle={(event) => setFormOpen(event.currentTarget.open)} className="workspace-disclosure goal-editor">
        <summary>{editingId ? "Edit goal" : "Create a goal"}</summary>
        <div className="space-y-4 pt-3 pb-5">

        {/* Type selector -- two rows */}
        <label className="flex items-center gap-3 text-sm">Goal type
          <select value={formType} onChange={(event) => handleTypeChange(event.target.value as GoalType)} title={DESCS[formType]} className="border rounded-lg px-3 py-2 bg-[hsl(var(--background))] max-w-full">
            {(Object.keys(LABELS) as GoalType[]).map((type) => <option key={type} value={type}>{LABELS[type]}</option>)}
          </select>
        </label>

        {/* Input row */}
        <div className="flex gap-3 flex-wrap">
          <input type="text" aria-label="Goal name" placeholder="Goal name" value={formName}
            onChange={(e) => setFormName(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-36
                       bg-[hsl(var(--background))] text-[hsl(var(--foreground))]
                       placeholder:text-[hsl(var(--muted-foreground))]" />
          {showCatPicker && formCats.length > 0 && (
            <select aria-label="Goal category" value={formCatId} onChange={(e) => setFormCatId(parseInt(e.target.value))}
              className="border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
              <CategoryOptions categories={formCats} />
            </select>
          )}
          {showAccountPicker && (
            <select aria-label="Goal account" value={formAccountId} onChange={(e) => setFormAccountId(parseInt(e.target.value))}
              className="border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
              <option value={0}>All Credit Cards & Loans</option>
              {debtAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name} ({a.account_type === "credit" ? "Credit Card" : "Loan"})</option>
              ))}
            </select>
          )}
          <div className="flex items-center gap-1">
            {!isRatePct && <span className="text-sm text-[hsl(var(--muted-foreground))]">$</span>}
            <input type="number" min={formType === "debt_paydown" ? "0" : "1"} step={isRatePct ? "1" : "0.01"}
              aria-label={isRatePct ? "Target savings rate" : "Target amount"} placeholder={isRatePct ? "Rate %" : "Target"}
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
            {saving ? "Saving..." : editingId ? "Save Changes" : "Add"}
          </button>
          {formOpen && (
            <button onClick={cancelEdit}
              className="px-4 py-2 border rounded-lg text-sm font-medium hover:bg-[hsl(var(--muted))] transition-colors">
              Cancel
            </button>
          )}
        </div>
        </div>
      </details>

      {loading && <CardListSkeleton count={3} />}

      {!loading && goals.length > 0 && <>
        <div className="goal-summary">
          <div><p>On track</p><strong>{onTrackCount}<span> / {goals.length}</span></strong></div>
          <div><p>Needs attention</p><strong className={attentionCount ? "text-[hsl(var(--warning))]" : ""}>{attentionCount}</strong></div>
          <div><p>Awaiting data</p><strong>{missingDataCount}</strong></div>
        </div>
        <div className="workspace-segments" role="group" aria-label="Goal status">
          <button aria-pressed={goalFilter === "all"} onClick={() => setGoalFilter("all")}><TargetIcon size={14} /> All goals</button>
          <button aria-pressed={goalFilter === "attention"} onClick={() => setGoalFilter("attention")}><WarningCircleIcon size={14} /> Attention</button>
          <button aria-pressed={goalFilter === "onTrack"} onClick={() => setGoalFilter("onTrack")}><CheckIcon size={14} /> On track</button>
        </div>
        {visibleGoals.length === 0 && <p className="text-sm text-[hsl(var(--muted-foreground))] py-8">No goals in this group.</p>}
      </>}

      {!loading && goals.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-20 text-center">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl mb-1"
            style={{ backgroundColor: "hsl(var(--muted))" }}
          >
            <TargetIcon size={24} />
          </div>
          <p className="font-semibold text-[hsl(var(--foreground))]">No goals yet</p>
          <p className="text-sm text-[hsl(var(--muted-foreground))] max-w-md">
            Your next milestone starts here.
          </p>
          <button onClick={() => setFormOpen(true)} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] text-sm"><PlusIcon size={15} /> Create your first goal</button>
        </div>
      )}

      <div className="goal-grid">
      {!loading && visibleGoals.map((g) => {
        const isSpend  = g.type === "reduce_spend";
        const isIncome = g.type === "increase_income";
        const isStreak = STREAK_TYPES.has(g.type);
        const isClassic = CLASSIC_TYPES.has(g.type);
        const isReduceType = isSpend || g.type === "debt_paydown";
        const targetMonths = g.target_months ?? 3;
        const streakCount = g.current_streak;

        const barPct = Math.max(0, Math.min(100, g.pct));
        const barColor = isReduceType
          ? (g.on_track ? "hsl(var(--primary))" : "hsl(var(--error))")
          : "hsl(var(--primary))";

        const totalDays = daysInMonth(month);
        const elapsed   = daysElapsed(month);
        const remaining = totalDays - elapsed;
        const dailyNeeded = remaining > 0
          ? (g.target_cents - g.current_cents) / remaining
          : 0;
        const showPace = remaining > 0 && (isSpend || isIncome);

        return (
          <article key={g.id} className="goal-item">
            <div className="flex items-start justify-between mb-3 gap-2">
              <div className="min-w-0">
                <h2 className="text-base font-semibold break-words">{g.name}</h2>
                <span className="text-xs text-[hsl(var(--muted-foreground))]">
                  {LABELS[g.type]}
                </span>
                {g.category_name && (
                  <span className="text-xs text-[hsl(var(--muted-foreground))]">
                    {", "}{g.category_name}
                  </span>
                )}
                {g.account_name && (
                  <span className="text-xs text-[hsl(var(--muted-foreground))]">
                    {", "}{g.account_name}
                  </span>
                )}
                {g.type === "debt_paydown" && !g.account_name && (
                  <span className="text-xs text-[hsl(var(--muted-foreground))]">
                    {", "}All debt accounts
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {confirmDeleteId === g.id ? (
                  <span className="flex items-center gap-1.5">
                    <button onClick={() => removeGoal(g.id)}
                      className="text-xs px-2 py-0.5 rounded-md font-medium"
                      style={{ color: "white", backgroundColor: "hsl(var(--error))" }}>
                      Delete?
                    </button>
                    <button onClick={() => setConfirmDeleteId(null)}
                      className="text-xs px-2 py-0.5 rounded-md border hover:bg-[hsl(var(--muted))] transition-colors">
                      Cancel
                    </button>
                  </span>
                ) : (
                  <span className="flex items-center gap-1">
                    <button onClick={() => startEdit(g)}
                      title="Edit goal" aria-label={`Edit ${g.name}`} className="workspace-icon text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--gold-ink))]">
                      <PencilSimpleIcon size={15} />
                    </button>
                    <button onClick={() => setConfirmDeleteId(g.id)}
                      title="Remove goal" aria-label={`Remove ${g.name}`} className="workspace-icon text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--error))]">
                      <TrashIcon size={15} />
                    </button>
                  </span>
                )}
              </div>
            </div>

            {hasData(g) && <p className={`flex items-center gap-1.5 text-xs mb-5 ${g.on_track ? "text-[hsl(var(--muted-foreground))]" : "text-[hsl(var(--warning))]"}`}>
              {g.on_track ? <CheckIcon size={14} /> : <WarningCircleIcon size={14} />}{g.on_track ? "On track" : "Needs attention"}
            </p>}

            {/* No-data banners */}
            {g.noBalanceData && (
              <p className="text-xs text-[hsl(var(--warning))] mb-3">
                No balance data yet -- import a CSV with a Balance column to enable this goal.
              </p>
            )}
            {g.noBudgetData && (
              <p className="text-xs text-[hsl(var(--warning))] mb-3">
                A monthly budget and covered, completed months are needed to measure this streak.
              </p>
            )}

            {/* Streak display */}
            {isStreak && !g.noBudgetData && (
              <div className="mb-3">
                <div className="flex items-baseline gap-2 mb-2">
                  <span className="text-2xl font-bold">{streakCount}</span>
                  <span className="text-sm text-[hsl(var(--muted-foreground))]">/ {targetMonths} months</span>
                  {streakCount >= targetMonths && (
                    <span className="text-sm font-semibold text-[hsl(var(--success))]">Goal reached</span>
                  )}
                </div>
                <div className="flex gap-1">
                  {Array.from({ length: targetMonths }).map((_, i) => (
                    <div key={i}
                      className="h-2 rounded-full flex-1"
                      style={{ backgroundColor: i < streakCount ? "hsl(var(--primary))" : "hsl(var(--muted))" }}
                    />
                  ))}
                </div>
                {g.type === "savings_rate_habit" && (
                  <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1.5">
                    Target: {g.target_cents / 100}% savings rate
                  </p>
                )}
              </div>
            )}

            {/* Classic + savings_target + balance_floor progress bar */}
            {!isStreak && !g.noBalanceData && (
              <div className="goal-progress">
                <div className="goal-progress-track h-2 rounded-full bg-[hsl(var(--muted))] overflow-hidden mb-3" role="meter" aria-label={`${g.name} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={barPct} aria-valuetext={`${formatCurrency(g.current_cents)} of ${formatCurrency(g.target_cents)}`}>
                  <div className="h-full rounded-full transition-all"
                    style={{ width: `${barPct}%`, backgroundColor: barColor }} />
                </div>

                <div className="goal-progress-values text-sm text-[hsl(var(--muted-foreground))] mb-3">
                  <span>
                    {isSpend       ? "Spent: "
                    : isIncome     ? "Earned: "
                    : g.type === "savings_target" ? "Saved: "
                    : g.type === "balance_floor"  ? "Balance: "
                    : g.type === "debt_paydown"   ? "Owed: "
                    :                              "Net: "}
                    <span className="goal-current text-[hsl(var(--foreground))]">
                      {formatCurrency(g.current_cents)}
                    </span>
                  </span>
                  <span>
                    {isSpend || g.type === "balance_floor" || g.type === "debt_paydown" ? "Target: " : "Goal: "}
                    <span className="font-medium text-[hsl(var(--foreground))]">
                      {formatCurrency(g.target_cents)}
                    </span>
                  </span>
                </div>
              </div>
            )}

            {!isStreak && hasData(g) && <p className="text-xs text-[hsl(var(--muted-foreground))] mb-3">
              {g.type === "debt_paydown"
                ? `${formatCurrency(Math.max(0, g.current_cents - g.target_cents))} left to pay down`
                : isSpend
                  ? `${formatCurrency(Math.abs(g.target_cents - g.current_cents))} ${g.current_cents > g.target_cents ? "over limit" : "left this month"}`
                  : g.current_cents >= g.target_cents ? "Target reached"
                  : `${formatCurrency(g.target_cents - g.current_cents)} to target`}
            </p>}

            {/* Daily pace + weekly bar for classic types */}
            {isClassic && showPace && (
              <div className="flex items-end justify-between gap-4 pt-2 border-t">
                <div>
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">
                    {isSpend ? "Daily allowance left" : "Daily needed"}
                  </p>
                  <p className={`text-sm font-semibold ${
                    isSpend
                      ? dailyNeeded < 0 ? "text-[hsl(var(--error))]" : "text-[hsl(var(--success))]"
                      : dailyNeeded <= 0 ? "text-[hsl(var(--success))]" : "text-[hsl(var(--foreground))]"
                  }`}>
                    {isSpend
                      ? dailyNeeded < 0 ? "Over limit"
                        : `${formatCurrency(dailyNeeded)}/day left`
                      : dailyNeeded <= 0 ? "Goal reached"
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
          </article>
        );
      })}
      </div>
    </div>
  );
}
