import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

/** Adds `delta` months to a YYYY-MM key without timezone drift. */
export function shiftMonth(ym: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m || !Number.isFinite(delta)) return ym;
  const d = new Date(Number(m[1]), Number(m[2]) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * The one month stepper. The e2e suite relies on an input[type="month"] and a button
 * named "Previous month" existing, so both are kept exactly.
 */
interface MonthPickerProps {
  value: string;
  onChange: (ym: string) => void;
  className?: string;
}

export default function MonthPicker({ value, onChange, className }: MonthPickerProps) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <button type="button" aria-label="Previous month" className="workspace-icon" onClick={() => onChange(shiftMonth(value, -1))}>
        <CaretLeftIcon size={16} aria-hidden="true" />
      </button>
      <input
        type="month"
        value={value}
        aria-label="Month"
        onChange={(e) => onChange(e.target.value)}
        className="border rounded-md px-3 py-1.5 text-sm bg-[hsl(var(--surface))] text-[hsl(var(--foreground))] tabular-nums"
      />
      <button type="button" aria-label="Next month" className="workspace-icon" onClick={() => onChange(shiftMonth(value, 1))}>
        <CaretRightIcon size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
