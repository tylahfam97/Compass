import { describe, it, expect, beforeEach } from "vitest";
import { detectNewMilestones } from "./milestones";

// vitest runs in the `node` environment (see vitest.config.ts), which has no localStorage.
// milestones.ts is deliberately localStorage-backed rather than DB-backed, so stub it.
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
});

describe("detectNewMilestones - one-shot behavior", () => {
  it("fires a milestone once and never again for the same state", () => {
    const first = detectNewMilestones(1, { goals: [{ id: 7, name: "Emergency fund", pct: 100 }] });
    expect(first).toHaveLength(1);
    expect(first[0].key).toBe("goal_complete_7");

    const second = detectNewMilestones(1, { goals: [{ id: 7, name: "Emergency fund", pct: 100 }] });
    expect(second).toHaveLength(0);
  });

  it("tracks milestones separately per profile", () => {
    detectNewMilestones(1, { goals: [{ id: 7, name: "Emergency fund", pct: 100 }] });
    const other = detectNewMilestones(2, { goals: [{ id: 7, name: "Emergency fund", pct: 100 }] });
    expect(other).toHaveLength(1);
  });
});

describe("detectNewMilestones - net worth thresholds", () => {
  it("fires only the highest threshold crossed, not every one below it", () => {
    const events = detectNewMilestones(1, { netWorthCents: 12_000_000 }); // $120K
    const netWorthEvents = events.filter((e) => e.key.startsWith("networth_"));
    expect(netWorthEvents.map((e) => e.key)).toEqual(["networth_positive", "networth_10000000"]);
  });

  it("does not re-fire a lower threshold after a higher one was already celebrated", () => {
    detectNewMilestones(1, { netWorthCents: 12_000_000 });
    expect(detectNewMilestones(1, { netWorthCents: 5_000_000 })).toHaveLength(0);
  });

  it("celebrates the next threshold up once it is crossed", () => {
    detectNewMilestones(1, { netWorthCents: 1_000_000 }); // $10K
    const next = detectNewMilestones(1, { netWorthCents: 2_500_000 }); // $25K
    expect(next.map((e) => e.key)).toEqual(["networth_2500000"]);
  });

  it("stays quiet for a negative net worth", () => {
    expect(detectNewMilestones(1, { netWorthCents: -500_000 })).toHaveLength(0);
  });

  it("uses the major tier only at six figures and up", () => {
    const tenK = detectNewMilestones(1, { netWorthCents: 1_000_000 });
    expect(tenK[tenK.length - 1].tier).toBe("standard");
    const hundredK = detectNewMilestones(2, { netWorthCents: 10_000_000 });
    expect(hundredK[hundredK.length - 1].tier).toBe("major");
  });
});

describe("detectNewMilestones - debts", () => {
  it("celebrates a paid-off debt instead of its partial-progress threshold", () => {
    const events = detectNewMilestones(1, {
      debts: [{ id: 3, name: "Visa", balanceCents: 0, firstKnownBalanceCents: -200_000 }],
    });
    expect(events.map((e) => e.key)).toEqual(["debt_paid_3"]);
  });

  it("fires the highest paydown threshold crossed, not each one in turn", () => {
    const events = detectNewMilestones(1, {
      debts: [{ id: 3, name: "Visa", balanceCents: -40_000, firstKnownBalanceCents: -200_000 }],
    });
    expect(events.map((e) => e.key)).toEqual(["debt_progress_75_3"]);
  });

  it("skips debts with no known starting balance to measure against", () => {
    const events = detectNewMilestones(1, {
      debts: [{ id: 3, name: "Visa", balanceCents: -40_000, firstKnownBalanceCents: null }],
    });
    expect(events).toHaveLength(0);
  });
});

describe("detectNewMilestones - budgets held", () => {
  const budget = (id: number, name: string, spentCents: number, limitCents: number) => ({
    id, name, month: "2026-07", monthLabel: "Jul '26", spentCents, limitCents,
  });

  it("collapses multiple held budgets into a single event", () => {
    const events = detectNewMilestones(1, {
      budgets: [budget(1, "Groceries", 30_000, 40_000), budget(2, "Dining", 10_000, 15_000)],
    });
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("2 budgets held");
  });

  it("ignores budgets that were overspent", () => {
    const events = detectNewMilestones(1, { budgets: [budget(1, "Groceries", 50_000, 40_000)] });
    expect(events).toHaveLength(0);
  });

  it("counts spending exactly at the limit as held", () => {
    const events = detectNewMilestones(1, { budgets: [budget(1, "Groceries", 40_000, 40_000)] });
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("Budget held");
  });

  it("celebrates each month separately", () => {
    detectNewMilestones(1, { budgets: [budget(1, "Groceries", 30_000, 40_000)] });
    const august = detectNewMilestones(1, {
      budgets: [{ ...budget(1, "Groceries", 30_000, 40_000), month: "2026-08", monthLabel: "Aug '26" }],
    });
    expect(august).toHaveLength(1);
  });
});

describe("detectNewMilestones - health grade", () => {
  it("records a baseline on first sight without celebrating", () => {
    expect(detectNewMilestones(1, { healthGrade: "C" })).toHaveLength(0);
  });

  it("celebrates an improvement over the recorded grade", () => {
    detectNewMilestones(1, { healthGrade: "C" });
    const events = detectNewMilestones(1, { healthGrade: "B" });
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe("Grade up: B");
  });

  it("stays quiet when the grade holds steady or drops", () => {
    detectNewMilestones(1, { healthGrade: "B" });
    expect(detectNewMilestones(1, { healthGrade: "B" })).toHaveLength(0);
    expect(detectNewMilestones(1, { healthGrade: "C" })).toHaveLength(0);
  });

  it("re-celebrates a grade that was lost and then re-earned", () => {
    detectNewMilestones(1, { healthGrade: "B" });
    detectNewMilestones(1, { healthGrade: "C" });
    expect(detectNewMilestones(1, { healthGrade: "B" })).toHaveLength(1);
  });
});
