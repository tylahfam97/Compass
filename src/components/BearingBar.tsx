import { motion } from "motion/react";
import { computeBearing } from "@/lib/bearing";
import { formatCurrency, cn } from "@/lib/utils";
import { useAppReducedMotion } from "@/hooks/useAppReducedMotion";

/**
 * The Dashboard's instrument: one track where spending, bills still due, and free money
 * are lengths of the month's income, with a tick at today's position. Position and length
 * rather than color or angle, so it reads at a glance and works without hue.
 */
interface BearingBarProps {
  incomeCents: number;
  spentCents: number;
  dueCents?: number;
  dueCount?: number;
  month: string;
  today?: Date;
  className?: string;
}

const EASE = [0.2, 0.7, 0.2, 1] as const;

export default function BearingBar({ incomeCents, spentCents, dueCents = 0, dueCount, month, today, className }: BearingBarProps) {
  const reduced = useAppReducedMotion();
  const b = computeBearing({ incomeCents, spentCents, dueCents, month, today });
  const over = b.overCents > 0 && b.incomeKnown;

  const segments = b.incomeKnown
    ? [
        { key: "spent", pct: b.spentPct, className: "bearing-seg-spent" },
        { key: "due", pct: b.duePct, className: "bearing-seg-due" },
        { key: "free", pct: b.freePct, className: "bearing-seg-free" },
      ].filter((s) => s.pct > 0)
    : [];

  const daysLabel = b.monthState === "current"
    ? `${b.daysLeft} ${b.daysLeft === 1 ? "day" : "days"} left`
    : b.monthState === "past" ? "Month complete" : "Not started";

  const spentLabel = !b.incomeKnown
    ? "No income recorded this month"
    : over ? `Over by ${formatCurrency(b.overCents)}` : `Spent ${Math.round(b.spentPct)}% of income`;

  const dueLabel = dueCents > 0
    ? `Still due ${formatCurrency(dueCents)}${dueCount ? ` (${dueCount} ${dueCount === 1 ? "bill" : "bills"})` : ""}`
    : null;

  const valueText = [spentLabel, dueLabel ? `${Math.round(b.duePct)}% still due` : null, daysLabel].filter(Boolean).join(", ");

  return (
    <div
      className={cn("bearing", className)}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.min(100, b.spentPct + b.duePct))}
      aria-valuetext={valueText}
    >
      <div className={cn("bearing-track mt-5", over && "bearing-track-over")}>
        {segments.map((s) => (
          <motion.div
            key={s.key}
            className={cn("bearing-seg", s.className)}
            style={{ width: `${s.pct}%` }}
            initial={reduced ? false : { scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 0.4, ease: EASE }}
          />
        ))}
        {b.monthState === "current" && (
          <span className="bearing-tick" style={{ left: `${b.elapsedPct}%` }} aria-hidden="true">
            <small>Today</small>
          </span>
        )}
      </div>
      <div className="flex flex-wrap justify-between gap-x-6 gap-y-1 mt-2 text-xs text-[hsl(var(--muted-foreground))]">
        <span style={over ? { color: "hsl(var(--error))" } : undefined}>{spentLabel}</span>
        {dueLabel && <span>{dueLabel}</span>}
        <span>{daysLabel}</span>
      </div>
    </div>
  );
}
