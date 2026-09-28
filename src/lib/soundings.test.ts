import { describe, it, expect } from "vitest";
import {
  addMonths, buildSoundingHistory, describeSounding, lastDayOfMonth, leastSquaresSlope,
  monthCutoffs, soundings, type BalanceObservation, type SoundingPoint,
} from "./soundings";

function point(month: string, net: number, parts: Partial<SoundingPoint> = {}): SoundingPoint {
  return { month, netWorthCents: net, liquidCents: parts.liquidCents ?? 100_000, investmentCents: parts.investmentCents ?? 0, debtCents: parts.debtCents ?? 0, loanDebtCents: parts.loanDebtCents ?? 0 };
}

function empty(month: string): SoundingPoint {
  return { month, netWorthCents: 0, liquidCents: 0, investmentCents: 0, debtCents: 0, loanDebtCents: 0 };
}

function line(startMonth: string, startNet: number, stepCents: number, n: number): SoundingPoint[] {
  return Array.from({ length: n }, (_, i) => point(addMonths(startMonth, i), startNet + stepCents * i));
}

describe("addMonths", () => {
  it("wraps across year ends in both directions", () => {
    expect(addMonths("2026-11", 3)).toBe("2027-02");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-09", 24)).toBe("2028-09");
  });
});

describe("leastSquaresSlope", () => {
  it("recovers the step of a straight line and zero for a flat one", () => {
    expect(leastSquaresSlope([10, 20, 30, 40])).toBe(10);
    expect(leastSquaresSlope([5, 5, 5])).toBe(0);
    expect(leastSquaresSlope([7])).toBe(0);
  });
});

describe("lastDayOfMonth", () => {
  it("knows month lengths and leap years", () => {
    expect(lastDayOfMonth("2026-01")).toBe("2026-01-31");
    expect(lastDayOfMonth("2026-04")).toBe("2026-04-30");
    expect(lastDayOfMonth("2026-02")).toBe("2026-02-28");
    expect(lastDayOfMonth("2028-02")).toBe("2028-02-29");
    expect(lastDayOfMonth("2100-02")).toBe("2100-02-28");
    expect(lastDayOfMonth("2000-02")).toBe("2000-02-29");
  });
});

describe("monthCutoffs", () => {
  it("ends each past month on its last day and the current month on today", () => {
    expect(monthCutoffs("2026-09-11", 3)).toEqual([
      { month: "2026-07", cutoff: "2026-07-31" },
      { month: "2026-08", cutoff: "2026-08-31" },
      { month: "2026-09", cutoff: "2026-09-11" },
    ]);
  });
});

describe("buildSoundingHistory", () => {
  const obs = (accountId: number, date: string, valueCents: number, kind: BalanceObservation["kind"]): BalanceObservation =>
    ({ accountId, date, valueCents, kind });

  it("carries each account's latest balance forward and sums by kind", () => {
    const history = buildSoundingHistory(
      [
        obs(1, "2026-07-05", 500_000, "checking"),
        obs(2, "2026-07-06", -200_000, "credit"),
        obs(1, "2026-08-20", 610_000, "checking"),
        obs(3, "2026-08-31", 900_000, "investment"),
        obs(4, "2026-09-02", -1_500_000, "loan"),
      ],
      monthCutoffs("2026-09-11", 3)
    );
    // July: only the checking and card readings exist yet.
    expect(history[0]).toEqual({ month: "2026-07", liquidCents: 500_000, investmentCents: 0, debtCents: -200_000, loanDebtCents: 0, netWorthCents: 300_000 });
    // August: checking moves, investments appear, the card carries forward unchanged.
    expect(history[1]).toEqual({ month: "2026-08", liquidCents: 610_000, investmentCents: 900_000, debtCents: -200_000, loanDebtCents: 0, netWorthCents: 1_310_000 });
    // September: the loan lands and drags net worth under.
    expect(history[2].loanDebtCents).toBe(-1_500_000);
    expect(history[2].netWorthCents).toBe(-190_000);
  });

  it("ignores balances recorded after the newest cutoff", () => {
    const history = buildSoundingHistory(
      [obs(1, "2026-09-10", 100_000, "checking"), obs(1, "2026-09-30", 999_000, "checking")],
      monthCutoffs("2026-09-11", 1)
    );
    expect(history[0].liquidCents).toBe(100_000);
  });

  it("takes the later row when two balances share a date", () => {
    const history = buildSoundingHistory(
      [obs(1, "2026-09-04", 100_000, "checking"), obs(1, "2026-09-04", 250_000, "checking")],
      monthCutoffs("2026-09-11", 1)
    );
    expect(history[0].liquidCents).toBe(250_000);
  });

  it("reports empty months before any account has a balance, which soundings then trims", () => {
    const months = monthCutoffs("2026-09-11", 3);
    const history = buildSoundingHistory([obs(1, "2026-09-01", 100_000, "checking")], months);
    expect(history.map((p) => p.netWorthCents)).toEqual([0, 0, 100_000]);
    expect(soundings(history).points).toHaveLength(1);
  });
});

