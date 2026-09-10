/**
 * One chart language for every recharts usage, so the same quantity is always drawn the
 * same way: recorded money (balances, income, net) in the sea blue, money the user
 * directs (spending, what-if projections) in gold, gains and losses in the status
 * colors. Pure module - safe to import from tests and from components alike.
 */

export const series = {
  /** Recorded data: balances, income, net worth, cumulative net. */
  balance: "hsl(var(--sea))",
  income: "hsl(var(--sea))",
  net: "hsl(var(--sea))",
  /** Money the user directs: spending series, what-if projections. */
  spending: "hsl(var(--primary))",
  projection: "hsl(var(--primary))",
  gain: "hsl(var(--success))",
  loss: "hsl(var(--error))",
  neutral: "hsl(var(--neutral))",
  reference: "hsl(var(--muted-foreground))",
  grid: "hsl(var(--border))",
} as const;

/** Dashed gold line for a projection or hypothetical series. */
export const projectionStroke = {
  stroke: series.projection,
  strokeDasharray: "7 3",
  strokeWidth: 2.5,
} as const;

export const chartTooltipStyle = {
  backgroundColor: "hsl(var(--surface-raised))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  fontSize: 12,
  color: "hsl(var(--foreground))",
  boxShadow: "var(--shadow-raised)",
} as const;

export const chartTooltipText = { color: "hsl(var(--foreground))" } as const;
export const chartTooltipWrapper = { zIndex: 50, outline: "none" } as const;

export const axisTick = { fontSize: 11, fill: "hsl(var(--muted-foreground))" } as const;

export const gridProps = {
  vertical: false,
  stroke: series.grid,
  strokeDasharray: "2 6",
} as const;

// ── Color harmonization ──────────────────────────────────────────────────────
// Category and account colors are stored in the database as whatever hex the seed or
// the user picked (today a Tailwind-500 rainbow). Rather than migrate them, every paint
// site normalises them: keep the hue, pin lightness and chroma per theme, so any color
// sits in the same band on the navy or the paper and stays distinguishable from its
// neighbours. OKLCH is used because equal steps there look equal to the eye.

type Oklch = { L: number; C: number; h: number };

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function parseHex(hex: string): [number, number, number] | null {
  const m = HEX_RE.exec(hex.trim());
  if (!m) return null;
  const s = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  const n = parseInt(s, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function toLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function toGamma(c: number): number {
  const v = Math.max(0, Math.min(1, c));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function rgbToOklch(r8: number, g8: number, b8: number): Oklch {
  const r = toLinear(r8), g = toLinear(g8), b = toLinear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(a, bb);
  let h = (Math.atan2(bb, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h };
}

/** Linear sRGB for an OKLCH color; may fall outside [0, 1] when out of gamut. */
function oklchToLinear({ L, C, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function inGamut([r, g, b]: [number, number, number]): boolean {
  const eps = 0.0005;
  return r >= -eps && r <= 1 + eps && g >= -eps && g <= 1 + eps && b >= -eps && b <= 1 + eps;
}

function oklchToHex(color: Oklch): string {
  // Reduce chroma until the color fits in sRGB, keeping hue and lightness fixed.
  let lo = 0, hi = color.C;
  let rgb = oklchToLinear(color);
  if (!inGamut(rgb)) {
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      const candidate = oklchToLinear({ ...color, C: mid });
      if (inGamut(candidate)) { lo = mid; rgb = candidate; } else hi = mid;
    }
  }
  const to8 = (c: number) => Math.round(toGamma(c) * 255).toString(16).padStart(2, "0");
  return `#${to8(rgb[0])}${to8(rgb[1])}${to8(rgb[2])}`;
}

/** Target band per theme: lightness and chroma every harmonized color is pinned to. */
const BAND = {
  dark: { L: 0.74, C: 0.11 },
  light: { L: 0.48, C: 0.12 },
} as const;

/** Below this chroma a color is a grey; it keeps zero chroma so "Uncategorized" stays grey. */
const GREY_CHROMA = 0.045;

/**
 * Normalises any stored hex color into the theme's band while preserving its hue.
 * Returns the input unchanged when it is not a parsable hex color (CSS variables and
 * hsl() strings pass straight through).
 */
export function harmonizeColor(hex: string, mode: "dark" | "light"): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const { C, h } = rgbToOklch(rgb[0], rgb[1], rgb[2]);
  const band = BAND[mode];
  if (C < GREY_CHROMA) return oklchToHex({ L: band.L, C: 0, h: 0 });
  return oklchToHex({ L: band.L, C: band.C, h });
}

/** Exposed for tests and for tooling that wants to inspect a color's hue. */
export function hexToOklch(hex: string): Oklch | null {
  const rgb = parseHex(hex);
  return rgb ? rgbToOklch(rgb[0], rgb[1], rgb[2]) : null;
}

/**
 * Twelve evenly spaced hues in the mid band, used as the stored default for new
 * categories, accounts and avatars. Stored colors are still harmonized at paint time,
 * so these only need to be distinct in hue.
 */
const RAMP_HUES = [25, 55, 85, 115, 150, 180, 210, 240, 270, 300, 330, 355] as const;
export const CATEGORY_HUES: readonly string[] = RAMP_HUES.map((h) => oklchToHex({ L: 0.7, C: 0.12, h }));
