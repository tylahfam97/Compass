export interface Profile {
  id: number;
  name: string;
  avatar_color: string;
  pin_hash: string | null;
  created_at: string;
}

/** User-defined recurring transaction rule (reminder-only for now - see recurring.ts's
 *  `computeNextOccurrence`; nothing is ever auto-inserted into `transactions`). Distinct from
 *  `detectRecurringCharges` in agent.ts, which analyses PAST transactions to find patterns
 *  after the fact - this lets a user schedule a bill/income ahead of its first occurrence. */
export type RecurringCadence = "monthly" | "weekly" | "biweekly";

export interface RecurringRule {
  id: number;
  profile_id: number;
  account_id: number | null;
  description: string;
  amount_cents: number;
  category_id: number | null;
  cadence: RecurringCadence;
  /** 1-31, used when cadence === "monthly". Clamped to each month's real last day. */
  day_of_month: number | null;
  /** 0=Mon..6=Sun (matches the `(strftime('%w',date)+6)%7` convention used elsewhere in the
   *  app), used when cadence is "weekly" or "biweekly". */
  day_of_week: number | null;
  start_date: string;
  active: boolean;
  created_at: string;
  // Joined
  category_name?: string;
  category_color?: string;
  account_name?: string;
}

export type InsightType =
  | "budget_gap"
  | "ghost_subscription"
  | "unusual_spike"
  | "savings_rate_low"
  | "overspend_streak"
  | "positive_streak"
  | "redundant_spending"
  | "income_irregular"
  | "top_merchants"
  | "food_delivery_spend"
  | "subscription_total"
  | "income_expected"
  | "overdraft_alert"
  | "category_creep"
  | "year_end_projection"
  | "most_improved"
  | "weekend_spending"
  | "spending_velocity"
  | "emergency_fund_runway"
  | "bill_due_soon"
  | "expense_ratio_drift"
  | "credit_card_debt_high"
  | "credit_card_debt_growing"
  | "credit_card_debt_improving"
  | "net_worth_growing"
  | "net_worth_declining"
  | "loan_debt_high"
  | "loan_debt_growing"
  | "loan_debt_improving"
  | "loan_payoff_projection"
  | "debt_payoff_priority"
  | "investment_performance"
  | "dividend_income_projected"
  | "investment_income_received"
  | "realized_gains_ytd"
  | "portfolio_concentration_risk";

/** Category ID reserved for internal bank transfers — excluded from expense totals. */
export const TRANSFER_CATEGORY_ID = 20;

/** Category ID for a general-purpose "leave this out of my totals" bucket - unlike
 *  Transfers (same-institution internal moves only), this is for anything else the user
 *  wants excluded from income/expense totals (reimbursements, one-off adjustments, etc.). */
export const EXCLUDED_CATEGORY_ID = 29;

/** Shared explainer for the Transfers/Excluded exclusion, reused by every Income/Expenses
 *  tooltip across Dashboard, Overview, and Transactions so the wording stays consistent. */
export const EXCLUSION_DISCLAIMER_TEXT =
  "Transfers tracks money moved between your own accounts (e.g. checking \u2192 savings) - including credit-card payments, so they're never double-counted as both a checking withdrawal and a card credit. Excluded is a catch-all for anything else you don't want counted (reimbursements, one-off adjustments, etc.). Both are left out of every income and expense total in the app.";

export interface InsightAction {
  type: "create_budget" | "create_goal";
  payload: Record<string, unknown>;
}

export interface Insight {
  id: string;
  type: InsightType;
  title: string;
  description: string;
  severity: "info" | "warning" | "success";
  actionLabel?: string;
  action?: InsightAction;
  dismissKey: string;
  richData?: InsightRichData;
  /** Set when this insight is about one specific account (e.g. a single credit card's debt)
   *  rather than the profile as a whole - lets account-detail views show only insights that
   *  actually pertain to that account instead of every insight of a matching type. */
  accountId?: number;
}

export interface InsightRichData {
  streakMonths?: number;
  budgetAmountCents?: number;
  currentRate?: number;
  targetRate?: number;
  beforeAmount?: number;
  afterAmount?: number;
  paceMonthly?: number;
  avgMonthly?: number;
  runwayMonths?: number;
  projectedSavings?: number;
  overCount?: number;
  avgMonthlyCents?: number;
  potentialLabel?: string;
  potentialValue?: number;
  /** Snapshot of the specific account's own numbers at the time this insight was generated -
   *  used to render a small account-specific blurb (balance/APR/min payment) when expanding a
   *  per-account insight (credit/loan debt tracking, payoff projection, payoff priority),
   *  rather than only re-showing the same title/description text already visible. */
  accountType?: "credit" | "loan";
  accountBalanceCents?: number | null;
  accountInterestRateBps?: number | null;
  accountMinimumPaymentCents?: number | null;
}

