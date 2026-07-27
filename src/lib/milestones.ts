/** Lightweight "have we already celebrated this?" tracker for one-time milestone moments
 *  (net worth crossing $0, a debt reaching $0, a goal completing). Persisted to localStorage
 *  per-profile so a milestone only ever celebrates once, even across app restarts, and doesn't
 *  require any new DB table/migration for what's purely a client-side UX flourish. */

function storageKey(profileId: number): string {
  return `compass_milestones_seen_${profileId}`;
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
  message: string;
}

/** Paydown percentages worth celebrating on the way to $0, checked from highest to lowest so
 *  a debt that jumps straight past an earlier threshold (e.g. a lump-sum payment taking it from
 *  10% to 60% paid down in one statement) still fires the highest one it actually crossed,
 *  instead of silently skipping straight to "paid off". */
const DEBT_PROGRESS_THRESHOLDS = [75, 50, 25];

/** Checks the given snapshot for any milestone that has been crossed but never celebrated
 *  before for this profile, marks each returned milestone as seen (so calling this again with
 *  the same state won't re-fire it), and returns them in the order they should be shown. */
export function detectNewMilestones(
  profileId: number,
  input: {
    netWorthCents?: number;
    debts?: { id: number; name: string; balanceCents: number | null; firstKnownBalanceCents?: number | null }[];
    goals?: { id: number; name: string; pct: number }[];
  }
): MilestoneEvent[] {
  const seen = loadSeen(profileId);
  const events: MilestoneEvent[] = [];

  if (input.netWorthCents !== undefined && input.netWorthCents > 0) {
    const key = "networth_positive";
    if (!seen.has(key)) {
      events.push({ key, message: "Your net worth just went positive! 🎉" });
      seen.add(key);
    }
  }

  for (const d of input.debts ?? []) {
    if (d.balanceCents === null) continue;
    const key = `debt_paid_${d.id}`;
    if (d.balanceCents >= 0 && !seen.has(key)) {
      events.push({ key, message: `${d.name} is paid off! 🎉` });
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
      const key = `debt_progress_${threshold}_${d.id}`;
      if (pctPaidDown >= threshold && !seen.has(key)) {
        events.push({ key, message: `You're ${threshold}% of the way to paying off ${d.name}! 🎉` });
        seen.add(key);
        break; // only fire the single highest threshold newly crossed, not every one below it
      }
    }
  }

  for (const g of input.goals ?? []) {
    const key = `goal_complete_${g.id}`;
    if (g.pct >= 100 && !seen.has(key)) {
      events.push({ key, message: `Goal reached: ${g.name}! 🎉` });
      seen.add(key);
    }
  }

  if (events.length > 0) saveSeen(profileId, seen);
  return events;
}
