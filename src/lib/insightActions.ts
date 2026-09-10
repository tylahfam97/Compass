import type { InsightAction } from "./types";

/**
 * Where an insight's action takes the user. Router actions resolve to a path and state that
 * the target page already reads; page-local actions (`open_payoff`, `open_section`) return
 * null and are handled by the page that can perform them.
 */
export interface ResolvedInsightAction {
  to: string;
  state?: Record<string, unknown>;
}

export function resolveInsightAction(action: InsightAction): ResolvedInsightAction | null {
  switch (action.type) {
    case "create_budget": return { to: "/budgets", state: { prefillBudget: action.payload } };
    case "create_goal":
    case "open_goals": return { to: "/goals" };
    case "view_transactions": return { to: "/transactions", state: action.payload };
    case "open_plan": return { to: "/plan" };
    case "open_budgets": return { to: "/budgets" };
    case "import": return { to: "/import" };
    case "open_payoff":
    case "open_section": return null;
  }
}

/** One label per intent. The engine only supplies `actionLabel` when it adds information (an amount). */
export const ACTION_LABELS: Record<InsightAction["type"], string> = {
  create_budget: "Set a budget",
  create_goal: "Set a goal",
  view_transactions: "View transactions",
  open_plan: "Open Plan",
  open_goals: "Open goals",
  open_budgets: "Open budgets",
  import: "Import transactions",
  open_payoff: "See payoff plan",
  open_section: "Review subscriptions",
};

export function insightActionLabel(insight: { actionLabel?: string; action?: InsightAction }): string | null {
  if (insight.actionLabel) return insight.actionLabel;
  if (!insight.action) return null;
  if (insight.action.type === "view_transactions" && (insight.action.payload as { category?: number | null }).category === 15) return "Categorize";
  return ACTION_LABELS[insight.action.type];
}
