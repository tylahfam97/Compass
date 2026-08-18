/** Lightweight "have we already celebrated this?" tracker for one-time milestone moments
 *  (net worth crossing $0 or a round number, a debt reaching $0, a goal completing, a budget
 *  held for a full month, a health-score grade going up). Persisted to localStorage per-profile
 *  so a milestone only ever celebrates once, even across app restarts, and doesn't require any
 *  new DB table/migration for what's purely a client-side UX flourish. */

function storageKey(profileId: number): string {
  return `compass_milestones_seen_${profileId}`;
}

function gradeKey(profileId: number): string {
  return `compass_milestone_grade_${profileId}`;
}

function loadSeen(profileId: number): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(profileId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}

function saveSeen(profileId: number, seen: Set<string>): void {
  try {
    localStorage.setItem(storageKey(profileId), JSON.stringify([...seen]));
  } catch {
    // localStorage unavailable (private browsing, quota, etc.) - celebrations just won't
    // persist across sessions, not worth surfacing an error for a cosmetic feature.
  }
}

export interface MilestoneEvent {
  key: string;
  title: string;
  message: string;
  tier: MilestoneTier;
  icon: MilestoneIcon;
}

/** "major" gets the full-screen dialog + heavy confetti; "standard" gets a top banner and a
 *  lighter burst. Reserve "major" for genuinely rare, hard-won moments so the big treatment
 *  keeps its impact. */
export type MilestoneTier = "major" | "standard";

export type MilestoneIcon = "trophy" | "trending-up" | "target" | "piggy" | "award";

/** Paydown percentages worth celebrating on the way to $0, checked from highest to lowest so
 *  a debt that jumps straight past an earlier threshold (e.g. a lump-sum payment taking it from
 *  10% to 60% paid down in one statement) still fires the highest one it actually crossed,
 *  instead of silently skipping straight to "paid off". */
const DEBT_PROGRESS_THRESHOLDS = [75, 50, 25];

/** Round-number net worth levels worth a moment, in cents, ascending. */
const NET_WORTH_THRESHOLDS_CENTS = [
  100_000,       // $1K
  500_000,       // $5K
  1_000_000,     // $10K
  2_500_000,     // $25K
  5_000_000,     // $50K
  10_000_000,    // $100K
  25_000_000,    // $250K
  50_000_000,    // $500K
  100_000_000,   // $1M
];

/** Net worth at or above this gets the full-screen treatment rather than a banner. */
const NET_WORTH_MAJOR_FLOOR_CENTS = 10_000_000; // $100K

/** Worst-to-best, matching `scoreGrade` in benchmarks.ts. The index order is what makes
 *  "did the grade go UP?" comparable. */
const GRADE_ORDER = ["—", "D", "C", "B", "A"];

