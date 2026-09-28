import { describe, it, expect } from "vitest";
import { accruedToday, averageDailyBalance, isInterestCharge, summarizeCostOfMoney } from "./costOfMoney";

describe("isInterestCharge", () => {
  it("matches interest and finance charge lines but not their reversals", () => {
    expect(isInterestCharge("INTEREST CHARGE ON PURCHASES")).toBe(true);
    expect(isInterestCharge("Finance Charge")).toBe(true);
    expect(isInterestCharge("INTEREST CHARGE REVERSAL")).toBe(false);
    expect(isInterestCharge("Interest free promo")).toBe(false);
    expect(isInterestCharge("GREEN MARKET")).toBe(false);
  });
});

describe("averageDailyBalance", () => {
  it("carries each account forward and starts from the balance known before the month", () => {
    const points = [
      { account_id: 1, date: "2026-07-28", balance_cents: 100_000 },
      { account_id: 1, date: "2026-08-11", balance_cents: 400_000 },
      { account_id: 2, date: "2026-08-21", balance_cents: 50_000 },
    ];
    // Account 1: 10 days at 1,000 then 21 days at 4,000; account 2: 11 days at 500.
    const expected = Math.round((10 * 100_000 + 21 * 400_000 + 11 * 50_000) / 31);
    expect(averageDailyBalance(points, "2026-08")).toBe(expected);
  });

  it("is zero with no balances on record", () => {
    expect(averageDailyBalance([], "2026-08")).toBe(0);
  });
});

describe("summarizeCostOfMoney", () => {
  const base = {
    month: "2026-08",
    cardInterest: [{ accountId: 10, cents: 4_200 }],
    bankInterestCents: 310,
    investmentIncomeCents: 2_150,
    debts: [
      { id: 10, name: "Visa", kind: "credit" as const, balanceCents: -180_000, rateBps: 2400 },
      { id: 11, name: "Rewards card", kind: "credit" as const, balanceCents: -95_000, rateBps: 2199 },
      { id: 20, name: "Car loan", kind: "loan" as const, balanceCents: -1_200_000, rateBps: 650 },
      { id: 21, name: "Student loan", kind: "loan" as const, balanceCents: -800_000, rateBps: null },
    ],
    avgCheckingCents: 620_000,
    latestCheckingCents: 700_000,
    reserveCents: 200_000,
    assumedYieldBps: 420,
  };

  it("nets measured card interest and estimated loan interest against what the money earned", () => {
    const s = summarizeCostOfMoney(base);
    expect(s.paidCardCents).toBe(4_200);
    expect(s.paidLoanCents).toBe(Math.round((1_200_000 * 0.065) / 12));
    expect(s.earnedCents).toBe(2_460);
    expect(s.netCents).toBe(2_460 - 4_200 - s.paidLoanCents);
    expect(s.netCents).toBeLessThan(0);
  });

  it("charges only cards that were actually charged interest, and names loans missing a rate", () => {
    const s = summarizeCostOfMoney(base);
    const visa = s.perAccount.find((a) => a.id === 10)!;
    const rewards = s.perAccount.find((a) => a.id === 11)!;
    const car = s.perAccount.find((a) => a.id === 20)!;
    expect(visa.basis).toBe("estimated");
    expect(visa.dailyCents).toBeCloseTo((180_000 * 0.24) / 365, 6);
    expect(rewards.basis).toBe("none");
    expect(rewards.dailyCents).toBe(0);
    expect(car.dailyCents).toBeCloseTo((1_200_000 * 0.065) / 365, 6);
    expect(s.missingRate).toEqual(["Student loan"]);
    expect(s.dailyCostCents).toBeCloseTo(visa.dailyCents + car.dailyCents, 6);
    expect(s.perAccount[0].id).toBe(20);
  });

  it("falls back to last month's measured interest when a charged card has no rate on file", () => {
    const s = summarizeCostOfMoney({ ...base, debts: [{ id: 10, name: "Visa", kind: "credit", balanceCents: -180_000, rateBps: null }] });
    const visa = s.perAccount[0];
    expect(visa.basis).toBe("measured");
    expect(visa.dailyCents).toBeCloseTo(4_200 / 31, 6);
  });

  it("treats only checking above the reserve as idle, at the assumed yield", () => {
    const s = summarizeCostOfMoney(base);
    expect(s.idleCents).toBe(420_000);
    expect(s.forgoneCents).toBe(Math.round((420_000 * 0.042) / 12));
    expect(s.dailyForgoneCents).toBeCloseTo((500_000 * 0.042) / 365, 6);
    const flush = summarizeCostOfMoney({ ...base, reserveCents: 1_000_000 });
    expect(flush.idleCents).toBe(0);
    expect(flush.forgoneCents).toBe(0);
  });

  it("accrues a daily figure by the fraction of the day elapsed", () => {
    expect(accruedToday(8_640, new Date(2026, 8, 10, 6, 0, 0))).toBeCloseTo(2_160, 6);
    expect(accruedToday(8_640, new Date(2026, 8, 10, 0, 0, 0))).toBe(0);
  });
});