export interface Account {
  id: number;
  name: string;
  account_type: string;
  institution: string;
  created_at: string;
  balance_anchor_cents?: number | null;
  balance_anchor_date?: string | null;
  hidden_from_dashboard?: boolean;
  excluded_from_insights?: boolean;
  /** Loan and credit accounts - purely informational (APR / minimum payment), never used in
   *  any calculation besides ranking and the Debt Payoff plan's amortization estimate. */
  interest_rate_bps?: number | null;
  minimum_payment_cents?: number | null;
}

export interface Transaction {
  id: number;
  account_id: number;
  date: string;
  amount_cents: number;
  description: string;
  category_id: number | null;
  notes: string | null;
  import_hash: string;
  balance_cents: number | null;
  created_at: string;
  // Joined from categories table
  category_name?: string;
  category_color?: string;
  // Joined from accounts table (only selected in a few places that need it)
  account_type?: string;
  account_name?: string;
}

export interface Category {
  id: number;
  name: string;
  parent_id: number | null;
  color: string;
  icon: string;
  is_system: boolean;
}

/** Broad security classification used to group holdings in the Investments page. */
export type SecurityType = "stock" | "etf" | "mutual_fund" | "cash" | "other";

/** A single lot/position row imported from a brokerage portfolio-positions export. */
export interface Holding {
  id: number;
  account_id: number;
  profile_id: number;
  import_session_id: number | null;
  as_of_date: string;
  security_type: SecurityType;
  symbol: string | null;
  description: string;
  shares: number | null;
  price_cents: number | null;
  market_value_cents: number | null;
  cost_basis_cents: number | null;
  trade_date: string | null;
  dividend_per_share_cents: number | null;
  est_annual_income_cents: number | null;
  created_at: string;
}

/** What a brokerage statement's activity line represents. */
export type ActivityType =
  | "buy" | "sell" | "dividend" | "reinvest" | "interest"
  | "deposit" | "withdrawal" | "transfer" | "fee" | "tax" | "other";

/**
 * One line of a brokerage statement's transaction/activity table. Unlike `Holding` (a dated
 * snapshot of what you own), this is the record of what actually happened during the period.
 * The realized-gain fields are only populated by statements that print per-lot cost basis
 * alongside the sale; account-level realized gain lives on `InvestmentSummary` instead.
 */
export interface InvestmentActivity {
  id: number;
  account_id: number;
  profile_id: number;
  import_session_id: number | null;
  trade_date: string;
  settle_date: string | null;
  activity_type: ActivityType;
  raw_activity_type: string | null;
  symbol: string | null;
  description: string;
  quantity: number | null;
  price_cents: number | null;
  amount_cents: number;
  cost_basis_cents: number | null;
  realized_gain_cents: number | null;
  acquired_date: string | null;
  term: "short" | "long" | null;
  import_hash: string;
  created_at: string;
}

/** A statement period's account-level totals. One row per account per statement period. */
export interface InvestmentSummary {
  id: number;
  account_id: number;
  profile_id: number;
  import_session_id: number | null;
  period_start: string | null;
  period_end: string;
  beginning_value_cents: number | null;
  ending_value_cents: number | null;
  change_in_value_cents: number | null;
  cash_balance_cents: number | null;
  deposits_cents: number | null;
  withdrawals_cents: number | null;
  transfers_cents: number | null;
  income_cents: number | null;
  dividends_cents: number | null;
  interest_cents: number | null;
  fees_cents: number | null;
  realized_gain_cents: number | null;
  realized_gain_ytd_cents: number | null;
  unrealized_gain_cents: number | null;
  created_at: string;
}


export interface Budget {
  id: number;
  category_id: number;
  amount_cents: number;
  period: "monthly" | "weekly";
  start_date: string;
  is_global: number;
}

export interface CategorizationRule {
  id: number;
  pattern: string;
  match_type: "contains" | "starts_with" | "regex";
  category_id: number;
  priority: number;
  min_abs_cents?: number | null;
  max_abs_cents?: number | null;
}

