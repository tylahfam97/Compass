import { useState, useEffect, useMemo, useCallback } from "react";
import { Link } from "react-router-dom";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceDot,
} from "recharts";
import { CalendarClock, TrendingUp, Sparkles, AlertTriangle, Wand2, EyeOff, Landmark } from "lucide-react";
import { formatCurrency, formatAxisCurrency, formatDate } from "@/lib/utils";
import {
  projectCashFlow, expandOccurrences, deriveNextActions, resolveForecastWindow,
  groupUpcomingEvents, monthlyEquivalentCents, toISODate, daysFromToday,
  type NextActionTone, type ForecastWindowMode,
} from "@/lib/forecast";
import { simulateCustomDebtPayoff } from "@/lib/agent";
import { getForecastInputs, getDebtContext, type ForecastInputs, type DebtContext } from "@/lib/forecastData";
import { hideCharge, unhideCharge, listHiddenCharges, clearHiddenCharges } from "@/lib/hiddenCharges";
import { useProfileStore } from "@/stores/profileStore";
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

const WINDOW_KEY = "compass_plan_window";

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

  const [inputs, setInputs] = useState<ForecastInputs | null>(null);
  const [debtContext, setDebtContext] = useState<DebtContext | null>(null);
  const [payoffOpen, setPayoffOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);

  const [planWindow, setPlanWindow] = useState<PlanWindow>(() => {
    const saved = localStorage.getItem(WINDOW_KEY) as PlanWindow | null;
    return WINDOWS.some((w) => w.id === saved) ? saved! : "month";
  });
  // What-if controls. Both feed straight back into the pure projection, which is why it has to
  // stay synchronous - these recompute on every drag with no DB round trip.
  const [extraSpendCents, setExtraSpendCents] = useState(0);
  const [bufferCents, setBufferCents] = useState(0);
  const [includeDetected, setIncludeDetected] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [data, debts] = await Promise.all([
      getForecastInputs(profileId),
      getDebtContext(profileId),
    ]);
    setInputs(data);
    setDebtContext(debts);
    setLoading(false);
  }, [profileId]);

  useEffect(() => {
    load().catch((err) => {
      setLoading(false);
      reportLoadError("your forecast", () => setReloadTick((t) => t + 1))(err);
    });
  }, [load, reloadTick]);

  const setWindowPersisted = (w: PlanWindow) => {
    setPlanWindow(w);
    localStorage.setItem(WINDOW_KEY, w);
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

    // The only per-day outflow is whatever the user is explicitly simulating - the forecast
    // never invents a spending rate of its own.
    const dailySpendCents = Math.round(extraSpendCents / days);

    return {
      result: projectCashFlow({
        startingBalanceCents: inputs.startingBalanceCents,
        startDate: start,
        days,
        events,
        dailySpendCents,
        bufferCents,
      }),
      days,
      endDate,
      usedFallback,
      events,
      /** Scheduled items falling just outside the window, so the UI can point at the next one. */
      laterEvents: allEvents.filter((e) => e.date > endDate),
    };
  }, [inputs, planWindow, extraSpendCents, bufferCents, includeDetected]);

  // Kept in cents: formatAxisCurrency and formatCurrency both expect cents, and converting to
  // dollars here made the axis render $1,500 as "$15".
  const chartData = useMemo(
    () => forecast?.result.days.map((d) => ({
      date: d.date,
      balance: d.balanceCents,
      committed: d.committedCents,
    })) ?? [],
    [forecast]
  );

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
    return <div className="p-8 max-w-5xl mx-auto"><CardListSkeleton /></div>;
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
      <div className="p-8 max-w-5xl mx-auto space-y-6">
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
  const low = result.lowPoint;
  const short = result.firstShortfall;
  const windowDays = forecast!.days;
  const incomeCount = forecast!.events.filter((e) => e.amountCents > 0).length;
  const billCount = forecast!.events.filter((e) => e.amountCents < 0).length;
  const windowLabel =
    planWindow === "nextMonth" ? "the end of next month"
    : planWindow === "paycheck" && !forecast!.usedFallback ? "your next paycheck"
    : "the rest of this month";

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      {header}

      {/* ── Headline ─────────────────────────────────────────────────────── */}
      <section
        className="border rounded-2xl p-6"
        style={{ borderColor: short ? "hsl(var(--error))" : "hsl(var(--success))" }}
      >
        <div className="flex items-start gap-4">
          <span
            className="w-11 h-11 rounded-full flex items-center justify-center shrink-0"
            style={{ backgroundColor: short ? "hsl(var(--error)/0.12)" : "hsl(var(--success)/0.12)" }}
          >
            {short
              ? <AlertTriangle size={22} style={{ color: "hsl(var(--error))" }} />
              : <TrendingUp size={22} style={{ color: "hsl(var(--success))" }} />}
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))] mb-1">
              {formatDate(toISODate(new Date()))} – {formatDate(forecast!.endDate)} · {windowDays} day{windowDays === 1 ? "" : "s"}
            </p>
            <h2 className="text-xl font-semibold">
              {short
                ? `You're projected to run short on ${formatDate(short.date)}`
                : `You stay above zero through ${windowLabel}`}
            </h2>
            {forecast!.usedFallback && (
              <p className="text-xs mt-1" style={{ color: "hsl(var(--warning))" }}>
                No income is scheduled yet, so this is showing the rest of the month instead.
              </p>
            )}
            <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">
              {short ? (
                <>
                  That's {daysFromToday(short.date)} days out, at about {formatCurrency(short.balanceCents)}.
                  Scheduling more of your income below, or moving a bill, changes this.
                </>
              ) : result.nextIncome ? (
                <>
                  Your next scheduled income is {formatCurrency(result.nextIncome.amountCents)} on{" "}
                  {formatDate(result.nextIncome.date)} - and you reach it with room to spare.
                </>
              ) : (
                <>Add your paycheck below and this becomes a real answer to "will I make it to payday".</>
              )}
            </p>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-6">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">Safe to spend</p>
            <p className="text-2xl font-bold tabular-nums mt-1">{formatCurrency(result.safeToSpendCents)}</p>
            <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">
              Today, without dipping below your cushion
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))] flex items-center gap-1">
              After bills
              <InfoTooltip text="The income arriving in this window minus the bills scheduled against it - what's left over to live on and save. Compass doesn't guess at your day-to-day spending, so nothing else is subtracted here." />
            </p>
            <p
              className="text-2xl font-bold tabular-nums mt-1"
              style={{ color: result.afterBillsCents < 0 ? "hsl(var(--error))" : "hsl(var(--success))" }}
            >
              {formatCurrency(result.afterBillsCents)}
            </p>
            <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">
              {result.afterBillsCents < 0
                ? "Bills exceed the income arriving"
                : "Income left over to live on and save"}
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
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 mt-5 pt-4 border-t text-sm tabular-nums">
          <span>{formatCurrency(inputs.startingBalanceCents)}</span>
          <span className="text-[hsl(var(--muted-foreground))] text-xs">now</span>
          <span className="text-[hsl(var(--muted-foreground))]">+</span>
          <span style={{ color: "hsl(var(--success))" }}>{formatCurrency(result.totalIncomeCents)}</span>
          <span className="text-[hsl(var(--muted-foreground))] text-xs">coming in</span>
          <span className="text-[hsl(var(--muted-foreground))]">−</span>
          <span style={{ color: "hsl(var(--error))" }}>{formatCurrency(result.totalBillsCents)}</span>
          <span className="text-[hsl(var(--muted-foreground))] text-xs">bills</span>
          {result.assumedSpendCents > 0 && (
            <>
              <span className="text-[hsl(var(--muted-foreground))]">−</span>
              <span style={{ color: "var(--gold)" }}>{formatCurrency(result.assumedSpendCents)}</span>
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
      </section>

      {/* ── What-if ──────────────────────────────────────────────────────── */}
      <section className="border rounded-2xl p-5 space-y-5">
        <div>
          <h2 className="font-semibold text-sm flex items-center gap-1.5"><Wand2 size={14} /> What if…</h2>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1 max-w-lg">
            Change the window or try a scenario - the numbers above and the chart below both
            react. Nothing here is saved or touches your data.
          </p>
        </div>

        <div>
          <span className="text-xs font-medium">…I look at</span>
          <div className="flex gap-1 border rounded-lg p-1 mt-2 w-fit">
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
          <span className="block text-[11px] text-[hsl(var(--muted-foreground))] mt-1.5">
            Sets the window every number on this page is calculated over - currently{" "}
            {formatDate(toISODate(new Date()))} to {formatDate(forecast!.endDate)}.
          </span>
        </div>

        <div className="grid sm:grid-cols-2 gap-5">
          <label className="block">
            <span className="text-xs font-medium">
              …I spend an extra{" "}
              <span className="tabular-nums" style={{ color: "var(--gold)" }}>{formatCurrency(extraSpendCents)}</span>
            </span>
            <input
              type="range" min={0} max={200_000} step={5_000}
              value={extraSpendCents}
              onChange={(e) => setExtraSpendCents(Number(e.target.value))}
              className="w-full mt-2 accent-[hsl(var(--primary))]"
            />
            <span className="text-[11px] text-[hsl(var(--muted-foreground))]">
              Day-to-day spending isn't in the forecast at all, so use this to try some
              {extraSpendCents > 0
                ? <> - {formatCurrency(Math.round(extraSpendCents / windowDays))} a day across the {windowDays}-day window</>
                : <> across the whole {windowDays}-day window</>}.
            </span>
          </label>

          <label className="block">
            <span className="text-xs font-medium">
              …I set aside{" "}
              <span className="tabular-nums" style={{ color: "var(--gold)" }}>{formatCurrency(bufferCents)}</span>
            </span>
            <input
              type="range" min={0} max={200_000} step={5_000}
              value={bufferCents}
              onChange={(e) => setBufferCents(Number(e.target.value))}
              className="w-full mt-2 accent-[hsl(var(--primary))]"
            />
            <span className="text-[11px] text-[hsl(var(--muted-foreground))]">
              Money you're saving rather than spending. Comes off "safe to spend" and shows as a
              line on the chart; it doesn't change the projection itself.
            </span>
          </label>
        </div>

        <div className="flex items-center justify-between gap-3 border-t pt-4">
          <label className="flex items-center gap-2 text-xs font-medium cursor-pointer select-none">
            <input type="checkbox" checked={includeDetected} onChange={(e) => setIncludeDetected(e.target.checked)} />
            Include {inputs.detected.length} charge{inputs.detected.length === 1 ? "" : "s"} detected from my history
          </label>
          {(extraSpendCents > 0 || bufferCents > 0) && (
            <button
              onClick={() => { setExtraSpendCents(0); setBufferCents(0); }}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg text-black transition-opacity hover:opacity-90 shrink-0"
              style={{ backgroundColor: "var(--gold)" }}
            >
              Reset
            </button>
          )}
        </div>
      </section>

      {/* ── Projection chart ─────────────────────────────────────────────── */}
      <section className="border rounded-2xl p-5" id="plan-chart">
        <h2 className="font-semibold text-sm mb-1">Projected checking balance</h2>
        <p className="text-xs text-[hsl(var(--muted-foreground))] mb-4">
          The blue line drops at bills and jumps at income. The red band is the bills still ahead
          of you - it only steps when one is actually due.
        </p>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 5, right: 8, left: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="planFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="committedFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--error))" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="hsl(var(--error))" stopOpacity={0.04} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis
                dataKey="date" tickFormatter={(d: string) => formatDate(d)}
                tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" minTickGap={28}
              />
              <YAxis tickFormatter={formatAxisCurrency} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={60} />
              <Tooltip
                formatter={(v, name) => [formatCurrency(v as number), name === "committed" ? "Bills still due" : "Balance"]}
                labelFormatter={(l) => formatDate(String(l))}
                contentStyle={{ backgroundColor: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
              />
              <ReferenceLine y={0} stroke="hsl(var(--error))" strokeDasharray="4 4" />
              {bufferCents > 0 && (
                <ReferenceLine
                  y={bufferCents} stroke="var(--gold)" strokeDasharray="4 4"
                  label={{ value: "set aside", position: "insideTopRight", fontSize: 10, fill: "var(--gold)" }}
                />
              )}
              <Area
                type="stepAfter" dataKey="committed" stroke="hsl(var(--error))" strokeWidth={1}
                strokeDasharray="3 3" fill="url(#committedFill)"
              />
              <Area type="monotone" dataKey="balance" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#planFill)" fillOpacity={0.35} />
              {low && (
                <ReferenceDot
                  x={low.date} y={low.balanceCents} r={4}
                  fill={low.balanceCents < 0 ? "hsl(var(--error))" : "hsl(var(--warning))"} stroke="none"
                />
              )}
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[11px] text-[hsl(var(--muted-foreground))]">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 rounded" style={{ backgroundColor: "hsl(var(--primary))" }} />
            Projected balance
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 rounded" style={{ backgroundColor: "hsl(var(--error))" }} />
            Bills still due
            <InfoTooltip text="At any point on the chart, the total of scheduled bills still to be paid before the window ends. It steps down only when a bill is actually due. Where the blue line sits above this band, the gap is what's left to live on and save." />
          </span>
          {bufferCents > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-0.5 rounded" style={{ backgroundColor: "var(--gold)" }} />
              Set aside
            </span>
          )}
        </div>
        <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-2">
          Built only from the scheduled bills and income below - Compass never assumes spending
          you haven't told it about. Add anything missing under What's coming.
        </p>
      </section>

      {/* ── What to do next ──────────────────────────────────────────────── */}
      {nextActions.length > 0 && (
        <section className="border rounded-2xl p-5">
          <h2 className="font-semibold text-sm mb-1">What to do next</h2>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mb-4">
            The rest of Compass tells you what happened. This is what you could do about it.
          </p>
          <div className="space-y-2">
            {nextActions.map((a) => (
              <div key={a.key} className="border rounded-xl px-4 py-3 flex items-start gap-3">
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0 mt-2"
                  style={{ backgroundColor: ACTION_TONE[a.tone].color }}
                />
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: ACTION_TONE[a.tone].color }}>
                    {ACTION_TONE[a.tone].label}
                  </p>
                  <p className="text-sm font-medium mt-0.5">{a.title}</p>
                  <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1 leading-relaxed">{a.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Put the surplus to work ──────────────────────────────────────── */}
      {payoff && debtContext && (
        <section className="border rounded-2xl p-5" style={{ borderColor: "var(--gold)" }}>
          <h2 className="font-semibold text-sm flex items-center gap-1.5">
            <Landmark size={14} style={{ color: "var(--gold)" }} /> Put your spare money to work
          </h2>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1 max-w-xl">
            Your scheduled income and bills leave about{" "}
            <span className="font-semibold" style={{ color: "var(--gold)" }}>
              {formatCurrency(monthlySurplusCents)}
            </span>{" "}
            a month spare. You owe {formatCurrency(debtContext.plan.totalDebtCents)} across{" "}
            {debtContext.debts.length} account{debtContext.debts.length === 1 ? "" : "s"} - here's what
            happens if that spare money goes there instead.
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
                Adding your surplus
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
        </section>
      )}

      {/* ── Bill calendar ────────────────────────────────────────────────── */}
      <section className="border rounded-2xl p-5">
        <h2 className="font-semibold text-sm mb-1">What's coming</h2>
        <p className="text-xs text-[hsl(var(--muted-foreground))] mb-4">
          Everything the forecast above is counting on, in order.
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
                    <div key={e.key} className="flex items-center gap-3 border rounded-lg px-3 py-2 group">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: e.categoryColor ?? "hsl(var(--neutral))" }} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{e.description}</p>
                        <p className="text-xs text-[hsl(var(--muted-foreground))]">
                          {formatDate(e.date)}
                          {e.source === "detected" && (
                            <span className="ml-1.5 inline-flex items-center gap-1 text-[hsl(var(--warning))]">
                              <Sparkles size={9} /> detected, not confirmed
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
                      <span className="w-4 shrink-0 flex justify-end">
                        {e.source === "detected" && (
                          <button
                            onClick={() => handleHide(e.description)}
                            aria-label={`Hide ${e.description}`}
                            title="Not a real bill - hide it from the forecast and subscriptions"
                            className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--error))]
                                       opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                          >
                            <EyeOff size={14} />
                          </button>
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
      </section>

      <RecurringRulesPanel profileId={profileId} onChanged={() => setReloadTick((t) => t + 1)} />

      {payoffOpen && debtContext && (
        <DebtPayoffModal
          profileIds={[profileId]}
          debts={debtContext.debts}
          title="Put your surplus to work"
          subtitle={`Based on the ${formatCurrency(monthlySurplusCents)} a month your schedule leaves spare`}
          onClose={() => setPayoffOpen(false)}
        />
      )}
    </div>
  );
}
