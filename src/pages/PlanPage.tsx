import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import CashFlowHorizon from "@/components/CashFlowHorizon";
import { loadScenario, saveScenario } from "@/lib/planScenario";
import { CalendarClock, TrendingUp, Sparkles, AlertTriangle, Wand2, EyeOff, Landmark, CalendarPlus, ChevronRight } from "lucide-react";
import { motion } from "motion/react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { staggerContainer, riseIn } from "@/lib/motionPresets";
import {
  projectCashFlow, expandOccurrences, deriveNextActions, resolveForecastWindow,
  groupUpcomingEvents, monthlyEquivalentCents, toISODate, baselineIsUsable,
  type NextAction, type NextActionTone, type ForecastWindowMode,
} from "@/lib/forecast";
import { simulateCustomDebtPayoff } from "@/lib/agent";
import { createRecurringRule } from "@/lib/db";
import { getForecastInputs, getDebtContext, type ForecastInputs, type DebtContext } from "@/lib/forecastData";
import { hideCharge, unhideCharge, listHiddenCharges, clearHiddenCharges } from "@/lib/hiddenCharges";
import { useProfileStore } from "@/stores/profileStore";
import { useCategoryStore } from "@/stores/categoryStore";
import { reportLoadError, toast } from "@/stores/toastStore";
import RecurringRulesPanel from "@/components/RecurringRulesPanel";
import DebtPayoffModal from "@/components/DebtPayoffModal";
import InfoTooltip from "@/components/InfoTooltip";
import { CardListSkeleton } from "@/components/Skeleton";

/** The three questions people actually ask about their balance. Each resolves to a different
 *  number of days, so every figure on this page moves with the selection. */
type PlanWindow = ForecastWindowMode;

const WINDOWS: { id: PlanWindow; label: string }[] = [
  { id: "month",      label: "Rest of month" },
  { id: "paycheck",   label: "To next paycheck" },
  { id: "nextMonth",  label: "Through next month" },
];

/** Events are expanded this far ahead regardless of window, so "to next paycheck" can find a
 *  paycheck further out than the window being shown, and "through next month" always reaches
 *  the end of a 31-day month. */
const MAX_LOOKAHEAD_DAYS = 95;

const ACTION_TONE: Record<NextActionTone, { color: string; label: string }> = {
  urgent:    { color: "hsl(var(--error))",   label: "Do this first" },
  suggested: { color: "hsl(var(--warning))", label: "Worth doing" },
  positive:  { color: "hsl(var(--success))", label: "Opportunity" },
};

function EmptyState({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 py-20 text-center">
      <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-1" style={{ backgroundColor: "hsl(var(--muted))" }}>
        {icon}
      </div>
      <p className="font-semibold text-[hsl(var(--foreground))]">{title}</p>
      <div className="text-sm text-[hsl(var(--muted-foreground))] max-w-md space-y-3">{children}</div>
    </div>
  );
}

export default function PlanPage() {
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const profileId = activeProfile?.id ?? 1;
  return <ProfilePlan key={profileId} profileId={profileId} />;
}

