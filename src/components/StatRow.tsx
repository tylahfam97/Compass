import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one stat-row pattern: a rule-separated, left-aligned row of figures that replaces
 * the bordered, centered stat tiles. Structure carries the hierarchy (label above,
 * figure, optional hint below); `hero` promotes one figure to the page's serif hero.
 */
export type StatTone = "default" | "success" | "error" | "warning" | "muted" | "gold";

export interface StatItem {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: StatTone;
  hero?: boolean;
}

interface StatRowProps {
  items: StatItem[];
  size?: "md" | "sm";
  /** Column count; "auto" packs as many 150px columns as fit. Defaults to the item count. */
  columns?: number | "auto";
  /** Hero figure size: 34px by default, 44px for the Dashboard. */
  heroSize?: "lg" | "xl";
  ariaLabel?: string;
  className?: string;
}

const TONE: Record<StatTone, string | undefined> = {
  default: undefined,
  success: "hsl(var(--success))",
  error: "hsl(var(--error))",
  warning: "hsl(var(--warning))",
  muted: "hsl(var(--muted-foreground))",
  gold: "hsl(var(--gold-ink))",
};

export default function StatRow({ items, size = "md", columns, heroSize = "lg", ariaLabel, className }: StatRowProps) {
  const cols = columns ?? Math.min(items.length, 4);
  const template = cols === "auto" ? "repeat(auto-fit, minmax(150px, 1fr))" : `repeat(${cols}, minmax(0, 1fr))`;
  return (
    <div
      className={cn("stat-row", className)}
      data-size={size}
      role="group"
      aria-label={ariaLabel}
      style={{ gridTemplateColumns: template }}
    >
      {items.map((item, i) => (
        <div key={i} className="stat-row-item min-w-0" data-hero={item.hero ? "true" : undefined}>
          <p className="text-xs font-medium text-[hsl(var(--muted-foreground))]">{item.label}</p>
          <strong
            className={cn(
              "block tabular-nums",
              item.hero ? "hero-figure" : size === "sm" ? "text-lg font-medium" : "text-[26px] leading-tight font-medium",
            )}
            data-size={item.hero && heroSize === "xl" ? "xl" : undefined}
            style={{ color: TONE[item.tone ?? "default"] }}
          >
            {item.value}
          </strong>
          {item.hint != null && item.hint !== false && (
            <small className="block text-[11px] text-[hsl(var(--muted-foreground))] mt-1">{item.hint}</small>
          )}
        </div>
      ))}
    </div>
  );
}
