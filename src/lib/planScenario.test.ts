import { describe, expect, it, vi } from "vitest";
import { projectCashFlow } from "./forecast";
import { validateScenario, loadScenario, saveScenario } from "./planScenario";
import { clearProfileLocalState } from "./profileReset";

describe("cash-flow scenario", () => {
  it("migrates legacy controls once, isolates profiles and clears only the target", () => {
    const entries = new Map<string, string>([["compass_plan_extra", "12000"]]);
    const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value), removeItem: (key: string) => entries.delete(key) };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);
    try {
      expect(loadScenario(1).extra).toBe(12000);
      expect(loadScenario(2).extra).toBe(0);
      saveScenario(2, { ...loadScenario(2), extra: 4000 });
      expect(loadScenario(1).extra).toBe(12000);
      clearProfileLocalState(1);
      expect(loadScenario(1).extra).toBe(0);
      expect(loadScenario(2).extra).toBe(4000);
    } finally { vi.unstubAllGlobals(); }
  });
  it("keeps controls usable when storage is unavailable", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    try { expect(() => saveScenario(1, loadScenario(1))).not.toThrow(); } finally { vi.unstubAllGlobals(); }
  });
  it.each([31, 95])("distributes exact cents across %s days", (days) => {
    const result = projectCashFlow({ startingBalanceCents: 100000, startDate: "2026-09-01", days, events: [], extraSpendCents: 10001 });
    expect(result.assumedSpendCents).toBe(10001);
    expect(result.endingBalanceCents).toBe(89999);
  });
  it("applies a hypothetical purchase only on and after its date", () => {
    const input = { startingBalanceCents: 100000, startDate: "2026-09-01", days: 3, events: [] };
    const current = projectCashFlow(input);
    const changed = projectCashFlow({ ...input, purchase: { date: "2026-09-02", amountCents: 25000 } });
    expect(changed.days.map((day) => day.balanceCents)).toEqual([100000, 75000, 75000]);
    expect(current.days.map((day) => day.balanceCents)).toEqual([100000, 100000, 100000]);
    expect(changed.totalBillsCents).toBe(0);
    expect(changed.days[1].events).toEqual([]);
    expect(changed.assumedSpendCents).toBe(25000);
    expect(projectCashFlow({ ...input, purchase: { date: "2026-10-01", amountCents: 25000 } }).endingBalanceCents).toBe(100000);
    expect(projectCashFlow({ ...input, bufferCents: 20000 }).days).toEqual(current.days);
  });
  it("rejects malformed persisted values", () => {
    const result = validateScenario({ extra: -1, buffer: NaN, purchase: { date: "2026-02-31", amountCents: 2.5 } });
    expect(result.extra).toBe(0);
    expect(result.buffer).toBe(0);
    expect(result.purchase).toEqual({ date: "", amountCents: 0 });
  });
});