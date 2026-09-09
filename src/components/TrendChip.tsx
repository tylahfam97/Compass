import { TrendingUp, TrendingDown } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

/**
 * Standard comparison-context chip for a headline metric: delta + direction + what it's
 * compared against. `invert` flips the good/bad colouring for metrics where a rise is bad
 * (expenses, debt).
 */
export default function TrendChip({
  deltaCents, compareLabel, invert = false, pct = null,
}: {
  deltaCents: number;
  /** e.g. "vs July" or "this year". */
  compareLabel: string;
  invert?: boolean;
  pct?: number | null;
}) {
  // Under $1 of movement reads as noise, not a trend.
  if (Math.abs(deltaCents) < 100) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-[hsl(var(--muted-foreground))]">
        ≈ same {compareLabel}
      </span>
    );
  }

  const rising = deltaCents > 0;
  const good = invert ? !rising : rising;
  const dir = rising ? "up" : "down";

  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-semibold tabular-nums ${
        good ? "text-[hsl(var(--success))]" : "text-[hsl(var(--error))]"
      }`}
      aria-label={`${dir} ${formatCurrency(Math.abs(deltaCents))}${pct != null ? ` (${Math.abs(Math.round(pct))}%)` : ""} ${compareLabel}`}
    >
      {rising ? <TrendingUp size={13} aria-hidden /> : <TrendingDown size={13} aria-hidden />}
      {formatCurrency(Math.abs(deltaCents))}
      {pct != null && <span className="font-medium">({Math.abs(Math.round(pct))}%)</span>}
      <span className="font-normal text-[hsl(var(--muted-foreground))]">{compareLabel}</span>
    </span>
  );
}
