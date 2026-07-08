import { create } from "zustand";
import type { Profile } from "@/lib/types";

const LS_ACTIVE_KEY = "compass_active_profile";

function getDismissedKey(profileId: number) {
  return `compass_dismissed_${profileId}`;
}

function loadDismissed(profileId: number): string[] {
  try {
    const raw = localStorage.getItem(getDismissedKey(profileId));
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveDismissed(profileId: number, keys: string[]) {
  localStorage.setItem(getDismissedKey(profileId), JSON.stringify(keys));
}

interface ProfileStore {
  profiles: Profile[];
  activeProfile: Profile | null;
  /** Profile IDs unlocked this session via PIN. Cleared on app restart. */
  unlockedIds: Set<number>;
  dismissedInsights: string[];

  setProfiles: (profiles: Profile[]) => void;
  setActiveProfile: (profile: Profile) => void;
  unlockProfile: (id: number) => void;
  dismissInsight: (key: string) => void;
  clearDismissed: () => void;
}

export const useProfileStore = create<ProfileStore>((set, get) => ({
  profiles: [],
  activeProfile: null,
  unlockedIds: new Set(),
  dismissedInsights: [],

  setProfiles: (profiles) => set({ profiles }),

  setActiveProfile: (profile) => {
    localStorage.setItem(LS_ACTIVE_KEY, String(profile.id));
    set({
      activeProfile: profile,
      dismissedInsights: loadDismissed(profile.id),
    });
  },

  unlockProfile: (id) =>
    set((s) => ({ unlockedIds: new Set([...s.unlockedIds, id]) })),

  dismissInsight: (key) => {
    const { activeProfile, dismissedInsights } = get();
    if (!activeProfile) return;
    if (dismissedInsights.includes(key)) return;
    const updated = [...dismissedInsights, key];
    saveDismissed(activeProfile.id, updated);
    set({ dismissedInsights: updated });
  },

  clearDismissed: () => {
    const { activeProfile } = get();
    if (!activeProfile) return;
    saveDismissed(activeProfile.id, []);
    set({ dismissedInsights: [] });
  },
}));

/** Returns the saved last-used profile ID, or null. */
export function getSavedProfileId(): number | null {
  const raw = localStorage.getItem(LS_ACTIVE_KEY);
  const n = raw ? parseInt(raw, 10) : NaN;
  return isNaN(n) ? null : n;
}
