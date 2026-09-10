import { useId, useState } from "react";
import type { Insight } from "@/lib/types";
import { useProfileStore } from "@/stores/profileStore";
import { formatCurrencyWhole } from "@/lib/utils";
import { insightActionLabel } from "@/lib/insightActions";
import InsightDetail, { hasDetail } from "@/components/InsightDetail";
import {
  WarningIcon, CheckCircleIcon, TargetIcon, InfoIcon, XIcon, TrendUpIcon, TrendDownIcon, PercentIcon, LightningIcon,
  ArrowsClockwiseIcon, ShoppingBagIcon, CalendarBlankIcon, ShieldIcon, CurrencyDollarIcon, CreditCardIcon, BankIcon,
  ChartLineIcon, ChartPieIcon, CalendarCheckIcon, WarningCircleIcon, ReceiptIcon, SparkleIcon, CopyIcon, ScalesIcon,
  TagIcon, ClockCounterClockwiseIcon, CoinsIcon, CaretDownIcon,
} from "@phosphor-icons/react";

// Maps insight type to a descriptive icon for row/scannable contexts.
const TYPE_ICONS: Record<string, React.ElementType> = {
  // Budget discipline
  budget_gap:             TargetIcon,
  overspend_streak:       TargetIcon,
  positive_streak:        TargetIcon,
  budget_pace:            TargetIcon,
  goal_off_track:         TargetIcon,
  goal_projection:        TargetIcon,
  // Rate / percentage
  savings_rate_low:       PercentIcon,
  expense_ratio_drift:    PercentIcon,
  weekend_spending:       PercentIcon,
  interest_paid:          PercentIcon,
  // Trending up (notable in a spend context)
  unusual_spike:          TrendUpIcon,
  category_creep:         TrendUpIcon,
  year_end_projection:    TrendUpIcon,
  // Improved / trending down (good)
  most_improved:          TrendDownIcon,
  // Velocity / pace
  spending_velocity:      LightningIcon,
  // Recurring charges
  subscription_total:     ArrowsClockwiseIcon,
  recurring_price_change: ReceiptIcon,
  new_recurring_charge:   SparkleIcon,
  annual_renewal:         CalendarBlankIcon,
  duplicate_charge:       CopyIcon,
  // Merchants
  top_merchants:          ShoppingBagIcon,
  food_delivery_spend:    ShoppingBagIcon,
  frequent_merchant:      ShoppingBagIcon,
  large_purchase:         ShoppingBagIcon,
  // Scheduled money
  bills_this_week:        CalendarCheckIcon,
  scheduled_missing:      WarningCircleIcon,
  income_expected:        CalendarBlankIcon,
  income_irregular:       CalendarBlankIcon,
  // Shape of a month
  fixed_costs_high:       ScalesIcon,
  no_spend_days:          CalendarBlankIcon,
  payday_burst:           CalendarBlankIcon,
  // Housekeeping
  uncategorized_share:    TagIcon,
  stale_data:             ClockCounterClockwiseIcon,
  // Account safety / health
  emergency_fund_runway:  ShieldIcon,
  overdraft_alert:        WarningIcon,
  // Credit cards
  credit_card_debt_high:      CreditCardIcon,
  credit_card_debt_growing:   CreditCardIcon,
  credit_card_debt_improving: CreditCardIcon,
  card_paid_in_full:          CheckCircleIcon,
  card_coverage_low:          CreditCardIcon,
  // Loans / payoff planning
  loan_debt_high:              BankIcon,
  loan_debt_growing:           BankIcon,
  loan_debt_improving:         BankIcon,
  loan_payoff_projection:      CalendarBlankIcon,
  debt_payoff_priority:        BankIcon,
  // Investments
  investment_performance:      ChartLineIcon,
  dividend_income_projected:   CurrencyDollarIcon,
  investment_income_received:  CurrencyDollarIcon,
  realized_gains_ytd:          ChartLineIcon,
  portfolio_concentration_risk: ChartPieIcon,
  investment_fees:             CoinsIcon,
};

const CARD_STYLES: Record<string, string> = {
  warning: "bg-gradient-to-br from-[hsl(var(--warning)/0.08)] to-[hsl(var(--warning)/0.02)] dark:from-[hsl(var(--warning)/0.12)] dark:to-[hsl(var(--warning)/0.04)]",
  info:    "bg-gradient-to-br from-[hsl(var(--primary)/0.08)] to-[hsl(var(--primary)/0.02)] dark:from-[hsl(var(--primary)/0.12)] dark:to-[hsl(var(--primary)/0.04)]",
  success: "bg-gradient-to-br from-[hsl(var(--success)/0.08)] to-[hsl(var(--success)/0.02)] dark:from-[hsl(var(--success)/0.12)] dark:to-[hsl(var(--success)/0.04)]",
};
// Short, rounded accent tick (not a full-height bar) - a lighter-touch severity cue.
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

