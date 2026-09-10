import { describe, it, expect } from "vitest";
import { resolveInsightAction, insightActionLabel } from "./insightActions";

describe("resolveInsightAction", () => {
  it("maps router actions to the paths and state the target pages read", () => {
    expect(resolveInsightAction({ type: "create_budget", payload: { category_id: 13, amount_cents: 40000 } }))
      .toEqual({ to: "/budgets", state: { prefillBudget: { category_id: 13, amount_cents: 40000 } } });
    expect(resolveInsightAction({ type: "view_transactions", payload: { month: "2026-09", category: 15 } }))
      .toEqual({ to: "/transactions", state: { month: "2026-09", category: 15 } });
    expect(resolveInsightAction({ type: "open_plan", payload: {} })).toEqual({ to: "/plan" });
    expect(resolveInsightAction({ type: "import", payload: {} })).toEqual({ to: "/import" });
  });

  it("returns null for page-local actions", () => {
    expect(resolveInsightAction({ type: "open_payoff", payload: {} })).toBeNull();
    expect(resolveInsightAction({ type: "open_section", payload: { section: "subs" } })).toBeNull();
  });
});

describe("insightActionLabel", () => {
  it("prefers the engine's specific label, then the intent vocabulary", () => {
    expect(insightActionLabel({ actionLabel: "Set $412 budget", action: { type: "create_budget", payload: {} } })).toBe("Set $412 budget");
    expect(insightActionLabel({ action: { type: "open_plan", payload: {} } })).toBe("Open Plan");
    expect(insightActionLabel({ action: { type: "view_transactions", payload: { category: 15 } } })).toBe("Categorize");
    expect(insightActionLabel({ action: { type: "view_transactions", payload: { month: "2026-09" } } })).toBe("View transactions");
    expect(insightActionLabel({})).toBeNull();
  });
});
