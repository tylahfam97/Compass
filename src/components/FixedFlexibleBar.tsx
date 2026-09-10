import { motion } from "motion/react";
import { Link } from "react-router-dom";
import type { FixedFlexibleSummary } from "@/lib/insights/shape";
import { formatCurrency, formatCurrencyWhole, cn } from "@/lib/utils";
import { useAppReducedMotion } from "@/hooks/useAppReducedMotion";
import StatRow from "@/components/StatRow";
import CountUp from "@/components/CountUp";
import InfoTooltip from "@/components/InfoTooltip";

/**
 * The Insights page's instrument: an average month as one track. Scheduled bills at their
 * planned monthly amounts, recurring charges Compass detected, flexible spending, and what was
 * left, as lengths of income. Income is the user's own Plan schedule when one exists
 * (paychecks, dividends - money that can be planned around), falling back to averaged deposits
 * when nothing is scheduled. Investments and large one-offs are reported separately, not as
 * spending, and months funded by supplemental deposits are said to be - not painted as errors.
 */
interface FixedFlexibleBarProps {
  summary: FixedFlexibleSummary;
  /** "Average of June to August, 3 complete months" */
  monthsLabel: string;
  className?: string;
}

const EASE = [0.2, 0.7, 0.2, 1] as const;

export default function FixedFlexibleBar({ summary, monthsLabel, className }: FixedFlexibleBarProps) {
  const reduced = useAppReducedMotion();
  const planned = summary.incomeBasis === "planned";
  const income = summary.avgIncomeCents;
  const supplemental = Math.max(0, summary.avgActualIncomeCents - income);
  const bills = summary.avgBillsCents;
  const recurring = summary.avgRecurringCents;
  const flexible = summary.avgFlexibleCents;
  const invested = summary.avgInvestedCents;
  const oneOff = summary.avgOneOffCents;
  const committed = bills + recurring;
  const uncommitted = income - committed;
  const spentTotal = committed + flexible;
  const overPlanned = spentTotal > income;
  // Red only when even supplemental deposits didn't cover it; covered months get a plain note.
  const hardOver = spentTotal > Math.max(income, summary.avgActualIncomeCents);
  const overCovered = overPlanned && !hardOver;
  const left = Math.max(0, income - spentTotal);

  // Segments never overflow the track: when a month ran over, everything scales to fit.
  const scale = overPlanned && spentTotal > 0 ? income / spentTotal : 1;
  const pct = (cents: number) => (income > 0 ? (cents / income) * 100 * scale : 0);
  const segments = [
    { key: "bills", cents: bills, className: "bearing-seg-committed" },
    { key: "recurring", cents: recurring, className: "bearing-seg-due" },
    { key: "flexible", cents: flexible, className: "bearing-seg-spent" },
    { key: "left", cents: left, className: "bearing-seg-free" },
  ].filter((s) => s.cents > 0);

  const share = (cents: number) => (income > 0 ? `${Math.round((cents / income) * 100)}% of income` : undefined);
  const noSchedule = committed === 0;
  const incomeWord = planned ? "planned income" : "average income";
  const valueText = `${formatCurrency(bills)} scheduled bills, ${formatCurrency(recurring)} detected recurring charges, ${formatCurrency(flexible)} flexible spending`
    + (overPlanned
      ? `, ${formatCurrency(spentTotal - income)} beyond ${incomeWord} of ${formatCurrency(income)}${overCovered ? ", covered by supplemental deposits" : ""}`
      : `, ${formatCurrency(left)} left of ${formatCurrency(income)} ${incomeWord}`);

  return (
    <section className={cn("fixed-flex", className)} aria-labelledby="fixed-flex-title">
      <div className="fixed-flex-head flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h3 id="fixed-flex-title" className="text-[15px] font-semibold leading-tight flex items-center gap-1.5">
            Fixed and flexible
            <InfoTooltip text={"Scheduled bills counts your Plan rules at their monthly amounts (weekly \u00d752\u00f712, every-other-week \u00d726\u00f712) - it matches the Plan page. Recurring is what Compass detected but you have not confirmed. Flexible spending is everyday spending that matches neither; money into investment categories and single purchases of $1,000+ are listed separately, not counted as flexible. Beyond planned means spending passed your planned income - it only turns red when supplemental deposits did not cover it. A bill payment Compass could not match by description counts as flexible until the payment is categorized as Transfers or the rule is named like the bank descriptor."} />
          </h3>
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-1">{monthsLabel}{planned && ", against planned income"}</p>
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
          { label: "Scheduled bills", value: formatCurrencyWhole(bills), hint: planned ? "planned, as in Plan" : share(bills) },
          { label: "Recurring, detected", value: formatCurrencyWhole(recurring), hint: share(recurring) },
          { label: "Flexible spending", value: formatCurrencyWhole(flexible), hint: share(flexible) },
          hardOver
            ? { label: "Over", value: formatCurrencyWhole(spentTotal - income), hint: "beyond all income", tone: "error" as const }
            : overCovered
              ? { label: "Beyond planned", value: formatCurrencyWhole(spentTotal - income), hint: "covered by supplemental income", tone: "warning" as const }
              : { label: "Left over", value: formatCurrencyWhole(left), hint: income > 0 ? `${Math.round((left / income) * 100)}%${planned ? " of planned income" : ", savings rate"}` : undefined },
        ]}
      />

      <div
        className={cn("bearing-track mt-6", hardOver && "bearing-track-over")}
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
        </p>
        <Link to="/plan" className="text-[hsl(var(--gold-ink))] hover:underline shrink-0">Manage scheduled bills &amp; income</Link>
      </div>
    </section>
  );
}
