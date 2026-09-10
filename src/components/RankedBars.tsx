import { cn } from "@/lib/utils";

/**
 * Ranked horizontal bars: shares compare by length, not by arc angle (the app replaced its
 * donuts with this deliberately). Extracted from the Reports page so Dashboard categories
 * and Investments allocation draw the same way.
 */
export interface RankedBarItem {
  key: string | number;
  name: string;
  value: number;
  /** Already harmonized by the caller. */
  color: string;
}

interface RankedBarsProps {
  items: RankedBarItem[];
  total?: number;
  formatValue: (value: number) => string;
  /** Completes the accessible label: "{name}: {value}, {pct}% {context}". */
  context: string;
  onSelect?: (item: RankedBarItem) => void;
  selectedKey?: string | number | null;
  showPct?: boolean;
  className?: string;
}

export default function RankedBars({ items, total, formatValue, context, onSelect, selectedKey, showPct = true, className }: RankedBarsProps) {
  const sum = total ?? items.reduce((acc, i) => acc + Math.abs(i.value), 0);
  const anySelected = selectedKey != null;
  return (
    <div className={cn("ranked-bars", className)}>
      {items.map((item) => {
        const pct = sum > 0 ? Math.round((Math.abs(item.value) / sum) * 100) : 0;
        const selected = selectedKey === item.key;
        const inner = (
          <>
            <div className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="truncate">{item.name}</span>
              <span className="tabular-nums shrink-0">
                {formatValue(item.value)}
                {showPct && <span className="text-[hsl(var(--muted-foreground))]"> {pct}%</span>}
              </span>
            </div>
            <div className="ranked-bar-track mt-1.5" role="img" aria-label={`${item.name}: ${formatValue(item.value)}, ${pct}% ${context}`}>
              <div className="ranked-bar-fill" style={{ width: `${pct}%`, backgroundColor: item.color }} />
            </div>
          </>
        );
        const cls = cn("report-category-row block w-full text-left py-2.5 transition-opacity", anySelected && !selected && "opacity-55");
        return onSelect ? (
          <button key={item.key} type="button" aria-pressed={selected} onClick={() => onSelect(item)} className={cn(cls, "hover:opacity-100")}>
            {inner}
          </button>
        ) : (
          <div key={item.key} className={cls}>{inner}</div>
        );
      })}
    </div>
  );
}