function ProfilePlan({ profileId }: { profileId: number }) {
  const [stored] = useState(() => loadScenario(profileId));

  const [inputs, setInputs] = useState<ForecastInputs | null>(null);
  const [debtContext, setDebtContext] = useState<DebtContext | null>(null);
  const [payoffOpen, setPayoffOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);
  const loadSequence = useRef(0);

  const [planWindow, setPlanWindow] = useState<PlanWindow>(stored.window);
  // What-if controls. These feed straight back into the pure projection, which is why it has to
  // stay synchronous - they recompute on every drag with no DB round trip. Persisted so a
  // scenario survives navigating away and back.
  const [extraSpendCents, setExtraSpendCents] = useState(stored.extra);
  const [bufferCents, setBufferCents] = useState(stored.buffer);
  const [includeDetected, setIncludeDetected] = useState(stored.detected);
  const [useBaseline, setUseBaseline] = useState(stored.typical);
  const [purchase, setPurchase] = useState(stored.purchase);
  const [holdScale, setHoldScale] = useState(false);
  useEffect(() => {
    const release = () => setHoldScale(false);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    return () => { window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release); window.removeEventListener("blur", release); };
  }, []);

  useEffect(() => {
    saveScenario(profileId, { version: 1, window: planWindow, extra: extraSpendCents, buffer: bufferCents, detected: includeDetected, typical: useBaseline, purchase });
  }, [profileId, planWindow, extraSpendCents, bufferCents, includeDetected, useBaseline, purchase]);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    const [data, debts] = await Promise.all([
      getForecastInputs(profileId),
      getDebtContext(profileId),
    ]);
    if (sequence !== loadSequence.current) return;
    setInputs(data);
    setDebtContext(debts);
    setLoading(false);
  }, [profileId]);

  useEffect(() => {
    let cancelled = false;
    load().catch((err) => {
      if (cancelled) return;
      setLoading(false);
      reportLoadError("your forecast", () => setReloadTick((t) => t + 1))(err);
    });
    return () => { cancelled = true; loadSequence.current++; };
  }, [load, reloadTick]);

  const setWindowPersisted = (w: PlanWindow) => {
    setPlanWindow(w);
  };

  const hiddenCount = listHiddenCharges(profileId).length;

  const handleHide = (description: string) => {
    hideCharge(profileId, description);
    setReloadTick((t) => t + 1);
    toast.info(<>Hidden from your forecast and subscriptions.</>, {
      action: {
        label: "Undo",
        onClick: () => { unhideCharge(profileId, description); setReloadTick((t) => t + 1); },
      },
    });
  };

  const handleRestoreHidden = () => {
    clearHiddenCharges(profileId);
    setReloadTick((t) => t + 1);
    toast.success("Restored every hidden charge.");
  };

  const categories = useCategoryStore((s) => s.categories);

  /** Promotes a detected charge to a real rule; the loose-match dedup in getForecastInputs
   *  drops the detected copy on the next load, so nothing is projected twice. */
  const handleConfirm = async (description: string) => {
    const rule = inputs?.detected.find((r) => r.description === description);
    if (!rule) return;
    try {
      await createRecurringRule({
        profileId,
        accountId: null,
        description: rule.description,
        amountCents: rule.amount_cents,
        categoryId: categories.find((c) => c.name === rule.category_name)?.id ?? null,
        cadence: "monthly",
        dayOfMonth: rule.day_of_month ?? 1,
        dayOfWeek: null,
        startDate: rule.start_date,
      });
      toast.success(<>Scheduled <span className="font-semibold">{rule.description}</span> - edit the date or amount below if the guess is off.</>);
      setReloadTick((t) => t + 1);
    } catch (err) {
      console.error(err);
      toast.error("Couldn't schedule that charge.");
    }
  };

  const upcomingRef = useRef<HTMLElement | null>(null);
  const rulesRef = useRef<HTMLDetailsElement | null>(null);
  const [ruleFormRequest, setRuleFormRequest] = useState<{ tick: number; income: boolean }>({ tick: 0, income: false });

  const handleAction = (a: NextAction) => {
    if (a.anchor === "payoff" && debtContext) setPayoffOpen(true);
    else if (a.anchor === "detected") upcomingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    else if (a.anchor === "rules") {
      if (rulesRef.current) rulesRef.current.open = true;
      setRuleFormRequest((r) => ({ tick: r.tick + 1, income: a.key === "add_income" }));
      rulesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const forecast = useMemo(() => {
    if (!inputs) return null;
    const today = new Date();
    const start = toISODate(today);
    const lookaheadEnd = new Date(today);
    lookaheadEnd.setDate(lookaheadEnd.getDate() + MAX_LOOKAHEAD_DAYS);

    const activeRules = includeDetected ? [...inputs.rules, ...inputs.detected] : inputs.rules;
    const allEvents = expandOccurrences(activeRules, today, lookaheadEnd);

    const { days, endDate, usedFallback } = resolveForecastWindow(allEvents, today, planWindow);
    const events = allEvents.filter((e) => e.date <= endDate);

    // Per-day outflow = the user's typical spending (when opted in) plus whatever extra they're
    // simulating - the forecast still never invents a rate the user hasn't accepted.
    const baselineDaily = useBaseline && baselineIsUsable(inputs.baseline) ? inputs.baseline.dailySpendCents : 0;
    const dailySpendCents = baselineDaily;

    return {
      current: projectCashFlow({ startingBalanceCents: inputs.startingBalanceCents, startDate: start, days, events, dailySpendCents, bufferCents }),
      result: projectCashFlow({
        startingBalanceCents: inputs.startingBalanceCents,
        startDate: start,
        days,
        events,
        dailySpendCents,
        bufferCents,
        extraSpendCents,
        purchase,
      }),
      days,
      endDate,
      usedFallback,
      events,
      baselineDailyCents: baselineDaily,
      /** Scheduled items falling just outside the window, so the UI can point at the next one. */
      laterEvents: allEvents.filter((e) => e.date > endDate),
    };
  }, [inputs, planWindow, extraSpendCents, bufferCents, includeDetected, useBaseline, purchase]);

  const nextActions = useMemo(() => {
    if (!forecast || !inputs) return [];
    const biggestDebt = debtContext?.debts
      .slice()
      .sort((a, b) => Math.abs(b.balance_cents ?? 0) - Math.abs(a.balance_cents ?? 0))[0];
    return deriveNextActions(forecast.result, {
      hasIncomeRule: inputs.hasIncomeRule,
      detectedCount: includeDetected ? inputs.detected.length : 0,
      dailyOutflowCents: Math.round(
        (forecast.result.totalBillsCents + forecast.result.assumedSpendCents) / forecast.days
      ),
      topDebt: biggestDebt
        ? { name: biggestDebt.name, balanceCents: Math.abs(biggestDebt.balance_cents ?? 0) }
        : null,
    });
  }, [forecast, inputs, includeDetected, debtContext]);

  /** Monthly income minus monthly bills from the scheduled rules. Deliberately independent of
   *  the selected window - scaling a 4-day paycheck window up to a month produces nonsense. */
  const monthlySurplusCents = useMemo(() => {
    if (!inputs) return 0;
    const rules = includeDetected ? [...inputs.rules, ...inputs.detected] : inputs.rules;
    return rules.reduce((sum, r) => sum + monthlyEquivalentCents(r), 0);
  }, [inputs, includeDetected]);

  /** What redirecting that surplus would do, against the minimum-payments-only baseline. */
  const payoff = useMemo(() => {
    if (!debtContext || monthlySurplusCents <= 0) return null;
    const withSurplus = simulateCustomDebtPayoff(debtContext.plan.simDebts, monthlySurplusCents);
    const baseline = debtContext.plan.baseline;
    const interestSaved = baseline.totalInterestCents - withSurplus.totalInterestCents;
    const monthsSaved =
      baseline.monthsToPayoff != null && withSurplus.monthsToPayoff != null
        ? baseline.monthsToPayoff - withSurplus.monthsToPayoff
        : null;
    return { baseline, withSurplus, interestSaved, monthsSaved };
  }, [debtContext, monthlySurplusCents]);

  if (loading) {
    return <div className="workspace-page"><CardListSkeleton /></div>;
  }

  const header = (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <div>
        <h1 className="text-2xl font-semibold">Plan</h1>
        <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1 max-w-lg">
          A forward look at your checking balance - what's coming in, what's going out, and
          whether you make it to the next paycheck.
        </p>
      </div>
    </div>
  );

  if (!inputs || inputs.checkingAccountCount === 0) {
    return (
      <div className="workspace-page space-y-6">
        {header}
        <EmptyState icon={<CalendarClock size={24} className="text-[hsl(var(--muted-foreground))]" />} title="No checking account yet">
          <p>
            The forecast projects your spendable cash, so it needs a checking or debit account.
            Import a bank statement and it'll appear here.
          </p>
          <Link to="/import" className="inline-block px-5 py-2.5 rounded-lg text-sm font-semibold bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]">
            Import a statement
          </Link>
        </EmptyState>
      </div>
    );
  }

  const result = forecast!.result;
  const incomplete = inputs.balanceSources.some((source) => source.balance === null);
  const low = result.lowPoint;
  const short = result.firstShortfall;
  const windowDays = forecast!.days;
  const baselineDaily = forecast!.baselineDailyCents;
  /** Whole-window totals for the waterfall; extra absorbs the per-day rounding remainder. */
  const typicalSpendTotal = baselineDaily * windowDays;
  const extraSpendTotal = result.assumedSpendCents - typicalSpendTotal;
  const incomeCount = forecast!.events.filter((e) => e.amountCents > 0).length;
  const billCount = forecast!.events.filter((e) => e.amountCents < 0).length;
  const windowLabel =
    planWindow === "nextMonth" ? "the end of next month"
    : planWindow === "paycheck" && !forecast!.usedFallback ? "your next paycheck"
    : "the rest of this month";

  return (
    <motion.div
      className="workspace-page plan-workspace"
      onPointerDownCapture={(event) => { if (event.target instanceof HTMLInputElement && event.target.type === "range" && event.target.closest(".plan-scenarios")) setHoldScale(true); }}
      variants={staggerContainer} initial="hidden" animate="show"
    >
      <div className="workspace-heading plan-heading">
        <div>
          <h1 className="text-2xl font-semibold">Plan</h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1 max-w-lg">
            {formatDate(toISODate(new Date()))} to {formatDate(forecast!.endDate)}
          </p>
        </div>
        <div className="shrink-0">
          <div className="flex gap-1 border rounded-lg p-1 w-fit" role="group" aria-label="Forecast window">
            {WINDOWS.map((w) => (
              <button
                key={w.id}
                onClick={() => setWindowPersisted(w.id)}
                aria-pressed={planWindow === w.id}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                  planWindow === w.id
                    ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                    : "hover:bg-[hsl(var(--muted))]"
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-1.5 text-right">
            {windowDays} days · {inputs.checkingAccountCount} checking account{inputs.checkingAccountCount === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      {/* ── Headline ─────────────────────────────────────────────────────── */}
      {/* All-good stays quiet (default border) so the red shortfall state is salient by scarcity. */}
      <motion.section
        variants={riseIn}
        className="plan-summary"
        style={{ borderColor: short ? "hsl(var(--error))" : undefined }}
      >
        <div className="flex items-start gap-4">
          <span
            className="w-11 h-11 rounded-full flex items-center justify-center shrink-0"
            style={{ backgroundColor: result.safeToSpendCents < 0 ? "hsl(var(--error)/0.12)" : "hsl(var(--muted))" }}
          >
            {result.safeToSpendCents < 0
              ? <AlertTriangle size={22} style={{ color: "hsl(var(--error))" }} />
              : <TrendingUp size={22} style={{ color: "hsl(var(--muted-foreground))" }} />}
          </span>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold">
              {incomplete ? "Account balances need attention" : short
                ? `Cash shortfall on ${formatDate(short.date)}`
                : result.safeToSpendCents < 0 ? "Your reserved cushion is at risk"
                : `Covered through ${windowLabel}`}
            </h2>
            {forecast!.usedFallback && (
              <p className="text-xs mt-1" style={{ color: "hsl(var(--warning))" }}>
                No paycheck scheduled. Showing month-end.
              </p>
            )}
            <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">
              {baselineDaily > 0 ? "Includes typical spending" : "Bills-only forecast · everyday spending excluded"}
            </p>
          </div>
        </div>

        <div className="plan-metrics">
          <div className="plan-primary-metric">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">Safe to spend</p>
            <p className="plan-available tabular-nums" data-testid="safe-to-spend" style={{ color: result.safeToSpendCents < 0 ? "hsl(var(--error))" : undefined }}>
              {incomplete ? "Unavailable" : formatCurrency(result.safeToSpendCents)}
            </p>
            <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">
              {incomplete ? "Missing a recorded checking balance" : result.safeToSpendCents < 0 ? "Short of your cash cushion" : "Above your reserved cushion"}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))] flex items-center gap-1">
              Scheduled margin
              <InfoTooltip text="Scheduled income minus bills in this window, before everyday spending." />
            </p>
            <p
              className="text-2xl font-bold tabular-nums mt-1"
              style={{ color: result.afterBillsCents < 0 ? "hsl(var(--error))" : undefined }}
            >
              {formatCurrency(result.afterBillsCents)}
            </p>
            <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">
              {result.afterBillsCents < 0
                ? "Bills exceed the income arriving"
                : "Income less bills, before spending"}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">Lowest point</p>
            <p className="text-2xl font-bold tabular-nums mt-1" style={{ color: (low?.balanceCents ?? 0) < 0 ? "hsl(var(--error))" : undefined }}>
              {low ? formatCurrency(low.balanceCents) : "—"}
            </p>
            <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">
              {low ? formatDate(low.date) : "No projection"}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">In vs out</p>
            <p className="text-2xl font-bold tabular-nums mt-1">
              <span style={{ color: "hsl(var(--success))" }}>{formatCurrency(result.totalIncomeCents)}</span>
              <span className="text-[hsl(var(--muted-foreground))] text-base"> / </span>
              <span style={{ color: "hsl(var(--error))" }}>{formatCurrency(result.totalBillsCents)}</span>
            </p>
            <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">
              {incomeCount === 0 && billCount === 0
                ? `Nothing scheduled in these ${windowDays} days`
                : `${incomeCount} deposit${incomeCount === 1 ? "" : "s"} · ${billCount} bill${billCount === 1 ? "" : "s"} over ${windowDays} day${windowDays === 1 ? "" : "s"}`}
            </p>
          </div>
        </div>

        {/* Starts from the real balance so it lands on the projected end figure - a flow-only
            version reads as a huge deficit even when the account never goes near zero. */}
        <details className="workspace-disclosure mt-5">
          <summary>Source balances</summary>
          {inputs.balanceSources.map((source) => <div key={source.id} className="flex justify-between gap-4 py-2 text-sm flex-wrap">
            <span>{source.name}</span><span>{source.balance === null ? "No recorded balance" : formatCurrency(source.balance)}{source.date ? ` as of ${formatDate(source.date)}` : ""}</span>
          </div>)}
          {incomplete && <p role="status" className="text-xs text-[hsl(var(--warning))]">Projection includes known balances only. Import or confirm missing balances before relying on it.</p>}
        </details>
        <details className="workspace-disclosure mt-5">
        <summary>Balance breakdown</summary>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 pt-4 text-sm tabular-nums">
          <span>{formatCurrency(inputs.startingBalanceCents)}</span>
          <span className="text-[hsl(var(--muted-foreground))] text-xs">now</span>
          <span className="text-[hsl(var(--muted-foreground))]">+</span>
          <span style={{ color: "hsl(var(--success))" }}>{formatCurrency(result.totalIncomeCents)}</span>
          <span className="text-[hsl(var(--muted-foreground))] text-xs">coming in</span>
          <span className="text-[hsl(var(--muted-foreground))]">−</span>
          <span style={{ color: "hsl(var(--error))" }}>{formatCurrency(result.totalBillsCents)}</span>
          <span className="text-[hsl(var(--muted-foreground))] text-xs">bills</span>
          {typicalSpendTotal > 0 && (
            <>
              <span className="text-[hsl(var(--muted-foreground))]">−</span>
              <span>{formatCurrency(typicalSpendTotal)}</span>
              <span className="text-[hsl(var(--muted-foreground))] text-xs">typical spending</span>
            </>
          )}
          {extraSpendTotal > 0 && (
            <>
              <span className="text-[hsl(var(--muted-foreground))]">−</span>
              <span style={{ color: "var(--gold)" }}>{formatCurrency(extraSpendTotal)}</span>
              <span className="text-[hsl(var(--muted-foreground))] text-xs">what-if spending</span>
            </>
          )}
          <span className="text-[hsl(var(--muted-foreground))]">=</span>
          <span
            className="font-semibold"
            style={{ color: result.endingBalanceCents < 0 ? "hsl(var(--error))" : "hsl(var(--success))" }}
          >
            {formatCurrency(result.endingBalanceCents)}
          </span>
          <span className="text-[hsl(var(--muted-foreground))] text-xs">
            left on {formatDate(forecast!.endDate)}
          </span>
        </div>

        {billCount === 0 && forecast!.events.length > 0 && (
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-4 pt-4 border-t">
            No bills fall inside this window - your next one is{" "}
            {(() => {
              const nextBill = forecast!.laterEvents.find((e) => e.amountCents < 0);
              return nextBill
                ? <><span className="font-medium text-[hsl(var(--foreground))]">{nextBill.description}</span> on {formatDate(nextBill.date)}</>
                : "further out";
            })()}
            . Widen the window to include it.
          </p>
        )}
        </details>
      </motion.section>

      {/* ── What-if ────────────────────────────────────────────────────── */}
      <motion.section variants={riseIn} className="plan-scenarios space-y-5">
        <div>
          <h2 className="font-semibold text-sm flex items-center gap-1.5"><Wand2 size={14} /> Your scenario</h2>
        </div>

        <div className="grid gap-6">
          <label className="block">
            <span className="text-xs font-medium">
              Extra spending{" "}
              <span className="tabular-nums" style={{ color: "var(--gold)" }}>{formatCurrency(extraSpendCents)}</span>
            </span>
            <input
              type="range" min={0} max={200_000} step={5_000}
              value={extraSpendCents}
              onChange={(e) => setExtraSpendCents(Number(e.target.value))}
              className="w-full mt-2 accent-[hsl(var(--primary))]"
            />
            <span className="text-[11px] text-[hsl(var(--muted-foreground))]">
              {formatCurrency(Math.round(extraSpendCents / windowDays))}/day over {windowDays} days
            </span>
          </label>

          <label className="block">
            <span className="text-xs font-medium">
              Keep in reserve{" "}
              <span className="tabular-nums" style={{ color: "var(--gold)" }}>{formatCurrency(bufferCents)}</span>
            </span>
            <input
              type="range" min={0} max={200_000} step={5_000}
              value={bufferCents}
              onChange={(e) => setBufferCents(Number(e.target.value))}
              className="w-full mt-2 accent-[hsl(var(--primary))]"
            />
            <span className="text-[11px] text-[hsl(var(--muted-foreground))]">
              Protected cash, not an expense
            </span>
          </label>
        </div>

        <fieldset className="border-t pt-4 space-y-3">
          <legend className="text-sm font-medium">Purchase preview</legend>
          <label className="block text-xs">Amount
            <input aria-label="Hypothetical purchase amount" type="number" min="0" max="1000000" step="0.01" value={purchase.amountCents / 100 || ""} onChange={(event) => setPurchase({ ...purchase, amountCents: Math.max(0, Math.min(100_000_000, Math.round(Number(event.target.value) * 100))) })} className="w-full border rounded-md bg-[hsl(var(--background))] px-3 py-2 mt-1" />
          </label>
          <label className="block text-xs">Date
            <input aria-label="Hypothetical purchase date" type="date" min={toISODate(new Date())} max={forecast!.endDate} value={purchase.date} onChange={(event) => setPurchase({ ...purchase, date: event.target.value })} className="w-full border rounded-md bg-[hsl(var(--background))] px-3 py-2 mt-1" />
          </label>
          {purchase.amountCents > 0 && (!purchase.date || purchase.date < toISODate(new Date()) || purchase.date > forecast!.endDate) && <p role="status" className="text-xs text-[hsl(var(--warning))]">Preview inactive: choose a date inside this forecast window.</p>}
        </fieldset>

        <div className="flex items-start justify-between gap-3 border-t pt-4">
          <div className="space-y-2.5">
            {inputs.baseline && (
              <label className={`flex items-center gap-2 text-xs font-medium select-none ${baselineIsUsable(inputs.baseline) ? "cursor-pointer" : "opacity-60"}`}>
                <input
                  type="checkbox"
                  checked={useBaseline && baselineIsUsable(inputs.baseline)}
                  disabled={!baselineIsUsable(inputs.baseline)}
                  onChange={(e) => setUseBaseline(e.target.checked)}
                />
                <span>
                  Include my typical spending
                  {baselineIsUsable(inputs.baseline)
                    ? <> <span className="tabular-nums">({formatCurrency(inputs.baseline.dailySpendCents)}/day)</span></>
                    : <span className="text-[hsl(var(--muted-foreground))]"> - needs about a month of imported history first</span>}
                </span>
              </label>
            )}
            {inputs.detected.length > 0 && <label className="flex items-center gap-2 text-xs font-medium cursor-pointer select-none">
              <input type="checkbox" checked={includeDetected} onChange={(e) => setIncludeDetected(e.target.checked)} />
              Include {inputs.detected.length} detected bills
            </label>}
          </div>
          {(extraSpendCents > 0 || bufferCents > 0 || purchase.amountCents > 0) && (
            <button
              onClick={() => { setExtraSpendCents(0); setBufferCents(0); setPurchase({ date: "", amountCents: 0 }); }}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg text-black transition-opacity hover:opacity-90 shrink-0"
              style={{ backgroundColor: "var(--gold)" }}
            >
              Reset
            </button>
          )}
        </div>
      </motion.section>

      {/* ── Projection chart ────────────────────────────────────────────── */}
      <motion.section variants={riseIn} className="plan-chart" id="plan-chart">
        <CashFlowHorizon key={planWindow} current={forecast!.current} scenario={result} bufferCents={bufferCents} typicalDailyCents={baselineDaily} holdScale={holdScale} />
      </motion.section>

      {/* ── What to do next ─────────────────────────────────────────────── */}
      {!incomplete && nextActions.length > 0 && (
        <motion.section variants={riseIn} className="plan-actions">
          <h2 className="font-semibold text-sm mb-3">Next steps</h2>
          <div className="space-y-2">
            {nextActions.map((a) => {
              const clickable = !!a.anchor && (a.anchor !== "payoff" || !!debtContext);
              const inner = (
                <>
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0 mt-2"
                    style={{ backgroundColor: ACTION_TONE[a.tone].color }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: ACTION_TONE[a.tone].color }}>
                      {ACTION_TONE[a.tone].label}
                    </p>
                    <p className="text-sm font-medium mt-0.5">{a.title}</p>
                  </div>
                  {clickable && <ChevronRight size={16} className="shrink-0 self-center text-[hsl(var(--muted-foreground))]" />}
                </>
              );
              return <div key={a.key} className="plan-action-row">{clickable ? (
                <button
                  onClick={() => handleAction(a)}
                  className="w-full text-left py-3 flex items-start gap-3 transition-colors
                             hover:bg-[hsl(var(--muted))] active:scale-[0.99]"
                >
                  {inner}
                </button>
              ) : (
                <div className="py-3 flex items-start gap-3">{inner}</div>
              )}<details className="workspace-disclosure text-xs"><summary>Why this matters</summary><p className="py-2 text-[hsl(var(--muted-foreground))]">{a.detail}</p></details></div>;
            })}
          </div>
        </motion.section>
      )}

      {/* ── Put the surplus to work ────────────────────────────────────── */}
      {payoff && debtContext && (
        <motion.section variants={riseIn} className="plan-payoff">
          <h2 className="font-semibold text-sm flex items-center gap-1.5">
            <Landmark size={14} style={{ color: "var(--gold)" }} /> Put your spare money to work
          </h2>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1 max-w-xl">
            Scheduled monthly margin:{" "}
            <span className="font-semibold" style={{ color: "var(--gold)" }}>
              {formatCurrency(monthlySurplusCents)}
            </span>{" "}
            before everyday spending. Debt: {formatCurrency(debtContext.plan.totalDebtCents)}.
          </p>

          <div className="grid sm:grid-cols-3 gap-4 mt-5">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">Minimums only</p>
              <p className="text-xl font-bold tabular-nums mt-1">{payoff.baseline.payoffDate ?? "Never"}</p>
              <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">
                {formatCurrency(payoff.baseline.totalInterestCents)} interest
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--gold)" }}>
                Redirecting that margin
              </p>
              <p className="text-xl font-bold tabular-nums mt-1" style={{ color: "var(--gold)" }}>
                {payoff.withSurplus.payoffDate ?? "Never"}
              </p>
              <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">
                {formatCurrency(payoff.withSurplus.totalInterestCents)} interest
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">You'd save</p>
              <p className="text-xl font-bold tabular-nums mt-1" style={{ color: "hsl(var(--success))" }}>
                {formatCurrency(Math.max(0, payoff.interestSaved))}
              </p>
              <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">
                {payoff.monthsSaved && payoff.monthsSaved > 0
                  ? `${payoff.monthsSaved} month${payoff.monthsSaved === 1 ? "" : "s"} sooner`
                  : "in interest"}
              </p>
            </div>
          </div>

          <button
            onClick={() => setPayoffOpen(true)}
            className="mt-5 text-sm font-semibold px-4 py-2 rounded-lg text-black transition-opacity hover:opacity-90"
            style={{ backgroundColor: "var(--gold)" }}
          >
            Build a payoff plan
          </button>
        </motion.section>
      )}

      {/* ── Bill calendar ──────────────────────────────────────────────── */}
      <motion.section variants={riseIn} className="plan-upcoming" ref={upcomingRef}>
        <h2 className="font-semibold text-sm mb-1">Upcoming cash flow</h2>
        <p className="text-xs text-[hsl(var(--muted-foreground))] mb-4">
          {incomeCount} deposits · {billCount} bills
        </p>

        {forecast!.events.length === 0 ? (
          <p className="text-sm text-[hsl(var(--muted-foreground))] italic">
            Nothing scheduled between now and {formatDate(forecast!.endDate)}. Add your bills and paycheck below.
          </p>
        ) : (
          <div className="space-y-5">
            {groupUpcomingEvents(forecast!.events).map((group) => (
              <div key={group.label}>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))] mb-2">
                  {group.label}
                </p>
                <div className="space-y-1.5">
                  {group.events.map((e) => (
                    <div key={e.key} className="flex items-center gap-3 border-b py-3 group">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: e.categoryColor ?? "hsl(var(--neutral))" }} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{e.description}</p>
                        <p className="text-xs text-[hsl(var(--muted-foreground))]">
                          {formatDate(e.date)}
                          {e.source === "detected" && (
                            <span className="ml-1.5 inline-flex items-center gap-1 text-[hsl(var(--warning))]">
                              <Sparkles size={12} /> Estimated
                            </span>
                          )}
                        </p>
                      </div>
                      <span
                        className="text-sm font-semibold tabular-nums shrink-0"
                        style={{ color: e.amountCents < 0 ? "hsl(var(--error))" : "hsl(var(--success))" }}
                      >
                        {formatCurrency(e.amountCents)}
                      </span>
                      {/* Space is reserved on every row, not just hideable ones, so amounts stay
                          aligned down the column. */}
                      <span className="w-16 shrink-0 flex justify-end gap-1">
                        {e.source === "detected" && (
                          <>
                            <button
                              onClick={() => handleConfirm(e.description)}
                              aria-label={`Confirm ${e.description} as a scheduled bill`}
                              title="This is a real bill - schedule it so the forecast stops guessing"
                              className="workspace-icon text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--success))]"
                            >
                              <CalendarPlus size={14} />
                            </button>
                            <button
                              onClick={() => handleHide(e.description)}
                              aria-label={`Hide ${e.description}`}
                              title="Not a real bill - hide it from the forecast and subscriptions"
                              className="workspace-icon text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--error))]"
                            >
                              <EyeOff size={14} />
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {hiddenCount > 0 && (
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-4 pt-3 border-t">
            {hiddenCount} charge{hiddenCount === 1 ? " is" : "s are"} hidden from this forecast.{" "}
            <button onClick={handleRestoreHidden} className="underline hover:text-[hsl(var(--foreground))]">
              Restore {hiddenCount === 1 ? "it" : "them"}
            </button>
          </p>
        )}
      </motion.section>

      <motion.details variants={riseIn} ref={rulesRef} className="workspace-disclosure plan-rules">
        <summary>Manage scheduled bills &amp; income</summary>
        <RecurringRulesPanel
          profileId={profileId}
          onChanged={() => setReloadTick((t) => t + 1)}
          openFormRequest={ruleFormRequest}
        />
      </motion.details>

      {payoffOpen && debtContext && (
        <DebtPayoffModal
          profileIds={[profileId]}
          debts={debtContext.debts}
          title="Put your surplus to work"
          subtitle={`Based on the ${formatCurrency(monthlySurplusCents)} a month your schedule leaves spare`}
          onClose={() => setPayoffOpen(false)}
        />
      )}
    </motion.div>
  );
}
