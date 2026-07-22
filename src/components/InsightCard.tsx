import { useState } from "react";
import type { Insight } from "@/lib/types";
import { useProfileStore } from "@/stores/profileStore";
import {
  AlertTriangle, CheckCircle, Target, Info, X,
  TrendingUp, TrendingDown, Percent, Zap,
  RefreshCw, ShoppingBag, Calendar, Shield, DollarSign, CreditCard,
  Landmark, LineChart, PieChart,
} from "lucide-react";

// Maps insight type to a descriptive icon for row/scannable contexts.
// Groups: budget (Target), rate/% (Percent), trend-up (TrendingUp),
// improved (TrendingDown), velocity (Zap), recurring (RefreshCw),
// merchant/spend (ShoppingBag/$), time (Calendar), safety (Shield).
const TYPE_ICONS: Record<string, React.ElementType> = {
  // ━━ Budget discipline ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  budget_gap:             Target,
  overspend_streak:       Target,
  positive_streak:        Target,
  // ━━ Rate / percentage ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  savings_rate_low:       Percent,
  expense_ratio_drift:    Percent,
  weekend_spending:       Percent,
  // ━━ Trending up (notable / bad in spend context) ━━━━━━━━━━━━━━━━━━━━━━
  unusual_spike:          TrendingUp,
  category_creep:         TrendingUp,
  year_end_projection:    TrendingUp,
  // ━━ Improved / trending down (good) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  most_improved:          TrendingDown,
  // ━━ Velocity / pace ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  spending_velocity:      Zap,
  // ━━ Recurring charges / subscriptions ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ghost_subscription:     RefreshCw,
  subscription_total:     RefreshCw,
  redundant_spending:     RefreshCw,
  // ━━ Merchant / shopping spend ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  top_merchants:          ShoppingBag,
  food_delivery_spend:    ShoppingBag,
  // ━━ Cost / money ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  bill_due_soon:          DollarSign,
  // ━━ Time / calendar ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  income_expected:        Calendar,
  income_irregular:       Calendar,
  // ━━ Account safety / health ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  emergency_fund_runway:  Shield,
  overdraft_alert:        AlertTriangle,
  // ━━ Credit card debt ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  credit_card_debt_high:      CreditCard,
  credit_card_debt_growing:   CreditCard,
  credit_card_debt_improving: CreditCard,  // ━━ Loan debt / payoff planning ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  loan_debt_high:              Landmark,
  loan_debt_growing:           Landmark,
  loan_debt_improving:         Landmark,
  loan_payoff_projection:      Calendar,
  debt_payoff_priority:        Landmark,
  // ━━ Investments ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  investment_performance:      LineChart,
  dividend_income_projected:   DollarSign,
  portfolio_concentration_risk: PieChart,};

