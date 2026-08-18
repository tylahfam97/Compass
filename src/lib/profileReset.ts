/** Every localStorage namespace scoped to a single profile. Erasing a profile's data has to
 *  clear these too, or the app keeps remembering things about data that no longer exists -
 *  milestones stay "already celebrated" and so never fire again, dismissed insights stay
 *  dismissed, and hidden charges stay hidden.
 *
 *  Kept as an explicit list rather than scanning localStorage for the profile id, which would
 *  false-match across profiles (profile 1 matching a key ending in `_11`). */
const PROFILE_SCOPED_KEY_PREFIXES = [
  "compass_milestones_seen_",
  "compass_milestone_grade_",
  "compass_voice_memory_",
  "compass_hidden_charges_",
  "compass_dismissed_",
  "compass_insight_view_",
  "compass_budget_view_",
  "compass_overview_view_",
];

export function clearProfileLocalState(profileId: number): void {
  for (const prefix of PROFILE_SCOPED_KEY_PREFIXES) {
    try {
      localStorage.removeItem(`${prefix}${profileId}`);
    } catch {
      // Nothing recoverable to do; the DB rows are already gone either way.
    }
  }
}
