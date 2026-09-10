import { motion } from "motion/react";
import { Link } from "react-router-dom";
import type { FixedFlexibleSummary } from "@/lib/insights/shape";
import { formatCurrency, formatCurrencyWhole, cn } from "@/lib/utils";
import { useAppReducedMotion } from "@/hooks/useAppReducedMotion";
import StatRow from "@/components/StatRow";
import CountUp from "@/components/CountUp";

/**
 * The Insights page's instrument: an average month as one track. Scheduled bills the user
 * confirmed in Plan, recurring charges Compass detected, flexible spending, and what was left,
 * as lengths of average income. The serif figure is the money not spoken for before the month
 * starts, because that is the part the user can direct.
 */
interface FixedFlexibleBarProps {
  summary: FixedFlexibleSummary;
  /** "Average of June to August, 3 complete months" */
  monthsLabel: string;
  topCategory?: { name: string; cents: number } | null;
  className?: string;
}

const EASE = [0.2, 0.7, 0.2, 1] as const;

export default function FixedFlexibleBar({ summary, monthsLabel, topCategory, className }: FixedFlexibleBarProps) {
  const reduced = useAppReducedMotion();
  const income = summary.avgIncomeCents;
  const bills = summary.avgBillsCents;
  const recurring = summary.avgRecurringCents;
  const flexible = summary.avgFlexibleCents;
  const committed = bills + recurring;
  const uncommitted = income - committed;
  const spentTotal = committed + flexible;
  const over = spentTotal > income;
  const left = Math.max(0, income - spentTotal);

  // Segments never overflow the track: when a month ran over, everything scales to fit and the
  // track itself turns to the error colour.
  const scale = over && spentTotal > 0 ? income / spentTotal : 1;
  const pct = (cents: number) => (income > 0 ? (cents / income) * 100 * scale : 0);
  const segments = [
    { key: "bills", cents: bills, className: "bearing-seg-committed" },
    { key: "recurring", cents: recurring, className: "bearing-seg-due" },
    { key: "flexible", cents: flexible, className: "bearing-seg-spent" },
    { key: "left", cents: left, className: "bearing-seg-free" },
  ].filter((s) => s.cents > 0);

  const share = (cents: number) => (income > 0 ? `${Math.round((cents / income) * 100)}% of income` : undefined);
  const noSchedule = committed === 0;
  const valueText = `${formatCurrency(bills)} scheduled bills, ${formatCurrency(recurring)} detected recurring charges, ${formatCurrency(flexible)} flexible spending`
    + (over ? `, over average income of ${formatCurrency(income)} by ${formatCurrency(spentTotal - income)}` : `, ${formatCurrency(left)} left of ${formatCurrency(income)} average income`);

  return (
    <section className={cn("fixed-flex", className)} aria-labelledby="fixed-flex-title">
      <div className="fixed-flex-head flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h3 id="fixed-flex-title" className="text-[15px] font-semibold leading-tight">Fixed and flexible</h3>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{monthsLabel}</p>
        </div>
        <div className="text-right">
          <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{committed > income ? "Committed beyond income" : "Flexible money each month"}</p>
          <p className="hero-figure" style={{ color: committed > income ? "hsl(var(--error))" : "hsl(var(--gold-ink))" }}>
            <CountUp value={Math.abs(uncommitted)} format={(v) => formatCurrencyWhole(Math.round(v))} />
          </p>
        </div>
      </div>

      <StatRow
        size="sm"
        columns={4}
        className="mt-4"
        ariaLabel="Average month"
        items={[
          { label: "Scheduled bills", value: formatCurrencyWhole(bills), hint: share(bills) },
          { label: "Recurring, detected", value: formatCurrencyWhole(recurring), hint: share(recurring) },
          { label: "Flexible spending", value: formatCurrencyWhole(flexible), hint: share(flexible) },
          over
            ? { label: "Over", value: formatCurrencyWhole(spentTotal - income), hint: share(spentTotal - income), tone: "error" as const }
            : { label: "Left over", value: formatCurrencyWhole(left), hint: income > 0 ? `${Math.round((left / income) * 100)}%, savings rate` : undefined },
        ]}
      />

      <div
        className={cn("bearing-track mt-6", over && "bearing-track-over")}
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
            : "Scheduled bills are the expenses that match your rules in Plan; recurring charges are the ones Compass detected but you have not confirmed."}
          {income > 0 && <> Average income {formatCurrencyWhole(income)}.</>}
          {topCategory && topCategory.cents > 0 && <> Top category {topCategory.name}, {formatCurrencyWhole(topCategory.cents)} a month.</>}
        </p>
        <Link to="/plan" className="text-[hsl(var(--gold-ink))] hover:underline shrink-0">Manage scheduled bills &amp; income</Link>
      </div>
    </section>
  );
}
