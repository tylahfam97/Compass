import { useState } from "react";
import type { Insight } from "@/lib/types";
import { useProfileStore } from "@/stores/profileStore";
import { WarningIcon, CheckCircleIcon, TargetIcon, InfoIcon, XIcon, TrendUpIcon, TrendDownIcon, PercentIcon, LightningIcon, ArrowsClockwiseIcon, ShoppingBagIcon, CalendarBlankIcon, ShieldIcon, CurrencyDollarIcon, CreditCardIcon, BankIcon, ChartLineIcon, ChartPieIcon } from "@phosphor-icons/react";

// Maps insight type to a descriptive icon for row/scannable contexts.
// Groups: budget (TargetIcon), rate/% (PercentIcon), trend-up (TrendUpIcon),
// improved (TrendDownIcon), velocity (LightningIcon), recurring (ArrowsClockwiseIcon),
// merchant/spend (ShoppingBag/$), time (CalendarBlankIcon), safety (ShieldIcon).
const TYPE_ICONS: Record<string, React.ElementType> = {
  // ━━ Budget discipline ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  budget_gap:             TargetIcon,
  overspend_streak:       TargetIcon,
  positive_streak:        TargetIcon,
  // ━━ Rate / percentage ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  savings_rate_low:       PercentIcon,
  expense_ratio_drift:    PercentIcon,
  weekend_spending:       PercentIcon,
  // ━━ Trending up (notable / bad in spend context) ━━━━━━━━━━━━━━━━━━━━━━
  unusual_spike:          TrendUpIcon,
  category_creep:         TrendUpIcon,
  year_end_projection:    TrendUpIcon,
  // ━━ Improved / trending down (good) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  most_improved:          TrendDownIcon,
  // ━━ Velocity / pace ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  spending_velocity:      LightningIcon,
  // ━━ Recurring charges / subscriptions ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ghost_subscription:     ArrowsClockwiseIcon,
  subscription_total:     ArrowsClockwiseIcon,
  redundant_spending:     ArrowsClockwiseIcon,
  // ━━ Merchant / shopping spend ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  top_merchants:          ShoppingBagIcon,
  food_delivery_spend:    ShoppingBagIcon,
  // ━━ Cost / money ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  bill_due_soon:          CurrencyDollarIcon,
  // ━━ Time / calendar ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  income_expected:        CalendarBlankIcon,
  income_irregular:       CalendarBlankIcon,
  // ━━ Account safety / health ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  emergency_fund_runway:  ShieldIcon,
  overdraft_alert:        WarningIcon,
  // ━━ Credit card debt ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  credit_card_debt_high:      CreditCardIcon,
  credit_card_debt_growing:   CreditCardIcon,
  credit_card_debt_improving: CreditCardIcon,  // ━━ Loan debt / payoff planning ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  loan_debt_high:              BankIcon,
  loan_debt_growing:           BankIcon,
  loan_debt_improving:         BankIcon,
  loan_payoff_projection:      CalendarBlankIcon,
  debt_payoff_priority:        BankIcon,
  // ━━ Investments ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  investment_performance:      ChartLineIcon,
  dividend_income_projected:   CurrencyDollarIcon,
  investment_income_received:  CurrencyDollarIcon,
  realized_gains_ytd:          ChartLineIcon,
  portfolio_concentration_risk: ChartPieIcon,};

const CARD_STYLES: Record<string, string> = {
  warning: "bg-gradient-to-br from-[hsl(var(--warning)/0.08)] to-[hsl(var(--warning)/0.02)] dark:from-[hsl(var(--warning)/0.12)] dark:to-[hsl(var(--warning)/0.04)]",
  info:    "bg-gradient-to-br from-[hsl(var(--primary)/0.08)] to-[hsl(var(--primary)/0.02)] dark:from-[hsl(var(--primary)/0.12)] dark:to-[hsl(var(--primary)/0.04)]",
  success: "bg-gradient-to-br from-[hsl(var(--success)/0.08)] to-[hsl(var(--success)/0.02)] dark:from-[hsl(var(--success)/0.12)] dark:to-[hsl(var(--success)/0.04)]",
};
// Short, rounded accent tick (not a full-height bar) - a lighter-touch severity cue that
// reads as a deliberate premium detail rather than a hard boxy stripe.
const ACCENT_BAR_CLS: Record<string, string> = {
  warning: "bg-[hsl(var(--warning))]",
  info:    "bg-[hsl(var(--primary))]",
  success: "bg-[hsl(var(--success))]",
};
const ICON_CLS: Record<string, string> = {
  warning: "text-[hsl(var(--warning))]",
  info:    "text-[hsl(var(--gold-ink))]",
  success: "text-[hsl(var(--success))]",
};
const TITLE_CLS: Record<string, string> = {
  warning: "text-[hsl(var(--foreground))]",
  info:    "text-[hsl(var(--foreground))]",
  success: "text-[hsl(var(--foreground))]",
};
const ACTION_CLS: Record<string, string> = {
  warning: "border border-[hsl(var(--warning)/0.5)] text-[hsl(var(--warning))] hover:bg-[hsl(var(--warning)/0.12)] dark:hover:bg-[hsl(var(--warning)/0.18)]",
  info:    "border border-[hsl(var(--primary)/0.5)] text-[hsl(var(--gold-ink))] hover:bg-[hsl(var(--primary)/0.12)] dark:hover:bg-[hsl(var(--primary)/0.18)]",
  success: "border border-[hsl(var(--success)/0.5)] text-[hsl(var(--success))] hover:bg-[hsl(var(--success)/0.12)] dark:hover:bg-[hsl(var(--success)/0.18)]",
};
const CARD_ICONS: Record<string, React.ElementType> = {
  warning: WarningIcon,
  info:    InfoIcon,
  success: CheckCircleIcon,
};
const ROW_ICONS: Record<string, React.ElementType> = {
  warning: TargetIcon,
  info:    InfoIcon,
  success: CheckCircleIcon,
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
              {insight.actionLabel}
            </button>
          )}
        </div>
        <button
          onClick={() => dismissInsight(insight.dismissKey)}
          aria-label="Dismiss"
          className="text-[hsl(var(--muted-foreground))] opacity-0 group-hover:opacity-40
                     hover:!opacity-100 focus:!opacity-100 focus-visible:!opacity-100 transition-opacity shrink-0 mt-0.5"
        >
          <XIcon size={13} />
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
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded((v) => !v); }
      }}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
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
            <span className="font-semibold ">
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
            {insight.actionLabel}
          </button>
        )}
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); dismissInsight(insight.dismissKey); }}
        aria-label="Dismiss"
        className={`${ICON_CLS[insight.severity]} opacity-50 hover:opacity-100 transition-opacity shrink-0 mt-0.5`}
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}
