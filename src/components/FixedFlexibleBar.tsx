import { useState } from "react";
import { motion } from "motion/react";
import { Link } from "react-router-dom";
import type { FixedFlexibleSummary } from "@/lib/insights/shape";
import { formatCurrency, formatCurrencyWhole, cn } from "@/lib/utils";
import { useAppReducedMotion } from "@/hooks/useAppReducedMotion";
import StatRow from "@/components/StatRow";
import CountUp from "@/components/CountUp";
import InfoTooltip from "@/components/InfoTooltip";

/**
 * The Insights page's instrument: an average month as one track. The plan is the source of
 * truth - planned income, scheduled bills at their planned monthly amounts, detected recurring
 * charges, and what that leaves for flexible spending. A toggle overlays the flexible spending
 * Compass measured from history (which inherits every categorization quirk - card payments or
 * transfers not marked as Transfers read as spending), kept off by default.
 */
interface FixedFlexibleBarProps {
  summary: FixedFlexibleSummary;
  /** "Average of June to August, 3 complete months" */
  monthsLabel: string;
  className?: string;
}

const EASE = [0.2, 0.7, 0.2, 1] as const;
const SHOW_FLEXIBLE_KEY = "compass_ff_show_flexible";

export default function FixedFlexibleBar({ summary, monthsLabel, className }: FixedFlexibleBarProps) {
  const reduced = useAppReducedMotion();
  const [showFlexible, setShowFlexible] = useState(() => localStorage.getItem(SHOW_FLEXIBLE_KEY) === "1");
  const toggleFlexible = () => setShowFlexible((v) => {
    localStorage.setItem(SHOW_FLEXIBLE_KEY, v ? "0" : "1");
    return !v;
  });
  const planned = summary.incomeBasis === "planned";
  const income = summary.avgIncomeCents;
  const supplemental = Math.max(0, summary.avgActualIncomeCents - income);
  // The two views never mix sources: plan view shows planned bills; measured view shows the
  // payments actually matched to rules, so unmatched bills inside flexible aren't counted twice.
  const bills = showFlexible ? summary.avgMeasuredBillsCents : summary.avgBillsCents;
  const recurring = summary.avgRecurringCents;
  const flexible = summary.avgFlexibleCents;
  const invested = summary.avgInvestedCents;
  const oneOff = summary.avgOneOffCents;
  const committed = bills + recurring;
  const uncommitted = income - (summary.avgBillsCents + recurring);
  const spentTotal = committed + flexible;
  const overPlanned = showFlexible && spentTotal > income;
  // Red only when even supplemental deposits didn't cover it; covered months get a plain note.
  const hardOver = overPlanned && spentTotal > Math.max(income, summary.avgActualIncomeCents);
  const overCovered = overPlanned && !hardOver;
  const overCommitted = summary.avgBillsCents + recurring > income;
  const left = showFlexible ? Math.max(0, income - spentTotal) : Math.max(0, uncommitted);

  // Segments never overflow the track: whatever is shown scales to fit the income track.
  const shownTotal = showFlexible ? spentTotal : committed;
  const scale = shownTotal > income && shownTotal > 0 ? income / shownTotal : 1;
  const pct = (cents: number) => (income > 0 ? (cents / income) * 100 * scale : 0);
  const segments = [
    { key: "bills", cents: bills, className: "bearing-seg-committed" },
    { key: "recurring", cents: recurring, className: "bearing-seg-due" },
    ...(showFlexible ? [{ key: "flexible", cents: flexible, className: "bearing-seg-spent" }] : []),
    { key: "left", cents: left, className: "bearing-seg-free" },
  ].filter((s) => s.cents > 0);

  const share = (cents: number) => (income > 0 ? `${Math.round((cents / income) * 100)}% of income` : undefined);
  const noSchedule = committed === 0;
  const incomeWord = planned ? "planned income" : "average income";
  const valueText = `${formatCurrency(bills)} scheduled bills, ${formatCurrency(recurring)} detected recurring charges`
    + (showFlexible
      ? `, ${formatCurrency(flexible)} measured flexible spending`
        + (overPlanned
          ? `, ${formatCurrency(spentTotal - income)} beyond ${incomeWord} of ${formatCurrency(income)}${overCovered ? ", covered by supplemental deposits" : ""}`
          : `, ${formatCurrency(left)} left of ${formatCurrency(income)} ${incomeWord}`)
      : `, ${formatCurrency(left)} left for flexible of ${formatCurrency(income)} ${incomeWord}`);;

  return (
    <section className={cn("fixed-flex", className)} aria-labelledby="fixed-flex-title">
      <div className="fixed-flex-head flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h3 id="fixed-flex-title" className="text-[15px] font-semibold leading-tight flex items-center gap-1.5">
            Fixed and flexible
            <InfoTooltip text={"Your plan is the source of truth here: planned income and scheduled bills at their monthly amounts (weekly \u00d752\u00f712, every-other-week \u00d726\u00f712), matching the Plan page, plus recurring charges Compass detected. What remains is yours to spend flexibly. The toggle overlays the flexible spending measured from your history - that measurement inherits your categorization, so card payments or moves between accounts not categorized as Transfers show up as spending. Money into investment categories and single purchases of $1,000+ are listed separately, never as flexible."} />
          </h3>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{monthsLabel}{planned && ", against planned income"}</p>
          <button
            type="button"
            onClick={toggleFlexible}
            aria-pressed={showFlexible}
            className={cn(
              "mt-2 inline-flex items-center gap-1.5 text-xs rounded-full border px-2.5 py-1 transition-colors",
              showFlexible
                ? "border-[hsl(var(--primary)/0.6)] bg-[hsl(var(--primary)/0.08)] text-[hsl(var(--foreground))]"
                : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))]"
            )}
          >
            <span className={cn("w-2 h-2 rounded-full", showFlexible ? "bg-[hsl(var(--primary))]" : "bg-[hsl(var(--border))]")} aria-hidden="true" />
            Show measured flexible spending
          </button>
        </div>
        <div className="text-right">
          <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{overCommitted ? "Committed beyond income" : "Flexible money each month"}</p>
          <p className="hero-figure" style={{ color: overCommitted ? "hsl(var(--error))" : "hsl(var(--gold-ink))" }}>
            <CountUp value={Math.abs(uncommitted)} format={(v) => formatCurrencyWhole(Math.round(v))} />
          </p>
        </div>
      </div>

      <StatRow
        size="sm"
        columns={showFlexible ? 4 : 3}
        className="mt-4"
        ariaLabel="Average month"
        items={showFlexible ? [
          { label: "Scheduled bills", value: formatCurrencyWhole(bills), hint: "matched from history" },
          { label: "Recurring, detected", value: formatCurrencyWhole(recurring), hint: share(recurring) },
          { label: "Flexible, measured", value: formatCurrencyWhole(flexible), hint: share(flexible) },
          hardOver
            ? { label: "Over", value: formatCurrencyWhole(spentTotal - income), hint: "beyond all income", tone: "error" as const }
            : overCovered
              ? { label: "Beyond planned", value: formatCurrencyWhole(spentTotal - income), hint: "covered by supplemental income", tone: "warning" as const }
              : { label: "Left over", value: formatCurrencyWhole(left), hint: income > 0 ? `${Math.round((left / income) * 100)}%${planned ? " of planned income" : ", savings rate"}` : undefined },
        ] : [
          { label: "Scheduled bills", value: formatCurrencyWhole(bills), hint: planned ? "planned, as in Plan" : share(bills) },
          { label: "Recurring, detected", value: formatCurrencyWhole(recurring), hint: share(recurring) },
          overCommitted
            ? { label: "Committed beyond income", value: formatCurrencyWhole(committed - income), hint: share(committed - income), tone: "error" as const }
            : { label: "Left for flexible", value: formatCurrencyWhole(left), hint: share(left), tone: "gold" as const },
        ]}
      />

      <div
        className={cn("bearing-track mt-6", (hardOver || overCommitted) && "bearing-track-over")}
        role="meter"
        aria-label="Fixed and flexible"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={income > 0 ? Math.round(Math.min(100, (committed / income) * 100)) : 0}
        aria-valuetext={valueText}
      >
        {segments.map((s) => (
          <motion.div
            key={s.key}
            className={cn("bearing-seg", s.className)}
            style={{ width: `${pct(s.cents)}%` }}
            initial={reduced ? false : { scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 0.4, ease: EASE }}
          />
        ))}
        <span className="bearing-tick" style={{ left: "50%" }} aria-hidden="true"><small>Half</small></span>
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 mt-3 text-xs text-[hsl(var(--muted-foreground))]">
        <p className="max-w-[64ch]">
          {noSchedule
            ? "No scheduled bills yet. Add them in Plan to see your fixed costs."
            : "Scheduled bills are your Plan rules at their monthly amounts; recurring charges are ones Compass detected but you have not confirmed."}
          {planned && income > 0 && <> Planned income {formatCurrencyWhole(income)} a month{supplemental > 0 && <>; supplemental deposits added about {formatCurrencyWhole(supplemental)} a month on top, not counted here</>}.</>}
          {!planned && income > 0 && <> Average income {formatCurrencyWhole(income)}. <Link to="/plan" className="text-[hsl(var(--gold-ink))] hover:underline">Schedule your paycheck in Plan</Link> and this will measure against planned income only.</>}
          {showFlexible && (
            <>
              {overCovered && <> Spending ran {formatCurrencyWhole(spentTotal - income)} beyond planned income; supplemental deposits covered it.</>}
              {(invested > 0 || oneOff > 0) && (
                <> Set aside, not counted as spending: {[
                  invested > 0 ? `${formatCurrencyWhole(invested)} a month into investments` : null,
                  oneOff > 0 ? `${formatCurrencyWhole(oneOff)} a month in large one-offs` : null,
                ].filter(Boolean).join(", ")}.</>
              )}
              {summary.flexibleTopCategories.length > 0 && (
                <> Biggest flexible: {summary.flexibleTopCategories.map((c) => `${c.name} ${formatCurrencyWhole(c.cents)}`).join(", ")} a month.</>
              )}
              <> Bills shown here are the payments matched to your rules; a bill whose bank descriptor doesn't match its rule sits in flexible instead - as do card payments or moves between your own accounts not marked as Transfers.</>
            </>
          )}
        </p>
        <Link to="/plan" className="text-[hsl(var(--gold-ink))] hover:underline shrink-0">Manage scheduled bills &amp; income</Link>
      </div>
    </section>
  );
}
