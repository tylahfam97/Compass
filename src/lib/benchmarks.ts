/**
 * Commonly-cited public "average American" financial benchmarks, used to give
 * Credit Card Health and Investment Health scores a real-world point of
 * reference. These are round, widely-reported figures (Experian / Federal
 * Reserve consumer credit surveys; long-run S&P 500 real-return studies) -
 * not a live feed, and not personalized or financial advice.
 */

/** Average U.S. credit card balance among households carrying a balance (~$6,000, commonly cited by Experian/Federal Reserve consumer credit reports). */
export const AVG_US_CREDIT_CARD_DEBT_CENTS = 600_000;

/** Long-run average U.S. stock market annual return, inflation-adjusted (S&P 500 real return, ~7%/yr). */
export const AVG_US_MARKET_RETURN_PCT = 7;

/** Design-system token behind each grade: success for A, the recorded-data blue for B, gold
 *  ink for C, warning for D, and the muted ink for "not yet". All clear 4.5:1 on both themes. */
export type GradeTone = "success" | "sea" | "gold" | "warning" | "neutral";

const TONE_TOKEN: Record<GradeTone, string> = {
  success: "--success",
  sea: "--sea",
  gold: "--gold-ink",
  warning: "--warning",
  neutral: "--muted-foreground",
};

/** A grade tone as a translucent tint, for washes and borders: `gradeTint("sea", 0.12)`. */
export function gradeTint(tone: GradeTone, alpha: number): string {
  return `hsl(var(${TONE_TOKEN[tone]}) / ${alpha})`;
}

/** Shared 0-100 score -> letter grade / label / colour mapping, used by the main
 *  Health Score as well as the standalone Credit Card / Investment mini-scores.
 *  `color` is a CSS colour built from a design token, so it follows the theme. */
export function scoreGrade(total: number): { grade: string; label: string; color: string; tone: GradeTone } {
  const grade = total >= 85 ? "A" : total >= 70 ? "B" : total >= 55 ? "C" : total >= 40 ? "D" : "—";
  const label = total >= 85 ? "Excellent" : total >= 70 ? "Good" : total >= 55 ? "Building" : total >= 40 ? "Developing" : "Getting Started";
  const tone: GradeTone = total >= 85 ? "success" : total >= 70 ? "sea" : total >= 55 ? "gold" : total >= 40 ? "warning" : "neutral";
  return { grade, label, color: `hsl(var(${TONE_TOKEN[tone]}))`, tone };
}
