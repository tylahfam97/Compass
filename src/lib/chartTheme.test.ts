import { describe, it, expect } from "vitest";
import { harmonizeColor, hexToOklch, CATEGORY_HUES } from "./chartTheme";

const HEX = /^#[0-9a-f]{6}$/;

function hueDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

describe("harmonizeColor", () => {
  const seeds = ["#22c55e", "#3b82f6", "#f97316", "#8b5cf6", "#ec4899", "#eab308", "#06b6d4", "#0ea5e9", "#f43f5e", "#14b8a6"];

  it("keeps the hue of every seeded category color within three degrees", () => {
    for (const seed of seeds) {
      for (const mode of ["dark", "light"] as const) {
        const out = harmonizeColor(seed, mode);
        expect(out).toMatch(HEX);
        const before = hexToOklch(seed)!;
        const after = hexToOklch(out)!;
        expect(hueDelta(before.h, after.h)).toBeLessThan(3);
      }
    }
  });

  it("pins lightness to the theme band", () => {
    for (const seed of seeds) {
      expect(Math.abs(hexToOklch(harmonizeColor(seed, "dark"))!.L - 0.74)).toBeLessThan(0.012);
      expect(Math.abs(hexToOklch(harmonizeColor(seed, "light"))!.L - 0.48)).toBeLessThan(0.012);
    }
  });

  it("is stable when applied twice (within 8-bit rounding)", () => {
    for (const seed of seeds) {
      const once = harmonizeColor(seed, "dark");
      const twice = harmonizeColor(once, "dark");
      for (let i = 1; i < 7; i += 2) {
        expect(Math.abs(parseInt(once.slice(i, i + 2), 16) - parseInt(twice.slice(i, i + 2), 16))).toBeLessThanOrEqual(1);
      }
    }
  });

  it("returns non-hex input unchanged", () => {
    expect(harmonizeColor("hsl(var(--neutral))", "dark")).toBe("hsl(var(--neutral))");
    expect(harmonizeColor("", "light")).toBe("");
    expect(harmonizeColor("not a color", "light")).toBe("not a color");
  });

  it("keeps greys grey", () => {
    for (const grey of ["#9ca3af", "#6b7280", "#94a3b8", "#71717a"]) {
      const out = hexToOklch(harmonizeColor(grey, "dark"))!;
      expect(out.C).toBeLessThan(0.02);
    }
  });

  it("accepts three-digit hex", () => {
    expect(harmonizeColor("#f00", "dark")).toMatch(HEX);
  });
});

describe("CATEGORY_HUES", () => {
  it("is twelve distinct valid colors", () => {
    expect(CATEGORY_HUES).toHaveLength(12);
    expect(new Set(CATEGORY_HUES).size).toBe(12);
    for (const c of CATEGORY_HUES) expect(c).toMatch(HEX);
  });

  it("survives harmonization in both modes", () => {
    for (const c of CATEGORY_HUES) {
      expect(harmonizeColor(c, "dark")).toMatch(HEX);
      expect(harmonizeColor(c, "light")).toMatch(HEX);
    }
  });
});
