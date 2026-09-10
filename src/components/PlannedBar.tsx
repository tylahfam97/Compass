import type { ReactNode } from "react";
import { motion } from "motion/react";
import { formatCurrency, cn } from "@/lib/utils";
import { useAppReducedMotion } from "@/hooks/useAppReducedMotion";

/**
 * Planned payments against planned income for the Plan window: the committed share of
 * scheduled income fills from the left, and what remains for unplanned spending is gold,
 * because it is the money the user can still direct.
 */
interface PlannedBarProps {
  plannedIncomeCents: number;
  plannedPaymentsCents: number;
  depositCount?: number;
  billCount?: number;
  windowDays?: number;
  tooltip?: ReactNode;
  className?: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default function PlannedBar({ plannedIncomeCents, plannedPaymentsCents, depositCount, billCount, windowDays, tooltip, className }: PlannedBarProps) {
  const reduced = useAppReducedMotion();
  const income = Math.max(0, plannedIncomeCents);
  const payments = Math.max(0, plannedPaymentsCents);
  const left = income - payments;
  const over = payments > income;
  const committedPct = income > 0 ? Math.min(100, (payments / income) * 100) : 0;
  const freePct = income > 0 ? Math.max(0, 100 - committedPct) : 0;

  const counts = depositCount != null && billCount != null
    ? `${plural(billCount, "bill", "bills")} and ${plural(depositCount, "deposit", "deposits")}${windowDays ? ` over ${plural(windowDays, "day", "days")}` : ""}`
    : null;

  return (
    <div
      className={cn("planned-bar", className)}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={income}
      aria-valuenow={Math.min(payments, income)}
      aria-valuetext={`${formatCurrency(payments)} of ${formatCurrency(income)} planned income is committed, ${formatCurrency(left)} left for unplanned`}
    >
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-[hsl(var(--muted-foreground))] flex items-center gap-1">Planned in this window{tooltip}</p>
          <p className="text-sm tabular-nums mt-0.5">{formatCurrency(income)} planned income</p>
        </div>
        <div className="text-right">
          <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">Left for unplanned</p>
          <p className="text-[22px] leading-tight font-medium tabular-nums" style={{ color: left < 0 ? "hsl(var(--error))" : "hsl(var(--gold-ink))" }}>
            {formatCurrency(left)}
          </p>
        </div>
      </div>
      <div className={cn("bearing-track mt-3", over && "bearing-track-over")}>
        {income > 0 && !over && (
          <>
            <motion.div className="bearing-seg bearing-seg-committed" style={{ width: `${committedPct}%` }} initial={reduced ? false : { scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.4, ease: [0.2, 0.7, 0.2, 1] }} />
            <motion.div className="bearing-seg bearing-seg-free" style={{ width: `${freePct}%` }} initial={reduced ? false : { scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.4, ease: [0.2, 0.7, 0.2, 1] }} />
          </>
        )}
      </div>
      <div className="flex flex-wrap justify-between gap-x-6 gap-y-1 mt-2 text-xs text-[hsl(var(--muted-foreground))]">
        <span className="tabular-nums">{formatCurrency(payments)} planned payments{over ? `, over by ${formatCurrency(payments - income)}` : ""}</span>
        {counts && <span>{counts}</span>}
      </div>
    </div>
  );
}
