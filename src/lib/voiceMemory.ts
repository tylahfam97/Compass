/** Per-profile "what did we already tell you" memory for the companion-voice insight layer
 *  (see voice.ts) - lets insight copy reference the previous period ("last month you were at
 *  $X, now $Y") for the handful of insight types that don't already compute a prior value
 *  straight from the database (e.g. streak counts, savings rate). Persisted to localStorage,
 *  same pattern as milestones.ts - purely a copy-continuity flourish, not worth a DB migration.
 *  Insight types that already query their own "previous" value from the database (credit/loan
 *  debt deltas, net worth deltas, most-improved category) don't need this - they pass their
 *  DB-sourced previous value straight into `composeInsightText` instead. */

function storageKey(profileId: number): string {
  return `compass_voice_memory_${profileId}`;
}

export interface VoiceMemoryRecord {
  /** Raw numeric value (whatever unit the caller uses - cents, whole percent points, months of
   *  a streak, etc.) - used only for trend classification, never displayed directly. */
  rawValue: number;
  /** Already-formatted display text for this value (e.g. "18%", "$1,204") - shown verbatim next
   *  time as "{previous}" in a phrasing template, so no format-guessing is needed on read. */
  label: string;
  asOfDate: string;
}

function loadMemory(profileId: number): Record<string, VoiceMemoryRecord> {
  try {
    const raw = localStorage.getItem(storageKey(profileId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveMemory(profileId: number, memory: Record<string, VoiceMemoryRecord>): void {
  try {
    localStorage.setItem(storageKey(profileId), JSON.stringify(memory));
  } catch {
    // localStorage unavailable (private browsing, quota, etc.) - the companion voice just
    // won't have continuity this session, not worth surfacing an error for a copy flourish.
  }
}

/** Reads the last-remembered state for one insight key, without mutating anything - call
 *  before composing this period's text so you have a "previous" to compare against. */
export function getRemembered(profileId: number, key: string): VoiceMemoryRecord | null {
  return loadMemory(profileId)[key] ?? null;
}

/** Records this period's value as the new "last known state" for one insight key, to be read
 *  back next time insights are generated. Call once per insight per generation pass, after
 *  composing this period's text (so the *next* call sees what was just shown, not itself). */
export function remember(profileId: number, key: string, rawValue: number, label: string, asOfDate: string): void {
  const memory = loadMemory(profileId);
  memory[key] = { rawValue, label, asOfDate };
  saveMemory(profileId, memory);
}
