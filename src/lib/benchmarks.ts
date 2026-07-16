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

/** Shared 0-100 score -> letter grade / label / color mapping, used by the main
 *  Health Score as well as the standalone Credit Card / Investment mini-scores. */
export function scoreGrade(total: number): { grade: string; label: string; color: string } {
  const grade = total >= 85 ? "A" : total >= 70 ? "B" : total >= 55 ? "C" : total >= 40 ? "D" : "—";
  const label = total >= 85 ? "Excellent" : total >= 70 ? "Good" : total >= 55 ? "Building" : total >= 40 ? "Developing" : "Getting Started";
  const color = total >= 85 ? "#059669" : total >= 70 ? "#2563eb" : total >= 55 ? "#d97706" : total >= 40 ? "#ea580c" : "#6b7280";
  return { grade, label, color };
}

