/** Per-profile list of detected recurring charges the user has explicitly hidden. Kept in
 *  localStorage rather than a DB table for the same reason as milestones.ts: it's a display
 *  preference about inferred data, not a fact about the user's money, and it shouldn't need a
 *  migration. Hiding a charge removes it from subscriptions, insights and the Plan forecast. */

function storageKey(profileId: number): string {
  return `compass_hidden_charges_${profileId}`;
}

/** Charges are identified by description, since that's what the detector groups on. Normalised
 *  so trivial whitespace/case differences can't produce a key that never matches again. */
export function chargeKey(description: string): string {
  return description.trim().replace(/\s+/g, " ").toUpperCase();
}

function load(profileId: number): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(profileId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}

function save(profileId: number, keys: Set<string>): void {
  try {
    localStorage.setItem(storageKey(profileId), JSON.stringify([...keys]));
  } catch {
    // Preference just won't persist; not worth surfacing an error over.
  }
}

/** Union of hidden charges across the given profiles, for the global/multi-profile views. */
export function getHiddenChargeKeys(profileIds: number[]): Set<string> {
  const all = new Set<string>();
  for (const id of profileIds) for (const key of load(id)) all.add(key);
  return all;
}

export function hideCharge(profileId: number, description: string): void {
  const keys = load(profileId);
  keys.add(chargeKey(description));
  save(profileId, keys);
}

export function unhideCharge(profileId: number, description: string): void {
  const keys = load(profileId);
  keys.delete(chargeKey(description));
  save(profileId, keys);
}

export function listHiddenCharges(profileId: number): string[] {
  return [...load(profileId)];
}

export function clearHiddenCharges(profileId: number): void {
  try {
    localStorage.removeItem(storageKey(profileId));
  } catch {
    // Nothing to do.
  }
}
