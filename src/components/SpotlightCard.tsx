import type { Insight } from "@/lib/types";
import { useProfileStore } from "@/stores/profileStore";
import {
  CheckCircle, Target, Info, X,
  TrendingUp, TrendingDown, Percent, Zap,
  RefreshCw, ShoppingBag, Calendar, Shield, DollarSign, AlertTriangle,
} from "lucide-react";
import { formatCurrency } from "@/lib/utils";

// Type-specific icons (shared logic with InsightCard)
const TYPE_ICONS: Record<string, React.ElementType> = {
  budget_gap: Target, overspend_streak: Target, positive_streak: Target,
  savings_rate_low: Percent, expense_ratio_drift: Percent, weekend_spending: Percent,
  unusual_spike: TrendingUp, category_creep: TrendingUp, year_end_projection: TrendingUp,
  most_improved: TrendingDown,
  spending_velocity: Zap,
  ghost_subscription: RefreshCw, subscription_total: RefreshCw, redundant_spending: RefreshCw,
  top_merchants: ShoppingBag, food_delivery_spend: ShoppingBag,
  bill_due_soon: DollarSign,
  income_expected: Calendar, income_irregular: Calendar,
  emergency_fund_runway: Shield,
  overdraft_alert: AlertTriangle,
};

// ── Visualizers ───────────────────────────────────────────────────────────────

function StreakTrack({ streak }: { streak: number }) {
  const dots = Math.min(Math.max(streak + 1, 4), 8);
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1.5">
        {Array.from({ length: dots }).map((_, i) => (
          <div
            key={i}
            className="rounded-full transition-all"
            style={{
              width: 12,
              height: 12,
              backgroundColor: i < streak ? "#059669" : "hsl(var(--muted))",
              boxShadow: i === streak - 1 ? "0 0 0 3px #05996930" : "none",
            }}
          />
        ))}
      </div>
      {streak >= 6 && (
        <span className="text-sm ml-1">🔥</span>
      )}
      <span className="text-xs text-emerald-600 font-semibold ml-1">
        {streak} month{streak !== 1 ? "s" : ""} straight
      </span>
    </div>
  );
}

