import { useState, useEffect, useMemo, useCallback } from "react";
import { Link } from "react-router-dom";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceDot,
} from "recharts";
import { CalendarClock, TrendingDown, TrendingUp, Sparkles, AlertTriangle, Wand2 } from "lucide-react";
import { formatCurrency, formatAxisCurrency, formatDate } from "@/lib/utils";
import {
  projectCashFlow, expandOccurrences, deriveDailyBaselineCents, monthlyEquivalentCents,
  toISODate, daysFromToday, type ForecastEvent,
} from "@/lib/forecast";
import { getForecastInputs, MIN_MONTHS_FOR_FORECAST, type ForecastInputs } from "@/lib/forecastData";
import { useProfileStore } from "@/stores/profileStore";
import { reportLoadError } from "@/stores/toastStore";
import RecurringRulesPanel from "@/components/RecurringRulesPanel";
import { CardListSkeleton } from "@/components/Skeleton";

const HORIZONS = [30, 60, 90] as const;
type Horizon = (typeof HORIZONS)[number];

const HORIZON_KEY = "compass_plan_horizon";

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

/** Groups upcoming events into calendar weeks for the bill calendar. */
function groupByWeek(events: ForecastEvent[]): { label: string; events: ForecastEvent[] }[] {
  const groups: { label: string; events: ForecastEvent[] }[] = [];
  for (const e of events) {
    const days = daysFromToday(e.date);
    const label =
      days <= 0 ? "Today"
      : days <= 7 ? "This week"
      : days <= 14 ? "Next week"
      : days <= 30 ? "Later this month"
      : "Beyond a month";
    const existing = groups.find((g) => g.label === label);
    if (existing) existing.events.push(e);
    else groups.push({ label, events: [e] });
  }
  return groups;
}

