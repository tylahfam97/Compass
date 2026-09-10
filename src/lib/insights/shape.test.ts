import { describe, it, expect } from "vitest";
import { summarizeFixedFlexible, shapeMonth, countNoSpendDays, paydayBurstShare, monthsWithIncome, type ShapeTxn } from "./shape";

const t = (date: string, amount_cents: number, description: string, extra: Partial<ShapeTxn> = {}): ShapeTxn =>
  ({ date, amount_cents, description, account_type: "checking", category_id: null, ...extra });

const rent = { description: "Rent", amount_cents: -140000 };
const netflix = { description: "Netflix", amount_cents: -1599 };

const august: ShapeTxn[] = [
  t("2026-08-01", 185000, "Acme Corp Payroll"),
  t("2026-08-15", 185000, "Acme Corp Payroll"),
  t("2026-08-03", -140000, "SUNSET APARTMENTS RENT"),
  t("2026-08-05", -1599, "Netflix"),
  t("2026-08-08", -6500, "Trader Joe's"),
  t("2026-08-16", -4200, "Shell Gas Station"),
  t("2026-08-16", -12000, "Best Buy", { account_type: "credit" }),
  t("2026-08-20", -32000, "Credit Card Payment", { category_id: 20 }),
  t("2026-08-20", 32000, "Payment - Thank You", { account_type: "credit", category_id: 20 }),
  t("2026-08-22", 4000, "Refund", { account_type: "credit" }),
];

describe("shapeMonth", () => {
  it("splits a month into income, bills, recurring, flexible and left", () => {
    const s = shapeMonth(august, "2026-08", [rent], [netflix]);
    expect(s.incomeCents).toBe(370000);
    expect(s.billsCents).toBe(140000);
    expect(s.recurringCents).toBe(1599);
    expect(s.flexibleCents).toBe(6500 + 4200 + 12000);
    expect(s.leftCents).toBe(370000 - 140000 - 1599 - 22700);
    expect(s.expenseCount).toBe(5);
  });

  it("ignores transfers, excluded rows and credits on credit accounts", () => {
    const s = shapeMonth(august, "2026-08", [], []);
    expect(s.incomeCents).toBe(370000);
    expect(s.billsCents + s.recurringCents).toBe(0);
    // Unmatched rent is a $1,000+ single purchase, so it lands in one-offs, not flexible.
    expect(s.oneOffCents).toBe(140000);
    expect(s.flexibleCents).toBe(1599 + 6500 + 4200 + 12000);
  });

  it("treats investment-like categories as saving, not flexible spending", () => {
    const txns = [...august, t("2026-08-18", -50000, "Coinbase", { category_name: "Crypto" })];
    const s = shapeMonth(txns, "2026-08", [rent], [netflix]);
    expect(s.investedCents).toBe(50000);
    expect(s.flexibleCents).toBe(6500 + 4200 + 12000);
  });
});

describe("summarizeFixedFlexible", () => {
  it("averages over the supplied months and reports shares of income", () => {
    const july = august.map((x) => ({ ...x, date: x.date.replace("2026-08", "2026-07") }));
    const s = summarizeFixedFlexible([...july, ...august], [rent], [netflix], ["2026-08", "2026-07"])!;
    expect(s.months).toHaveLength(2);
    expect(s.avgIncomeCents).toBe(370000);
    expect(s.avgBillsCents).toBe(140000);
    expect(s.committedShare).toBeCloseTo((140000 + 1599) / 370000, 6);
    expect(s.leftShare).toBeCloseTo(s.avgLeftCents / 370000, 6);
  });

  it("returns null shares without income and null with no months", () => {
    const s = summarizeFixedFlexible(august.filter((x) => x.amount_cents < 0), [rent], [], ["2026-08"])!;
    expect(s.avgIncomeCents).toBe(0);
    expect(s.committedShare).toBeNull();
    expect(summarizeFixedFlexible(august, [], [], [])).toBeNull();
  });

  it("uses the planned schedule as the basis when provided, actual deposits otherwise", () => {
    const s = summarizeFixedFlexible(august, [rent], [netflix], ["2026-08"], { incomeCents: 400000, billsCents: 150000 })!;
    expect(s.incomeBasis).toBe("planned");
    expect(s.avgIncomeCents).toBe(400000);
    expect(s.avgActualIncomeCents).toBe(370000);
    expect(s.avgBillsCents).toBe(150000);
    expect(s.avgLeftCents).toBe(400000 - 150000 - 1599 - 22700);
    expect(s.committedShare).toBeCloseTo((150000 + 1599) / 400000, 6);
    expect(s.flexibleTopCategories[0]).toEqual({ name: "Uncategorized", cents: 22700 });
    const actual = summarizeFixedFlexible(august, [rent], [netflix], ["2026-08"], { incomeCents: 0, billsCents: 0 })!;
    expect(actual.incomeBasis).toBe("actual");
    expect(actual.avgIncomeCents).toBe(370000);
    expect(actual.avgBillsCents).toBe(140000);
  });

  it("lists only candidate months that had income, newest first", () => {
    expect(monthsWithIncome(august, ["2026-09", "2026-08", "2026-07"])).toEqual(["2026-08"]);
  });
});

describe("countNoSpendDays", () => {
  it("counts days without flexible spending; bills and recurring charges do not break the run", () => {
    const r = countNoSpendDays(august, "2026-08", [rent], [netflix]);
    // Flexible spending on Aug 8 and Aug 16 only.
    expect(r.noSpendDays).toBe(31 - 2);
    expect(r.expenseCount).toBe(5);
    expect(r.daysInMonth).toBe(31);
  });
});

describe("paydayBurstShare", () => {
  it("measures flexible spending in the days after each deposit", () => {
    const rows = [
      t("2026-08-01", 185000, "Payroll"), t("2026-08-15", 185000, "Payroll"),
      t("2026-08-02", -30000, "Target"), t("2026-08-03", -10000, "Amazon"),
      t("2026-08-25", -10000, "Groceries"),
    ];
    const r = paydayBurstShare(rows, "2026-08", [], [])!;
    expect(r.share).toBeCloseTo(40000 / 50000, 6);
    expect(r.deposits).toBe(2);
    expect(r.coveredShare).toBeCloseTo(8 / 31, 6);
  });

  it("returns null without a qualifying deposit or without flexible spending", () => {
    expect(paydayBurstShare([t("2026-08-02", -30000, "Target")], "2026-08", [], [])).toBeNull();
    expect(paydayBurstShare([t("2026-08-01", 185000, "Payroll")], "2026-08", [], [])).toBeNull();
  });
});
