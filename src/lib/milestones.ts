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

/** Checks the given snapshot for any milestone that has been crossed but never celebrated
 *  before for this profile, marks each returned milestone as seen (so calling this again with
 *  the same state won't re-fire it), and returns them in the order they should be shown. */
export function detectNewMilestones(
  profileId: number,
  input: {
    netWorthCents?: number;
    debts?: { id: number; name: string; balanceCents: number | null }[];
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