const CARD_STYLES: Record<string, string> = {
  warning: "bg-gradient-to-br from-amber-50 to-amber-50/30 dark:from-amber-950/30 dark:to-amber-950/10",
  info:    "bg-gradient-to-br from-blue-50/80 to-blue-50/20 dark:from-blue-950/25 dark:to-blue-950/10",
  success: "bg-gradient-to-br from-emerald-50/80 to-emerald-50/20 dark:from-emerald-950/25 dark:to-emerald-950/10",
};
// Short, rounded accent tick (not a full-height bar) - a lighter-touch severity cue that
// reads as a deliberate premium detail rather than a hard boxy stripe.
const ACCENT_BAR_CLS: Record<string, string> = {
  warning: "bg-amber-400",
  info:    "bg-blue-400",
  success: "bg-emerald-400",
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
const CARD_ICONS: Record<string, React.ElementType> = {
  warning: AlertTriangle,
  info:    Info,
  success: CheckCircle,
};
const ROW_ICONS: Record<string, React.ElementType> = {
  warning: Target,
  info:    Info,
  success: CheckCircle,
};

interface InsightCardProps {
  insight: Insight;
  onApply?: (insight: Insight) => void;
  compact?: boolean;
  variant?: "card" | "row";
}

export default function InsightCard({ insight, onApply, compact = false, variant = "card" }: InsightCardProps) {
  const dismissInsight = useProfileStore((s) => s.dismissInsight);
  const [expanded, setExpanded] = useState(false);
  // Row variant: use the type-specific icon for instant scannability;
  // fall back to the severity default if no mapping exists.
  const typeIcon = TYPE_ICONS[insight.type];
  const Icon = variant === "row"
    ? (typeIcon ?? ROW_ICONS[insight.severity])
    : CARD_ICONS[insight.severity];

  if (variant === "row") {
    return (
      <div className="group flex items-start gap-4 px-5 py-4 border-b last:border-0
                      hover:bg-[hsl(var(--muted)/0.5)] transition-colors">
        <Icon size={14} className={`shrink-0 mt-0.5 ${ICON_CLS[insight.severity]} opacity-60`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-[hsl(var(--foreground))] leading-snug">
            {insight.title}
          </p>
          {!compact && insight.description && (
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
          className="text-[hsl(var(--muted-foreground))] opacity-0 group-hover:opacity-40
                     hover:!opacity-100 transition-opacity shrink-0 mt-0.5"
        >
          <X size={13} />
        </button>
      </div>
    );
  }

  // Account-specific blurb (balance/APR/min payment), only present for insights generated
  // per-account (credit/loan debt tracking, payoff projection/priority) - undefined for
  // profile-wide insights, so the section below simply doesn't render for those.
  const rd = insight.richData;
  const hasAccountBlurb = rd?.accountBalanceCents !== undefined;

  const formatBps = (bps: number) => `${(bps / 100).toFixed(2)}%`;
  const formatDollars = (cents: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);

  return (
    <div
      onClick={() => setExpanded((v) => !v)}
      title={expanded ? "Click to collapse" : "Click for full details"}
      className={`insight-card-hover relative h-full rounded-2xl pl-4 pr-3.5 py-3.5 flex items-start gap-3 shadow-sm hover:shadow-md transition-all duration-200 overflow-hidden cursor-pointer ${CARD_STYLES[insight.severity]}`}
    >
      <span aria-hidden="true" className={`absolute left-0 top-3 bottom-3 w-[3px] rounded-full ${ACCENT_BAR_CLS[insight.severity]}`} />
      <span className="relative shrink-0 mt-0.5">
        <span aria-hidden="true" className="insight-icon-glow" />
        <Icon size={15} className={`relative ${ICON_CLS[insight.severity]}`} />
      </span>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-semibold leading-snug ${TITLE_CLS[insight.severity]} ${expanded ? "" : "line-clamp-2"}`}>
          {insight.title}
        </p>
        {!compact && (
          <p className={`text-xs text-[hsl(var(--muted-foreground))] mt-1 leading-relaxed ${expanded ? "" : "line-clamp-2"}`}>
            {insight.description}
          </p>
        )}
        {expanded && hasAccountBlurb && (
          <div className="mt-2 pt-2 border-t border-[hsl(var(--border))]/50 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[hsl(var(--muted-foreground))]">
            <span className="font-semibold uppercase tracking-wide">
              {rd!.accountType === "credit" ? "Credit Card" : "Loan"}
            </span>
            {rd!.accountBalanceCents != null && (
              <span>Balance: <span className="font-medium text-[hsl(var(--foreground))]">{formatDollars(Math.abs(rd!.accountBalanceCents))}</span></span>
            )}
            {rd!.accountInterestRateBps != null && (
              <span>APR: <span className="font-medium text-[hsl(var(--foreground))]">{formatBps(rd!.accountInterestRateBps)}</span></span>
            )}
            {rd!.accountMinimumPaymentCents != null && (
              <span>Min payment: <span className="font-medium text-[hsl(var(--foreground))]">{formatDollars(rd!.accountMinimumPaymentCents)}/mo</span></span>
            )}
          </div>
        )}
        {insight.actionLabel && onApply && (
          <button
            onClick={(e) => { e.stopPropagation(); onApply(insight); }}
            className={`mt-2 text-xs font-semibold px-3 py-1 rounded-full transition-colors ${ACTION_CLS[insight.severity]}`}
          >
            {insight.actionLabel} →
          </button>
        )}
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); dismissInsight(insight.dismissKey); }}
        aria-label="Dismiss"
        className={`${ICON_CLS[insight.severity]} opacity-50 hover:opacity-100 transition-opacity shrink-0 mt-0.5`}
      >
        <X size={14} />
      </button>
    </div>
  );
}
