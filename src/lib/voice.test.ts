import { describe, it, expect } from "vitest";
import { classifyTrend, pickVariantIndex } from "./voice";

describe("classifyTrend", () => {
  it("treats a null previous value as flat (no history to compare against)", () => {
    expect(classifyTrend(100, null, true)).toBe("flat");
  });

  it("classifies a rise as improving when higher is better", () => {
    expect(classifyTrend(120, 100, true)).toBe("improving");
  });

  it("classifies a rise as worsening when lower is better (e.g. debt balance)", () => {
    expect(classifyTrend(120, 100, false)).toBe("worsening");
  });

  it("treats a small change within tolerance as flat", () => {
    expect(classifyTrend(100.2, 100, true)).toBe("flat");
  });

  it("classifies a large drop as worsening when higher is better", () => {
    expect(classifyTrend(50, 100, true)).toBe("worsening");
  });
});

describe("pickVariantIndex", () => {
  it("is deterministic for the same seed", () => {
    const a = pickVariantIndex("profile:insight:2026-07", 3);
    const b = pickVariantIndex("profile:insight:2026-07", 3);
    expect(a).toBe(b);
  });

  it("always returns an index within [0, count)", () => {
    for (const seed of ["a", "abc", "a-longer-seed-string", ""]) {
      const idx = pickVariantIndex(seed, 4);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(4);
    }
  });

  it("can vary across different seeds (not a constant)", () => {
    const seeds = Array.from({ length: 20 }, (_, i) => `seed-${i}`);
    const results = new Set(seeds.map((s) => pickVariantIndex(s, 5)));
    expect(results.size).toBeGreaterThan(1);
  });
});
