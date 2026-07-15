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
  | "expense_ratio_drift";

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
}

export interface Account {
  id: number;
  name: string;
  account_type: string;
  institution: string;
  created_at: string;
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
