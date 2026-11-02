import { describe, it, expect } from "vitest";
import { aggregateSavingsRate, savingsRatePoints, runwayPoints, creditOwedCents, idleCashPaydown } from "./agent";

describe("Health Score rubric", () => {
  it("savings rate bands: 5/10/15/20% boundaries, null = unmeasured neutral", () => {
    expect([-0.5, 0, 0.0499, 0.05, 0.0999, 0.10, 0.15, 0.1999, 0.20, 0.9].map(savingsRatePoints))
      .toEqual([0, 0, 0, 10, 10, 20, 30, 30, 40, 40]);
    expect(savingsRatePoints(null)).toBe(20);
  });

  it("runway: no balance or no spending history is unmeasured; zero or overdrawn is the lowest band", () => {
    expect(runwayPoints(null, 100_000)).toEqual({ points: 10, measured: false });
    expect(runwayPoints(250_000, 0)).toEqual({ points: 10, measured: false });
    expect(runwayPoints(0, 100_000)).toEqual({ points: 2, measured: true });
    expect(runwayPoints(-1, 0)).toEqual({ points: 2, measured: true });
    expect(runwayPoints(600_000, 100_000)).toEqual({ points: 20, measured: true });
  });

  it("credit owed sums each card's negative balance and ignores cards in credit", () => {
    expect(creditOwedCents([-200_000, 60_000, null, -5_000])).toBe(205_000);
    expect(creditOwedCents([50_000])).toBe(0);
    expect(creditOwedCents([])).toBe(0);
  });
});

describe("idleCashPaydown", () => {
  // Card A owes $2,000 and charged $40 last month (2%/mo); card B owes $1,000 and charged $10 (1%/mo).
  const cards = [{ owedCents: 100_000, monthlyInterestCents: 1_000 }, { owedCents: 200_000, monthlyInterestCents: 4_000 }];

  it("pays the costliest card per dollar first and prices only the share retired", () => {
    // $2,500 spare: all of A ($40 x 12 = $480/yr) then half of B (0.5 x $10 x 12 = $60/yr).
    expect(idleCashPaydown(250_000, cards)).toEqual({ payCents: 250_000, annualInterestCents: 54_000 });
  });

  it("never pays more than is owed or more than is spare", () => {
    expect(idleCashPaydown(1_000_000, cards)).toEqual({ payCents: 300_000, annualInterestCents: 60_000 });
    expect(idleCashPaydown(0, cards)).toEqual({ payCents: 0, annualInterestCents: 0 });
    expect(idleCashPaydown(-50_000, cards)).toEqual({ payCents: 0, annualInterestCents: 0 });
  });

  it("ignores cards with nothing owed or no interest charged", () => {
    expect(idleCashPaydown(100_000, [{ owedCents: 0, monthlyInterestCents: 500 }, { owedCents: 50_000, monthlyInterestCents: 0 }]))
      .toEqual({ payCents: 0, annualInterestCents: 0 });
  });
});

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
