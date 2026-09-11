import { describe, it, expect } from "vitest";
import { addDaysIso, cycleSpend, daysBetweenIso, detectPayCycle, summarizeWatch, type PayCycleTxn } from "./payCycle";

const today = "2026-09-10";

function deposit(date: string, description = "ACME CORP PAYROLL", amount_cents = 185_000) {
  return { date, description, amount_cents };
}

function spend(date: string, amount_cents: number, account_type = "checking", category_id: number | null = 13, description = "Green Market"): PayCycleTxn {
  return { date, amount_cents: -amount_cents, category_id, category_name: "Groceries", account_type, description };
}

describe("detectPayCycle", () => {
  it("uses the Plan schedule when it brackets today", () => {
    const d = detectPayCycle({ plannedPaydays: ["2026-08-13", "2026-08-27", "2026-09-10", "2026-09-24"], deposits: [], today: "2026-09-15" })!;
    expect(d).toMatchObject({ source: "planned", lastPayday: "2026-09-10", nextPayday: "2026-09-24", cadenceDays: 14 });
  });

  it("infers a biweekly rhythm from payroll deposits and projects the next payday", () => {
    const deposits = ["2026-06-19", "2026-07-03", "2026-07-17", "2026-07-31", "2026-08-14", "2026-08-28"].map((d) => deposit(d));
    deposits.push(deposit("2026-07-20", "Venmo from Sam", 60_000));
    const d = detectPayCycle({ plannedPaydays: [], deposits, today })!;
    expect(d.source).toBe("detected");
    expect(d.cadenceDays).toBe(14);
    expect(d.lastPayday).toBe("2026-08-28");
    expect(d.nextPayday).toBe("2026-09-11");
    expect(d.payer).toBe("ACME CORP PAYROLL");
    expect(d.depositCount).toBe(6);
  });

  it("tolerates a weekend shift but not an irregular payer, small deposits, or a payer gone quiet", () => {
    const shifted = ["2026-07-01", "2026-07-15", "2026-07-29", "2026-08-12", "2026-08-25"].map((d) => deposit(d));
    expect(detectPayCycle({ plannedPaydays: [], deposits: shifted, today })?.cadenceDays).toBe(14);
    const irregular = ["2026-06-01", "2026-06-20", "2026-07-25", "2026-08-30"].map((d) => deposit(d));
    expect(detectPayCycle({ plannedPaydays: [], deposits: irregular, today })).toBeNull();
    const small = ["2026-08-01", "2026-08-15", "2026-08-29"].map((d) => deposit(d, "SIDE GIG", 20_000));
    expect(detectPayCycle({ plannedPaydays: [], deposits: small, today })).toBeNull();
    const quiet = ["2026-05-01", "2026-05-15", "2026-05-29", "2026-06-12"].map((d) => deposit(d));
    expect(detectPayCycle({ plannedPaydays: [], deposits: quiet, today })).toBeNull();
  });
});

describe("cycleSpend", () => {
  it("accumulates everyday spending by day since payday and leaves bills out", () => {
    const bills = [{ description: "Rent", amount_cents: -150_000 }];
    const txns = [
      spend("2026-08-28", 4_000),
      spend("2026-08-30", 2_500, "credit"),
      { ...spend("2026-09-01", 150_000), description: "RENT PAYMENT" },
      { ...spend("2026-09-02", 3_000), category_id: 20 },
      spend("2026-09-05", 1_000),
      spend("2026-09-11", 9_999),
    ];
    const c = cycleSpend("2026-08-28", "2026-09-11", txns, bills, []);
    expect(c.days).toBe(14);
    expect(c.cumulative[0]).toBe(4_000);
    expect(c.cumulative[2]).toBe(6_500);
    expect(c.cumulative[4]).toBe(6_500);
    expect(c.cumulative[8]).toBe(7_500);
    expect(c.totalCents).toBe(7_500);
  });
});

describe("summarizeWatch", () => {
  it("compares today's pace with the usual curve and prices the days left", () => {
    const paydays = ["2026-07-17", "2026-07-31", "2026-08-14", "2026-08-28"];
    const detection = { paydays, lastPayday: "2026-08-28", nextPayday: "2026-09-11", cadenceDays: 14, source: "detected" as const };
    const txns: PayCycleTxn[] = [];
    // Three past cycles spending $70 a day evenly; the current cycle spends $100 a day.
    for (let c = 0; c < 3; c++) for (let d = 0; d < 14; d++) txns.push(spend(addDaysIso(paydays[c], d), 7_000));
    for (let d = 0; d <= daysBetweenIso("2026-08-28", today); d++) txns.push(spend(addDaysIso("2026-08-28", d), 10_000));
    const w = summarizeWatch({ detection, txns, bills: [], detected: [], today });
    expect(w.cycleDays).toBe(14);
    expect(w.dayIndex).toBe(13);
    expect(w.daysLeft).toBe(1);
    expect(w.past).toHaveLength(3);
    expect(w.typicalTotalCents).toBe(98_000);
    expect(w.usualByNowCents).toBe(98_000);
    expect(w.spentSoFarCents).toBe(140_000);
    expect(w.paceDeltaCents).toBe(42_000);
    expect(w.leftPerDayCents).toBe(0);
  });

  it("gives each remaining day its share of what is left of the usual total", () => {
    const paydays = ["2026-08-14", "2026-08-28"];
    const detection = { paydays, lastPayday: "2026-08-28", nextPayday: "2026-09-11", cadenceDays: 14, source: "detected" as const };
    const txns: PayCycleTxn[] = [];
    for (let d = 0; d < 14; d++) txns.push(spend(addDaysIso("2026-08-14", d), 5_000));
    txns.push(spend("2026-08-29", 20_000));
    const w = summarizeWatch({ detection, txns, bills: [], detected: [], today: "2026-09-04" });
    expect(w.dayIndex).toBe(7);
    expect(w.daysLeft).toBe(7);
    expect(w.spentSoFarCents).toBe(20_000);
    expect(w.usualByNowCents).toBe(40_000);
    expect(w.leftPerDayCents).toBe(Math.round((70_000 - 20_000) / 7));
  });

  it("spots a three-paycheck month on a biweekly rhythm", () => {
    const detection = { paydays: ["2026-09-04"], lastPayday: "2026-09-04", nextPayday: "2026-09-18", cadenceDays: 14, source: "detected" as const };
    const w = summarizeWatch({ detection, txns: [], bills: [], detected: [], today: "2026-09-10" });
    expect(w.monthPaydays).toBe(2);
    expect(w.threePaycheckMonth).toBe(false);
    const oct = summarizeWatch({ ...{ detection: { ...detection, paydays: ["2026-10-02"], lastPayday: "2026-10-02", nextPayday: "2026-10-16" } }, txns: [], bills: [], detected: [], today: "2026-10-05" });
    expect(oct.monthPaydays).toBe(3);
    expect(oct.threePaycheckMonth).toBe(true);
  });
});