/** One button style for every intent: gold is agency, severity stays on the icon. */
const ACTION_BUTTON_CLS = "insight-action rounded-md border border-[hsl(var(--border))] px-2.5 py-1 text-xs font-medium text-[hsl(var(--gold-ink))] hover:bg-[hsl(var(--primary)/0.1)] transition-colors";

interface InsightCardProps {
  insight: Insight;
  onApply?: (insight: Insight) => void;
  compact?: boolean;
  variant?: "card" | "row";
  /** Row variant: open the detail panel on mount (the top-ranked problem opens on arrival). */
  defaultExpanded?: boolean;
}

export default function InsightCard({ insight, onApply, compact = false, variant = "card", defaultExpanded = false }: InsightCardProps) {
  const dismissInsight = useProfileStore((s) => s.dismissInsight);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const detailId = useId();
  // Row variant: use the type-specific icon for instant scannability;
  // fall back to the severity default if no mapping exists.
  const typeIcon = TYPE_ICONS[insight.type];
  const Icon = variant === "row"
    ? (typeIcon ?? ROW_ICONS[insight.severity])
    : CARD_ICONS[insight.severity];
  const label = insightActionLabel(insight);

  if (variant === "row") {
    const detail = hasDetail(insight);
    const impact = Math.abs(insight.impactCents ?? 0);
    return (
      <div className="insight-row group">
        <Icon size={14} className={`insight-row-icon ${ICON_CLS[insight.severity]}`} />
        <div className="min-w-0">
          <p className="text-sm font-medium text-[hsl(var(--foreground))] leading-snug">{insight.title}</p>
          {insight.description && (
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5 leading-relaxed">{insight.description}</p>
          )}
          {((label && onApply && insight.action) || detail) && (
            <div className="insight-row-controls">
              {label && onApply && insight.action && (
                <button type="button" onClick={() => onApply(insight)} className={ACTION_BUTTON_CLS}>{label}</button>
              )}
              {detail && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  aria-expanded={expanded}
                  aria-controls={detailId}
                  className="insight-details-toggle"
                >
                  Details
                  <CaretDownIcon size={12} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
                </button>
              )}
            </div>
          )}
          {detail && expanded && (
            <div id={detailId} className="insight-detail">
              <InsightDetail insight={insight} />
            </div>
          )}
        </div>
        <div className="insight-row-figure">
          {impact > 0 && <span className="block text-sm font-medium tabular-nums text-[hsl(var(--foreground))]">{formatCurrencyWhole(impact)}</span>}
          {insight.period && <span className="block text-xs text-[hsl(var(--muted-foreground))]">{insight.period}</span>}
        </div>
        <button
          type="button"
          onClick={() => dismissInsight(insight.dismissKey)}
          aria-label="Dismiss"
          className="insight-row-dismiss text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
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
        <p className={`text-sm font-semibold leading-snug text-[hsl(var(--foreground))] ${expanded ? "" : "line-clamp-2"}`}>
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
              {rd!.accountType === "credit" ? "Credit card" : "Loan"}
            </span>
            {rd!.accountBalanceCents != null && (
              <span>Balance: <span className="font-medium text-[hsl(var(--foreground))]">{formatCurrencyWhole(Math.abs(rd!.accountBalanceCents))}</span></span>
            )}
            {rd!.accountInterestRateBps != null && (
              <span>APR: <span className="font-medium text-[hsl(var(--foreground))]">{formatBps(rd!.accountInterestRateBps)}</span></span>
            )}
            {rd!.accountMinimumPaymentCents != null && (
              <span>Min payment: <span className="font-medium text-[hsl(var(--foreground))]">{formatCurrencyWhole(rd!.accountMinimumPaymentCents)}/mo</span></span>
            )}
          </div>
        )}
        {label && onApply && insight.action && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onApply(insight); }}
            className={`mt-2 ${ACTION_BUTTON_CLS}`}
          >
            {label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); dismissInsight(insight.dismissKey); }}
        aria-label="Dismiss"
        className={`${ICON_CLS[insight.severity]} opacity-50 hover:opacity-100 transition-opacity shrink-0 mt-0.5`}
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}
