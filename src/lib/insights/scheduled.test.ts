import { describe, it, expect } from "vitest";
import { findMissingScheduled, billsDueWithin, nextIncomeEvent } from "./scheduled";
import type { ForecastEvent, ForecastRule } from "../forecast";

const rent: ForecastRule = {
  id: 1, description: "Rent", amount_cents: -150000, source: "rule",
  cadence: "monthly", day_of_month: 1, day_of_week: null, start_date: "2026-01-01",
};
const pay: ForecastRule = {
  id: 2, description: "Paycheck", amount_cents: 300000, source: "rule",
  cadence: "biweekly", day_of_month: null, day_of_week: 4, start_date: "2026-01-02",
};

describe("findMissingScheduled", () => {
  it("reports a bill whose date passed with no matching transaction", () => {
    const out = findMissingScheduled([rent], [], "2026-09-10", "2026-09-09");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ expectedDate: "2026-09-01", kind: "bill" });
  });

  it("matches a loosely named bank descriptor near the expected date", () => {
    const txns = [{ date: "2026-09-02", description: "SUNSET APTS RENT PYMT", amount_cents: -150000 }];
    expect(findMissingScheduled([rent], txns, "2026-09-10", "2026-09-09")).toHaveLength(0);
  });

  it("stays quiet while the imported data has not reached the due date yet", () => {
    expect(findMissingScheduled([rent], [], "2026-09-10", "2026-08-30")).toHaveLength(0);
  });

  it("respects the grace period and the rule start date", () => {
    const august = [{ date: "2026-08-01", description: "Rent", amount_cents: -150000 }];
    // Sep 1 is only two days ago: still inside the grace period.
    expect(findMissingScheduled([rent], august, "2026-09-03", "2026-09-03")).toHaveLength(0);
    // Two days later the grace period has passed.
    expect(findMissingScheduled([rent], august, "2026-09-05", "2026-09-05").map((m) => m.expectedDate)).toEqual(["2026-09-01"]);
    const young = { ...rent, start_date: "2026-09-15" };
    expect(findMissingScheduled([young], [], "2026-09-10", "2026-09-10")).toHaveLength(0);
  });

  it("only lets a rule's own account satisfy it when the rule names one", () => {
    const txns = [{ date: "2026-09-01", description: "Rent", amount_cents: -150000, account_id: 2 }];
    expect(findMissingScheduled([{ ...rent, accountId: 1 }], txns, "2026-09-10", "2026-09-10")).toHaveLength(1);
    expect(findMissingScheduled([{ ...rent, accountId: 2 }], txns, "2026-09-10", "2026-09-10")).toHaveLength(0);
  });

  it("does not let one deposit satisfy two biweekly paychecks", () => {
    // Fridays Aug 14 and Aug 28 fall in the lookback window for Sep 10.
    const txns = [{ date: "2026-08-14", description: "PAYCHECK ACME CORP", amount_cents: 300000 }];
    const out = findMissingScheduled([pay], txns, "2026-09-10", "2026-09-10");
    expect(out.map((m) => m.expectedDate)).toEqual(["2026-08-28"]);
    expect(out[0].kind).toBe("income");
  });
});

describe("billsDueWithin and nextIncomeEvent", () => {
  const ev = (date: string, amountCents: number, description: string): ForecastEvent =>
    ({ key: `${description}-${date}`, date, amountCents, description, source: "rule", categoryName: null, categoryColor: null });
  const events = [ev("2026-09-11", -150000, "Rent"), ev("2026-09-14", 300000, "Paycheck"), ev("2026-09-20", -1599, "Netflix"), ev("2026-09-09", -5000, "Yesterday")];

  it("returns only bills inside the window, today included, sorted by date", () => {
    expect(billsDueWithin(events, "2026-09-10", 7).map((e) => e.description)).toEqual(["Rent"]);
    expect(billsDueWithin(events, "2026-09-10", 10).map((e) => e.description)).toEqual(["Rent", "Netflix"]);
  });

  it("finds the next deposit", () => {
    expect(nextIncomeEvent(events, "2026-09-10")?.date).toBe("2026-09-14");
    expect(nextIncomeEvent(events, "2026-09-15")).toBeNull();
  });
});
