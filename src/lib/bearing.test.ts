import { describe, it, expect } from "vitest";
import { computeBearing, monthBoundsIso } from "./bearing";

const sep10 = new Date(2026, 8, 10);

describe("computeBearing", () => {
  it("renders nothing to scale when there is no income", () => {
    const b = computeBearing({ incomeCents: 0, spentCents: 44_000, month: "2026-09", today: sep10 });
    expect(b.incomeKnown).toBe(false);
    expect(b.spentPct).toBe(0);
    expect(b.duePct).toBe(0);
    expect(b.freePct).toBe(0);
    expect(b.freeCents).toBe(0);
    expect(b.overCents).toBe(44_000);
    for (const v of Object.values(b)) expect(Number.isNaN(v as number)).toBe(false);
  });

  it("splits spent, due and free as shares of income", () => {
    const b = computeBearing({ incomeCents: 700_000, spentCents: 441_990, dueCents: 118_000, month: "2026-09", today: sep10 });
    expect(b.spentPct).toBeCloseTo(63.1, 1);
    expect(b.duePct).toBeCloseTo(16.9, 1);
    expect(b.freePct).toBeCloseTo(20, 0);
    expect(b.freeCents).toBe(140_010);
    expect(b.overCents).toBe(0);
  });

  it("clamps due before spent when the schedule over-commits", () => {
    const b = computeBearing({ incomeCents: 100_000, spentCents: 80_000, dueCents: 50_000, month: "2026-09", today: sep10 });
    expect(b.spentPct).toBe(80);
    expect(b.duePct).toBe(20);
    expect(b.freePct).toBe(0);
    expect(b.overCents).toBe(30_000);
  });

  it("caps an over-spent month at the full track", () => {
    const b = computeBearing({ incomeCents: 100_000, spentCents: 150_000, month: "2026-09", today: sep10 });
    expect(b.spentPct).toBe(100);
    expect(b.duePct).toBe(0);
    expect(b.overCents).toBe(50_000);
  });

  it("knows past, current and future months", () => {
    expect(computeBearing({ incomeCents: 1, spentCents: 0, month: "2026-08", today: sep10 }).monthState).toBe("past");
    expect(computeBearing({ incomeCents: 1, spentCents: 0, month: "2026-09", today: sep10 }).monthState).toBe("current");
    expect(computeBearing({ incomeCents: 1, spentCents: 0, month: "2026-10", today: sep10 }).monthState).toBe("future");
  });

  it("counts days left including today, and elapsed share before today", () => {
    const b = computeBearing({ incomeCents: 1, spentCents: 0, month: "2026-09", today: sep10 });
    expect(b.daysInMonth).toBe(30);
    expect(b.daysLeft).toBe(21);
    expect(b.elapsedPct).toBe(30);
    const first = computeBearing({ incomeCents: 1, spentCents: 0, month: "2026-10", today: new Date(2026, 9, 1) });
    expect(first.daysInMonth).toBe(31);
    expect(first.daysLeft).toBe(31);
    expect(first.elapsedPct).toBe(0);
    const last = computeBearing({ incomeCents: 1, spentCents: 0, month: "2026-10", today: new Date(2026, 9, 31) });
    expect(last.daysLeft).toBe(1);
    expect(computeBearing({ incomeCents: 1, spentCents: 0, month: "2026-08", today: sep10 }).daysLeft).toBe(0);
    expect(computeBearing({ incomeCents: 1, spentCents: 0, month: "2026-11", today: sep10 }).daysLeft).toBe(30);
  });
});

describe("monthBoundsIso", () => {
  it("handles a leap-year February", () => {
    expect(monthBoundsIso("2028-02")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
  });
  it("returns the input for a malformed key", () => {
    expect(monthBoundsIso("nope")).toEqual({ start: "nope", end: "nope" });
  });
});
