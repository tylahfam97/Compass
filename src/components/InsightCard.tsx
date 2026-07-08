import type { Insight } from "@/lib/types";
import { useProfileStore } from "@/stores/profileStore";

const ICONS: Record<string, string> = {
  warning: "⚠",
  info: "◆",
  success: "✓",
};

const SEVERITY_STYLES: Record<string, string> = {
  warning: "border-l-amber-400 bg-amber-50 dark:bg-amber-950/20",
  info: "border-l-blue-400 bg-blue-50 dark:bg-blue-950/20",
  success: "border-l-emerald-400 bg-emerald-50 dark:bg-emerald-950/20",
};

const ICON_STYLES: Record<string, string> = {
  warning: "text-amber-500",
  info: "text-blue-500",
  success: "text-emerald-500",
};

interface InsightCardProps {
  insight: Insight;
  onApply?: (insight: Insight) => void;
  compact?: boolean;
}

export default function InsightCard({ insight, onApply, compact = false }: InsightCardProps) {
  const dismissInsight = useProfileStore((s) => s.dismissInsight);

  return (
    <div
      className={`border-l-4 rounded-lg px-4 py-3 flex items-start gap-3
        ${SEVERITY_STYLES[insight.severity]}`}
    >
      <span className={`text-base shrink-0 mt-0.5 ${ICON_STYLES[insight.severity]}`}>
        {ICONS[insight.severity]}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-snug">{insight.title}</p>
        {!compact && (
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5 leading-relaxed">
            {insight.description}
          </p>
        )}
        {insight.actionLabel && onApply && (
          <button
            onClick={() => onApply(insight)}
            className="mt-1.5 text-xs font-medium text-[hsl(var(--primary))] hover:opacity-80
                       transition-opacity"
          >
            {insight.actionLabel} →
          </button>
        )}
      </div>
      <button
        onClick={() => dismissInsight(insight.dismissKey)}
        aria-label="Dismiss"
        className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]
                   transition-colors text-lg leading-none shrink-0 -mt-0.5"
      >
        ×
      </button>
    </div>
  );
}