export interface HealthScoreComponent {
  score: number;
  max: number;
  pct: number;
}

export interface HealthScore {
  total: number;
  grade: string;
  label: string;
  color: string;
  components: {
    savingsRate:     HealthScoreComponent;
    budgetHealth:    HealthScoreComponent;
    balanceRunway:   HealthScoreComponent;
    incomeStability: HealthScoreComponent;
  };
}

/** A standalone 0-100 score benchmarked against a national-average figure,
 *  shown as its own mini-card rather than folded into the main Health Score. */
export interface MiniHealthScore {
  score: number;
  hasData: boolean;
  grade: string;
  label: string;
  color: string;
  detail: string;
}

export interface CreditCardHealthScore extends MiniHealthScore {
  debtCents: number;
  benchmarkCents: number;
}

export interface InvestmentHealthScore extends MiniHealthScore {
  returnPct: number | null;
  benchmarkPct: number;
}

/** One discretionary spending category feeding a debt-payoff plan's "what can be cut"
 *  breakdown - average monthly spend over the observed history window. */
export interface DebtPayoffCategoryBreakdown {
  categoryId: number;
  name: string;
  color: string;
  avgMonthlyCents: number;
  /** A few example transaction descriptions in this category (most frequent first), shown on
   *  hover so "Shopping" or "Entertainment" isn't just an abstract label. May be empty. */
  exampleItems: string[];
}

/** One resolved debt, normalized to cents/fractional-monthly-rate, ready for the
 *  month-by-month payoff simulation. Returned as part of `DebtPayoffPlan` so the Debt Payoff
 *  modal can re-run `simulateCustomDebtPayoff` locally (e.g. on every slider tick or category
 *  toggle) without a DB round-trip. */
export interface DebtPayoffSimDebt {
  id: number;
  balanceCents: number;
  /** Fractional monthly interest rate (annual bps already converted), e.g. 0.015 for 1.5%/mo. */
  monthlyRate: number;
  minPaymentCents: number;
}

/** One debt's projected payoff month under a given scenario - feeds the payoff timeline
 *  visualization (each debt reaching $0 in sequence). */
export interface DebtPayoffDebtMonths {
  id: number;
  monthsToPayoff: number | null;
}

/** Result of simulating one payoff scenario - either the fixed "Stay the Course" baseline
 *  (extraMonthlyCents=0) or a live, user-adjusted scenario driven by the Debt Payoff modal's
 *  slider + category toggles. */
export interface DebtPayoffCustomResult {
  extraMonthlyCents: number;
  /** Months until every debt in the plan reaches $0, or null if minimum payments don't
   *  even cover interest at the current pace (would never pay off on its own). */
  monthsToPayoff: number | null;
  /** "Mon YYYY" formatted projected debt-free date, or null if monthsToPayoff is null. */
  payoffDate: string | null;
  totalInterestCents: number;
  totalPaidCents: number;
  /** Per-debt month-to-payoff under this scenario, for the payoff timeline visualization. */
  perDebtMonths: DebtPayoffDebtMonths[];
}

export interface DebtPayoffPlan {
  totalDebtCents: number;
  weightedAvgRateBps: number | null;
  hasRateData: boolean;
  totalMinPaymentCents: number;
  discretionaryBreakdown: DebtPayoffCategoryBreakdown[];
  discretionaryTotalCents: number;
  monthsOfHistory: number;
  /** Resolved simulation inputs - see `DebtPayoffSimDebt`. */
  simDebts: DebtPayoffSimDebt[];
  /** "Stay the course" (minimum payments only) scenario - the fixed reference point every
   *  custom/live scenario is compared against. */
  baseline: DebtPayoffCustomResult;
}

/** A recurring charge (subscription/bill) detected by day-of-month or "Nth weekday of month"
 *  cadence - see `detectRecurringCharges` in agent.ts. `month_count` is the length of the
 *  CURRENT consecutive-month streak ending at `last_seen`, not just a lifetime occurrence
 *  count, so a charge that lapsed months ago won't still show as "recurring". */
export interface RecurringCharge {
  description: string;
  amount_cents: number;
  month_count: number;
  first_seen: string;
  last_seen: string;
  category_name: string | null;
  category_color: string | null;
  /** Human-readable cadence, e.g. "21st of the month" or "3rd Thursday of the month". */
  patternLabel: string;
}
