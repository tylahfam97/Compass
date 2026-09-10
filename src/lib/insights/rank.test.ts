import { describe, it, expect } from "vitest";
import { rankInsights, pickDashboardInsights } from "./rank";
import type { Insight, InsightType } from "../types";

const make = (type: InsightType, severity: Insight["severity"], impactCents = 0, extra: Partial<Insight> = {}): Insight =>
  ({ id: `${type}_${impactCents}_${Math.random()}`, type, title: type, description: "", severity, dismissKey: type, impactCents, ...extra });

describe("rankInsights", () => {
  it("bands by severity, then orders by money at stake", () => {
    const ranked = rankInsights([
      make("frequent_merchant", "info", 9100),
      make("no_spend_days", "success"),
      make("bills_this_week", "warning", 150000),
      make("budget_pace", "warning", 15300),
      make("top_merchants", "info", 40000),
    ]);
    // top_merchants is a status row, so it sinks below the finding in its band despite the larger figure.
    expect(ranked.map((i) => i.type)).toEqual(["bills_this_week", "budget_pace", "frequent_merchant", "top_merchants", "no_spend_days"]);
  });

  it("pins housekeeping to the top of its band, sinks status rows, and keeps budget_gap last", () => {
    const ranked = rankInsights([
      make("budget_gap", "info", 999999),
      make("top_merchants", "info", 40000),
      make("recurring_price_change", "info", 2400),
      make("stale_data", "info", 0),
    ]);
    expect(ranked.map((i) => i.type)).toEqual(["stale_data", "recurring_price_change", "top_merchants", "budget_gap"]);
  });

  it("trims a very long list without ever dropping a warning", () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => make("category_creep", "info", 1000 + i, { id: `c${i}` })),
      ...Array.from({ length: 5 }, (_, i) => make("scheduled_missing", "warning", 500, { id: `w${i}` })),
    ];
    const ranked = rankInsights(rows);
    expect(ranked.filter((i) => i.severity === "warning")).toHaveLength(4); // scheduled_missing is capped at 4
    expect(ranked).toHaveLength(24);
  });

  it("caps noisy types and keeps the first rows the engine produced", () => {
    const rows = Array.from({ length: 5 }, (_, i) => make("budget_pace", "warning", 1000 - i, { id: `bp${i}` }));
    const ranked = rankInsights(rows);
    expect(ranked).toHaveLength(3);
    expect(ranked.map((i) => i.id)).toEqual(["bp0", "bp1", "bp2"]);
  });

  it("breaks impact ties with the type priority table", () => {
    const ranked = rankInsights([make("category_creep", "info", 5000), make("recurring_price_change", "info", 5000)]);
    expect(ranked.map((i) => i.type)).toEqual(["recurring_price_change", "category_creep"]);
  });
});

describe("pickDashboardInsights", () => {
  it("takes one row per type and prefers rows with an action", () => {
    const action = { type: "open_plan" as const, payload: {} };
    const ranked = rankInsights([
      make("budget_pace", "warning", 20000, { id: "a" }),
      make("budget_pace", "warning", 10000, { id: "b" }),
      make("bills_this_week", "warning", 150000, { id: "c", action }),
      make("top_merchants", "info", 40000, { id: "d", action }),
      make("no_spend_days", "success", 0, { id: "e" }),
    ]);
    expect(pickDashboardInsights(ranked, 3).map((i) => i.id)).toEqual(["c", "d", "a"]);
  });
});
