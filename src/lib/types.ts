export interface Profile {
  id: number;
  name: string;
  avatar_color: string;
  pin_hash: string | null;
  created_at: string;
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
  | "net_worth_declining";

/** Category ID reserved for internal bank transfers — excluded from expense totals. */
export const TRANSFER_CATEGORY_ID = 20;

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
}

export interface Account {
  id: number;
  name: string;
  account_type: string;
  institution: string;
  created_at: string;
  balance_anchor_cents?: number | null;
  balance_anchor_date?: string | null;
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