describe("soundings", () => {
  it("drops the empty months before the first recorded balance", () => {
    const s = soundings([empty("2025-01"), empty("2025-02"), ...line("2025-03", -500_000, 50_000, 6)]);
    expect(s.points[0].month).toBe("2025-03");
    expect(s.latest?.month).toBe("2025-08");
  });

  it("returns an unknown crossing and no latest when nothing is recorded", () => {
    const s = soundings([empty("2026-01"), empty("2026-02")]);
    expect(s.latest).toBeNull();
    expect(s.crossing).toEqual({ kind: "unknown" });
    expect(describeSounding(s)).toBe("Import a statement to take the first sounding.");
  });

  it("measures the pace over the trailing window and projects the month it clears zero", () => {
    // Down 1,000,000 cents, climbing 112,000 a month: 9 months to the waterline.
    const s = soundings(line("2026-01", -1_896_000, 112_000, 9));
    expect(s.latest?.netWorthCents).toBe(-1_000_000);
    expect(s.paceMonths).toBe(6);
    expect(s.paceCentsPerMonth).toBe(112_000);
    expect(s.crossing).toEqual({ kind: "projected", month: "2027-06", monthsAway: 9 });
    expect(s.projection).toHaveLength(9);
    expect(s.projection[0]).toEqual({ month: "2026-10", netWorthCents: -888_000 });
    expect(s.projection[8].netWorthCents).toBe(0);
    expect(describeSounding(s)).toBe("At this pace, up $1,120 a month over the last 6 months, net worth clears zero around June 2027.");
  });

  it("reports month and year changes when the history is long enough", () => {
    const s = soundings(line("2025-01", 0, 10_000, 14));
    expect(s.changeMonthCents).toBe(10_000);
    expect(s.changeYearCents).toBe(120_000);
    expect(soundings(line("2026-01", 0, 10_000, 5)).changeYearCents).toBeNull();
  });

  it("finds the month a positive net worth last came above the waterline", () => {
    const s = soundings([...line("2026-01", -300_000, 100_000, 3), ...line("2026-04", 50_000, 100_000, 3)]);
    expect(s.crossing).toEqual({ kind: "above", sinceMonth: "2026-04" });
    expect(describeSounding(s)).toBe("Above water since April 2026, up $1,129 a month over the last 6 months.");
  });

  it("treats a history that was never negative as above water throughout", () => {
    const s = soundings(line("2026-01", 100_000, 5_000, 4));
    expect(s.crossing).toEqual({ kind: "above", sinceMonth: null });
    expect(describeSounding(s)).toBe("Above water for the whole recorded history, up $50 a month over the last 4 months.");
  });

  it("calls a falling or flat negative net worth sinking or holding, never projected", () => {
    const falling = soundings(line("2026-01", -100_000, -20_000, 6));
    expect(falling.crossing).toEqual({ kind: "sinking" });
    expect(falling.projection).toEqual([]);
    expect(describeSounding(falling)).toBe("Net worth is down $200 a month over the last 6 months. It is not on course to clear zero.");

    const flat = soundings(line("2026-01", -100_000, 0, 6));
    expect(flat.paceCentsPerMonth).toBe(0);
    expect(flat.crossing).toEqual({ kind: "sinking" });
    expect(describeSounding(flat)).toBe("Holding steady over the last 6 months, not yet climbing toward the waterline.");
  });

  it("marks a crossing more than ten years out as distant", () => {
    const s = soundings(line("2026-01", -10_000_000, 5_000, 6));
    expect(s.crossing.kind).toBe("distant");
    expect(describeSounding(s)).toMatch(/clearing zero is more than \d+ years out\.$/);
  });

  it("needs three soundings before it will name a pace", () => {
    const s = soundings(line("2026-01", -100_000, 10_000, 2));
    expect(s.paceCentsPerMonth).toBeNull();
    expect(s.crossing).toEqual({ kind: "unknown" });
    expect(describeSounding(s)).toBe("A few more months of statements will show the pace.");
  });

  it("keeps every sentence free of dashes, arrows and exclamation marks", () => {
    const cases = [
      soundings(line("2026-01", -1_896_000, 112_000, 9)),
      soundings(line("2026-01", 100_000, 5_000, 4)),
      soundings(line("2026-01", -100_000, -20_000, 6)),
      soundings(line("2026-01", -10_000_000, 5_000, 6)),
      soundings([]),
    ];
    for (const c of cases) expect(describeSounding(c)).not.toMatch(/[—–→·!]/);
  });
});
