import { MousePointerClick } from "lucide-react";

/**
 * Small "click for details" pill that fades in after ~1s of continuous hover over the
 * nearest `.chart-clickable` ancestor (see `.click-hint` rules in index.css - the 1s delay
 * and instant-revert-on-leave behavior are both pure CSS, no state/JS timers needed here).
 * Purely presentational - drop it anywhere inside a `.chart-clickable` card; it positions
 * itself absolutely so it never affects that card's own layout.
 */
export default function ClickHint({ label = "Click for more details" }: { label?: string }) {
  return (
    <span
      role="tooltip"
      aria-hidden="true"
      className="click-hint absolute z-20 bottom-2.5 left-1/2 -translate-x-1/2 flex items-center gap-1
                 px-2.5 py-1 rounded-full text-[10px] font-medium shadow-lg pointer-events-none whitespace-nowrap"
      style={{ backgroundColor: "hsl(var(--foreground))", color: "hsl(var(--background))" }}
    >
      <MousePointerClick size={11} className="shrink-0" />
      {label}
    </span>
  );
}
