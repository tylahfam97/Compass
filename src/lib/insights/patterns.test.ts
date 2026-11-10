import { describe, expect, it } from "vitest";
import { paydayCushion, smallPurchases, CUSHION_MAX_DAYS } from "./patterns";
import type { ShapeTxn } from "./shape";

describe("paydayCushion", () => {
  const base = { balanceCents: 60000, daysToIncome: 8, billsDueCents: 40000, dailySpendCents: 4000 };

  it("reports what is free per day once the scheduled bills are paid", () => {
    // $600 - $400 of bills = $200 over 8 days = $25 a day against a usual $40.
    expect(paydayCushion(base)).toEqual({ days: 8, freeCents: 20000, perDayCents: 2500, gapCents: 12000 });
  });

  it("stays quiet when there is room at the usual pace", () => {
    expect(paydayCushion({ ...base, balanceCents: 80000 })).toBeNull(); // $50 a day
    expect(paydayCushion({ ...base, balanceCents: 64000 })).toBeNull(); // $30 a day, exactly 75%
  });

  it("leaves a real shortfall to the shortfall warning", () => {
    expect(paydayCushion({ ...base, balanceCents: 30000 })).toBeNull();
  });

  it("reports a zero cushion as zero, not as missing", () => {
    expect(paydayCushion({ ...base, balanceCents: 40000 })).toMatchObject({ freeCents: 0, perDayCents: 0, gapCents: 32000 });
  });

  it("needs a known pace and an income date inside the window", () => {
    expect(paydayCushion({ ...base, dailySpendCents: 0 })).toBeNull();
    expect(paydayCushion({ ...base, daysToIncome: 1 })).toBeNull();
    expect(paydayCushion({ ...base, daysToIncome: CUSHION_MAX_DAYS + 1 })).toBeNull();
  });
});

describe("smallPurchases", () => {
  const txn = (date: string, amount_cents: number, description: string, extra: Partial<ShapeTxn> = {}): ShapeTxn =>
    ({ date, amount_cents, description, account_type: "checking", category_id: 6, ...extra });
  const netflix = [{ description: "NETFLIX.COM", amount_cents: -799 }];

  const rows: ShapeTxn[] = [
    txn("2026-10-02", -450, "CORNER CAFE"),
    txn("2026-10-09", -475, "CORNER CAFE"),
    txn("2026-10-11", -899, "VENDING CO"),
    txn("2026-10-12", -1000, "LUNCH SPOT"),          // exactly $10: not small
    txn("2026-10-15", -8176, "GREEN MARKET"),
    txn("2026-10-16", -799, "NETFLIX.COM"),          // recurring: a commitment, not a habit
    txn("2026-10-18", -500, "SAVINGS XFER", { category_id: 20 }), // transfer: never spending
    txn("2026-10-20", 600, "CORNER CAFE REFUND", { account_type: "credit" }),
    txn("2026-11-01", -300, "CORNER CAFE"),          // another month
  ];

  it("counts flexible purchases under $10 against all flexible spending in the month", () => {
    const result = smallPurchases(rows, "2026-10", [], netflix)!;
    expect(result.count).toBe(3);
    expect(result.totalCents).toBe(1824);
    expect(result.flexibleCents).toBe(1824 + 1000 + 8176);
    expect(result.share).toBeCloseTo(1824 / 11000, 6);
    expect(result.top).toEqual([
      { label: "CORNER CAFE", cents: 925, count: 2 },
      { label: "VENDING CO", cents: 899, count: 1 },
    ]);
  });

  it("returns null when the month has no flexible spending to compare against", () => {
    expect(smallPurchases(rows, "2026-09", [], netflix)).toBeNull();
    expect(smallPurchases([txn("2026-10-16", -799, "NETFLIX.COM")], "2026-10", [], netflix)).toBeNull();
  });

  it("returns a measured zero when the month had spending but nothing small", () => {
    expect(smallPurchases([txn("2026-10-15", -8176, "GREEN MARKET")], "2026-10", [], [])).toMatchObject({ count: 0, totalCents: 0, share: 0 });
  });
});
