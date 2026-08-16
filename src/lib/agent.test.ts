import { describe, it, expect } from "vitest";
import { aggregateSavingsRate } from "./agent";

describe("aggregateSavingsRate", () => {
  it("weights months by dollars, not equally", () => {
    // A month with almost no income has an extreme per-month ratio (-900%). Averaging the three
    // ratios gives -293%; the dollars actually netted +$100 on $10,100 of income.
    const months = [
      { income: 500_000, expenses: 450_000 },
      { income: 500_000, expenses: 450_000 },
      { income: 10_000, expenses: 100_000 },
    ];
    const meanOfRatios =
      months.reduce((s, m) => s + (m.income - m.expenses) / m.income, 0) / months.length;
    expect(Math.round(meanOfRatios * 100)).toBe(-293);
    expect(Math.round(aggregateSavingsRate(months)! * 100)).toBe(1);
  });

  it("matches the simple case where every month is the same size", () => {
    expect(aggregateSavingsRate([
      { income: 100_000, expenses: 75_000 },
      { income: 100_000, expenses: 75_000 },
    ])).toBeCloseTo(0.25, 10);
  });

  it("returns a negative rate when expenses genuinely exceed income", () => {
    expect(aggregateSavingsRate([{ income: 100_000, expenses: 120_000 }])).toBeCloseTo(-0.2, 10);
  });

  it("does not let a zero-income month drag the rate toward zero", () => {
    // The old code skipped zero-income months in the numerator but still divided by the full
    // month count, halving a genuine 25% rate.
    expect(aggregateSavingsRate([
      { income: 100_000, expenses: 75_000 },
      { income: 0, expenses: 0 },
    ])).toBeCloseTo(0.25, 10);
  });

  it("returns null when there is no income at all", () => {
    expect(aggregateSavingsRate([{ income: 0, expenses: 5_000 }])).toBeNull();
    expect(aggregateSavingsRate([])).toBeNull();
  });
});