export default function PlanPage() {
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const profileId = activeProfile?.id ?? 1;

  const [inputs, setInputs] = useState<ForecastInputs | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);

  const [horizon, setHorizon] = useState<Horizon>(() => {
    const saved = Number(localStorage.getItem(HORIZON_KEY));
    return (HORIZONS as readonly number[]).includes(saved) ? (saved as Horizon) : 30;
  });
  // What-if controls. Both feed straight back into the pure projection, which is why it has to
  // stay synchronous - these recompute on every drag with no DB round trip.
  const [extraSpendCents, setExtraSpendCents] = useState(0);
  const [bufferCents, setBufferCents] = useState(0);
  const [includeDetected, setIncludeDetected] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await getForecastInputs(profileId);
    setInputs(data);
    setLoading(false);
  }, [profileId]);

  useEffect(() => {
    load().catch((err) => {
      setLoading(false);
      reportLoadError("your forecast", () => setReloadTick((t) => t + 1))(err);
    });
  }, [load, reloadTick]);

  const setHorizonPersisted = (h: Horizon) => {
    setHorizon(h);
    localStorage.setItem(HORIZON_KEY, String(h));
  };

  const forecast = useMemo(() => {
    if (!inputs) return null;
    const today = new Date();
    const start = toISODate(today);
    const end = new Date(today);
    end.setDate(end.getDate() + horizon);

    const activeRules = includeDetected ? [...inputs.rules, ...inputs.detected] : inputs.rules;
    const events = expandOccurrences(activeRules, today, end);

    // Only outgoing rules belong in the baseline adjustment - income doesn't inflate the
    // average expense figure the baseline is derived from.
    const knownMonthlyBills = activeRules
      .filter((r) => r.amount_cents < 0)
      .reduce((sum, r) => sum + Math.abs(monthlyEquivalentCents(r)), 0);

    const dailyBaselineCents =
      deriveDailyBaselineCents(inputs.avgMonthlyExpenseCents, knownMonthlyBills) +
      Math.round(extraSpendCents / 30);

    return {
      result: projectCashFlow({
        startingBalanceCents: inputs.startingBalanceCents,
        startDate: start,
        days: horizon,
        events,
        dailyBaselineCents,
        bufferCents,
      }),
      dailyBaselineCents,
      events,
    };
  }, [inputs, horizon, extraSpendCents, bufferCents, includeDetected]);

  const chartData = useMemo(
    () => forecast?.result.days.map((d) => ({ date: d.date, balance: d.balanceCents / 100 })) ?? [],
    [forecast]
  );

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
      <div className="flex gap-1 border rounded-lg p-1 shrink-0">
        {HORIZONS.map((h) => (
          <button
            key={h}
            onClick={() => setHorizonPersisted(h)}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              horizon === h
                ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                : "hover:bg-[hsl(var(--muted))]"
            }`}
          >
            {h} days
          </button>
        ))}
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

  if (inputs.monthsOfData < MIN_MONTHS_FOR_FORECAST) {
    return (
      <div className="p-8 max-w-5xl mx-auto space-y-6">
        {header}
        <EmptyState icon={<CalendarClock size={24} className="text-[hsl(var(--muted-foreground))]" />} title="Not enough history yet">
          <p>
            Compass needs at least {MIN_MONTHS_FOR_FORECAST} months of transactions before it can
            project your spending honestly - with less than that it would be guessing at a number
            you might actually rely on. You have {inputs.monthsOfData}{" "}
            {inputs.monthsOfData === 1 ? "month" : "months"} so far.
          </p>
          <p>You can still schedule bills and income below - they'll be waiting when the forecast unlocks.</p>
        </EmptyState>
        <RecurringRulesPanel profileId={profileId} onChanged={() => setReloadTick((t) => t + 1)} />
      </div>
    );
  }

  const result = forecast!.result;
  const low = result.lowPoint;
  const short = result.firstShortfall;

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
            <h2 className="text-xl font-semibold">
              {short
                ? `You're projected to run short on ${formatDate(short.date)}`
                : `You stay above zero for the next ${horizon} days`}
            </h2>
            <p className="text-sm text-[hsl(var(--muted-foreground))] mt-1">
              {short ? (
                <>
                  That's {daysFromToday(short.date)} days out, at about {formatCurrency(short.balanceCents)}.
                  Scheduling more of your income below, or trimming everyday spending, moves this.
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

        <div className="grid sm:grid-cols-3 gap-4 mt-6">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))]">Safe to spend</p>
            <p className="text-2xl font-bold tabular-nums mt-1">{formatCurrency(result.safeToSpendCents)}</p>
            <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">
              Without pushing your low point below your buffer
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
            <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-0.5">Scheduled over {horizon} days</p>
          </div>
        </div>
      </section>

      {/* ── Projection chart ─────────────────────────────────────────────── */}
      <section className="border rounded-2xl p-5">
        <h2 className="font-semibold text-sm mb-4">Projected checking balance</h2>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 5, right: 8, left: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="planFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis
                dataKey="date" tickFormatter={(d: string) => formatDate(d)}
                tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" minTickGap={28}
              />
              <YAxis tickFormatter={formatAxisCurrency} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={60} />
              <Tooltip
                formatter={(v) => formatCurrency(Math.round((v as number) * 100))}
                labelFormatter={(l) => formatDate(String(l))}
                contentStyle={{ backgroundColor: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
              />
              <ReferenceLine y={0} stroke="hsl(var(--error))" strokeDasharray="4 4" />
              <Area type="monotone" dataKey="balance" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#planFill)" />
              {low && (
                <ReferenceDot
                  x={low.date} y={low.balanceCents / 100} r={4}
                  fill={low.balanceCents < 0 ? "hsl(var(--error))" : "hsl(var(--warning))"} stroke="none"
                />
              )}
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-3">
          Everyday spending is estimated at {formatCurrency(forecast!.dailyBaselineCents)}/day from your
          last 3 months, on top of the scheduled items below. This is an estimate, not a promise.
        </p>
      </section>

      {/* ── What-if ──────────────────────────────────────────────────────── */}
      <section className="border rounded-2xl p-5 space-y-4">
        <h2 className="font-semibold text-sm flex items-center gap-1.5"><Wand2 size={14} /> What if…</h2>

        <label className="block">
          <span className="text-xs font-medium">
            I spend an extra {formatCurrency(extraSpendCents)} this month
          </span>
          <input
            type="range" min={0} max={200_000} step={5_000}
            value={extraSpendCents}
            onChange={(e) => setExtraSpendCents(Number(e.target.value))}
            className="w-full mt-2 accent-[hsl(var(--primary))]"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium">
            I keep a {formatCurrency(bufferCents)} cushion untouched
          </span>
          <input
            type="range" min={0} max={200_000} step={5_000}
            value={bufferCents}
            onChange={(e) => setBufferCents(Number(e.target.value))}
            className="w-full mt-2 accent-[hsl(var(--primary))]"
          />
        </label>

        <div className="flex items-center justify-between gap-3 pt-1">
          <label className="flex items-center gap-2 text-xs font-medium cursor-pointer select-none">
            <input type="checkbox" checked={includeDetected} onChange={(e) => setIncludeDetected(e.target.checked)} />
            Include {inputs.detected.length} charge{inputs.detected.length === 1 ? "" : "s"} detected from my history
          </label>
          {(extraSpendCents > 0 || bufferCents > 0) && (
            <button
              onClick={() => { setExtraSpendCents(0); setBufferCents(0); }}
              className="text-xs px-2.5 py-1 border rounded-lg hover:bg-[hsl(var(--muted))]"
            >
              Reset
            </button>
          )}
        </div>
      </section>

      {/* ── Bill calendar ────────────────────────────────────────────────── */}
      <section className="border rounded-2xl p-5">
        <h2 className="font-semibold text-sm mb-1">What's coming</h2>
        <p className="text-xs text-[hsl(var(--muted-foreground))] mb-4">
          Everything the forecast above is counting on, in order.
        </p>

        {forecast!.events.length === 0 ? (
          <p className="text-sm text-[hsl(var(--muted-foreground))] italic">
            Nothing scheduled in the next {horizon} days. Add your bills and paycheck below.
          </p>
        ) : (
          <div className="space-y-5">
            {groupByWeek(forecast!.events).map((group) => (
              <div key={group.label}>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-[hsl(var(--muted-foreground))] mb-2">
                  {group.label}
                </p>
                <div className="space-y-1.5">
                  {group.events.map((e) => (
                    <div key={e.key} className="flex items-center gap-3 border rounded-lg px-3 py-2">
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
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {!inputs.hasIncomeRule && (
        <div className="border rounded-2xl p-4 flex items-start gap-3" style={{ borderColor: "hsl(var(--warning))" }}>
          <TrendingDown size={16} style={{ color: "hsl(var(--warning))" }} className="mt-0.5 shrink-0" />
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            <span className="font-medium text-[hsl(var(--foreground))]">No income is scheduled yet.</span>{" "}
            Until you add your paycheck below, this forecast only ever goes down - which makes it
            look far worse than reality.
          </p>
        </div>
      )}

      <RecurringRulesPanel profileId={profileId} onChanged={() => setReloadTick((t) => t + 1)} />
    </div>
  );
}