function thresholdLabel(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${dollars / 1_000_000}M`;
  return `$${dollars / 1_000}K`;
}

/** Reads the last health grade recorded for this profile and, if the new grade is strictly
 *  better, returns a milestone. The very first observation only records a baseline - we don't
 *  celebrate a grade the user has presumably had all along. Deliberately NOT part of the
 *  seen-set: a grade can drop and be re-earned, and that comeback deserves the same
 *  celebration as the first time. */
function detectGradeImprovement(profileId: number, grade: string): MilestoneEvent | null {
  const newIdx = GRADE_ORDER.indexOf(grade);
  if (newIdx < 0) return null;

  let previous: string | null;
  try {
    previous = localStorage.getItem(gradeKey(profileId));
    localStorage.setItem(gradeKey(profileId), grade);
  } catch {
    // Without persistence we'd re-celebrate the same grade on every load - skip instead.
    return null;
  }

  if (previous === null) return null; // baseline only
  const oldIdx = GRADE_ORDER.indexOf(previous);
  if (oldIdx < 0 || newIdx <= oldIdx) return null;

  return {
    key: `health_grade_up_${previous}_${grade}`,
    title: `Grade up: ${grade}`,
    message: `Your Financial Health Score moved from a ${previous} to a ${grade}.`,
    tier: grade === "A" ? "major" : "standard",
    icon: "award",
  };
}

/** Checks the given snapshot for any milestone that has been crossed but never celebrated
 *  before for this profile, marks each returned milestone as seen (so calling this again with
 *  the same state won't re-fire it), and returns them in the order they should be shown. */
export function detectNewMilestones(
  profileId: number,
  input: {
    netWorthCents?: number;
    debts?: { id: number; name: string; balanceCents: number | null; firstKnownBalanceCents?: number | null }[];
    goals?: { id: number; name: string; pct: number }[];
    /** Budgets for a single COMPLETED month - passing a month that hasn't ended yet would
     *  celebrate a budget the user can still blow through. All entries must share one `month`;
     *  they're collapsed into a single "budgets held" event. */
    budgets?: { id: number; name: string; month: string; monthLabel: string; spentCents: number; limitCents: number }[];
    /** Letter grade from `scoreGrade` (benchmarks.ts). */
    healthGrade?: string;
  }
): MilestoneEvent[] {
  const seen = loadSeen(profileId);
  const events: MilestoneEvent[] = [];

  if (input.netWorthCents !== undefined && input.netWorthCents > 0) {
    const key = "networth_positive";
    if (!seen.has(key)) {
      events.push({
        key,
        title: "Net worth is positive",
        message: "You own more than you owe. That's the hardest turn to make.",
        tier: "major",
        icon: "trending-up",
      });
      seen.add(key);
    }

    // Fire only the highest threshold newly crossed, but mark every lower one seen too - a user
    // who imports years of history at once should get one "$100K" moment, not nine banners
    // counting up to it.
    let highestCrossed: number | null = null;
    for (const threshold of NET_WORTH_THRESHOLDS_CENTS) {
      if (input.netWorthCents < threshold) break;
      const thresholdKey = `networth_${threshold}`;
      if (!seen.has(thresholdKey)) {
        seen.add(thresholdKey);
        highestCrossed = threshold;
      }
    }
    if (highestCrossed !== null) {
      events.push({
        key: `networth_${highestCrossed}`,
        title: `${thresholdLabel(highestCrossed)} net worth`,
        message: `Your net worth just passed ${thresholdLabel(highestCrossed)}.`,
        tier: highestCrossed >= NET_WORTH_MAJOR_FLOOR_CENTS ? "major" : "standard",
        icon: "trending-up",
      });
    }
  }

  for (const d of input.debts ?? []) {
    if (d.balanceCents === null) continue;
    const key = `debt_paid_${d.id}`;
    if (d.balanceCents >= 0 && !seen.has(key)) {
      events.push({
        key,
        title: "Debt paid off",
        message: `${d.name} is paid off. That balance is gone for good.`,
        tier: "major",
        icon: "trophy",
      });
      seen.add(key);
      continue; // fully paid off supersedes any partial-progress milestone for this debt
    }

    // Partial paydown progress, e.g. "50% of the way to paying off your Visa" - only
    // meaningful once we have a starting balance to measure progress against.
    if (d.firstKnownBalanceCents == null || d.firstKnownBalanceCents === 0) continue;
    const startAbs = Math.abs(d.firstKnownBalanceCents);
    const currentAbs = Math.abs(d.balanceCents);
    const pctPaidDown = ((startAbs - currentAbs) / startAbs) * 100;
    for (const threshold of DEBT_PROGRESS_THRESHOLDS) {
      const progressKey = `debt_progress_${threshold}_${d.id}`;
      if (pctPaidDown >= threshold && !seen.has(progressKey)) {
        events.push({
          key: progressKey,
          title: `${threshold}% paid down`,
          message: `You're ${threshold}% of the way to paying off ${d.name}.`,
          tier: threshold >= 75 ? "major" : "standard",
          icon: "trending-up",
        });
        seen.add(progressKey);
        break; // only fire the single highest threshold newly crossed, not every one below it
      }
    }
  }

  for (const g of input.goals ?? []) {
    const key = `goal_complete_${g.id}`;
    if (g.pct >= 100 && !seen.has(key)) {
      events.push({
        key,
        title: "Goal reached",
        message: `You hit your goal: ${g.name}.`,
        tier: "major",
        icon: "target",
      });
      seen.add(key);
    }
  }

  // Rolled into a single event on purpose: someone holding five budgets shouldn't sit through
  // five sequential banners for what is really one accomplishment.
  const heldBudgets = (input.budgets ?? []).filter((b) => b.limitCents > 0 && b.spentCents <= b.limitCents);
  if (heldBudgets.length > 0) {
    const key = `budgets_held_${heldBudgets[0].month}`;
    if (!seen.has(key)) {
      const label = heldBudgets[0].monthLabel;
      events.push({
        key,
        title: heldBudgets.length === 1 ? "Budget held" : `${heldBudgets.length} budgets held`,
        message:
          heldBudgets.length === 1
            ? `You stayed inside your ${heldBudgets[0].name} budget for all of ${label}.`
            : `You finished ${label} inside ${heldBudgets.length} of your budgets.`,
        tier: "standard",
        icon: "piggy",
      });
      seen.add(key);
    }
  }

  if (events.length > 0) saveSeen(profileId, seen);

  if (input.healthGrade !== undefined) {
    const gradeEvent = detectGradeImprovement(profileId, input.healthGrade);
    if (gradeEvent) events.push(gradeEvent);
  }

  return events;
}
