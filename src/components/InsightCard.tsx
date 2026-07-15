import type { Insight } from "@/lib/types";
import { useProfileStore } from "@/stores/profileStore";
import { AlertTriangle, Info, TrendingUp, X } from "lucide-react";

const CARD_STYLES: Record<string, string> = {
  warning: "border-l-[6px] border-l-amber-400 bg-amber-50 dark:bg-amber-950/20",
  info:    "border-l-4 border-l-blue-400 bg-blue-50 dark:bg-blue-950/20",
  success: "border-l-4 border-l-emerald-400 bg-emerald-50 dark:bg-emerald-950/20",
};

const ICON_CLS: Record<string, string> = {
  warning: "text-amber-500",
  info:    "text-blue-500",
  success: "text-emerald-600",
};

const TITLE_CLS: Record<string, string> = {
  warning: "text-amber-900 dark:text-amber-100",
  info:    "text-[hsl(var(--foreground))]",
  success: "text-emerald-900 dark:text-emerald-100",
};

const ACTION_CLS: Record<string, string> = {
  warning: "border border-amber-400 text-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/30",
  info:    "border border-blue-400 text-blue-700 hover:bg-blue-100 dark:hover:bg-blue-900/30",
  success: "border border-emerald-500 text-emerald-700 hover:bg-emerald-100 dark:hover:bg-emerald-900/30",
};

interface InsightCardProps {
  insight: Insight;
  onApply?: (insight: Insight) => void;
  compact?: boolean;
}

export default function InsightCard({ insight, onApply, compact = false }: InsightCardProps) {
  const dismissInsight = useProfileStore((s) => s.dismissInsight);
  const Icon = insight.severity === "warning" ? AlertTriangle
             : insight.severity === "success"  ? TrendingUp
             : Info;

  return (
    <div className={`rounded-lg px-4 py-3 flex items-start gap-3 ${CARD_STYLES[insight.severity]}`}>
      <Icon size={15} className={`shrink-0 mt-0.5 ${ICON_CLS[insight.severity]}`} />
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-semibold leading-snug ${TITLE_CLS[insight.severity]}`}>
          {insight.title}
        </p>
        {!compact && (
          <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5 leading-relaxed">
            {insight.description}
          </p>
        )}
        {insight.actionLabel && onApply && (
          <button
            onClick={() => onApply(insight)}
            className={`mt-2 text-xs font-semibold px-3 py-1 rounded-full transition-colors ${ACTION_CLS[insight.severity]}`}
          >
            {insight.actionLabel} →
          </button>
        )}
      </div>
      <button
        onClick={() => dismissInsight(insight.dismissKey)}
        aria-label="Dismiss"
        className={`${ICON_CLS[insight.severity]} opacity-50 hover:opacity-100 transition-opacity shrink-0 mt-0.5`}
      >
        <X size={14} />
      </button>
    </div>
  );
}
