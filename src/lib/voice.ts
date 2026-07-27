/** The "companion voice" layer for rule-based insight text (see generateInsights() in
 *  agent.ts) - phrasing variety + trend-aware tone, composed on top of whatever "current vs
 *  previous" comparison the caller has available (either a fresh DB query, for insight types
 *  that already track a prior period, or `voiceMemory.ts`'s localStorage store, for types that
 *  don't). This is deliberately NOT an LLM - see the plan decision: bundled/local models are
 *  too heavy for low-end hardware and cloud models break this app's offline-first, local-data
 *  design. Everything here is authored templates + simple deterministic selection logic. */

import type { InsightType } from "./types";

export type VoiceTone = "improving" | "worsening" | "flat";

/** Classifies the trend between a previous value and the current one - "flat" if the change is
 *  within a small relative/absolute tolerance (avoids labeling ordinary month-to-month noise as
 *  a meaningful improvement or decline). `higherIsBetter` differs by metric (e.g. savings rate:
 *  higher is better; debt balance: lower is better) so it's the caller's responsibility. */
export function classifyTrend(current: number, previous: number | null, higherIsBetter: boolean): VoiceTone {
  if (previous == null) return "flat";
  const delta = current - previous;
  const tolerance = Math.max(Math.abs(previous) * 0.03, 0.5);
  if (Math.abs(delta) <= tolerance) return "flat";
  const improved = higherIsBetter ? delta > 0 : delta < 0;
  return improved ? "improving" : "worsening";
}

/** Deterministic pseudo-random index picker - the same seed always picks the same phrasing
 *  variant (no flicker if an insight re-renders within the same period), but a seed that
 *  changes over time (e.g. includes the month label) rotates the wording so the companion
 *  doesn't sound like a broken record every time you open the app. Exported for other
 *  lightweight narrative callouts (e.g. Budgets/Trends pages) that want phrasing variety
 *  without the full memory + tone machinery below. */
export function pickVariantIndex(seed: string, count: number): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(hash) % count;
}

type PhrasingSet = Partial<Record<VoiceTone, string[]>>;

/** Phrasing-variant pools per insight type. Templates use `{current}`/`{previous}` placeholders
 *  - already-formatted display strings supplied by the caller, since the right formatter
 *  (currency vs percent vs "N months") is already known at the call site in agent.ts. Only a
 *  subset of `InsightType` has a pool here - types without one just keep using their original,
 *  single-phrasing description text (see `composeInsightText`'s fallback), so every insight type
 *  keeps working even before it gets its own dedicated voice pass. */
const PHRASING: Partial<Record<InsightType, PhrasingSet>> = {
  savings_rate_low: {
    improving: [
      "Your savings rate climbed to {current} - last time it was {previous}. Keep this up.",
      "Nice movement: {previous} \u2192 {current} saved. Small steps count.",
    ],
    worsening: [
      "Your savings rate slipped to {current}, down from {previous}. Worth a look at what changed.",
      "Down from {previous} to {current} saved this period - no judgment, just flagging it.",
    ],
    flat: [
      "Still saving around {current}, same as last time - a savings goal could help you push higher.",
    ],
  },
  positive_streak: {
    improving: ["You're on a roll: {current} months running now, up from {previous} last time you checked."],
    worsening: ["Streak's at {current} months now - a little shorter than the {previous} you had going."],
    flat: ["You're {current} months into this streak - keep it going."],
  },
  overspend_streak: {
    improving: ["Overspending eased to {current}, better than the {previous} you were at."],
    worsening: ["Overspending stretched to {current}, up from {previous}."],
    flat: ["You've been over budget for {current} in a row now - consider adjusting the limit."],
  },
  credit_card_debt_growing: {
    worsening: [
      "That's {current} now, up from {previous} - worth a look before it compounds with interest.",
      "This balance grew to {current} from {previous}.",
    ],
    flat: ["Balance is holding around {current}."],
    improving: ["Balance moved to {current} from {previous}."],
  },
  credit_card_debt_improving: {
    improving: [
      "Down to {current} from {previous} - that's real progress.",
      "Nice work: {previous} \u2192 {current} owed.",
    ],
    flat: ["Balance is holding around {current}."],
    worsening: ["Balance moved to {current} from {previous}."],
  },
  loan_debt_growing: {
    worsening: ["This loan grew to {current}, up from {previous} last month."],
    flat: ["Balance is holding around {current}."],
    improving: ["Balance moved to {current} from {previous}."],
  },
  loan_debt_improving: {
    improving: ["This loan dropped to {current}, down from {previous} - keep going."],
    flat: ["Balance is holding around {current}."],
    worsening: ["Balance moved to {current} from {previous}."],
  },
  net_worth_growing: {
    improving: [
      "Your net worth is up to {current}, from {previous} last month.",
      "Climbing: {previous} \u2192 {current}.",
    ],
    flat: ["Net worth is holding around {current}."],
    worsening: ["Net worth moved to {current} from {previous}."],
  },
  net_worth_declining: {
    worsening: ["Your net worth dipped to {current}, from {previous} last month."],
    flat: ["Net worth is holding around {current}."],
    improving: ["Net worth moved to {current} from {previous}."],
  },
  most_improved: {
    improving: [
      "Last month: {previous}. This month so far: {current}. Great progress - keep it up.",
      "You cut this from {previous} to {current} - that adds up over a year.",
    ],
    flat: ["Last month: {previous}. This month so far: {current}."],
    worsening: ["Last month: {previous}. This month so far: {current}."],
  },
};

export interface ComposeInsightInput {
  type: InsightType;
  currentValue: number;
  currentLabel: string;
  previousValue: number | null;
  previousLabel: string | null;
  higherIsBetter: boolean;
  /** Deterministic per-period seed so the picked variant is stable within a render but rotates
   *  over time - e.g. `${profileId}:${dismissKey}:${monthLabel}`. */
  variantSeed: string;
  /** Original single-phrasing text, used whenever there's no previous value to compare against
   *  or no phrasing pool defined yet for this insight type. */
  fallback: string;
}

/** Ties trend classification + phrasing pools together into the final description text for one
 *  insight. Falls back to the caller-supplied text unchanged whenever there's nothing to compare
 *  against yet (first time an insight type has ever fired for this profile) or the insight type
 *  doesn't have a phrasing pool defined above. */
export function composeInsightText(input: ComposeInsightInput): string {
  if (input.previousValue == null || input.previousLabel == null) return input.fallback;
  const set = PHRASING[input.type];
  if (!set) return input.fallback;
  const tone = classifyTrend(input.currentValue, input.previousValue, input.higherIsBetter);
  const variants = set[tone];
  if (!variants || variants.length === 0) return input.fallback;
  const template = variants[pickVariantIndex(input.variantSeed, variants.length)];
  return template.replace("{current}", input.currentLabel).replace("{previous}", input.previousLabel);
}