function RateGauge({ current, target = 0.2 }: { current: number; target?: number }) {
  const MAX = 0.4;
  const currentPct = Math.min(100, (current / MAX) * 100);
  const targetPct  = Math.min(100, (target  / MAX) * 100);
  const color = current >= target ? "#059669" : current >= target * 0.7 ? "#d97706" : "#dc2626";

  return (
    <div className="space-y-2">
      <div
        className="relative h-3.5 rounded-full overflow-visible"
        style={{ background: "linear-gradient(to right, #dc2626 0%, #f59e0b 45%, #22c55e 100%)" }}
      >
        {/* Target marker */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white/70"
          style={{ left: `${targetPct}%` }}
        />
        {/* Current thumb */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-white shadow-md border-2 transition-all"
          style={{ left: `calc(${currentPct}% - 10px)`, borderColor: color }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-[hsl(var(--muted-foreground))]">
        <span>0%</span>
        <span className="font-semibold text-amber-500">{Math.round(target * 100)}% target</span>
        <span>40%+</span>
      </div>
      <p className="text-xs font-semibold" style={{ color }}>
        Current rate: {Math.round(current * 100)}%
      </p>
    </div>
  );
}

function PaceMeter({ paceMonthly, avgMonthly }: { paceMonthly: number; avgMonthly: number }) {
  const ratio = avgMonthly > 0 ? paceMonthly / avgMonthly : 1;
  // Normal bar fills to proportion of total
  const normalFillPct = ratio >= 1
    ? Math.round((1 / ratio) * 100)
    : 100;
  const overshootPct = ratio > 1 ? Math.min(50, Math.round(((ratio - 1) / ratio) * 100)) : 0;

  return (
    <div className="space-y-2">
      <div className="relative h-3.5 rounded-full bg-[hsl(var(--muted))] overflow-hidden">
        <div
          className="absolute left-0 top-0 h-full rounded-l-full bg-blue-400"
          style={{ width: `${normalFillPct}%` }}
        />
        {overshootPct > 0 && (
          <div
            className="absolute top-0 h-full bg-amber-400"
            style={{ left: `${normalFillPct}%`, width: `${overshootPct}%` }}
          />
        )}
        {/* Normal-pace divider */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white/50"
          style={{ left: `${normalFillPct}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px]">
        <span className="text-blue-500 font-semibold">
          avg: {formatCurrency(avgMonthly)}
        </span>
        <span className="text-amber-500 font-semibold">
          pace: {formatCurrency(paceMonthly)}
        </span>
      </div>
    </div>
  );
}

function BeforeAfterBars({ before, after }: { before: number; after: number }) {
  const max = Math.max(before, after, 1);
  const beforePct = Math.round((before / max) * 100);
  const afterPct  = Math.round((after  / max) * 100);
  const dropPct   = before > 0 ? Math.round(((before - after) / before) * 100) : 0;

  return (
    <div className="space-y-2.5">
      <div className="space-y-1.5">
        <div className="flex items-center gap-3">
          <div
            className="h-3 rounded-full flex-1"
            style={{ background: `linear-gradient(to right, hsl(var(--muted-foreground)/25) ${beforePct}%, transparent ${beforePct}%)` }}
          />
          <span className="text-[10px] text-[hsl(var(--muted-foreground))] w-20 shrink-0 text-right">
            Last: {formatCurrency(before)}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div
            className="h-3 rounded-full flex-1 bg-[hsl(var(--muted))]"
          >
            <div
              className="h-full rounded-full bg-emerald-500"
              style={{ width: `${afterPct}%` }}
            />
          </div>
          <span className="text-[10px] text-emerald-600 font-semibold w-20 shrink-0 text-right">
            Now: {formatCurrency(after)} (−{dropPct}%)
          </span>
        </div>
      </div>
    </div>
  );
}

function RunwaySegments({ runway }: { runway: number }) {
  const MAX = 12;
  const fillPct = Math.min(100, (Math.min(runway, MAX) / MAX) * 100);
  const color = runway < 1 ? "#dc2626" : runway < 3 ? "#d97706" : runway < 6 ? "#2563eb" : "#059669";
  const markers = [
    { frac: 1 / 12, label: "1mo" },
    { frac: 3 / 12, label: "3mo" },
    { frac: 6 / 12, label: "6mo" },
  ];

  return (
    <div className="space-y-2">
      <div className="relative h-3.5 rounded-full bg-[hsl(var(--muted))] overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${fillPct}%`, backgroundColor: color }}
        />
        {markers.map(({ frac }) => (
          <div
            key={frac}
            className="absolute top-0 bottom-0 w-px bg-white/40"
            style={{ left: `${frac * 100}%` }}
          />
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-[hsl(var(--muted-foreground))]">
        <span>0</span>
        {markers.map(({ frac, label }) => (
          <span key={label}
            className="font-medium"
            style={{ color: runway >= frac * MAX ? color : undefined }}
          >
            {label}
          </span>
        ))}
        <span>12mo</span>
      </div>
      <p className="text-xs font-semibold" style={{ color }}>
        {runway < 1
          ? "Less than 1 month covered"
          : runway >= 6
          ? `${Math.floor(runway)} months — healthy cushion`
          : `~${runway.toFixed(1)} months covered`}
      </p>
    </div>
  );
}

// ── Spotlight card ────────────────────────────────────────────────────────────

interface SpotlightCardProps {
  insight: Insight;
  onApply?: (insight: Insight) => void;
}

export default function SpotlightCard({ insight, onApply }: SpotlightCardProps) {
  const dismissInsight = useProfileStore((s) => s.dismissInsight);
  const rd = insight.richData;
  if (!rd) return null;

  const isSuccess = insight.severity === "success";
  const isWarning = insight.severity === "warning";
  // Use type-specific icon if available, otherwise fall back to severity default
  const Icon = TYPE_ICONS[insight.type]
    ?? (isSuccess ? CheckCircle : isWarning ? Target : Info);

  const wrapStyle = isSuccess
    ? "border-emerald-200 dark:border-emerald-800/50 bg-emerald-50/50 dark:bg-emerald-950/20"
    : isWarning
    ? "border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/20"
    : "border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)]";
  const accentCls = isSuccess ? "text-emerald-600" : isWarning ? "text-amber-500" : "text-blue-500";
  const actionCls = isSuccess
    ? "border border-emerald-400 text-emerald-700 hover:bg-emerald-100 dark:hover:bg-emerald-900/30"
    : isWarning
    ? "border border-amber-400 text-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/30"
    : "border border-blue-400 text-blue-700 hover:bg-blue-100 dark:hover:bg-blue-900/30";

  function Viz(r: NonNullable<Insight["richData"]>) {
    switch (insight.type) {
      case "positive_streak":
        return r.streakMonths !== undefined
          ? <StreakTrack streak={r.streakMonths} /> : null;
      case "savings_rate_low":
        return r.currentRate !== undefined
          ? <RateGauge current={r.currentRate} target={r.targetRate ?? 0.2} /> : null;
      case "most_improved":
        return r.beforeAmount !== undefined && r.afterAmount !== undefined
          ? <BeforeAfterBars before={r.beforeAmount} after={r.afterAmount} /> : null;
      case "spending_velocity":
        return r.paceMonthly !== undefined && r.avgMonthly !== undefined
          ? <PaceMeter paceMonthly={r.paceMonthly} avgMonthly={r.avgMonthly} /> : null;
      case "emergency_fund_runway":
        return r.runwayMonths !== undefined
          ? <RunwaySegments runway={r.runwayMonths} /> : null;
      default:
        return null;
    }
  }

  const viz = Viz(rd);
  if (!viz) return null;

  return (
    <div className={`rounded-2xl border p-5 space-y-4 ${wrapStyle}`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <Icon size={15} className={`shrink-0 mt-0.5 ${accentCls}`} />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[hsl(var(--foreground))] leading-snug">
              {insight.title}
            </p>
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5 leading-relaxed">
              {insight.description}
            </p>
          </div>
        </div>
        <button
          onClick={() => dismissInsight(insight.dismissKey)}
          aria-label="Dismiss"
          className={`shrink-0 mt-0.5 opacity-40 hover:opacity-100 transition-opacity ${accentCls}`}
        >
          <X size={14} />
        </button>
      </div>

      {/* Visualizer */}
      <div>{viz}</div>

      {/* Potential callout + action button */}
      {(rd.potentialLabel || insight.actionLabel) && (
        <div className="flex items-center justify-between gap-4 pt-1 border-t border-[inherit]">
          {rd.potentialLabel ? (
            <p className="text-[11px] text-[hsl(var(--muted-foreground))] italic flex-1">
              ↗ {rd.potentialLabel}
            </p>
          ) : <div className="flex-1" />}
          {insight.actionLabel && onApply && (
            <button
              onClick={() => onApply(insight)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-full shrink-0 transition-colors ${actionCls}`}
            >
              {insight.actionLabel} →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
